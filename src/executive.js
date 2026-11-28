'use strict';

// Painel executivo: os números da rede numa tela só (visão do dono/sócios/investidor).
// Junta o que já existe: vendas das lojas (CPlug), distribuição B2B, caixa e contas, conferência, estoque e integrações.
// Não calcula EBITDA ainda: depende das decisões contábeis (receita das lojas, taxas, CMV) — fica indicado como pendente.

const T = require('./time');
const itau = require('./itau');

const div = (a, b) => (b ? a / b : null);
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function createExecutive(db, { analytics, accounts, cashflow, conciliacao }) {
  // vendas do balcão (CPlug) por loja e dia
  const storeRows = () => db.prepare(`SELECT l.id AS location_id, l.name, l.opened_at, l.area_m2, l.rent_cents, l.capex_cents, s.id AS store_id
    FROM locations l LEFT JOIN int_stores s ON s.location_id = l.id AND s.source = 'cplug'
    WHERE l.kind = 'loja' AND l.active = 1 ORDER BY l.name`).all();
  const salesSum = (storeId, from, to) => (storeId ? db.prepare(`SELECT COALESCE(SUM(COALESCE(products_cents, payments_cents, 0)), 0) v, COUNT(*) d
    FROM cplug_daily_totals WHERE store_id = ? AND date BETWEEN ? AND ?`).get(storeId, from, to) : { v: 0, d: 0 });

  function overview(today = T.localDate()) {
    const yesterday = T.addDays(today, -1);
    const ym = today.slice(0, 7);
    const monthStart = `${ym}-01`;
    const dayN = Number(today.slice(8, 10));
    const prevYm = addMonths(ym, -1);
    const [prevStart, prevEndMonth] = T.monthBounds(prevYm);
    const prevEnd = `${prevYm}-${String(Math.min(dayN, Number(prevEndMonth.slice(8)))).padStart(2, '0')}`;
    const ltmStart = `${addMonths(ym, -11)}-01`;

    // ---- lojas ----
    const months = Array.from({ length: 12 }, (_, i) => addMonths(ym, i - 11));
    const stores = storeRows().map((s) => {
      const mtd = salesSum(s.store_id, monthStart, today);
      const prev = salesSum(s.store_id, prevStart, prevEnd);
      const ltm = salesSum(s.store_id, ltmStart, today);
      const byMonth = months.map((m) => { const [a, b] = T.monthBounds(m); return { month: m, cents: salesSum(s.store_id, a, b).v }; });
      return {
        location_id: s.location_id, name: s.name, linked: !!s.store_id, opened_at: s.opened_at,
        today: salesSum(s.store_id, today, today).v, yesterday: salesSum(s.store_id, yesterday, yesterday).v,
        mtd: mtd.v, mtd_days: mtd.d, prev_mtd: prev.v, growth: prev.v ? (mtd.v - prev.v) / prev.v : null,
        avg_day: mtd.d ? Math.round(mtd.v / mtd.d) : null, ltm: ltm.v, by_month: byMonth,
        rent_pct: s.rent_cents && mtd.d ? div(s.rent_cents * (mtd.d / 30), mtd.v) : null,
        sales_m2_month: s.area_m2 && mtd.d ? Math.round((mtd.v / mtd.d) * 30 / s.area_m2) : null,
      };
    });
    const sum = (k) => stores.reduce((a, s) => a + (s[k] || 0), 0);
    const storesTotal = { today: sum('today'), yesterday: sum('yesterday'), mtd: sum('mtd'), prev_mtd: sum('prev_mtd'), ltm: sum('ltm') };
    storesTotal.growth = storesTotal.prev_mtd ? (storesTotal.mtd - storesTotal.prev_mtd) / storesTotal.prev_mtd : null;
    const chart = months.map((m, i) => ({ month: m, stores: stores.map((s) => ({ name: s.name, cents: s.by_month[i].cents })) }));

    // ---- distribuição B2B ----
    const b2b = analytics.metrics(monthStart, today);
    const b2bPrev = analytics.metrics(prevStart, prevEnd);
    const rec = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) v, COALESCE(SUM(CASE WHEN due_date < ? THEN amount_cents END), 0) late
      FROM fin_entries WHERE order_id IS NOT NULL AND paid_date IS NULL`).get(today);
    const openOrders = db.prepare("SELECT COUNT(*) n FROM orders WHERE deleted_at IS NULL AND status NOT IN ('entregue', 'cancelado')").get().n;

    // ---- caixa e contas ----
    let cash = null; let proj = null;
    try { cash = accounts.total(); } catch { cash = null; }
    try { proj = cashflow.projection(30, today); } catch { proj = null; }
    const payables = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN COALESCE(e.due_date, e.competence_date) < ? THEN e.amount_cents END), 0) late,
        COALESCE(SUM(CASE WHEN COALESCE(e.due_date, e.competence_date) BETWEEN ? AND ? THEN e.amount_cents END), 0) week
      FROM fin_entries e JOIN fin_accounts a ON a.id = e.account_id WHERE a.kind = 'despesa' AND e.paid_date IS NULL`).get(today, today, T.addDays(today, 7));

    // ---- conferência (últimos 7 dias) ----
    let conf = [];
    try {
      conf = conciliacao.report({ from: T.addDays(today, -7), to: yesterday }).map((s) => ({ name: s.name, ...s.summary }));
    } catch { conf = []; }

    // ---- estoque da câmara ----
    const stock = db.prepare(`SELECT COALESCE(SUM(CAST(stock_units AS REAL) / NULLIF(units_per_box, 0)), 0) boxes,
      COALESCE(SUM(CASE WHEN has_cost = 1 THEN stock_value_cents END), 0) value,
      COUNT(CASE WHEN stock_units > 0 AND has_cost = 0 THEN 1 END) uncosted, COUNT(CASE WHEN stock_units > 0 THEN 1 END) with_stock
      FROM products WHERE active = 1`).get();

    // ---- integrações ----
    const lastRun = (source) => db.prepare('SELECT source, kind, status, started_at, message FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 1').get(source) || null;
    const integrations = { cplug: lastRun('cplug'), rede: lastRun('rede'), itau: lastRun('itau'), santander: lastRun('santander') };
    let cert = itau.certInfo(itau.config());
    const dbCert = db.prepare('SELECT MIN(valid_to) v FROM itau_credentials WHERE active = 1 AND valid_to IS NOT NULL').get();
    if (dbCert && dbCert.v) cert = { cert_found: true, valid_to: dbCert.v, days_left: Math.floor((Date.parse(`${dbCert.v}T23:59:59Z`) - Date.now()) / 86400000) };

    // ---- alertas ----
    const alerts = [];
    const add = (level, text, view) => alerts.push({ level, text, view });
    for (const c of conf) if (c.diff) add('alto', `${c.name}: ${c.diff} diferença(s) na conferência dos últimos 7 dias.`, 'conferencia');
    if (payables.late) add('alto', `Contas a pagar vencidas: ${(payables.late / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`, 'financeiro');
    if (rec.late) add('medio', `Clientes B2B com pagamento atrasado: ${(rec.late / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`, 'financeiro');
    if (proj && proj.first_negative) add('alto', `O caixa projetado fica negativo em ${String(proj.first_negative.date).split('-').reverse().join('/')}.`, 'financeiro');
    for (const [k, r] of Object.entries(integrations)) if (r && r.status === 'erro') add('medio', `Última busca ${k === 'cplug' ? 'do CPlug' : k === 'rede' ? 'da Rede' : k === 'santander' ? 'do Santander' : 'do Itaú'} deu erro.`, 'integracoes');
    if (cert.cert_found && cert.days_left !== undefined && cert.days_left <= 30) add('alto', `O certificado do Itaú vence em ${cert.days_left} dias: renove no Itaú for Developers.`, 'integracoes');
    if (stock.uncosted) add('medio', `${stock.uncosted} produto(s) com estoque sem custo: o CMV e a margem ficam incompletos.`, 'estoque');
    for (const s of stores) if (!s.linked) add('baixo', `${s.name}: sem loja do CPlug ligada (cadastre em Lojas).`, 'lojas');
    const incomplete = db.prepare("SELECT name FROM locations WHERE kind = 'loja' AND active = 1 AND (opened_at IS NULL OR capex_cents IS NULL OR rent_cents IS NULL)").all();
    if (incomplete.length) add('baixo', `Ficha incompleta (inauguração, aluguel ou investimento): ${incomplete.map((l) => l.name).join(', ')}.`, 'lojas');

    return {
      today, month: ym, period: { from: monthStart, to: today, prev_from: prevStart, prev_to: prevEnd, ltm_from: ltmStart },
      stores, stores_total: storesTotal, chart,
      b2b: { revenue: b2b.revenue, margin: b2b.margin, margin_pct: b2b.margin_pct, orders: b2b.orders, buyers: b2b.buyers, prev_revenue: b2bPrev.revenue,
        growth: b2bPrev.revenue ? (b2b.revenue - b2bPrev.revenue) / b2bPrev.revenue : null, receivable: rec.v, receivable_late: rec.late, open_orders: openOrders, uncosted: b2b.uncosted },
      cash: { total: cash, min30: proj ? proj.min : null, end30: proj ? proj.end_cents : null, payables_week: payables.week, payables_late: payables.late },
      conferencia: conf, stock, integrations, certificate: cert.cert_found ? { valid_to: cert.valid_to, days_left: cert.days_left } : null,
      alerts: alerts.sort((a, b) => ['alto', 'medio', 'baixo'].indexOf(a.level) - ['alto', 'medio', 'baixo'].indexOf(b.level)),
      pending: ['EBITDA por loja: depende de lançar a receita das lojas, as taxas da Rede e o CMV (decisões contábeis pendentes).'],
    };
  }

  return { overview };
}

module.exports = { createExecutive };

'use strict';

// Análises do negócio (só master). Começa pelo que o sistema já mede com segurança:
// vendas B2B (receita e CMV a custo médio), estoque, perdas e contas a receber.
// As vendas do balcão das lojas entram quando a integração com o PDV (CPlug) existir.

const T = require('./time');
const { addMonths } = require('./recurring');

const div = (a, b) => (b ? a / b : null);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5) + 1;

function createAnalytics(db, reports) {
  // Números de um período [from, to] (dias locais).
  function metrics(from, to) {
    const movs = reports.periodMovements(from, to);
    const sales = movs.filter((m) => m.eff_type === 'saida_pedido');
    const revenue = sales.reduce((s, m) => s + (m.revenue_cents ?? 0), 0);
    const cmv = sales.reduce((s, m) => s - (m.value_cents ?? 0), 0);
    const units = sales.reduce((s, m) => s - m.quantity, 0);
    // pedido conta se ficou com venda no período (estorno de cancelamento zera)
    const byOrder = new Map();
    for (const m of sales) if (m.order_id) byOrder.set(m.order_id, (byOrder.get(m.order_id) || 0) + (m.revenue_cents ?? 0));
    const orders = [...byOrder.values()].filter((v) => v > 0).length;
    const byCustomer = new Map();
    for (const m of sales) if (m.customer_id) byCustomer.set(m.customer_id, (byCustomer.get(m.customer_id) || 0) + (m.revenue_cents ?? 0));
    const buyers = [...byCustomer.values()].filter((v) => v > 0).length;
    const losses = movs.filter((m) => m.eff_type === 'perda' || m.eff_type === 'divergencia_inventario')
      .reduce((s, m) => s - (m.value_cents ?? 0), 0);
    const toStores = movs.filter((m) => m.eff_type === 'transferencia').reduce((s, m) => s - (m.value_cents ?? 0), 0);
    const purchases = movs.filter((m) => m.eff_type === 'entrada').reduce((s, m) => s + (m.value_cents ?? 0), 0);
    const days = daysBetween(from, to);
    return {
      from, to, days, revenue, cmv, margin: revenue - cmv, margin_pct: div(revenue - cmv, revenue),
      units, orders, ticket: orders ? Math.round(revenue / orders) : null, buyers, losses,
      losses_pct: div(losses, cmv + losses + toStores), to_stores: toStores, purchases,
      uncosted: sales.some((m) => m.value_cents === null),
    };
  }

  // Estoque hoje e por quantos dias ele dura no ritmo de saída (vendas B2B + envios às lojas) do período.
  function stock(m) {
    const p = db.prepare('SELECT COALESCE(SUM(stock_value_cents), 0) v, COALESCE(SUM(stock_units), 0) u FROM products WHERE has_cost = 1').get();
    const dailyOut = (m.cmv + m.to_stores) / m.days;
    return { value: p.v, units: p.u, days_cover: dailyOut > 0 ? Math.round(p.v / dailyOut) : null };
  }

  // Contas a receber dos pedidos: em aberto, vencido e prazo médio real de recebimento (pedidos recebidos no período).
  function receivables(from, to, today = T.localDate()) {
    const open = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) v, COALESCE(SUM(CASE WHEN due_date < ? THEN amount_cents END), 0) late,
      COUNT(CASE WHEN due_date < ? THEN 1 END) late_n FROM fin_entries WHERE order_id IS NOT NULL AND paid_date IS NULL`).get(today, today);
    const paid = db.prepare(`SELECT AVG(julianday(paid_date) - julianday(competence_date)) d, COUNT(*) n FROM fin_entries
      WHERE order_id IS NOT NULL AND paid_date BETWEEN ? AND ?`).get(from, to);
    return { open: open.v, late: open.late, late_count: open.late_n, avg_days: paid.n ? Math.round(paid.d) : null, paid_count: paid.n };
  }

  // Curva ABC: A até 80% do total, B até 95%, C o resto.
  function abc(rows, key) {
    const total = rows.reduce((s, r) => s + Math.max(0, r[key]), 0);
    let acc = 0;
    return rows.slice().sort((a, b) => b[key] - a[key]).map((r) => {
      acc += Math.max(0, r[key]);
      const share = div(Math.max(0, r[key]), total);
      const cum = div(acc, total);
      return { ...r, share, cum, cls: cum === null ? 'C' : cum - (share || 0) < 0.8 ? 'A' : cum - (share || 0) < 0.95 ? 'B' : 'C' };
    });
  }

  function groupSales(sales, keyFn, labelFn) {
    const map = new Map();
    for (const m of sales) {
      const k = keyFn(m);
      const g = map.get(k) || { key: k, label: labelFn(m), units: 0, revenue: 0, cmv: 0, orders: new Set() };
      g.units -= m.quantity;
      g.revenue += m.revenue_cents ?? 0;
      g.cmv -= m.value_cents ?? 0;
      if (m.order_id) g.orders.add(m.order_id);
      map.set(k, g);
    }
    return [...map.values()].filter((g) => g.revenue !== 0 || g.units !== 0)
      .map(({ orders, ...g }) => ({ ...g, orders: orders.size, margin: g.revenue - g.cmv, margin_pct: div(g.revenue - g.cmv, g.revenue) }));
  }

  // Período anterior do mesmo tamanho (para comparar).
  function previous(from, to) {
    const days = daysBetween(from, to);
    // mês cheio → mês anterior cheio
    if (from.slice(8) === '01' && to === T.monthBounds(to.slice(0, 7))[1] && from.slice(0, 7) === to.slice(0, 7)) {
      const ym = addMonths(from, -1).slice(0, 7);
      return T.monthBounds(ym);
    }
    return [T.addDays(from, -days), T.addDays(from, -1)];
  }

  function overview(from, to) {
    const cur = metrics(from, to);
    const [pf, pt] = previous(from, to);
    const prev = metrics(pf, pt);
    const sales = reports.periodMovements(from, to).filter((m) => m.eff_type === 'saida_pedido');
    const products = abc(groupSales(sales, (m) => m.product_id, (m) => m.product_name), 'margin');
    const customers = abc(groupSales(sales, (m) => m.customer_id || 0, (m) => m.nome_fantasia || m.razao_social || 'Sem cliente'), 'revenue');
    const lines = groupSales(sales, (m) => `${m.product_type}|${m.category}`, (m) => (m.product_type && m.product_type !== m.category ? `${m.product_type} › ${m.category}` : m.category))
      .sort((a, b) => b.margin - a.margin);
    const types = groupSales(sales, (m) => m.product_type || 'Outros', (m) => m.product_type || 'Outros').sort((a, b) => b.revenue - a.revenue);

    // evolução: últimos 6 meses até o mês de `to`
    const months = [];
    for (let k = 5; k >= 0; k -= 1) {
      const ym = addMonths(`${to.slice(0, 7)}-01`, -k).slice(0, 7);
      const [a, b] = T.monthBounds(ym);
      months.push({ month: ym, ...metrics(a, b > T.localDate() ? T.localDate() : b) });
    }
    const m = cur;
    const warnings = [];
    if (m.uncosted) warnings.push('Há vendas de produtos sem custo no período: o CMV e a margem ficam maiores do que o real.');
    warnings.push('Só as vendas B2B entram nestes números. As vendas do balcão das lojas entram quando o CPlug estiver integrado.');
    return {
      from, to, prev_from: pf, prev_to: pt, current: cur, previous: prev,
      stock: stock(cur), receivables: receivables(from, to),
      products, customers, lines, types, months, warnings,
    };
  }

  return { overview, metrics, abc };
}

module.exports = { createAnalytics };

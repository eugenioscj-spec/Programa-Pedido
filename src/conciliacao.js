'use strict';

// Conferência diária por loja: CPlug (o que o caixa registrou) × Rede (o que a maquininha vendeu) × Itaú (o que caiu).
// Regra combinada com o dono (18/11/2026): valor EXATO (diferença zero). Só compara: não lança nada.
//   Cartão:   crédito CPlug = crédito Rede (bruto aprovado); débito CPlug = débito Rede.
//   Pix:      Pix CPlug = "PIX QR CODE RECEBIDO" no Itaú da loja, no mesmo dia.
//   Depósito: no dia útil seguinte cai no Itaú o líquido do débito e do crédito ANTECIPADO
//             (linhas "RECEBIMENTO REDE <BANDEIRA> DB|AT<PV>"); crédito sem antecipação (CD) cai em ~30 dias.
// Dia útil = segunda a sexta (feriados ainda não contam).

const T = require('./time');
const { nextBusinessDay } = require('./receivables');
const { parseAccount } = require('./itau');

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function bucket(method) {
  const m = fold(method);
  if (/credito/.test(m)) return 'credito';
  if (/debito/.test(m)) return 'debito';
  if (/pix/.test(m)) return 'pix';
  if (/dinheiro|especie/.test(m)) return 'dinheiro';
  return 'outros';
}
const digits = (x) => String(x || '').replace(/\D/g, '').replace(/^0+/, '');
const REDE_LINE = /RECEBIMENTO REDE\s+(\S+)\s+(DB|AT|CD)0*(\d{6,})/i;
const PIX_LINE = /PIX QR CODE RECEBIDO/i;

function createConciliacao(db) {
  function stores() {
    const locs = db.prepare("SELECT * FROM locations WHERE kind = 'loja' AND active = 1 ORDER BY name").all();
    let contas = {};
    try { contas = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'conc_itau_contas'").get()?.value || '{}'); } catch { contas = {}; }
    const banks = db.prepare("SELECT id, name, account_number FROM bank_accounts WHERE bank_code = '341' AND kind = 'corrente'").all();
    return locs.map((l) => {
      const cplug = db.prepare("SELECT id FROM int_stores WHERE source = 'cplug' AND location_id = ?").get(l.id);
      const pvs = db.prepare("SELECT external_id FROM int_stores WHERE source = 'rede' AND location_id = ?").all(l.id).map((r) => r.external_id);
      // conta do Itaú: a da ficha da loja (Lojas → cadastro); se não tiver, a configuração antiga
      const acc = l.itau_account ? parseAccount(l.itau_account) : null;
      const want = acc ? digits(`${acc.number}${acc.digit}`) : digits(contas[l.name]);
      const bankAcc = want ? banks.find((b) => digits(b.account_number).endsWith(want)) : null;
      return { location_id: l.id, name: l.name, cplug_store_id: cplug ? cplug.id : null, pvs, bank_account: bankAcc || null, bank_account_hint: acc ? acc.label : (contas[l.name] || null) };
    });
  }

  // Itaú: o extrato cobre o dia? (algum OFX/busca com período que inclui a data)
  const covered = (accId, date) => !!db.prepare('SELECT 1 FROM bank_imports WHERE bank_account_id = ? AND period_start <= ? AND period_end >= ?').get(accId, date, date);

  function day(store, date) {
    const out = { date };
    // CPlug
    if (store.cplug_store_id && db.prepare('SELECT 1 FROM cplug_daily_totals WHERE store_id = ? AND date = ?').get(store.cplug_store_id, date)) {
      const c = { credito: 0, debito: 0, pix: 0, dinheiro: 0, outros: 0 };
      for (const p of db.prepare('SELECT method, value_cents FROM cplug_daily_payments WHERE store_id = ? AND date = ?').all(store.cplug_store_id, date)) c[bucket(p.method)] += p.value_cents;
      out.cplug = c;
    }
    // Rede
    if (store.pvs.length) {
      const ph = store.pvs.map(() => '?').join(',');
      const fetched = db.prepare(`SELECT COUNT(*) n FROM rede_days WHERE date = ? AND pv IN (${ph})`).get(date, ...store.pvs).n;
      if (fetched) {
        const rows = db.prepare(`SELECT * FROM rede_sales WHERE date = ? AND pv IN (${ph})`).all(date, ...store.pvs);
        const r = { credito: 0, debito: 0, outros: 0, fee: 0, other: 0, net: 0, count: 0, cancelled_count: 0, cancelled: 0, deposit_d1: 0, credit_later: 0 };
        for (const s of rows) {
          if (s.cancelled) { r.cancelled_count += 1; r.cancelled += s.gross_cents; continue; }
          r.count += 1;
          if (s.modality === 'CREDIT') r.credito += s.gross_cents; else if (s.modality === 'DEBIT') r.debito += s.gross_cents; else r.outros += s.gross_cents;
          r.fee += s.fee_cents; r.other += s.other_cents; r.net += s.net_cents;
          // cai no dia útil seguinte: débito e crédito antecipado (com desconto além da taxa)
          if (s.modality === 'DEBIT' || (s.modality === 'CREDIT' && s.other_cents > 0)) r.deposit_d1 += s.net_cents; else if (s.modality === 'CREDIT') r.credit_later += s.net_cents;
        }
        out.rede = r;
      }
    }
    // Itaú (Pix do dia)
    if (store.bank_account && covered(store.bank_account.id, date)) {
      const txs = db.prepare('SELECT description, amount_cents FROM bank_transactions WHERE bank_account_id = ? AND posted_date = ?').all(store.bank_account.id, date);
      out.itau = { pix: txs.filter((t) => PIX_LINE.test(t.description) && t.amount_cents > 0).reduce((a, t) => a + t.amount_cents, 0) };
    }
    // Comparações (valor exato)
    const cmp = (a, b) => (a === undefined || b === undefined ? null : { a, b, diff: a - b, ok: a === b });
    out.check = {
      credito: out.cplug && out.rede ? cmp(out.cplug.credito, out.rede.credito) : null,
      debito: out.cplug && out.rede ? cmp(out.cplug.debito, out.rede.debito) : null,
      pix: out.cplug && out.itau ? cmp(out.cplug.pix, out.itau.pix) : null,
    };
    out.deposit_date = out.rede ? nextBusinessDay(date) : null;
    return out;
  }

  // Depósitos da Rede no Itaú, por dia de depósito: previsto (vendas que caem naquele dia) × recebido.
  function deposits(store, from, to, days) {
    if (!store.bank_account || !store.pvs.length) return [];
    const byDate = new Map();
    for (const d of days) {
      if (!d.rede || !d.deposit_date) continue;
      const x = byDate.get(d.deposit_date) || { date: d.deposit_date, expected: 0, sale_days: [] };
      x.expected += d.rede.deposit_d1;
      x.sale_days.push(d.date);
      byDate.set(d.deposit_date, x);
    }
    const pvSet = new Set(store.pvs.map(digits));
    const out = [];
    for (const x of [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))) {
      if (!covered(store.bank_account.id, x.date)) { out.push({ ...x, received: null, lines: [], ok: null }); continue; }
      const lines = db.prepare('SELECT description, amount_cents FROM bank_transactions WHERE bank_account_id = ? AND posted_date = ?').all(store.bank_account.id, x.date)
        .map((t) => ({ ...t, m: String(t.description).match(REDE_LINE) }))
        .filter((t) => t.m && pvSet.has(digits(t.m[3])))
        .map((t) => ({ brand: t.m[1].toUpperCase(), type: t.m[2].toUpperCase(), amount_cents: t.amount_cents }));
      const received = lines.filter((l) => l.type !== 'CD').reduce((a, l) => a + l.amount_cents, 0);
      // o primeiro dia do período pode receber vendas de antes do período: não dá para afirmar diferença
      const partial = nextBusinessDay(T.addDays(from, -1)) === x.date; // junta vendas de dias antes do período
      out.push({ ...x, received, lines, credit_cd: lines.filter((l) => l.type === 'CD').reduce((a, l) => a + l.amount_cents, 0), ok: partial ? null : received === x.expected, partial });
    }
    return out;
  }

  function report({ from, to, locationId } = {}) {
    if (!T.isDate(String(from || '')) || !T.isDate(String(to || ''))) throw new Error('Período inválido.');
    const list = [];
    for (let d = from; d <= to; d = T.addDays(d, 1)) list.push(d);
    return stores().filter((s) => !locationId || s.location_id === Number(locationId)).map((s) => {
      const days = list.map((d) => day(s, d));
      const deps = deposits(s, from, to, days);
      const depByDate = Object.fromEntries(deps.map((x) => [x.date, x]));
      for (const d of days) if (d.deposit_date && depByDate[d.deposit_date]) d.deposit = { date: d.deposit_date, ok: depByDate[d.deposit_date].ok };
      const all = days.flatMap((d) => Object.values(d.check).filter(Boolean)).concat(deps.filter((x) => x.ok !== null).map((x) => ({ ok: x.ok })));
      return {
        location_id: s.location_id, name: s.name, pvs: s.pvs, bank_account: s.bank_account ? s.bank_account.name : null, bank_account_hint: s.bank_account_hint,
        has_cplug: !!s.cplug_store_id, days, deposits: deps,
        summary: { checks: all.length, ok: all.filter((c) => c.ok).length, diff: all.filter((c) => !c.ok).length },
      };
    });
  }

  return { report, stores, bucket };
}

module.exports = { createConciliacao, bucket, REDE_LINE };

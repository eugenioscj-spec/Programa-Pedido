'use strict';

// Financeiro v1 (só master): plano de contas, lançamentos, DRE gerencial e DFC (método direto).
//
// DRE — regime de COMPETÊNCIA (data de competência do lançamento; estoque pela data do movimento):
//   linhas automáticas vêm do estoque (venda B2B e CMV na separação, perdas, brindes, transferências a custo);
//   o resto vem dos lançamentos, conforme a "linha da DRE" de cada conta.
// DFC — regime de CAIXA (data em que foi pago/recebido): só lançamentos com data de pagamento.

const T = require('./time');

const DRE_GROUPS = {
  receita_bruta: 'Receita bruta',
  deducoes: 'Deduções da receita',
  despesas_pessoal: 'Despesas com pessoal',
  despesas_ocupacao: 'Despesas de ocupação',
  despesas_comerciais: 'Despesas comerciais',
  despesas_administrativas: 'Despesas administrativas',
  receitas_financeiras: 'Receitas financeiras',
  despesas_financeiras: 'Despesas financeiras',
  outras_receitas: 'Outras receitas',
  outras_despesas: 'Outras despesas',
  impostos_lucro: 'IR / CSLL',
};
const DFC_ACTIVITIES = { operacional: 'Atividades operacionais', investimento: 'Atividades de investimento', financiamento: 'Atividades de financiamento' };

function monthsBetween(from, to) {
  const out = [];
  let ym = from.slice(0, 7);
  while (ym <= to.slice(0, 7)) {
    out.push(ym);
    const [y, m] = ym.split('-').map(Number);
    ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return out;
}
const monthLabel = (ym) => `${ym.slice(5)}/${ym.slice(0, 4)}`;

function createFinance(db, reports) {
  // Soma por mês: { 'YYYY-MM': cents }
  const add = (obj, month, v) => { obj[month] = (obj[month] || 0) + v; };
  const sum = (obj) => Object.values(obj).reduce((s, v) => s + v, 0);

  function stockLines(from, to) {
    const lines = { revenue: {}, cmv: {}, transfers: {}, losses: {}, nonsale: {} };
    let uncosted = false;
    for (const m of reports.periodMovements(from, to)) {
      if (m.value_cents === null && m.quantity !== 0 && m.eff_type !== 'entrada') uncosted = true;
      const v = m.value_cents ?? 0; // valores do kardex: saídas são negativas
      switch (m.eff_type) {
        case 'saida_pedido': add(lines.revenue, m.month, m.revenue_cents ?? 0); add(lines.cmv, m.month, v); break;
        case 'transferencia': add(lines.transfers, m.month, v); break;
        case 'perda': case 'divergencia_inventario': case 'sobra_inventario': add(lines.losses, m.month, v); break;
        case 'saida_sem_venda': add(lines.nonsale, m.month, v); break;
        default: break;
      }
    }
    return { lines, uncosted };
  }

  // Lançamentos agrupados por linha da DRE e mês de competência. Receita positiva, despesa negativa.
  function entryLines(from, to) {
    const rows = db.prepare(`
      SELECT e.amount_cents, substr(e.competence_date, 1, 7) AS month, a.kind, a.dre_group, a.name AS account
      FROM fin_entries e JOIN fin_accounts a ON a.id = e.account_id
      WHERE e.competence_date >= ? AND e.competence_date <= ? AND a.dre_group IS NOT NULL`).all(from, to);
    const groups = {};
    for (const r of rows) {
      const g = groups[r.dre_group] || (groups[r.dre_group] = { total: {}, accounts: {} });
      const v = r.kind === 'receita' ? r.amount_cents : -r.amount_cents;
      add(g.total, r.month, v);
      add(g.accounts[r.account] || (g.accounts[r.account] = {}), r.month, v);
    }
    return groups;
  }

  function dre(from, to) {
    const months = monthsBetween(from, to);
    const { lines, uncosted } = stockLines(from, to);
    const groups = entryLines(from, to);
    const g = (k) => groups[k] || { total: {}, accounts: {} };
    const rows = [];
    const row = (label, values, opts = {}) => {
      const r = { line: label, _class: opts.cls };
      for (const m of months) r[m] = values[m] || 0;
      r.total = sum(values);
      rows.push(r);
      return values;
    };
    const combine = (...objs) => {
      const out = {};
      for (const o of objs) for (const [k, v] of Object.entries(o)) add(out, k, v);
      return out;
    };
    const accountRows = (key) => {
      for (const [name, vals] of Object.entries(g(key).accounts)) row(`   ${name}`, vals, { cls: 'sub' });
    };

    const receitaBruta = combine(lines.revenue, g('receita_bruta').total);
    row('Receita bruta', receitaBruta, { cls: 'strong' });
    row('   Vendas B2B (portal)', lines.revenue, { cls: 'sub' });
    accountRows('receita_bruta');
    row('(−) Deduções (impostos e devoluções)', g('deducoes').total);
    accountRows('deducoes');
    const receitaLiquida = row('= Receita líquida', combine(receitaBruta, g('deducoes').total), { cls: 'total' });

    const custos = combine(lines.cmv, lines.transfers, lines.losses);
    row('(−) Custo das mercadorias', custos);
    row('   CMV das vendas B2B (custo médio)', lines.cmv, { cls: 'sub' });
    row('   Mercadoria enviada às lojas (a custo)', lines.transfers, { cls: 'sub' });
    row('   Perdas e ajustes de inventário', lines.losses, { cls: 'sub' });
    const lucroBruto = row('= Lucro bruto', combine(receitaLiquida, custos), { cls: 'total' });

    const despOper = combine(lines.nonsale, g('despesas_pessoal').total, g('despesas_ocupacao').total,
      g('despesas_comerciais').total, g('despesas_administrativas').total);
    row('(−) Despesas operacionais', despOper);
    row('   Brindes, parcerias e bonificações (a custo)', lines.nonsale, { cls: 'sub' });
    for (const k of ['despesas_pessoal', 'despesas_ocupacao', 'despesas_comerciais', 'despesas_administrativas']) {
      row(`   ${DRE_GROUPS[k]}`, g(k).total, { cls: 'sub' });
    }
    const operacional = row('= Resultado operacional', combine(lucroBruto, despOper), { cls: 'total' });

    const financeiro = combine(g('receitas_financeiras').total, g('despesas_financeiras').total, g('outras_receitas').total, g('outras_despesas').total);
    row('(±) Resultado financeiro e outros', financeiro);
    const antesIr = row('= Resultado antes do IR/CSLL', combine(operacional, financeiro), { cls: 'total' });
    row('(−) IR / CSLL', g('impostos_lucro').total);
    const liquido = row('= Resultado líquido', combine(antesIr, g('impostos_lucro').total), { cls: 'total strong' });

    // margens em % da receita líquida
    const pctRow = { line: 'Margem líquida', _class: 'sub' };
    for (const m of [...months, 'total']) {
      const rl = m === 'total' ? sum(receitaLiquida) : receitaLiquida[m] || 0;
      const ll = m === 'total' ? sum(liquido) : liquido[m] || 0;
      pctRow[m] = rl ? ll / rl : null;
    }

    const warnings = [];
    if (uncosted) warnings.push('Há movimentações de produtos sem custo no período: o custo delas entra como zero. Informe o custo inicial em Estoque.');
    warnings.push('“Mercadoria enviada às lojas” é a aproximação do CMV das lojas enquanto as vendas do balcão não vêm do PDV. Lance as vendas das lojas em Financeiro (contas “Vendas Loja…”).');

    const columns = [{ key: 'line', label: '', type: 'text' }, ...months.map((m) => ({ key: m, label: monthLabel(m), type: 'money' })),
      { key: 'total', label: 'Total', type: 'money' }];
    return {
      title: 'DRE gerencial',
      subtitle: `${from} a ${to}. Regime de competência. Valores negativos reduzem o resultado.`,
      warnings,
      sections: [
        { title: 'Demonstração do resultado', columns, rows },
        { title: 'Indicadores', columns: [{ key: 'line', label: '', type: 'text' }, ...months.map((m) => ({ key: m, label: monthLabel(m), type: 'pct' })), { key: 'total', label: 'Total', type: 'pct' }], rows: [pctRow] },
      ],
      result: { receita_liquida: sum(receitaLiquida), lucro_bruto: sum(lucroBruto), resultado_liquido: sum(liquido) },
    };
  }

  function dfc(from, to) {
    const months = monthsBetween(from, to);
    const opening = Number(db.prepare("SELECT value FROM settings WHERE key = 'cash_opening_cents'").get()?.value) || 0;
    const before = db.prepare(`SELECT COALESCE(SUM(CASE a.kind WHEN 'receita' THEN e.amount_cents ELSE -e.amount_cents END), 0) AS v
      FROM fin_entries e JOIN fin_accounts a ON a.id = e.account_id WHERE e.paid_date IS NOT NULL AND e.paid_date < ?`).get(from).v;
    const entries = db.prepare(`
      SELECT e.amount_cents, substr(e.paid_date, 1, 7) AS month, a.kind, a.dfc_activity, a.name AS account
      FROM fin_entries e JOIN fin_accounts a ON a.id = e.account_id
      WHERE e.paid_date IS NOT NULL AND e.paid_date >= ? AND e.paid_date <= ?`).all(from, to);

    const rows = [];
    const row = (label, values, cls) => {
      const r = { line: label, _class: cls };
      for (const m of months) r[m] = values[m] || 0;
      r.total = sum(values);
      rows.push(r);
    };
    let balance = opening + before;
    const initial = {};
    const variation = {};
    for (const act of Object.keys(DFC_ACTIVITIES)) {
      const acc = {};
      const net = {};
      for (const e of entries.filter((x) => (x.dfc_activity || 'operacional') === act)) {
        const v = e.kind === 'receita' ? e.amount_cents : -e.amount_cents;
        add(acc[e.account] || (acc[e.account] = {}), e.month, v);
        add(net, e.month, v);
        add(variation, e.month, v);
      }
      row(DFC_ACTIVITIES[act], {}, 'strong');
      for (const [name, vals] of Object.entries(acc)) row(`   ${name}`, vals, 'sub');
      row(`= Caixa líquido — ${DFC_ACTIVITIES[act].replace('Atividades de ', '').replace('Atividades ', '')}`, net, 'total');
    }
    row('= Variação do caixa', variation, 'total strong');
    // saldo inicial/final mês a mês
    const ini = { line: 'Saldo inicial de caixa', _class: 'strong' };
    const fin = { line: 'Saldo final de caixa', _class: 'total strong' };
    for (const m of months) {
      ini[m] = balance;
      initial[m] = balance;
      balance += variation[m] || 0;
      fin[m] = balance;
    }
    ini.total = initial[months[0]] ?? opening + before;
    fin.total = balance;
    rows.unshift(ini);
    rows.push(fin);
    const columns = [{ key: 'line', label: '', type: 'text' }, ...months.map((m) => ({ key: m, label: monthLabel(m), type: 'money' })),
      { key: 'total', label: 'Total', type: 'money' }];
    return {
      title: 'DFC — fluxo de caixa (método direto)',
      subtitle: `${from} a ${to}. Regime de caixa: só lançamentos com data de pagamento/recebimento.`,
      warnings: [
        'Recebimentos de clientes B2B e pagamentos de notas de mercadoria entram aqui só quando lançados em Financeiro. Contas a receber automáticas dos pedidos ficam para a Fase 2.',
        ...(opening ? [] : ['Informe o saldo de caixa inicial em Financeiro → Plano de contas para o saldo ficar correto.']),
      ],
      sections: [{ title: 'Fluxo de caixa', columns, rows }],
      result: { saldo_inicial: ini.total, variacao: sum(variation), saldo_final: balance },
    };
  }

  return { dre, dfc };
}

module.exports = { createFinance, DRE_GROUPS, DFC_ACTIVITIES, monthsBetween };

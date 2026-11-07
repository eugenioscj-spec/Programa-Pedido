'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createReports } = require('../src/reports');
const { createFinance } = require('../src/finance');
const { createAnalytics } = require('../src/analytics');
const { seedTestData } = require('../src/test-data');
const T = require('../src/time');

test('análises: batem com o relatório de vendas; curva ABC; comparação com o período anterior', () => {
  const db = openDatabase(':memory:');
  seedTestData(db, { log: () => {} });
  const reports = createReports(db);
  const an = createAnalytics(db, reports);
  const to = T.localDate();
  const from = T.addDays(to, -59);
  const o = an.overview(from, to);
  const sales = reports.sales(from, to).total;
  assert.equal(o.current.revenue, sales.revenue);
  assert.equal(o.current.cmv, sales.cost);
  assert.equal(o.current.margin, sales.margin);
  assert.ok(o.current.orders > 0 && o.current.buyers > 0);
  assert.equal(o.current.ticket, Math.round(o.current.revenue / o.current.orders));
  assert.equal(o.current.losses, reports.losses(from, to).sections[0].total.cost);
  assert.deepEqual([o.prev_from, o.prev_to], [T.addDays(from, -60), T.addDays(from, -1)]);

  // ABC: soma das participações = 100%; A vem antes de B, que vem antes de C
  const shares = o.products.reduce((s, r) => s + (r.share || 0), 0);
  assert.ok(Math.abs(shares - 1) < 1e-9);
  const order = o.products.map((r) => r.cls).join('');
  assert.match(order, /^A+B*C*$/);
  assert.equal(o.customers.reduce((s, r) => s + r.revenue, 0), o.current.revenue);
  assert.equal(o.types.reduce((s, r) => s + r.revenue, 0), o.current.revenue);
  assert.equal(o.months.length, 6);
  assert.ok(o.stock.value > 0);

  // mês cheio compara com o mês anterior cheio
  const full = an.overview('2026-10-01', '2026-10-31');
  assert.deepEqual([full.prev_from, full.prev_to], ['2026-09-01', '2026-09-30']);
});

test('DRE: análise vertical em % da receita líquida', () => {
  const db = openDatabase(':memory:');
  seedTestData(db, { log: () => {} });
  const reports = createReports(db);
  const to = T.localDate();
  const dre = createFinance(db, reports).dre(T.addDays(to, -59), to);
  const av = dre.sections.find((s) => /Análise vertical/.test(s.title));
  const rl = av.rows.find((r) => r.line === '= Receita líquida');
  assert.equal(rl.total, 1);
  const lucro = av.rows.find((r) => r.line === '= Lucro bruto');
  assert.ok(Math.abs(lucro.total - dre.result.lucro_bruto / dre.result.receita_liquida) < 1e-9);
  assert.ok(av.rows.every((r) => !r.line.startsWith(' ')), 'só linhas principais');
});

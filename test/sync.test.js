'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { loadOggiCatalog } = require('../src/catalog');
const { createSync, rank } = require('../src/sync');

const ENV = { CPLUG_EMPRESA: '1', CPLUG_USUARIO: 'robo', CPLUG_SENHA: 'x' };
const day = (date, extra = 0) => ({
  date,
  stores: [
    { id: 1, name: 'MT SINOP SETOR COMERCIAL', cnpj: '63.532.954/0001-65', errors: [],
      products: { items: [{ code: '543', name: 'SENSA BRIGADEIRO', quantity: 2, value_cents: 1198 }, { code: '2', name: 'DELICIA ABACAXI AO VINHO 60G', quantity: 5 + extra, value_cents: 1375 + extra * 275 }], other_cents: 0, total_cents: 2573 + extra * 275 },
      payments: { methods: [{ method: 'Dinheiro', value_cents: 1000 }, { method: 'PIX', value_cents: 1573 + extra * 275 }], total_cents: 2573 + extra * 275 } },
    { id: 2, name: 'MT SINOP RESIDENCIAL BURITIS', cnpj: '63.532.954/0002-46', errors: ['Não achei a tabela de vendas por forma de pagamento.'],
      products: { items: [{ code: '2', name: '2 LITROS NAPOLITANO', quantity: 1, value_cents: 2399 }], other_cents: -100, total_cents: 2299 }, payments: null },
  ],
});

function setup(fetchDay) {
  const db = openDatabase(':memory:');
  loadOggiCatalog(db, { withImages: false });
  return { db, sync: createSync(db, { fetchDay, env: ENV, log: () => {} }) };
}

test('rotina: guarda o retrato do dia por loja, refaz sem duplicar e monta o de-para', async () => {
  let calls = 0;
  const { db, sync } = setup(async ({ date }) => { calls += 1; return day(date, calls - 1); });
  const r1 = await sync.run(['2026-11-13'], 'manual');
  assert.equal(r1.status, 'parcial', 'Buritis sem formas de pagamento');
  assert.match(r1.message, /BURITIS 2026-11-13/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM int_stores').get().n, 2);
  // segunda busca do mesmo dia (vendas aumentaram): substitui, não soma
  await sync.run(['2026-11-13'], 'hoje');
  const t = db.prepare("SELECT t.* FROM cplug_daily_totals t JOIN int_stores s ON s.id = t.store_id WHERE s.external_id = '1'").get();
  assert.equal(t.products_cents, 2573 + 275);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cplug_daily_products').get().n, 3);
  assert.equal(db.prepare("SELECT value_cents FROM cplug_daily_payments WHERE method = 'PIX'").get().value_cents, 1573 + 275);
  // de-para: nome igual = ligado; ambíguo = sugestão
  const dp = Object.fromEntries(db.prepare('SELECT c.name, c.status, p.name AS product FROM cplug_products c LEFT JOIN products p ON p.id = c.product_id').all().map((r) => [r.name, [r.status, r.product]]));
  assert.deepEqual(dp['SENSA BRIGADEIRO'], ['confirmado', 'Picolé Sensa Brigadeiro']);
  assert.deepEqual(dp['DELICIA ABACAXI AO VINHO 60G'], ['confirmado', 'Picolé Delícia Abacaxi ao Vinho']);
  assert.deepEqual(dp['2 LITROS NAPOLITANO'], ['sugerido', 'Pote Tradicionais Napolitano']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_runs').get().n, 2);
});

test('rotina: erro do CPlug fica registrado e não derruba nada', async () => {
  const { db, sync } = setup(async () => { throw new Error('O CPlug recusou o login.'); });
  const r = await sync.run(['2026-11-13'], 'hoje');
  assert.equal(r.status, 'erro');
  assert.match(r.message, /recusou o login/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cplug_daily_totals').get().n, 0);
});

test('agenda: hora em hora a partir das 8h; fechamento de ontem e anteontem a partir das 3h; desligável', async () => {
  const { db, sync } = setup(async ({ date }) => day(date));
  const at = (iso) => new Date(iso); // UTC; Cuiabá = UTC−4
  assert.equal(sync.due(at('2026-11-14T05:00:00Z')), null, '1h em Cuiabá: nada');
  assert.deepEqual(sync.due(at('2026-11-14T07:30:00Z')), { kind: 'fechamento', dates: ['2026-11-12', '2026-11-13'] }, '3h30');
  await sync.run(['2026-11-12', '2026-11-13'], 'fechamento');
  assert.equal(sync.due(at('2026-11-14T08:00:00Z')), null, 'fechamento feito; antes das 8h nada');
  assert.deepEqual(sync.due(at('2026-11-14T12:10:00Z')), { kind: 'hoje', dates: ['2026-11-14'] }, '8h10: hoje');
  await sync.run(['2026-11-14'], 'hoje');
  assert.equal(sync.due(new Date()), null, 'acabou de buscar: espera 1 hora');
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'cplug_auto'").run();
  db.prepare("UPDATE sync_runs SET started_at = '2000-01-01 00:00:00'").run();
  assert.equal(sync.due(at('2026-11-14T15:00:00Z')), null, 'rotina desligada');
});

test('de-para: tamanhos e linha Zero', () => {
  const products = [
    { id: 1, name: 'Açaí 200g Guaraná', product_type: 'Açaí' }, { id: 2, name: 'Açaí 1,5L Guaraná', product_type: 'Açaí' },
    { id: 3, name: 'Pote Tradicionais Napolitano', product_type: 'Potes' }, { id: 4, name: 'Pote Zero Napolitano', product_type: 'Potes' },
  ];
  assert.equal(rank('1,5 LITROS AÇAI COM GUARANÁ', products)[0].product.id, 2);
  assert.equal(rank('AÇAI COM GUARANA 200G', products)[0].product.id, 1);
  assert.equal(rank('1,5 LITROS NAPOLITANO ZERO AÇUCAR', products)[0].product.id, 4);
  assert.equal(rank('2 LITROS NAPOLITANO', products)[0].product.id, 3);
});

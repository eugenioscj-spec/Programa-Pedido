'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const holidays = require('../src/holidays');
const { nextBusinessDay } = require('../src/receivables');

function server() {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO admins (email, name, password_hash, role) VALUES ('m@x.com', 'Dono', ?, 'master')").run(hashPassword('senha-123456'));
  const app = createApp(db);
  return new Promise((resolve) => { const s = app.listen(0, () => resolve({ db, s, base: `http://127.0.0.1:${s.address().port}` })); });
}
function client(base) {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('feriados: nacionais, bancários pela Páscoa e extras; dia útil pula feriado', () => {
  assert.equal(holidays.easter(2026), '2026-04-05');
  assert.equal(holidays.holidayName('2026-02-16'), 'Carnaval (segunda)');
  assert.equal(holidays.holidayName('2026-06-04'), 'Corpus Christi');
  assert.equal(nextBusinessDay('2026-11-19'), '2026-11-23', '20/11 (Consciência Negra) cai numa sexta');
  assert.equal(nextBusinessDay('2026-12-24'), '2026-12-28');
  holidays.setExtras([{ date: '09-14', name: 'Aniversário de Sinop' }]);
  assert.equal(nextBusinessDay('2026-09-11'), '2026-09-15');
  holidays.setExtras([]);
});

test('cadastro de lojas, registro de alterações e painel executivo pela API', async (t) => {
  const { db, s, base } = await server();
  t.after(() => s.close());
  const api = client(base);
  assert.equal((await api('POST', '/api/admin/login', { email: 'm@x.com', senha: 'senha-123456' })).status, 200);

  let r = await api('GET', '/api/admin/lojas/cadastro');
  const loja2 = r.data.stores.find((x) => x.name === 'Loja 2');
  assert.equal(loja2.itau_account, '4776/99822-3');
  assert.deepEqual(loja2.pvs, ['107531038']);
  assert.ok(loja2.missing.includes('aluguel'));

  r = await api('PUT', `/api/admin/lojas/cadastro/${loja2.id}`, { opened_at: '2025-03-01', area_m2: '42,5', rent_cents: '4.500,00', capex_cents: '350000', royalty_pct: '6', marketing_pct: '2,5', status: 'ativa' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.store.rent_cents, r.data.store.capex_cents, r.data.store.royalty_bp, r.data.store.marketing_bp, r.data.store.area_m2], [450000, 35000000, 600, 250, 42.5]);

  r = await api('POST', '/api/admin/lojas/cadastro', { name: 'Loja 3 - Jardim', status: 'planejada', pvs: '107468247' });
  assert.equal(r.status, 400, 'PV já é da Loja 1');
  r = await api('POST', '/api/admin/lojas/cadastro', { name: 'Loja 3 - Jardim', status: 'planejada', pvs: '200000001' });
  assert.equal(r.status, 201);
  assert.ok(db.prepare("SELECT 1 FROM bank_accounts WHERE type = 'caixa' AND location_id = ?").get(r.data.store.id), 'nova loja ganha o caixa');

  r = await api('PUT', '/api/admin/feriados', { extras: [{ date: '09-14', name: 'Aniversário de Sinop' }] });
  assert.equal(r.status, 200);
  assert.equal((await api('PUT', '/api/admin/feriados', { extras: [{ date: '14/09' }] })).status, 400);

  r = await api('GET', '/api/admin/registro');
  const paths = r.data.rows.map((x) => `${x.method} ${x.path}`);
  assert.ok(paths.includes(`PUT /lojas/cadastro/${loja2.id}`));
  assert.ok(r.data.rows.every((x) => x.status < 400), 'por padrão só o que deu certo');
  assert.ok(!JSON.stringify(r.data).includes('senha-123456'), 'senha nunca vai para o registro');
  assert.equal(r.data.rows.find((x) => x.path === `/lojas/cadastro/${loja2.id}`).user_name, 'Dono');

  r = await api('GET', '/api/admin/executivo');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.stores.length >= 2);
  assert.ok(Array.isArray(r.data.alerts));
  assert.ok(r.data.alerts.some((a) => /sem loja do CPlug/.test(a.text)));
  assert.equal(r.data.chart.length, 12);
  holidays.setExtras([]);
});

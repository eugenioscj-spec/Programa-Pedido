'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { createInventory } = require('../src/inventory');
const { createCrm } = require('../src/crm');
const T = require('../src/time');

function client(base) {
  const jar = {};
  return async (method, p, body, raw = false) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar[k] = v; }
    if (raw) return { status: res.status, type: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

async function setup(t) {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const adm = client(base);
  await adm('POST', '/api/admin/setup', { name: 'Eugênio', email: 'eugenio.scj@gmail.com', senha: 'senha-forte-1' });
  const inv = createInventory(db);
  const p = Number(db.prepare("INSERT INTO products (name, category, units_per_box, unit_price_cents, box_price_cents) VALUES ('Picolé Teste', 'X', 10, 500, 5000)").run().lastInsertRowid);
  inv.receive({ lines: [{ product_id: p, units: 100, cost_cents: 200 }], document: 'NF', user: 'x' });
  const cli = client(base);
  await cli('POST', '/api/cliente/cadastro', { cnpj: '11.222.333/0001-81', razao_social: 'Bar do Zé LTDA', telefone: '66999990000', senha: 'abcdef' });
  const cid = db.prepare("SELECT id FROM customers WHERE cnpj = '11222333000181'").get().id;
  await adm('PUT', `/api/admin/clientes/${cid}`, { status: 'ativo' });
  return { db, adm, cli, base, inv, p, cid };
}

test('PDF do pedido: cliente baixa o dele; outro cliente não', async (t) => {
  const { adm, cli, base, p } = await setup(t);
  const order = (await cli('POST', '/api/pedidos', { items: [{ product_id: p, unit_type: 'caixa', quantity: 2 }], notes: 'Entregar de manhã, açaí' })).data.order;
  const pdf = await cli('GET', `/api/pedidos/${order.id}/pdf`, null, true);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await adm('GET', `/api/admin/pedidos/${order.id}/pdf`, null, true)).status, 200);
  const outro = client(base);
  await outro('POST', '/api/cliente/cadastro', { cnpj: '52998224725', razao_social: 'Maria', telefone: '1', senha: 'abcdef' });
  assert.notEqual((await outro('GET', `/api/pedidos/${order.id}/pdf`, null, true)).status, 200);
});

test('excluir pedido entregue desfaz estoque, conta a receber e conciliação; só com permissão', async (t) => {
  const { db, adm, cli, p } = await setup(t);
  const order = (await cli('POST', '/api/pedidos', { items: [{ product_id: p, unit_type: 'caixa', quantity: 3 }] })).data.order;
  for (const s of ['confirmado', 'separado', 'entregue']) await adm('POST', `/api/admin/pedidos/${order.id}/status`, { status: s });
  assert.equal(db.prepare('SELECT stock_units FROM products WHERE id = ?').get(p).stock_units, 70);
  const entry = db.prepare('SELECT * FROM fin_entries WHERE order_id = ?').get(order.id);
  assert.ok(entry, 'conta a receber criada');
  // conciliada com um movimento do banco
  db.exec("INSERT INTO bank_accounts (id, name, bank_code, account_number) VALUES (90, 'Itaú', '341', '1')");
  db.prepare("INSERT INTO bank_transactions (bank_account_id, dedupe_key, posted_date, amount_cents, description, status, entry_id, link_type) VALUES (90, 'k', ?, ?, 'PIX', 'conciliado', ?, 'baixado')")
    .run(T.localDate(), entry.amount_cents, entry.id);

  // master sem a permissão não exclui
  await adm('POST', '/api/admin/usuarios', { name: 'Outro', email: 'outro@x.com', senha: 'senha-forte-2', role: 'master' });
  const other = db.prepare("SELECT can_delete_orders FROM admins WHERE email = 'outro@x.com'").get();
  assert.equal(other.can_delete_orders, 0);
  assert.equal(db.prepare("SELECT can_delete_orders FROM admins WHERE email = 'eugenio.scj@gmail.com'").get().can_delete_orders, 0, 'banco novo: liberado ao iniciar o servidor');
  db.prepare("UPDATE admins SET can_delete_orders = 1 WHERE email = 'eugenio.scj@gmail.com'").run(); // o que o server.js faz ao iniciar

  assert.equal((await adm('DELETE', `/api/admin/pedidos/${order.id}`, {})).status, 400, 'motivo obrigatório');
  const r = await adm('DELETE', `/api/admin/pedidos/${order.id}`, { reason: 'Pedido em duplicidade' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.receivables_removed, r.data.bank_unlinked], [1, 1]);
  assert.equal(db.prepare('SELECT stock_units FROM products WHERE id = ?').get(p).stock_units, 100, 'estoque volta');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE order_id = ? AND type = 'estorno'").get(order.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fin_entries WHERE order_id = ?').get(order.id).n, 0);
  assert.deepEqual(db.prepare('SELECT status, entry_id FROM bank_transactions').get(), { status: 'pendente', entry_id: null });
  assert.equal((await adm('GET', '/api/admin/pedidos')).data.orders.length, 0, 'some da lista da loja');
  assert.equal((await cli('GET', '/api/pedidos')).data.orders.length, 0, 'e da do cliente');
  assert.equal((await adm('DELETE', `/api/admin/pedidos/${order.id}`, { reason: 'x' })).status, 404, 'não exclui duas vezes');

  // sem permissão
  db.prepare("UPDATE admins SET can_delete_orders = 0 WHERE email = 'eugenio.scj@gmail.com'").run();
  const o2 = (await cli('POST', '/api/pedidos', { items: [{ product_id: p, unit_type: 'unidade', quantity: 1 }] })).data.order;
  assert.equal((await adm('DELETE', `/api/admin/pedidos/${o2.id}`, { reason: 'x' })).status, 403);
});

test('CRM: registrar, próximas ações, clientes sem contato', () => {
  const db = openDatabase(':memory:');
  const crm = createCrm(db);
  const today = T.localDate();
  const c1 = Number(db.prepare("INSERT INTO customers (cnpj, razao_social, password_hash, status) VALUES ('11222333000181', 'Bar', 'x', 'ativo')").run().lastInsertRowid);
  const c2 = Number(db.prepare("INSERT INTO customers (cnpj, razao_social, password_hash, status) VALUES ('11444777000161', 'Mercado', 'x', 'ativo')").run().lastInsertRowid);
  const a = crm.create({ customer_id: c1, kind: 'visita', date: today, summary: 'Levei catálogo', next_action: 'Ligar', next_action_date: T.addDays(today, -1) }, 'Eu');
  crm.create({ prospect_name: 'Sorveteria Nova', kind: 'whatsapp', date: today, summary: 'Primeiro contato' }, 'Eu');
  assert.throws(() => crm.create({ kind: 'visita', summary: 'x' }, 'Eu'), /cliente ou informe/);
  assert.throws(() => crm.create({ customer_id: c1, summary: '' }, 'Eu'), /Descreva/);

  let s = crm.summary({ days: 30 });
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].overdue, true);
  assert.ok(s.quiet.some((c) => c.id === c2) && !s.quiet.some((c) => c.id === c1), 'quem teve contato sai da lista');
  assert.equal(s.month.total, 2);
  crm.update(a, { next_done: true });
  s = crm.summary();
  assert.equal(s.pending.length, 0);
  assert.equal(crm.list({ customerId: c1 }).length, 1);
  assert.equal(crm.list({ q: 'Nova' }).length, 1);
});

test('excluir pedido novo não mexe no estoque', () => {
  const db = openDatabase(':memory:');
  const inv = createInventory(db);
  const p = Number(db.prepare("INSERT INTO products (name, category, units_per_box, unit_price_cents, box_price_cents) VALUES ('P', 'X', 10, 500, 5000)").run().lastInsertRowid);
  inv.receive({ lines: [{ product_id: p, units: 10, cost_cents: 200 }], document: 'NF', user: 'x' });
  const c = Number(db.prepare("INSERT INTO customers (cnpj, razao_social, password_hash, status) VALUES ('11222333000181', 'Bar', 'x', 'ativo')").run().lastInsertRowid);
  const id = inv.createOrder({ customerId: c, items: [{ product_id: p, unit_type: 'unidade', quantity: 5 }] });
  assert.equal(inv.availableUnits(p), 5);
  inv.deleteOrder({ orderId: id, user: 'x', reason: 'teste' });
  assert.equal(inv.availableUnits(p), 10, 'reserva liberada');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 1);
});

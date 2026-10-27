'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase, SCHEMA_V1 } = require('../src/db');
const { createInventory } = require('../src/inventory');
const { LATEST_VERSION, LOJA2 } = require('../src/migrations');
const { seedTestData } = require('../src/test-data');

// As migrações até a 5 preservam os dados; a 6 é a limpeza para começar do zero (testada à parte).
const V5 = 5;

// Monta um banco exatamente no formato da versão 1, com dados de todos os tipos antigos.
function buildV1(file) {
  const db = new Database(file);
  db.exec(SCHEMA_V1);
  db.exec(`
    INSERT INTO products (id, name, units_per_box, unit_price_cents, box_price_cents, stock_units) VALUES
      (1, 'Picolé A', 24, 400, 9600, 30),
      (2, 'Pote B', 4, 2000, 8000, 0);
    INSERT INTO customers (id, cnpj, razao_social, password_hash, status) VALUES (1, '11222333000181', 'Cliente', 'x', 'ativo');
    INSERT INTO orders (id, customer_id, status, total_cents, stock_deducted) VALUES (1, 1, 'cancelado', 2000, 0);
    INSERT INTO order_items (order_id, product_id, product_name, unit_type, quantity, units_per_box, units_total, price_cents, subtotal_cents)
      VALUES (1, 1, 'Picolé A', 'unidade', 5, 24, 5, 400, 2000);
    INSERT INTO stock_movements (id, product_id, type, quantity, balance_after, order_id, document, note, created_by, created_at) VALUES
      (1, 1, 'entrada', 48, 48, NULL, 'NF 1', NULL, 'Dono', '2026-09-01 12:00:00'),
      (2, 1, 'saida_pedido', -5, 43, 1, 'Pedido #1', NULL, 'Dono', '2026-09-02 12:00:00'),
      (3, 1, 'estorno_pedido', 5, 48, 1, 'Pedido #1', 'Cancelamento', 'Dono', '2026-09-03 12:00:00'),
      (4, 1, 'perda', -2, 46, NULL, NULL, 'quebrou', 'Dono', '2026-09-04 12:00:00'),
      (5, 1, 'transferencia_loja', -10, 36, NULL, NULL, NULL, 'Dono', '2026-09-05 12:00:00'),
      (6, 1, 'saida_avulsa', -3, 33, NULL, NULL, 'amostra', 'Dono', '2026-09-06 12:00:00'),
      (7, 1, 'ajuste', 1, 34, NULL, NULL, 'Inventário', 'Dono', '2026-09-07 12:00:00'),
      (8, 1, 'ajuste', -4, 30, NULL, NULL, 'Inventário', 'Dono', '2026-09-08 12:00:00');
    INSERT INTO settings (key, value) VALUES ('store_name', 'Minha Loja');
  `);
  db.close();
}

test('migração: banco no formato antigo, com dados, migra sem perder nada', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oggi-mig-'));
  const file = path.join(dir, 'oggi.db');
  buildV1(file);

  const logs = [];
  const db = openDatabase(file, { log: (m) => logs.push(m), upTo: V5 });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get().value, String(V5));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'store_name'").get().value, 'Minha Loja');

  // cópia de segurança feita antes de migrar
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(backups.length, 1);
  const old = new Database(path.join(dir, 'backups', backups[0]), { readonly: true });
  assert.equal(old.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 8);
  old.close();

  // todos os lançamentos, com os mesmos ids, saldos e datas
  const movs = db.prepare('SELECT * FROM stock_movements ORDER BY id').all();
  assert.deepEqual(movs.map((m) => m.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(movs.map((m) => m.balance_after), [48, 43, 48, 46, 36, 33, 34, 30]);
  assert.deepEqual(movs.map((m) => m.type), [
    'entrada', 'saida_pedido', 'estorno', 'perda', 'transferencia', 'saida_sem_venda', 'sobra_inventario', 'divergencia_inventario',
  ]);
  assert.equal(movs[0].created_at, '2026-09-01 12:00:00');
  assert.ok(movs.every((m) => m.value_cents === null), 'histórico antigo fica sem valor');
  assert.equal(movs[1].revenue_cents, 2000, 'receita da venda antiga vem do pedido');
  assert.equal(movs[2].reverses_movement_id, 2, 'estorno antigo ligado à saída');
  assert.equal(db.prepare('SELECT name FROM locations WHERE id = ?').get(movs[4].location_id).name, 'Loja 1 - Centro');
  assert.equal(db.prepare('SELECT name FROM loss_reasons WHERE id = ?').get(movs[3].reason_id).name, 'Não informado (migrado)');
  assert.equal(movs[5].subtype, 'outros');

  // produto com saldo fica "sem custo"; valorizar não muda unidades
  const p = db.prepare('SELECT * FROM products WHERE id = 1').get();
  assert.deepEqual([p.stock_units, p.has_cost, p.stock_value_cents], [30, 0, 0]);
  const inv = createInventory(db);
  inv.openingCost({ productId: 1, costCents: 250, costPer: 'unidade' });
  assert.deepEqual(
    Object.values(db.prepare('SELECT stock_units, stock_value_cents, has_cost FROM products WHERE id = 1').get()),
    [30, 7500, 1],
  );
  db.close();

  // rodar de novo não faz nada (idempotente) e não cria outra cópia
  const again = openDatabase(file, { log: () => {}, upTo: V5 });
  assert.equal(again.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 9);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migração 3: remove os produtos de exemplo da 1ª versão sem mexer no resto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oggi-mig3-'));
  const file = path.join(dir, 'oggi.db');
  const old = new Database(file);
  old.exec(SCHEMA_V1);
  old.exec(`
    INSERT INTO settings (key, value) VALUES ('show_stock_quantity', '1');
    INSERT INTO products (id, sku, name, units_per_box, unit_price_cents, box_price_cents, stock_units) VALUES
      (1, 'EX001', 'Picolé Chocolate (exemplo)', 24, 450, 9800, 20),
      (2, 'EX002', 'Picolé Morango (exemplo)', 24, 450, 9800, 24),
      (3, 'OG26-SENSA-CLASSICO', 'Picolé Sensa Clássico', 20, 599, 11980, 40);
    INSERT INTO customers (id, cnpj, razao_social, password_hash, status) VALUES (1, '11222333000181', 'Cliente', 'x', 'ativo');
    INSERT INTO orders (id, customer_id, status, total_cents, stock_deducted) VALUES
      (1, 1, 'separado', 4500 + 599, 1), (2, 1, 'novo', 9800, 0);
    INSERT INTO order_items (order_id, product_id, product_name, unit_type, quantity, units_per_box, units_total, price_cents, subtotal_cents) VALUES
      (1, 1, 'Picolé Chocolate (exemplo)', 'unidade', 10, 24, 10, 450, 4500),
      (1, 3, 'Picolé Sensa Clássico', 'unidade', 1, 20, 1, 599, 599),
      (2, 2, 'Picolé Morango (exemplo)', 'caixa', 1, 24, 24, 9800, 9800);
    INSERT INTO stock_movements (id, product_id, type, quantity, balance_after, order_id) VALUES
      (1, 1, 'entrada', 30, 30, NULL), (2, 3, 'entrada', 41, 41, NULL),
      (3, 1, 'saida_pedido', -10, 20, 1), (4, 3, 'saida_pedido', -1, 40, 1), (5, 2, 'entrada', 24, 24, NULL);
  `);
  old.close();

  const db = openDatabase(file, { log: () => {}, upTo: V5 });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get().value, String(V5));
  assert.deepEqual(db.prepare('SELECT name FROM products').all().map((r) => r.name), ['Picolé Sensa Clássico']);
  assert.deepEqual(db.prepare('SELECT id FROM stock_movements ORDER BY id').all().map((r) => r.id), [2, 4], 'só o histórico do produto de verdade');
  assert.deepEqual(db.prepare('SELECT id, total_cents FROM orders').all(), [{ id: 1, total_cents: 599 }], 'pedido misto fica, só de exemplo sai');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM settings WHERE key = 'show_stock_quantity'").get().n, 0);
  assert.throws(() => db.prepare('DELETE FROM stock_movements WHERE id = 2').run(), /não podem ser apagadas/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migração 6: apaga movimentações, pedidos e financeiro; fica só o cliente Loja 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oggi-mig6-'));
  const file = path.join(dir, 'oggi.db');
  const old = openDatabase(file, { log: () => {}, upTo: V5 });
  seedTestData(old, { log: () => {} });
  old.exec(`
    INSERT INTO fin_entries (account_id, description, amount_cents, competence_date, paid_date) VALUES (1, 'Aluguel', 300000, '2026-10-01', '2026-10-05');
    INSERT INTO bank_accounts (id, name, bank_code, account_number) VALUES (1, 'Itaú', '341', '12345');
    INSERT INTO bank_imports (id, bank_account_id) VALUES (1, 1);
    INSERT INTO bank_transactions (bank_account_id, import_id, dedupe_key, posted_date, amount_cents, description, status, entry_id)
      VALUES (1, 1, 'k1', '2026-10-05', -300000, 'ALUGUEL', 'conciliado', 1);
    INSERT INTO bank_rules (pattern, account_id) VALUES ('ALUGUEL', 1);
    UPDATE settings SET value = '50000' WHERE key = 'cash_opening_cents';
  `);
  const before = old.prepare('SELECT COUNT(*) n FROM stock_movements').get().n;
  assert.ok(before > 0 && old.prepare('SELECT COUNT(*) n FROM orders').get().n > 0);
  old.close();

  const db = openDatabase(file, { log: () => {} });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get().value, String(LATEST_VERSION));
  const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  for (const t of ['stock_movements', 'orders', 'order_items', 'fin_entries', 'bank_accounts', 'bank_imports', 'bank_transactions', 'bank_rules']) {
    assert.equal(count(t), 0, `${t} vazia`);
  }
  // produtos, fotos, plano de contas e locais continuam; estoque zerado e sem custo
  assert.equal(count('products'), 90);
  assert.ok(count('product_images') > 0 && count('fin_accounts') > 0 && count('locations') > 0);
  assert.deepEqual(db.prepare('SELECT SUM(stock_units) u, SUM(stock_value_cents) v, SUM(has_cost) c FROM products').get(), { u: 0, v: 0, c: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE barcode LIKE '789000000%' OR box_barcode LIKE '1789000000%'").get().n, 0);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'cash_opening_cents'").get().value, '0');
  // único cliente: Loja 2, ativa, ainda sem senha
  const customers = db.prepare('SELECT * FROM customers').all();
  assert.deepEqual(customers.map((c) => [c.cnpj, c.nome_fantasia, c.status]), [[LOJA2.cnpj, 'Loja 2', 'ativo']]);
  // o kardex volta a ser imutável e o estoque funciona do zero
  const inv = createInventory(db);
  const p = db.prepare('SELECT id FROM products LIMIT 1').get();
  const [m] = inv.receive({ lines: [{ product_id: p.id, units: 10, cost_cents: 100 }], document: 'NF 1', user: 'Teste' });
  assert.equal(m.id, 1, 'numeração recomeça do 1');
  assert.throws(() => db.prepare('DELETE FROM stock_movements').run(), /não podem ser apagadas/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

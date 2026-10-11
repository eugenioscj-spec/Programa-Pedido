'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createInventory } = require('../src/inventory');
const { isValidCnpj, toCents, parseCsv } = require('../src/util');

function setup() {
  const db = openDatabase(':memory:');
  const inv = createInventory(db);
  const productId = Number(db.prepare(`
    INSERT INTO products (name, barcode, box_barcode, units_per_box, unit_price_cents, box_price_cents)
    VALUES ('Picolé Teste', '789001', '1789001', 24, 500, 10000)`).run().lastInsertRowid);
  const customerId = Number(db.prepare(`
    INSERT INTO customers (cnpj, razao_social, password_hash, status) VALUES ('11222333000181', 'Cliente', 'x', 'ativo')`).run().lastInsertRowid);
  const stock = () => db.prepare('SELECT stock_units FROM products WHERE id = ?').get(productId).stock_units;
  return { db, inv, productId, customerId, stock };
}

test('entrada soma ao estoque e registra no histórico', () => {
  const { db, inv, productId, stock } = setup();
  inv.manualMovement({ type: 'entrada', lines: [{ product_id: productId, units: 48 }], document: 'NF 1', user: 't' });
  assert.equal(stock(), 48);
  const mov = db.prepare('SELECT * FROM stock_movements').all();
  assert.equal(mov.length, 1);
  assert.equal(mov[0].quantity, 48);
  assert.equal(mov[0].balance_after, 48);
});

test('saídas manuais não deixam o estoque negativo', () => {
  const { inv, productId, stock } = setup();
  inv.manualMovement({ type: 'entrada', lines: [{ product_id: productId, units: 10 }] });
  assert.throws(() => inv.manualMovement({ type: 'perda', lines: [{ product_id: productId, units: 11 }] }), /insuficiente/);
  inv.manualMovement({ type: 'transferencia_loja', lines: [{ product_id: productId, units: 4 }] });
  assert.equal(stock(), 6);
});

test('pedido reserva estoque, separação dá baixa e cancelamento estorna', () => {
  const { inv, productId, customerId, stock } = setup();
  inv.manualMovement({ type: 'entrada', lines: [{ product_id: productId, units: 48 }] });

  const orderId = inv.createOrder({
    customerId,
    items: [{ product_id: productId, unit_type: 'caixa', quantity: 1 }, { product_id: productId, unit_type: 'unidade', quantity: 5 }],
  });
  assert.equal(stock(), 48, 'pedido novo não mexe no físico');
  assert.equal(inv.availableUnits(productId), 48 - 29, 'mas reserva o disponível');

  // outro cliente não consegue pedir mais do que o disponível
  assert.throws(() => inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'unidade', quantity: 20 }] }), /insuficiente/);

  inv.changeStatus({ orderId, status: 'confirmado', user: 't' });
  inv.changeStatus({ orderId, status: 'separado', user: 't' });
  assert.equal(stock(), 19);
  assert.equal(inv.availableUnits(productId), 19);

  inv.changeStatus({ orderId, status: 'cancelado', user: 't' });
  assert.equal(stock(), 48);
});

test('cancelar pedido novo libera a reserva sem movimentar estoque', () => {
  const { db, inv, productId, customerId, stock } = setup();
  inv.manualMovement({ type: 'entrada', lines: [{ product_id: productId, units: 24 }] });
  const orderId = inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'caixa', quantity: 1 }] });
  assert.equal(inv.availableUnits(productId), 0);
  inv.changeStatus({ orderId, status: 'cancelado' });
  assert.equal(inv.availableUnits(productId), 24);
  assert.equal(stock(), 24);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 1);
});

test('transições inválidas são bloqueadas', () => {
  const { inv, productId, customerId } = setup();
  inv.manualMovement({ type: 'entrada', lines: [{ product_id: productId, units: 24 }] });
  const orderId = inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'unidade', quantity: 1 }] });
  assert.throws(() => inv.changeStatus({ orderId, status: 'entregue' }), /Não é possível/);
  inv.changeStatus({ orderId, status: 'separado' });
  inv.changeStatus({ orderId, status: 'entregue' });
  assert.throws(() => inv.changeStatus({ orderId, status: 'cancelado' }), /Não é possível/);
});

test('total do pedido usa preço de caixa e de unidade', () => {
  const { db, inv, productId, customerId } = setup();
  inv.manualMovement({ type: 'entrada', lines: [{ product_id: productId, units: 100 }] });
  const orderId = inv.createOrder({
    customerId,
    items: [{ product_id: productId, unit_type: 'caixa', quantity: 2 }, { product_id: productId, unit_type: 'unidade', quantity: 3 }],
  });
  assert.equal(db.prepare('SELECT total_cents FROM orders WHERE id = ?').get(orderId).total_cents, 2 * 10000 + 3 * 500);
});

test('pedido mínimo é respeitado', () => {
  const { inv, productId, customerId } = setup();
  inv.manualMovement({ type: 'entrada', lines: [{ product_id: productId, units: 10 }] });
  assert.throws(
    () => inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'unidade', quantity: 1 }], minOrderCents: 1000 }),
    /mínimo/,
  );
});

test('produto vendido só por caixa recusa unidade', () => {
  const { db, inv, productId, customerId } = setup();
  db.prepare('UPDATE products SET sell_unit = 0 WHERE id = ?').run(productId);
  inv.manualMovement({ type: 'entrada', lines: [{ product_id: productId, units: 48 }] });
  assert.throws(() => inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'unidade', quantity: 1 }] }), /somente por caixa/);
});

test('editar itens do pedido respeita o disponível', () => {
  const { db, inv, productId, customerId } = setup();
  inv.manualMovement({ type: 'entrada', lines: [{ product_id: productId, units: 48 }] });
  const orderId = inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'caixa', quantity: 1 }] });
  const item = db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId);
  inv.editOrderItems({ orderId, changes: [{ item_id: item.id, quantity: 2 }] });
  assert.equal(db.prepare('SELECT total_cents FROM orders WHERE id = ?').get(orderId).total_cents, 20000);
  assert.throws(() => inv.editOrderItems({ orderId, changes: [{ item_id: item.id, quantity: 3 }] }), /insuficiente/);
});

test('inventário ajusta a diferença', () => {
  const { db, inv, productId, stock } = setup();
  inv.manualMovement({ type: 'entrada', lines: [{ product_id: productId, units: 50 }] });
  inv.inventoryCount({ counts: [{ product_id: productId, counted_units: 47 }] });
  assert.equal(stock(), 47);
  const last = db.prepare("SELECT * FROM stock_movements WHERE type = 'ajuste'").get();
  assert.equal(last.quantity, -3);
});

test('utilitários', () => {
  assert.equal(isValidCnpj('11.222.333/0001-81'), true);
  assert.equal(isValidCnpj('11.222.333/0001-82'), false);
  assert.equal(isValidCnpj('00000000000000'), false);
  assert.equal(toCents('1.234,56'), 123456);
  assert.equal(toCents('4,5'), 450);
  assert.equal(toCents('12.50'), 1250);
  const rows = parseCsv('nome;preco_unidade\n"Picolé; especial";4,50\r\nCone;8\n');
  assert.deepEqual(rows, [{ nome: 'Picolé; especial', preco_unidade: '4,50' }, { nome: 'Cone', preco_unidade: '8' }]);
});

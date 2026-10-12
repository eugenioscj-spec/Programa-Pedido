'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createInventory } = require('../src/inventory');
const { isValidCnpj, toCents, parseCsv } = require('../src/util');

function setup({ upb = 12 } = {}) {
  const db = openDatabase(':memory:');
  const inv = createInventory(db);
  const productId = Number(db.prepare(`
    INSERT INTO products (name, barcode, box_barcode, units_per_box, unit_price_cents, box_price_cents, retail_price_cents)
    VALUES ('Picolé Teste', '789001', '1789001', ?, 500, 5000, 599)`).run(upb).lastInsertRowid);
  const customerId = Number(db.prepare(`
    INSERT INTO customers (cnpj, razao_social, password_hash, status) VALUES ('11222333000181', 'Cliente', 'x', 'ativo')`).run().lastInsertRowid);
  const prod = () => db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  const stock = () => prod().stock_units;
  const lastMov = () => db.prepare('SELECT * FROM stock_movements ORDER BY id DESC LIMIT 1').get();
  const loja = db.prepare("SELECT id FROM locations WHERE kind = 'loja' ORDER BY id LIMIT 1").get().id;
  const reason = (name) => db.prepare('SELECT id FROM loss_reasons WHERE name = ?').get(name).id;
  const entrada = (units, costCents, per = 'unidade', extra = {}) => inv.receive({
    lines: [{ product_id: productId, units, cost_cents: costCents, cost_per: per, ...extra }], document: 'NF', ...extra.header,
  });
  return { db, inv, productId, customerId, prod, stock, lastMov, loja, reason, entrada };
}

test('custo médio: duas entradas com custos diferentes e uma saída', () => {
  const { inv, prod, entrada, loja, lastMov, productId } = setup();
  entrada(10, 1000); // 10 un × R$ 10,00
  entrada(10, 2000); // 10 un × R$ 20,00
  assert.equal(prod().stock_value_cents, 30000);
  assert.equal(prod().stock_value_cents / prod().stock_units, 1500, 'custo médio R$ 15,00');
  inv.dispatch({ type: 'transferencia', lines: [{ product_id: productId, units: 5 }], locationId: loja });
  assert.equal(lastMov().value_cents, -7500);
  assert.equal(lastMov().unit_cost_cents, 1500);
  assert.equal(lastMov().unit_price_cents, 599, 'transferência guarda o preço de varejo do dia');
  assert.equal(prod().stock_units, 15);
  assert.equal(prod().stock_value_cents, 22500);
});

test('entrada por caixa converte para unidade e saída que zera o saldo zera o valor', () => {
  const { inv, prod, entrada, productId, reason } = setup({ upb: 12 });
  entrada(12, 8730, 'caixa'); // caixa de R$ 87,30 com 12 un. = R$ 7,275/un.
  assert.equal(prod().stock_value_cents, 8730);
  inv.dispatch({ type: 'perda', reasonId: reason('Vencimento'), lines: [{ product_id: productId, units: 5 }] });
  assert.equal(prod().stock_value_cents, 8730 - 3638); // 5 × 7,275 = 36,375 → 36,38
  inv.dispatch({ type: 'perda', reasonId: reason('Vencimento'), lines: [{ product_id: productId, units: 7 }] });
  assert.equal(prod().stock_units, 0);
  assert.equal(prod().stock_value_cents, 0, 'sem centavo fantasma');
});

test('estorno devolve o valor original mesmo depois de nova entrada com custo diferente', () => {
  const { db, inv, prod, entrada, productId, reason } = setup();
  entrada(10, 1000);
  const [perda] = inv.dispatch({ type: 'perda', reasonId: reason('Avaria / embalagem danificada'), lines: [{ product_id: productId, units: 4 }] });
  assert.equal(perda.value_cents, -4000);
  entrada(10, 2000); // médio agora: (6000 + 20000) / 16 = 1625
  const est = inv.reverse({ movementId: perda.id, reason: 'Lançada errado' });
  assert.equal(est.value_cents, 4000, 'volta pelo valor que saiu, não pelo médio atual');
  assert.equal(prod().stock_units, 20);
  assert.equal(prod().stock_value_cents, 30000);
  assert.throws(() => inv.reverse({ movementId: perda.id, reason: 'de novo' }), /já foi estornada/);
  assert.throws(() => inv.reverse({ movementId: est.id, reason: 'x' }), /não pode ser estornado/);
  assert.throws(() => db.prepare('UPDATE stock_movements SET quantity = 1 WHERE id = ?').run(perda.id), /não podem ser alteradas/);
  assert.throws(() => db.prepare('DELETE FROM stock_movements WHERE id = ?').run(perda.id), /não podem ser apagadas/);
});

test('saldo nunca fica negativo, nem em unidades nem em valor', () => {
  const { db, inv, entrada, productId, prod } = setup();
  entrada(10, 1000);
  assert.throws(() => inv.dispatch({ type: 'saida_sem_venda', subtype: 'consumo_interno', lines: [{ product_id: productId, units: 11 }] }), /insuficiente/);
  assert.throws(() => db.prepare('UPDATE products SET stock_units = -1 WHERE id = ?').run(productId), /inválido/);
  assert.equal(prod().stock_units, 10);
});

test('venda B2B: reserva, baixa a custo médio na separação, receita e estorno no cancelamento', () => {
  const { db, inv, productId, customerId, stock, entrada, prod } = setup({ upb: 24 });
  entrada(48, 300); // R$ 3,00/un
  const orderId = inv.createOrder({
    customerId,
    items: [{ product_id: productId, unit_type: 'caixa', quantity: 1 }, { product_id: productId, unit_type: 'unidade', quantity: 5 }],
  });
  assert.equal(stock(), 48, 'pedido novo não mexe no físico');
  assert.equal(inv.availableUnits(productId), 48 - 29, 'mas reserva o disponível');
  assert.throws(() => inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'unidade', quantity: 20 }] }), /insuficiente/);

  inv.changeStatus({ orderId, status: 'confirmado' });
  inv.changeStatus({ orderId, status: 'separado' });
  assert.equal(stock(), 19);
  const sales = db.prepare("SELECT * FROM stock_movements WHERE type = 'saida_pedido' ORDER BY id").all();
  assert.deepEqual(sales.map((m) => m.revenue_cents), [5000, 2500]);
  assert.deepEqual(sales.map((m) => m.value_cents), [-7200, -1500]);
  assert.ok(sales.every((m) => m.customer_id === customerId));

  inv.changeStatus({ orderId, status: 'cancelado' });
  assert.equal(stock(), 48);
  assert.equal(prod().stock_value_cents, 14400);
  const est = db.prepare("SELECT * FROM stock_movements WHERE type = 'estorno' ORDER BY id").all();
  assert.deepEqual(est.map((m) => [m.value_cents, m.revenue_cents]), [[7200, -5000], [1500, -2500]]);
});

test('cancelar pedido novo libera a reserva sem movimentar estoque', () => {
  const { db, inv, productId, customerId, stock, entrada } = setup({ upb: 24 });
  entrada(24, 300);
  const orderId = inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'caixa', quantity: 1 }] });
  assert.equal(inv.availableUnits(productId), 0);
  inv.changeStatus({ orderId, status: 'cancelado' });
  assert.equal(inv.availableUnits(productId), 24);
  assert.equal(stock(), 24);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 1);
});

test('venda não pode ser estornada pelo histórico: só cancelando o pedido', () => {
  const { db, inv, productId, customerId, entrada } = setup();
  entrada(10, 100);
  const orderId = inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'unidade', quantity: 1 }] });
  inv.changeStatus({ orderId, status: 'separado' });
  const sale = db.prepare("SELECT id FROM stock_movements WHERE type = 'saida_pedido'").get();
  assert.throws(() => inv.reverse({ movementId: sale.id, reason: 'x' }), /cancele o pedido/);
});

test('transições inválidas são bloqueadas', () => {
  const { inv, productId, customerId, entrada } = setup();
  entrada(24, 100);
  const orderId = inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'unidade', quantity: 1 }] });
  assert.throws(() => inv.changeStatus({ orderId, status: 'entregue' }), /Não é possível/);
  inv.changeStatus({ orderId, status: 'separado' });
  inv.changeStatus({ orderId, status: 'entregue' });
  assert.throws(() => inv.changeStatus({ orderId, status: 'cancelado' }), /Não é possível/);
});

test('total do pedido, pedido mínimo, venda só por caixa e edição de itens', () => {
  const { db, inv, productId, customerId, entrada } = setup({ upb: 12 });
  entrada(100, 100);
  const orderId = inv.createOrder({
    customerId,
    items: [{ product_id: productId, unit_type: 'caixa', quantity: 2 }, { product_id: productId, unit_type: 'unidade', quantity: 3 }],
  });
  assert.equal(db.prepare('SELECT total_cents FROM orders WHERE id = ?').get(orderId).total_cents, 2 * 5000 + 3 * 500);
  assert.throws(() => inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'unidade', quantity: 1 }], minOrderCents: 1000 }), /mínimo/);
  const item = db.prepare("SELECT id FROM order_items WHERE order_id = ? AND unit_type = 'caixa'").get(orderId);
  inv.editOrderItems({ orderId, changes: [{ item_id: item.id, quantity: 7 }] });
  assert.throws(() => inv.editOrderItems({ orderId, changes: [{ item_id: item.id, quantity: 9 }] }), /insuficiente/);
  db.prepare('UPDATE products SET sell_unit = 0 WHERE id = ?').run(productId);
  assert.throws(() => inv.createOrder({ customerId, items: [{ product_id: productId, unit_type: 'unidade', quantity: 1 }] }), /somente por caixa/);
});

test('inventário: sobra entra pelo custo médio, falta vira divergência', () => {
  const { db, inv, productId, prod, entrada } = setup();
  entrada(10, 1000);
  inv.inventoryCount({ counts: [{ product_id: productId, counted_units: 8 }] });
  let m = db.prepare('SELECT * FROM stock_movements ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual([m.type, m.quantity, m.value_cents], ['divergencia_inventario', -2, -2000]);
  inv.inventoryCount({ counts: [{ product_id: productId, counted_units: 9 }] });
  m = db.prepare('SELECT * FROM stock_movements ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual([m.type, m.quantity, m.value_cents], ['sobra_inventario', 1, 1000]);
  // produto zerado: sobra usa o custo da última entrada
  inv.inventoryCount({ counts: [{ product_id: productId, counted_units: 0 }] });
  inv.inventoryCount({ counts: [{ product_id: productId, counted_units: 2 }] });
  assert.equal(prod().stock_value_cents, 2000);
});

test('produto com saldo e sem custo: entrada usa o custo da nota ou o custo informado', () => {
  const { db, inv, productId, prod } = setup({ upb: 10 });
  // saldo sem custo (ex.: dados antigos)
  inv.inventoryCount({ counts: [{ product_id: productId, counted_units: 6 }] });
  assert.equal(prod().has_cost, 0);
  assert.equal(db.prepare('SELECT value_cents FROM stock_movements ORDER BY id DESC').get().value_cents, null);
  assert.throws(() => inv.move({ productId, type: 'entrada', quantity: 1, valueCents: 100 }), /sem custo/);

  inv.receive({ lines: [{ product_id: productId, units: 10, cost_cents: 2500, cost_per: 'caixa' }], document: 'NF 9' });
  const ab = db.prepare("SELECT * FROM stock_movements WHERE type = 'abertura_custo'").get();
  assert.deepEqual([ab.quantity, ab.value_cents], [0, 1500], '6 un × R$ 2,50 da nota');
  assert.equal(prod().stock_value_cents, 4000);

  // segundo produto: custo inicial informado
  const p2 = Number(db.prepare("INSERT INTO products (name, units_per_box) VALUES ('Pote', 4)").run().lastInsertRowid);
  inv.inventoryCount({ counts: [{ product_id: p2, counted_units: 4 }] });
  inv.receive({ lines: [{ product_id: p2, units: 4, cost_cents: 8000, cost_per: 'caixa', opening_cost_cents: 1500, opening_cost_per: 'unidade' }] });
  assert.equal(db.prepare('SELECT stock_value_cents v FROM products WHERE id = ?').get(p2).v, 6000 + 8000);
});

test('custo inicial pela tela própria e estorno do custo inicial', () => {
  const { db, inv, productId, prod } = setup({ upb: 12 });
  inv.inventoryCount({ counts: [{ product_id: productId, counted_units: 24 }] });
  const ab = inv.openingCost({ productId, costCents: 6000, costPer: 'caixa' });
  assert.equal(prod().stock_value_cents, 12000);
  assert.equal(prod().stock_units, 24, 'não muda as unidades');
  inv.reverse({ movementId: ab.id, reason: 'Custo errado' });
  assert.deepEqual([prod().has_cost, prod().stock_value_cents], [0, 0]);
  inv.openingCost({ productId, costCents: 450, costPer: 'unidade' });
  assert.equal(prod().stock_value_cents, 10800);
  assert.throws(() => inv.openingCost({ productId, costCents: 1, costPer: 'unidade' }), /já tem custo/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE type = 'abertura_custo'").get().n, 2);
});

test('observações obrigatórias: custo zero, motivo "Outros" e saída acima do limite', () => {
  const { inv, productId, reason } = setup();
  assert.throws(() => inv.receive({ lines: [{ product_id: productId, units: 5, cost_cents: 0 }] }), /observação/);
  inv.receive({ lines: [{ product_id: productId, units: 5, cost_cents: 0 }], note: 'Bonificação da franqueadora' });
  inv.receive({ lines: [{ product_id: productId, units: 100, cost_cents: 1000 }] });
  assert.throws(() => inv.dispatch({ type: 'perda', reasonId: reason('Outros'), lines: [{ product_id: productId, units: 1 }] }), /precisa de observação/);
  assert.throws(() => inv.dispatch({ type: 'saida_sem_venda', subtype: 'amostra_degustacao', lines: [{ product_id: productId, units: 30 }], noteThresholdCents: 20000 }), /acima de R\$ 200,00/);
  inv.dispatch({ type: 'saida_sem_venda', subtype: 'amostra_degustacao', lines: [{ product_id: productId, units: 30 }], noteThresholdCents: 20000, note: 'Evento' });
  assert.throws(() => inv.dispatch({ type: 'transferencia', lines: [{ product_id: productId, units: 1 }] }), /loja de destino/);
  assert.throws(() => inv.dispatch({ type: 'saida_sem_venda', lines: [{ product_id: productId, units: 1 }] }), /tipo da saída/);
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createInventory } = require('../src/inventory');
const { createReports } = require('../src/reports');
const T = require('../src/time');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function world() {
  const db = openDatabase(':memory:');
  const inv = createInventory(db);
  const rep = createReports(db);
  const customerId = Number(db.prepare(
    "INSERT INTO customers (cnpj, razao_social, password_hash, status) VALUES ('11222333000181', 'Bar', 'x', 'ativo')",
  ).run().lastInsertRowid);
  const products = [];
  [[24, 400, 20], [39, 175, 39], [4, 2199, 4], [12, 999, 12], [18, 799, 18]].forEach(([upb, price], i) => {
    products.push(Number(db.prepare(
      'INSERT INTO products (name, category, units_per_box, unit_price_cents, box_price_cents, retail_price_cents) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(`Produto ${i + 1}`, i % 2 ? 'Picolés' : 'Potes', upb, price, price * upb, price + 100).lastInsertRowid));
  });
  const loja = db.prepare("SELECT id FROM locations WHERE kind = 'loja'").all().map((r) => r.id);
  const reasons = db.prepare('SELECT id, requires_note FROM loss_reasons WHERE active = 1').all();
  return { db, inv, rep, customerId, products, loja, reasons };
}

test('conciliação: sequência aleatória de movimentações de todos os tipos sempre fecha', () => {
  for (const seed of [1, 7, 42, 2026, 99991]) {
    const { db, inv, rep, customerId, products, loja, reasons } = world();
    const r = rng(seed);
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    let clock = Date.parse('2026-06-01T10:00:00Z');
    const at = () => { clock += int(1, 30) * 3600e3; return new Date(clock).toISOString().slice(0, 19).replace('T', ' '); };
    const stockOf = (id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    // um produto começa com saldo sem custo (como dado antigo)
    inv.inventoryCount({ counts: [{ product_id: products[4], counted_units: 30 }], at: at() });

    for (let i = 0; i < 250; i++) {
      const pid = pick(products);
      const p = stockOf(pid);
      const op = int(0, 9);
      try {
        if (op <= 2) {
          inv.receive({ lines: [{ product_id: pid, units: int(1, 80), cost_cents: int(0, 3) ? int(50, 9000) : 0, cost_per: pick(['caixa', 'unidade']) }], note: 'nf', at: at() });
        } else if (op === 3 && p.stock_units > 0) {
          inv.dispatch({ type: 'transferencia', locationId: pick(loja), lines: [{ product_id: pid, units: int(1, p.stock_units) }], at: at() });
        } else if (op === 4 && p.stock_units > 0) {
          const reason = pick(reasons);
          inv.dispatch({ type: 'perda', reasonId: reason.id, note: 'x', lines: [{ product_id: pid, units: int(1, p.stock_units) }], at: at() });
        } else if (op === 5 && p.stock_units > 0) {
          inv.dispatch({ type: 'saida_sem_venda', subtype: pick(['bonificacao_cliente', 'amostra_degustacao', 'consumo_interno', 'outros']), customerId: r() < 0.5 ? customerId : null, lines: [{ product_id: pid, units: int(1, p.stock_units) }], at: at() });
        } else if (op === 6) {
          inv.inventoryCount({ counts: [{ product_id: pid, counted_units: Math.max(0, p.stock_units + int(-5, 5)) }], at: at() });
        } else if (op === 7 && inv.availableUnits(pid) > 0) {
          const orderId = inv.createOrder({ customerId, items: [{ product_id: pid, unit_type: 'unidade', quantity: int(1, inv.availableUnits(pid)) }], at: at() });
          inv.changeStatus({ orderId, status: 'separado', at: at() });
          if (r() < 0.25) inv.changeStatus({ orderId, status: 'cancelado', at: at() });
        } else if (op === 8) {
          const m = db.prepare(`SELECT id FROM stock_movements m WHERE type IN ('entrada', 'perda', 'transferencia', 'saida_sem_venda', 'sobra_inventario', 'divergencia_inventario')
            AND NOT EXISTS (SELECT 1 FROM stock_movements x WHERE x.reverses_movement_id = m.id) ORDER BY RANDOM() LIMIT 1`).get();
          if (m) inv.reverse({ movementId: m.id, reason: 'teste', at: at() });
        } else if (op === 9 && !p.has_cost && p.stock_units > 0) {
          inv.openingCost({ productId: pid, costCents: int(100, 500), costPer: 'unidade', at: at() });
        }
      } catch (e) {
        if (!/insuficiente|negativo|observação/.test(e.message)) throw e;
      }
    }

    const last = T.localDate(new Date(clock));
    // posição reconstruída no último dia = estado atual dos produtos
    const pos = new Map(rep.positionRows(last).map((x) => [x.id, x]));
    for (const pid of products) {
      const p = stockOf(pid);
      assert.equal(pos.get(pid).units, p.stock_units, `seed ${seed}: unidades do produto ${pid}`);
      if (p.has_cost) assert.equal(pos.get(pid).value, p.stock_value_cents, `seed ${seed}: valor do produto ${pid}`);
    }
    // conciliação fecha em vários recortes de período
    for (const [from, to] of [['2026-06-01', last], ['2026-06-10', '2026-07-15'], ['2026-07-01', '2026-07-31'], [T.addDays(last, -20), last]]) {
      const c = rep.reconciliation(from, to);
      assert.equal(c.check.units, 0, `seed ${seed} ${from}..${to}: unidades`);
      assert.equal(c.check.value, 0, `seed ${seed} ${from}..${to}: valor`);
      const productRows = c.sections.find((s) => s.title.includes('R$ a custo')).rows;
      for (const row of productRows) assert.equal(row.diff_value, 0);
    }
    // total do estoque a custo bate com a soma dos produtos com custo
    const total = rep.position(last).sections[0].total.value;
    const expected = db.prepare('SELECT COALESCE(SUM(stock_value_cents), 0) v FROM products WHERE has_cost = 1 AND stock_units > 0').get().v;
    assert.equal(total, expected);
  }
});

test('fuso: movimentação às 23h de Cuiabá do dia 31 cai no mês correto', () => {
  const { db, inv, rep, products, reasons } = world();
  const pid = products[0];
  inv.receive({ lines: [{ product_id: pid, units: 10, cost_cents: 100 }], at: T.localToUtc('2026-08-01 09:00') });
  const lateNight = T.localToUtc('2026-08-31 23:00');
  assert.equal(lateNight, '2026-09-01 03:00:00', 'em UTC já é dia 1º');
  inv.dispatch({ type: 'perda', reasonId: reasons[0].id, lines: [{ product_id: pid, units: 3 }], at: lateNight });

  assert.equal(rep.losses('2026-08-01', '2026-08-31').total.units, 3, 'conta em agosto');
  assert.equal(rep.losses('2026-09-01', '2026-09-30').total.units, 0, 'não conta em setembro');
  assert.equal(rep.positionRows('2026-08-31').find((r) => r.id === pid).units, 7);
  assert.equal(db.prepare(`SELECT ${T.sqlLocalDate('created_at')} d FROM stock_movements ORDER BY id DESC`).get().d, '2026-08-31');
  assert.deepEqual(T.utcRange('2026-08-01', '2026-08-31'), ['2026-08-01 04:00:00', '2026-09-01 04:00:00']);
  assert.equal(T.localDate(new Date('2026-09-01T03:59:00Z')), '2026-08-31');
});

test('vendas B2B: receita, CMV e margem; cancelamento desconta no mês do cancelamento', () => {
  const { inv, rep, products, customerId } = world();
  const pid = products[0];
  inv.receive({ lines: [{ product_id: pid, units: 100, cost_cents: 250 }], at: T.localToUtc('2026-08-01 08:00') });
  const o1 = inv.createOrder({ customerId, items: [{ product_id: pid, unit_type: 'unidade', quantity: 10 }], at: T.localToUtc('2026-08-10 08:00') });
  inv.changeStatus({ orderId: o1, status: 'separado', at: T.localToUtc('2026-08-10 09:00') });
  const o2 = inv.createOrder({ customerId, items: [{ product_id: pid, unit_type: 'unidade', quantity: 4 }], at: T.localToUtc('2026-08-20 08:00') });
  inv.changeStatus({ orderId: o2, status: 'separado', at: T.localToUtc('2026-08-20 09:00') });
  inv.changeStatus({ orderId: o2, status: 'cancelado', at: T.localToUtc('2026-09-02 09:00') });

  const aug = rep.sales('2026-08-01', '2026-08-31').total;
  assert.deepEqual([aug.units, aug.revenue, aug.cost, aug.margin], [14, 5600, 3500, 2100]);
  assert.equal(Math.round(aug.margin_pct * 1000), 375);
  const sep = rep.sales('2026-09-01', '2026-09-30').total;
  assert.deepEqual([sep.units, sep.revenue, sep.cost], [-4, -1600, -1000]);
});

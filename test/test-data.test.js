'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createInventory } = require('../src/inventory');
const { createReports } = require('../src/reports');
const { seedTestData } = require('../src/test-data');
const T = require('../src/time');

test('dados de teste: catálogo com caixas disponíveis, conciliação fechando e só uma vez', () => {
  const db = openDatabase(':memory:');
  const log = () => {};
  const first = seedTestData(db, { log });
  assert.equal(first.fresh, true);
  const inv = createInventory(db);
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  assert.equal(products.length, 90);
  assert.deepEqual(products.filter((p) => inv.availableUnits(p.id) < p.units_per_box).map((p) => p.name), [], 'todo produto tem ao menos 1 caixa');
  const c = createReports(db).reconciliation(T.addDays(T.localDate(), -60), T.localDate());
  assert.deepEqual([c.check.units, c.check.value], [0, 0]);

  const movements = db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n;
  assert.deepEqual(seedTestData(db, { log }), { fresh: false, topped: 0 }, 'segunda vez não faz nada');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, movements);
});

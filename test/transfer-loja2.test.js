'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { loadOggiCatalog } = require('../src/catalog');
const M = require('../src/migrations');

test('transferência de 14/11/2026 para a Loja 2: entra uma vez, depois do inventário, com a data certa', () => {
  const db = openDatabase(':memory:');
  loadOggiCatalog(db, { withImages: false });
  db.prepare("INSERT INTO settings (key, value) VALUES ('pending_inventory', '2026-11-13') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('pending_transfer_loja2', '2026-11-14') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const log = () => {};
  assert.equal(M.applyPendingTransfer(db, { log }), null, 'espera o inventário');
  M.applyPendingInventory(db, { log });
  const r = M.applyPendingTransfer(db, { log });
  assert.equal(r.error, undefined);
  assert.equal(r.products, 49);
  assert.deepEqual(r.missing, []);
  const boxes = M.TRANSFER_LOJA2_2026_11_14.reduce((s, [, b]) => s + b, 0);
  assert.equal(boxes, 110);
  const rows = db.prepare(`SELECT m.*, p.units_per_box, l.name AS loc FROM stock_movements m JOIN products p ON p.id = m.product_id
    JOIN locations l ON l.id = m.location_id WHERE m.type = 'transferencia'`).all();
  assert.equal(rows.length, 49);
  assert.ok(rows.every((m) => m.loc === 'Loja 2' && m.created_at.startsWith('2026-11-14')));
  assert.equal(rows.reduce((s, m) => s - m.quantity / m.units_per_box, 0), 110);
  const mickey = db.prepare("SELECT stock_units, units_per_box FROM products WHERE sku = 'OG26-DISNEY-LEITE-CACAU'").get();
  assert.equal(mickey.stock_units, (9 - 3) * mickey.units_per_box);
  assert.equal(M.applyPendingTransfer(db, { log }), null, 'não repete');
});

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

// Esquema da versão 1. As mudanças posteriores ficam em migrations.js.
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY,
  cnpj          TEXT NOT NULL UNIQUE,
  razao_social  TEXT NOT NULL,
  nome_fantasia TEXT,
  contato       TEXT,
  telefone      TEXT,
  email         TEXT,
  endereco      TEXT,
  cidade        TEXT,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pendente'
                CHECK (status IN ('pendente', 'ativo', 'bloqueado')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_type  TEXT NOT NULL CHECK (user_type IN ('admin', 'customer')),
  user_id    INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

-- Estoque sempre guardado em UNIDADES. Caixa = units_per_box unidades.
CREATE TABLE IF NOT EXISTS products (
  id               INTEGER PRIMARY KEY,
  sku              TEXT UNIQUE,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'Geral',
  barcode          TEXT UNIQUE,          -- EAN da unidade
  box_barcode      TEXT UNIQUE,          -- DUN-14 / EAN da caixa (opcional)
  units_per_box    INTEGER NOT NULL DEFAULT 1 CHECK (units_per_box >= 1),
  unit_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
  box_price_cents  INTEGER NOT NULL DEFAULT 0 CHECK (box_price_cents >= 0),
  sell_unit        INTEGER NOT NULL DEFAULT 1,
  sell_box         INTEGER NOT NULL DEFAULT 1,
  min_stock        INTEGER NOT NULL DEFAULT 0,
  stock_units      INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  description      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY,
  customer_id    INTEGER NOT NULL REFERENCES customers(id),
  status         TEXT NOT NULL DEFAULT 'novo'
                 CHECK (status IN ('novo', 'confirmado', 'separado', 'entregue', 'cancelado')),
  total_cents    INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  admin_notes    TEXT,
  delivery_date  TEXT,
  stock_deducted INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at   TEXT,
  picked_at      TEXT,
  delivered_at   TEXT,
  cancelled_at   TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products(id),
  product_name     TEXT NOT NULL,
  unit_type        TEXT NOT NULL CHECK (unit_type IN ('caixa', 'unidade')),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  units_per_box    INTEGER NOT NULL,
  units_total      INTEGER NOT NULL,
  price_cents      INTEGER NOT NULL,
  subtotal_cents   INTEGER NOT NULL
);

-- Kardex: toda entrada/saída fica registrada aqui. quantity é com sinal (+ entra, - sai).
CREATE TABLE IF NOT EXISTS stock_movements (
  id            INTEGER PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  type          TEXT NOT NULL CHECK (type IN (
                  'entrada', 'saida_pedido', 'estorno_pedido', 'ajuste',
                  'perda', 'transferencia_loja', 'saida_avulsa')),
  quantity      INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  order_id      INTEGER REFERENCES orders(id),
  document      TEXT,
  note          TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_mov_product ON stock_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mov_created ON stock_movements(created_at);
`;

const DEFAULT_SETTINGS = {
  store_name: 'Oggi Sorvetes',
  store_subtitle: 'Pedidos para empresas',
  whatsapp: '',
  min_order_cents: '0',
  auto_approve_customers: '0',
  order_notice: 'Pedidos confirmados em até 1 dia útil. Entrega/retirada combinada pelo WhatsApp.',
};

// Onde o banco fica salvo. No Railway, se houver um Volume conectado, usa ele automaticamente.
function defaultDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'oggi.db');
  return path.join(__dirname, '..', 'data', 'oggi.db');
}

// Em hospedagem sem disco persistente, os dados somem a cada atualização.
function storageIsPersistent() {
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  return !onRailway || !!(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DB_PATH);
}

function openDatabase(file, { log } = {}) {
  const target = file || defaultDbPath();
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_V1);
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  runMigrations(db, target, { log: log || (target === ':memory:' ? () => {} : console.log) });
  return db;
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

module.exports = { openDatabase, getSettings, storageIsPersistent, DEFAULT_SETTINGS, SCHEMA_V1 };

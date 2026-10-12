'use strict';

// Migrações versionadas do banco. Rodam ao iniciar, são idempotentes e fazem
// uma cópia do arquivo do banco antes de mexer em qualquer coisa.
//
// Para criar uma nova: adicione { version: N, name, up(db) } ao final da lista.

const fs = require('node:fs');
const path = require('node:path');

const LOSS_REASONS = [
  ['Vencimento', 0],
  ['Avaria / embalagem danificada', 0],
  ['Descongelamento / quebra da cadeia de frio', 0],
  ['Divergência no recebimento', 0],
  ['Furto / extravio', 0],
  ['Outros', 1],
];
const MIGRATED_REASON = 'Não informado (migrado)';

const MOVEMENT_TYPES = [
  'entrada', 'saida_pedido', 'transferencia', 'perda', 'saida_sem_venda',
  'sobra_inventario', 'divergencia_inventario', 'abertura_custo', 'estorno',
];

const MIGRATIONS = [
  {
    version: 2,
    name: 'Estoque v2: custo médio, destinos, motivos, kardex imutável e imagens',
    up(db) {
      // ---- produtos: valor do estoque, preço de varejo, situação de custo, imagem
      const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
      const addCol = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${ddl}`); };
      addCol('stock_value_cents', 'INTEGER NOT NULL DEFAULT 0');
      addCol('retail_price_cents', 'INTEGER');
      addCol('has_cost', 'INTEGER NOT NULL DEFAULT 0');
      addCol('image_updated_at', 'TEXT');

      // ---- locais e motivos
      db.exec(`
        CREATE TABLE IF NOT EXISTS locations (
          id          INTEGER PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          kind        TEXT NOT NULL CHECK (kind IN ('camara', 'loja')),
          description TEXT,
          active      INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS loss_reasons (
          id            INTEGER PRIMARY KEY,
          name          TEXT NOT NULL UNIQUE,
          requires_note INTEGER NOT NULL DEFAULT 0,
          active        INTEGER NOT NULL DEFAULT 1,
          sort          INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS product_images (
          product_id INTEGER PRIMARY KEY REFERENCES products(id),
          mime       TEXT NOT NULL,
          data       BLOB NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const insLoc = db.prepare('INSERT OR IGNORE INTO locations (name, kind, description) VALUES (?, ?, ?)');
      insLoc.run('Câmara fria', 'camara', 'Estoque central');
      insLoc.run('Loja 1 - Centro', 'loja', 'Loja do centro (não fica junto da câmara)');
      insLoc.run('Loja 2', 'loja', 'Loja junto da câmara');
      const insReason = db.prepare('INSERT OR IGNORE INTO loss_reasons (name, requires_note, sort, active) VALUES (?, ?, ?, ?)');
      LOSS_REASONS.forEach(([name, note], i) => insReason.run(name, note, i + 1, 1));
      insReason.run(MIGRATED_REASON, 0, 99, 0);

      // ---- kardex: reconstrói a tabela com os novos tipos e colunas, preservando ids
      const oldCols = db.prepare('PRAGMA table_info(stock_movements)').all().map((c) => c.name);
      if (!oldCols.includes('value_cents')) {
        const loja1 = db.prepare("SELECT id FROM locations WHERE name = 'Loja 1 - Centro'").get().id;
        const migratedReason = db.prepare('SELECT id FROM loss_reasons WHERE name = ?').get(MIGRATED_REASON).id;
        db.exec(`
          CREATE TABLE stock_movements_v2 (
            id                   INTEGER PRIMARY KEY,
            product_id           INTEGER NOT NULL REFERENCES products(id),
            type                 TEXT NOT NULL CHECK (type IN (${MOVEMENT_TYPES.map((t) => `'${t}'`).join(', ')})),
            quantity             INTEGER NOT NULL,
            balance_after        INTEGER NOT NULL,
            unit_cost_cents      REAL,
            value_cents          INTEGER,
            value_after_cents    INTEGER,
            unit_price_cents     INTEGER,
            revenue_cents        INTEGER,
            order_id             INTEGER REFERENCES orders(id),
            location_id          INTEGER REFERENCES locations(id),
            reason_id            INTEGER REFERENCES loss_reasons(id),
            subtype              TEXT,
            customer_id          INTEGER REFERENCES customers(id),
            supplier             TEXT,
            document             TEXT,
            note                 TEXT,
            reverses_movement_id INTEGER REFERENCES stock_movements(id),
            created_by           TEXT,
            created_at           TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO stock_movements_v2
            (id, product_id, type, quantity, balance_after, order_id, location_id, reason_id, subtype, document, note, created_by, created_at)
          SELECT id, product_id,
            CASE type
              WHEN 'estorno_pedido' THEN 'estorno'
              WHEN 'ajuste' THEN CASE WHEN quantity >= 0 THEN 'sobra_inventario' ELSE 'divergencia_inventario' END
              WHEN 'transferencia_loja' THEN 'transferencia'
              WHEN 'saida_avulsa' THEN 'saida_sem_venda'
              ELSE type
            END,
            quantity, balance_after, order_id,
            CASE WHEN type = 'transferencia_loja' THEN ${loja1} END,
            CASE WHEN type = 'perda' THEN ${migratedReason} END,
            CASE WHEN type = 'saida_avulsa' THEN 'outros' END,
            document, note, created_by, created_at
          FROM stock_movements ORDER BY id;
          DROP TABLE stock_movements;
          ALTER TABLE stock_movements_v2 RENAME TO stock_movements;
        `);

        // Receita das vendas antigas (vem dos itens do pedido) e cliente.
        db.exec(`
          UPDATE stock_movements SET
            revenue_cents = (SELECT oi.subtotal_cents FROM order_items oi
              WHERE oi.order_id = stock_movements.order_id AND oi.product_id = stock_movements.product_id
                AND oi.units_total = -stock_movements.quantity ORDER BY oi.id LIMIT 1),
            customer_id = (SELECT customer_id FROM orders WHERE id = stock_movements.order_id)
          WHERE type = 'saida_pedido' AND order_id IS NOT NULL;
          UPDATE stock_movements SET unit_price_cents = CAST(ROUND(revenue_cents * 1.0 / -quantity) AS INTEGER)
          WHERE type = 'saida_pedido' AND revenue_cents IS NOT NULL;
        `);
        // Liga cada estorno antigo de pedido à saída que ele devolveu.
        const reversals = db.prepare("SELECT * FROM stock_movements WHERE type = 'estorno' AND reverses_movement_id IS NULL ORDER BY id").all();
        const findOriginal = db.prepare(`
          SELECT id FROM stock_movements m WHERE m.type = 'saida_pedido' AND m.order_id = ? AND m.product_id = ?
            AND m.quantity = ? AND m.id < ?
            AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id)
          ORDER BY m.id LIMIT 1`);
        const link = db.prepare('UPDATE stock_movements SET reverses_movement_id = ?, customer_id = (SELECT customer_id FROM stock_movements WHERE id = ?), revenue_cents = -(SELECT revenue_cents FROM stock_movements WHERE id = ?) WHERE id = ?');
        for (const r of reversals) {
          const orig = r.order_id && findOriginal.get(r.order_id, r.product_id, -r.quantity, r.id);
          if (orig) link.run(orig.id, orig.id, orig.id, r.id);
        }
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_mov_product ON stock_movements(product_id, id);
        CREATE INDEX IF NOT EXISTS idx_mov_created ON stock_movements(created_at);
        CREATE INDEX IF NOT EXISTS idx_mov_type ON stock_movements(type, created_at);
        CREATE INDEX IF NOT EXISTS idx_mov_order ON stock_movements(order_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mov_reverses ON stock_movements(reverses_movement_id)
          WHERE reverses_movement_id IS NOT NULL;

        -- Kardex é imutável: correção é sempre um estorno.
        CREATE TRIGGER IF NOT EXISTS mov_no_update BEFORE UPDATE ON stock_movements
        BEGIN SELECT RAISE(ABORT, 'Movimentações não podem ser alteradas. Faça um estorno.'); END;
        CREATE TRIGGER IF NOT EXISTS mov_no_delete BEFORE DELETE ON stock_movements
        BEGIN SELECT RAISE(ABORT, 'Movimentações não podem ser apagadas. Faça um estorno.'); END;

        -- Saldo nunca negativo, e produto sem unidades não pode ter valor ("centavo fantasma").
        CREATE TRIGGER IF NOT EXISTS products_stock_guard BEFORE UPDATE OF stock_units, stock_value_cents ON products
        WHEN NEW.stock_units < 0 OR NEW.stock_value_cents < 0 OR (NEW.stock_units = 0 AND NEW.stock_value_cents <> 0)
        BEGIN SELECT RAISE(ABORT, 'Saldo de estoque inválido (negativo ou valor sem unidades).'); END;
      `);

      const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      setDefault.run('out_note_threshold_cents', '20000');
      setDefault.run('default_supplier', 'Franqueadora Oggi');
    },
  },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function currentVersion(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 1;
}

function hasData(db) {
  return db.prepare('SELECT (SELECT COUNT(*) FROM products) + (SELECT COUNT(*) FROM customers) AS n').get().n > 0;
}

function runMigrations(db, file, { log = console.log } = {}) {
  let version = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > version);
  if (!pending.length) return { from: version, to: version, backup: null };

  let backup = null;
  if (file && file !== ':memory:' && hasData(db)) {
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backup = path.join(dir, `antes-da-versao-${pending[0].version}-${stamp}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    log(`Cópia de segurança do banco salva em ${backup}`);
  }

  const from = version;
  for (const m of pending) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        m.up(db);
        const problems = db.prepare('PRAGMA foreign_key_check').all();
        if (problems.length) throw new Error(`Migração ${m.version}: ${problems.length} referência(s) inválida(s).`);
        db.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(m.version));
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    version = m.version;
    log(`Banco atualizado para a versão ${m.version}: ${m.name}`);
  }
  return { from, to: version, backup };
}

module.exports = { runMigrations, LATEST_VERSION, MOVEMENT_TYPES, MIGRATED_REASON };

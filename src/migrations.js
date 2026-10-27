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

// [chave, nome, exige observação]
const NONSALE_TYPES = [
  ['bonificacao_cliente', 'Bonificação a cliente', 0],
  ['brinde', 'Brinde', 0],
  ['parceria', 'Parceria / patrocínio', 1],
  ['amostra_degustacao', 'Amostra / degustação', 0],
  ['doacao', 'Doação', 1],
  ['consumo_interno', 'Consumo interno', 0],
  ['outros', 'Outros', 1],
];

// Plano de contas inicial: [nome, receita/despesa, linha da DRE (null = não entra na DRE), atividade na DFC]
// Linhas da DRE: receita_bruta, deducoes, despesas_pessoal, despesas_ocupacao, despesas_comerciais,
// despesas_administrativas, receitas_financeiras, despesas_financeiras, outras_receitas, outras_despesas, impostos_lucro.
// Venda B2B, CMV, perdas, brindes e transferências vêm sozinhos do estoque — por isso "Recebimento de clientes B2B"
// e "Pagamento de notas de mercadoria" só entram na DFC (caixa), para não contar duas vezes na DRE.
const FIN_ACCOUNTS = [
  ['Vendas Loja 1 - Centro', 'receita', 'receita_bruta', 'operacional'],
  ['Vendas Loja 2', 'receita', 'receita_bruta', 'operacional'],
  ['Outras vendas', 'receita', 'receita_bruta', 'operacional'],
  ['Recebimento de clientes B2B', 'receita', null, 'operacional'],
  ['Receitas financeiras', 'receita', 'receitas_financeiras', 'operacional'],
  ['Outras receitas', 'receita', 'outras_receitas', 'operacional'],
  ['Empréstimos e aportes recebidos', 'receita', null, 'financiamento'],
  ['Impostos sobre vendas (Simples/ICMS)', 'despesa', 'deducoes', 'operacional'],
  ['Devoluções e descontos concedidos', 'despesa', 'deducoes', 'operacional'],
  ['Pagamento de notas de mercadoria', 'despesa', null, 'operacional'],
  ['Salários e encargos', 'despesa', 'despesas_pessoal', 'operacional'],
  ['Pró-labore', 'despesa', 'despesas_pessoal', 'operacional'],
  ['Aluguel e condomínio', 'despesa', 'despesas_ocupacao', 'operacional'],
  ['Energia elétrica', 'despesa', 'despesas_ocupacao', 'operacional'],
  ['Água, internet e telefone', 'despesa', 'despesas_ocupacao', 'operacional'],
  ['Royalties e taxas da franquia', 'despesa', 'despesas_comerciais', 'operacional'],
  ['Fundo de propaganda / marketing', 'despesa', 'despesas_comerciais', 'operacional'],
  ['Taxas de cartão e meios de pagamento', 'despesa', 'despesas_comerciais', 'operacional'],
  ['Fretes e entregas', 'despesa', 'despesas_comerciais', 'operacional'],
  ['Manutenção de equipamentos', 'despesa', 'despesas_administrativas', 'operacional'],
  ['Contabilidade e sistemas', 'despesa', 'despesas_administrativas', 'operacional'],
  ['Outras despesas administrativas', 'despesa', 'despesas_administrativas', 'operacional'],
  ['Juros e tarifas bancárias', 'despesa', 'despesas_financeiras', 'operacional'],
  ['Outras despesas', 'despesa', 'outras_despesas', 'operacional'],
  ['IRPJ / CSLL', 'despesa', 'impostos_lucro', 'operacional'],
  ['Compra de equipamentos', 'despesa', null, 'investimento'],
  ['Pagamento de empréstimos', 'despesa', null, 'financiamento'],
  ['Distribuição de lucros', 'despesa', null, 'financiamento'],
];

const MOVEMENT_TYPES = [
  'entrada', 'saida_pedido', 'transferencia', 'perda', 'saida_sem_venda',
  'sobra_inventario', 'divergencia_inventario', 'abertura_custo', 'estorno',
];

const MOV_DELETE_GUARD = `
  CREATE TRIGGER IF NOT EXISTS mov_no_delete BEFORE DELETE ON stock_movements
  BEGIN SELECT RAISE(ABORT, 'Movimentações não podem ser apagadas. Faça um estorno.'); END;`;

// Produtos de exemplo da 1ª versão do sistema (scripts/seed-demo.js antigo): SKU EX001…, nome "… (exemplo)".
const LEGACY_DEMO_PRODUCTS = "sku GLOB 'EX[0-9][0-9][0-9]' AND name LIKE '% (exemplo)'";

// Códigos de barras fictícios usados pelos dados de teste (src/test-data.js), de unidade e de caixa.
const TEST_BARCODES = ['7890000000011', '17890000000018', '7890000000028', '17890000000025', '7890000000059', '17890000000056'];

// Loja 2: loja física ligada à câmara. Por enquanto é o único cliente; no futuro os pedidos dela
// viram transferência da câmara para o estoque da loja.
const LOJA2 = {
  cnpj: '63532954000246',
  razao_social: 'Oggi Sorvetes - Loja 2',
  nome_fantasia: 'Loja 2',
  notes: 'Loja própria ligada à câmara. Os pedidos dela vão virar transferência para o estoque da loja (a desenvolver).',
};

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
        ${MOV_DELETE_GUARD}

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
  {
    version: 3,
    name: 'Remove os produtos de exemplo da 1ª versão e a opção de mostrar quantidade ao cliente',
    up(db) {
      // O cliente não vê mais a quantidade em estoque (só disponível/esgotado).
      db.prepare("DELETE FROM settings WHERE key = 'show_stock_quantity'").run();

      const ids = db.prepare(`SELECT id FROM products WHERE ${LEGACY_DEMO_PRODUCTS}`).all().map((r) => r.id);
      if (!ids.length) return;
      const list = ids.join(',');
      const orders = db.prepare(`SELECT DISTINCT order_id AS id FROM order_items WHERE product_id IN (${list})`).all().map((r) => r.id);
      // Produtos de teste saem por inteiro, com o histórico deles. O resto do kardex continua imutável.
      db.exec('DROP TRIGGER IF EXISTS mov_no_delete');
      db.exec(`DELETE FROM stock_movements WHERE product_id IN (${list})`);
      db.exec(MOV_DELETE_GUARD);
      db.exec(`DELETE FROM product_images WHERE product_id IN (${list})`);
      db.exec(`DELETE FROM order_items WHERE product_id IN (${list})`);
      for (const orderId of orders) {
        const left = db.prepare('SELECT COUNT(*) n FROM order_items WHERE order_id = ?').get(orderId).n;
        if (left) {
          db.prepare('UPDATE orders SET total_cents = (SELECT SUM(subtotal_cents) FROM order_items WHERE order_id = ?) WHERE id = ?').run(orderId, orderId);
        } else if (!db.prepare('SELECT 1 FROM stock_movements WHERE order_id = ? LIMIT 1').get(orderId)) {
          db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
        }
      }
      db.exec(`DELETE FROM products WHERE id IN (${list})`);
    },
  },
  {
    version: 4,
    name: 'Perfis de usuário (master/loja), tipos de saída sem venda editáveis e financeiro (DRE/DFC)',
    up(db) {
      // ---- perfis: quem já existia vira master
      const cols = db.prepare('PRAGMA table_info(admins)').all().map((c) => c.name);
      if (!cols.includes('role')) db.exec("ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'master'");
      if (!cols.includes('location_id')) db.exec('ALTER TABLE admins ADD COLUMN location_id INTEGER REFERENCES locations(id)');
      if (!cols.includes('active')) db.exec('ALTER TABLE admins ADD COLUMN active INTEGER NOT NULL DEFAULT 1');

      // ---- tipos de saída sem venda (antes fixos no código)
      db.exec(`
        CREATE TABLE IF NOT EXISTS nonsale_types (
          key           TEXT PRIMARY KEY,
          label         TEXT NOT NULL,
          requires_note INTEGER NOT NULL DEFAULT 0,
          active        INTEGER NOT NULL DEFAULT 1,
          sort          INTEGER NOT NULL DEFAULT 0
        );
      `);
      const insType = db.prepare('INSERT OR IGNORE INTO nonsale_types (key, label, requires_note, sort) VALUES (?, ?, ?, ?)');
      NONSALE_TYPES.forEach(([key, label, note], i) => insType.run(key, label, note, i + 1));

      // ---- financeiro: plano de contas e lançamentos
      db.exec(`
        CREATE TABLE IF NOT EXISTS fin_accounts (
          id           INTEGER PRIMARY KEY,
          name         TEXT NOT NULL UNIQUE,
          kind         TEXT NOT NULL CHECK (kind IN ('receita', 'despesa')),
          dre_group    TEXT,
          dfc_activity TEXT CHECK (dfc_activity IS NULL OR dfc_activity IN ('operacional', 'investimento', 'financiamento')),
          active       INTEGER NOT NULL DEFAULT 1,
          sort         INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS fin_entries (
          id              INTEGER PRIMARY KEY,
          account_id      INTEGER NOT NULL REFERENCES fin_accounts(id),
          description     TEXT NOT NULL,
          amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
          competence_date TEXT NOT NULL,
          due_date        TEXT,
          paid_date       TEXT,
          location_id     INTEGER REFERENCES locations(id),
          counterparty    TEXT,
          document        TEXT,
          note            TEXT,
          created_by      TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_fin_competence ON fin_entries(competence_date);
        CREATE INDEX IF NOT EXISTS idx_fin_paid ON fin_entries(paid_date);
      `);
      const insAcc = db.prepare('INSERT OR IGNORE INTO fin_accounts (name, kind, dre_group, dfc_activity, sort) VALUES (?, ?, ?, ?, ?)');
      FIN_ACCOUNTS.forEach(([name, kind, dre, dfc], i) => insAcc.run(name, kind, dre, dfc, i + 1));

      const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      setDefault.run('cash_opening_cents', '0');
    },
  },
  {
    version: 5,
    name: 'Bancos: contas, extratos OFX, conciliação e regras',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bank_accounts (
          id             INTEGER PRIMARY KEY,
          name           TEXT NOT NULL,
          bank_code      TEXT,
          bank_name      TEXT,
          branch         TEXT,
          account_number TEXT NOT NULL,
          kind           TEXT NOT NULL DEFAULT 'corrente' CHECK (kind IN ('corrente', 'cartao')),
          active         INTEGER NOT NULL DEFAULT 1,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (bank_code, account_number, kind)
        );
        CREATE TABLE IF NOT EXISTS bank_imports (
          id               INTEGER PRIMARY KEY,
          bank_account_id  INTEGER NOT NULL REFERENCES bank_accounts(id),
          file_name        TEXT,
          period_start     TEXT,
          period_end       TEXT,
          ledger_balance_cents INTEGER,
          balance_date     TEXT,
          count_new        INTEGER NOT NULL DEFAULT 0,
          count_duplicate  INTEGER NOT NULL DEFAULT 0,
          created_by       TEXT,
          created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS bank_transactions (
          id              INTEGER PRIMARY KEY,
          bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
          import_id       INTEGER REFERENCES bank_imports(id),
          dedupe_key      TEXT NOT NULL,
          fitid           TEXT,
          posted_date     TEXT NOT NULL,
          amount_cents    INTEGER NOT NULL,
          description     TEXT NOT NULL,
          trntype         TEXT,
          status          TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'conciliado', 'ignorado')),
          entry_id        INTEGER REFERENCES fin_entries(id),
          link_type       TEXT CHECK (link_type IS NULL OR link_type IN ('criado', 'baixado')),
          note            TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (bank_account_id, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS idx_banktx_status ON bank_transactions(status, posted_date);
        CREATE INDEX IF NOT EXISTS idx_banktx_entry ON bank_transactions(entry_id);
        CREATE TABLE IF NOT EXISTS bank_rules (
          id         INTEGER PRIMARY KEY,
          pattern    TEXT NOT NULL UNIQUE,
          account_id INTEGER NOT NULL REFERENCES fin_accounts(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const cols = db.prepare('PRAGMA table_info(fin_entries)').all().map((c) => c.name);
      if (!cols.includes('bank_account_id')) db.exec('ALTER TABLE fin_entries ADD COLUMN bank_account_id INTEGER REFERENCES bank_accounts(id)');
    },
  },
  {
    version: 6,
    name: 'Começo limpo: apaga movimentações, pedidos e lançamentos de teste; único cliente é a Loja 2',
    up(db) {
      // Estoque zerado: kardex e pedidos saem inteiros. Produtos, fotos, locais, motivos e plano de contas ficam.
      db.exec('DROP TRIGGER IF EXISTS mov_no_delete');
      db.exec('DELETE FROM stock_movements');
      db.exec(MOV_DELETE_GUARD);
      db.exec('DELETE FROM order_items; DELETE FROM orders;');
      db.exec('UPDATE products SET stock_units = 0, stock_value_cents = 0, has_cost = 0');
      // códigos de barras fictícios dos dados de teste
      const fake = TEST_BARCODES.map((c) => `'${c}'`).join(',');
      db.exec(`UPDATE products SET barcode = NULL WHERE barcode IN (${fake})`);
      db.exec(`UPDATE products SET box_barcode = NULL WHERE box_barcode IN (${fake})`);

      // Financeiro e bancos: lançamentos, extratos, contas bancárias e regras aprendidas.
      db.exec('DELETE FROM bank_transactions; DELETE FROM bank_imports; DELETE FROM bank_rules; DELETE FROM fin_entries; DELETE FROM bank_accounts;');
      db.prepare("UPDATE settings SET value = '0' WHERE key = 'cash_opening_cents'").run();
      db.prepare("DELETE FROM settings WHERE key = 'test_stock_loaded'").run();

      // Clientes: fica só a Loja 2. Sem senha até o master definir uma em Clientes → Editar.
      db.prepare("DELETE FROM sessions WHERE user_type = 'customer'").run();
      db.prepare('DELETE FROM customers WHERE cnpj <> ?').run(LOJA2.cnpj);
      db.prepare(`INSERT OR IGNORE INTO customers (cnpj, razao_social, nome_fantasia, cidade, password_hash, status, notes)
        VALUES (?, ?, ?, 'Sinop', '!', 'ativo', ?)`).run(LOJA2.cnpj, LOJA2.razao_social, LOJA2.nome_fantasia, LOJA2.notes);

      // numeração recomeça do 1 (pedido #1, lançamento #1…)
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
        db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('stock_movements', 'orders', 'order_items', 'fin_entries',
          'bank_accounts', 'bank_imports', 'bank_transactions', 'bank_rules', 'customers')`);
      }
    },
  },
  {
    version: 7,
    name: 'Corrige o CNPJ da Loja 2',
    up(db) {
      // A versão 6 foi ao ar com um dígito trocado (65.532.954/0002-46).
      if (db.prepare('SELECT 1 FROM customers WHERE cnpj = ?').get(LOJA2.cnpj)) return;
      db.prepare("UPDATE customers SET cnpj = ? WHERE cnpj = '65532954000246'").run(LOJA2.cnpj);
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

// upTo: para os testes pararem numa versão intermediária.
function runMigrations(db, file, { log = console.log, upTo = LATEST_VERSION } = {}) {
  let version = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > version && m.version <= upTo);
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

module.exports = { runMigrations, LATEST_VERSION, LOJA2, TEST_BARCODES, MOVEMENT_TYPES, MIGRATED_REASON, NONSALE_TYPES, FIN_ACCOUNTS };

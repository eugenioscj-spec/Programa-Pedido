'use strict';

// Migrações versionadas do banco. Rodam ao iniciar, são idempotentes e fazem
// uma cópia do arquivo do banco antes de mexer em qualquer coisa.
//
// Para criar uma nova: adicione { version: N, name, up(db) } ao final da lista.

const fs = require('node:fs');
const path = require('node:path');
const { productTypeOf } = require('./catalog');

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

// Quem pode excluir pedidos (inclusive entregues) desde o início; depois ele pode liberar outros masters.
const ORDER_DELETER_EMAIL = 'eugenio.scj@gmail.com';

// Picolés Disney: o personagem da embalagem passa a fazer parte do nome.
const DISNEY_NAMES = [
  ['disney-leite-cacau', 'Picolé Disney Leite com Cacau', 'Picolé Disney Mickey Leite com Cacau'],
  ['disney-morango', 'Picolé Disney Morango', 'Picolé Disney Minnie Morango'],
  ['disney-caramelo', 'Picolé Disney Caramelo', 'Picolé Disney Woody Caramelo'],
  ['disney-morango-baunilha', 'Picolé Disney Leite com Morango e Baunilha', 'Picolé Disney Jessie Leite com Morango e Baunilha'],
  ['disney-uva', 'Picolé Disney Uva Roxa', 'Picolé Disney Ariel Uva Roxa'],
  ['disney-baunilha', 'Picolé Disney Baunilha', 'Picolé Disney Linguado Baunilha'],
  ['disney-iogurte-morango', 'Picolé Disney Iogurte de Morango', 'Picolé Disney Homem-Aranha Iogurte de Morango'],
  ['disney-iogurte-frutas-vermelhas', 'Picolé Disney Iogurte de Frutas Vermelhas', 'Picolé Disney Spider-Gwen Iogurte de Frutas Vermelhas'],
];

// Inventário físico da câmara em 13/11/2026, em CAIXAS fechadas (folhas de contagem conferidas pelo dono).
// Produto que não está aqui ficou com zero.
const INVENTORY_2026_11_13 = [
  ['OG26-REGIONAIS-CAJA', 6], // Picolé Regionais Cajá
  ['OG26-REGIONAIS-CAJU', 6], // Picolé Regionais Caju
  ['OG26-REGIONAIS-GRAVIOLA', 8], // Picolé Regionais Graviola
  ['OG26-REGIONAIS-CUPUACU', 15], // Picolé Regionais Cupuaçu
  ['OG26-REGIONAIS-TAPIOCA', 12], // Picolé Regionais Tapioca
  ['OG26-FAZENDA-AMENDOIM', 11], // Picolé Fazenda Amendoim
  ['OG26-FAZENDA-COCO', 11], // Picolé Fazenda Coco
  ['OG26-FAZENDA-COCO-QUEIMADO', 11], // Picolé Fazenda Coco Queimado
  ['OG26-FAZENDA-DOCE-DE-LEITE', 13], // Picolé Fazenda Doce de Leite
  ['OG26-FAZENDA-MILHO-VERDE', 14], // Picolé Fazenda Milho Verde
  ['OG26-DELICIA-ABACAXI-VINHO', 15], // Picolé Delícia Abacaxi ao Vinho
  ['OG26-DELICIA-BEIJINHO', 14], // Picolé Delícia Beijinho
  ['OG26-DELICIA-CHOCOLATE', 13], // Picolé Delícia Chocolate
  ['OG26-DELICIA-IOGURTE-FRUTAS-VERMELHAS', 15], // Picolé Delícia Iogurte com Frutas Vermelhas
  ['OG26-DELICIA-MOUSSE-MARACUJA', 13], // Picolé Delícia Mousse de Maracujá
  ['OG26-DELICIA-QUEIJO-GOIABADA', 18], // Picolé Delícia Queijo com Goiabada
  ['OG26-DELICIA-TORTA-LIMAO', 17], // Picolé Delícia Torta de Limão
  ['OG26-SELECOES-CARIOCA', 4], // Pote Seleções Carioca
  ['OG26-SELECOES-CHOCOLATE', 9], // Pote Seleções Chocolate
  ['OG26-SELECOES-PASSAS-RUM', 6], // Pote Seleções Passas ao Rum
  ['OG26-SELECOES-FLOCOS', 4], // Pote Seleções Flocos
  ['OG26-FESTA-POTE-TRIO-YOGO', 12], // Pote Festa Trio Yogo
  ['OG26-NETFLIX-MUNDO-INVERTIDO', 6], // Picolé Chocolate do Mundo Invertido
  ['OG26-NETFLIX-DEMOGORGON', 8], // Picolé Demogorgon Freeze
  ['OG26-NETFLIX-TOP-HIT', 6], // Picolé Top Hit de Hawkins
  ['OG26-TRADICIONAIS-NAPOLITANO', 8], // Pote Tradicionais Napolitano
  ['OG26-DISNEY-LEITE-CACAU', 9], // Picolé Disney Mickey Leite com Cacau
  ['OG26-DISNEY-UVA', 12], // Picolé Disney Ariel Uva Roxa
  ['OG26-DISNEY-MORANGO-BAUNILHA', 4], // Picolé Disney Jessie Leite com Morango e Baunilha
  ['OG26-DISNEY-IOGURTE-MORANGO', 8], // Picolé Disney Homem-Aranha Iogurte de Morango
  ['OG26-DISNEY-IOGURTE-FRUTAS-VERMELHAS', 13], // Picolé Disney Spider-Gwen Iogurte de Frutas Vermelhas
  ['OG26-HK-TUTTI-FRUTTI', 16], // Picolé Hello Kitty Tutti-Frutti
  ['OG26-HK-PINTA-LINGUA', 16], // Picolé Hello Kitty Pinta-Língua
  ['OG26-FESTA-FRUTAS-VERMELHAS', 36], // Picolé Festa Frutas Vermelhas
  ['OG26-FESTA-MELANCIA', 30], // Picolé Festa Melancia
  ['OG26-FESTA-GROSELHA', 29], // Picolé Festa Groselha
  ['OG26-FESTA-ACHOCOLATADO', 28], // Picolé Festa Achocolatado
  ['OG26-FESTA-IOGURTE', 33], // Picolé Festa Iogurte
  ['OG26-FESTA-LEITE-CONDENSADO', 28], // Picolé Festa Leite Condensado
  ['OG26-ZERO-ACAI', 5], // Picolé Zero Açaí
  ['OG26-ZERO-AMENDOIM', 8], // Picolé Zero Amendoim
  ['OG26-ZERO-CHOCOLATE', 7], // Picolé Zero Chocolate
  ['OG26-ZERO-COCO', 6], // Picolé Zero Coco
  ['OG26-ZERO-LIMAO', 14], // Picolé Zero Limão
  ['OG26-ZERO-MILHO', 6], // Picolé Zero Milho Verde
  ['OG26-FRUTOS-ABACAXI', 8], // Picolé Frutos Abacaxi
  ['OG26-FRUTOS-ACAI', 16], // Picolé Frutos Açaí
  ['OG26-FRUTOS-GOIABA', 7], // Picolé Frutos Goiaba
  ['OG26-FRUTOS-LIMAO', 18], // Picolé Frutos Limão
  ['OG26-FRUTOS-MANGA', 8], // Picolé Frutos Manga
  ['OG26-FRUTOS-MORANGO', 20], // Picolé Frutos Morango
  ['OG26-FRUTOS-UVA', 16], // Picolé Frutos Uva
  ['OG26-CLASSICOS-BOMBOM', 24], // Picolé Clássicos Bombom no Palito
  ['OG26-CLASSICOS-BRIGADEIRO', 24], // Picolé Clássicos Brigadeiro
  ['OG26-SENSA-BRIGADEIRO', 10], // Picolé Sensa Brigadeiro
  ['OG26-SENSA-CHOCO-AMENDOIM', 16], // Picolé Sensa Choco Amendoim
  ['OG26-SENSA-CHOCOLATE-BRANCO', 13], // Picolé Sensa Chocolate Branco
  ['OG26-SENSA-CHOCO-MENTA', 14], // Picolé Sensa Choco Menta
  ['OG26-SENSA-CLASSICO', 13], // Picolé Sensa Clássico
  ['OG26-SENSA-FRUTAS-VERMELHAS', 8], // Picolé Sensa Frutas Vermelhas
  ['OG26-SENSA-MEIO-AMARGO', 9], // Picolé Sensa Meio Amargo
  ['OG26-SUNDAE-MORANGO', 8], // Top Sundae Morango
  ['OG26-SUNDAE-CHOCOLATE', 8], // Top Sundae Chocolate
  ['OG26-SENSA-BOMBOM-CLASSICO', 4], // Sensa Bombom Clássico
  ['OG26-GIRATTO-AVELA-TRUFADO', 12], // Cone Giratto Avelã Trufado
  ['OG26-GIRATTO-CROCANTE', 6], // Cone Giratto Crocante
  ['OG26-GIRATTO-LEITE-TRUFADO', 8], // Cone Giratto Leite Trufado
  ['OG26-DUETTO-CHOCOLATE-TRUFA', 3], // Pote Duetto Chocolate com Trufa
  ['OG26-DUETTO-FRUTAS-VERMELHAS', 4], // Pote Duetto Frutas Vermelhas
  ['OG26-DUETTO-LEITINHO-TRUFADO', 12], // Pote Duetto Leitinho Trufado
  ['OG26-DUETTO-MOUSSE-MARACUJA', 8], // Pote Duetto Mousse de Maracujá
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
  {
    version: 8,
    name: 'Tipo do produto (Picolés › linha), favoritos e linhas liberadas por cliente, Disney com personagem, açaí 200g com 12/cx',
    up(db) {
      const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
      if (!cols.includes('product_type')) db.exec("ALTER TABLE products ADD COLUMN product_type TEXT NOT NULL DEFAULT 'Outros'");
      const setType = db.prepare('UPDATE products SET product_type = ? WHERE id = ?');
      for (const p of db.prepare('SELECT id, name FROM products').all()) setType.run(productTypeOf(p.name), p.id);

      // Linhas que o cliente pode ver e pedir. NULL = todas. Lista JSON de "Tipo" (o tipo inteiro,
      // inclusive linhas novas) ou "Tipo|Linha" (só aquela linha).
      const ccols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
      if (!ccols.includes('allowed_lines')) db.exec('ALTER TABLE customers ADD COLUMN allowed_lines TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS customer_favorites (
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (customer_id, product_id)
        );
      `);

      // Disney: nome do personagem da embalagem no nome (só se o nome ainda for o do catálogo).
      for (const [slug, from, to] of DISNEY_NAMES) {
        db.prepare('UPDATE products SET name = ? WHERE sku = ? AND name = ?').run(to, `OG26-${slug.toUpperCase()}`, from);
      }
      // Açaí 200g: 12 unidades por caixa. O preço da caixa acompanha (unidade × 12), como no catálogo.
      db.prepare(`UPDATE products SET units_per_box = 12, box_price_cents = unit_price_cents * 12, updated_at = datetime('now')
        WHERE sku IN ('OG26-ACAI-200-BANANA', 'OG26-ACAI-200-GUARANA') AND units_per_box = 4`).run();
    },
  },
  {
    version: 9,
    name: 'Contas recorrentes no Financeiro',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fin_recurrences (
          id                INTEGER PRIMARY KEY,
          account_id        INTEGER NOT NULL REFERENCES fin_accounts(id),
          description       TEXT NOT NULL,
          amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
          start_date        TEXT NOT NULL,              -- 1º vencimento; o dia dele é o dia de todo mês
          interval_months   INTEGER NOT NULL DEFAULT 1, -- 1 mensal, 2, 3, 6, 12 anual
          end_date          TEXT,                       -- NULL = sem fim
          competence_offset INTEGER NOT NULL DEFAULT 0, -- -1 = competência no mês anterior ao vencimento
          location_id       INTEGER REFERENCES locations(id),
          counterparty      TEXT,
          document          TEXT,
          note              TEXT,
          active            INTEGER NOT NULL DEFAULT 1,
          generated_until   TEXT,                       -- último vencimento já lançado
          created_by        TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const cols = db.prepare('PRAGMA table_info(fin_entries)').all().map((c) => c.name);
      if (!cols.includes('recurrence_id')) db.exec('ALTER TABLE fin_entries ADD COLUMN recurrence_id INTEGER REFERENCES fin_recurrences(id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_fin_recurrence ON fin_entries(recurrence_id, due_date)');
    },
  },
  {
    version: 10,
    name: 'Contas e saldos (bancos, cofre, caixas das lojas), transferências e contas a receber B2B',
    up(db) {
      const acols = db.prepare('PRAGMA table_info(bank_accounts)').all().map((c) => c.name);
      // type: banco (com ou sem extrato OFX), cofre, caixa (de uma loja)
      if (!acols.includes('type')) db.exec("ALTER TABLE bank_accounts ADD COLUMN type TEXT NOT NULL DEFAULT 'banco'");
      if (!acols.includes('opening_balance_cents')) db.exec('ALTER TABLE bank_accounts ADD COLUMN opening_balance_cents INTEGER');
      if (!acols.includes('opening_date')) db.exec('ALTER TABLE bank_accounts ADD COLUMN opening_date TEXT');
      if (!acols.includes('location_id')) db.exec('ALTER TABLE bank_accounts ADD COLUMN location_id INTEGER REFERENCES locations(id)');
      db.exec(`
        CREATE TABLE IF NOT EXISTS fin_transfers (
          id              INTEGER PRIMARY KEY,
          from_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
          to_account_id   INTEGER NOT NULL REFERENCES bank_accounts(id),
          amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
          date            TEXT NOT NULL,
          note            TEXT,
          created_by      TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_transfer_date ON fin_transfers(date);
      `);
      const ins = db.prepare("INSERT OR IGNORE INTO bank_accounts (name, account_number, kind, type, location_id) VALUES (?, ?, 'corrente', ?, ?)");
      ins.run('Cofre', 'COFRE', 'cofre', null);
      for (const l of db.prepare("SELECT id, name FROM locations WHERE kind = 'loja' AND active = 1").all()) {
        ins.run(`Caixa ${l.name}`, `CAIXA-${l.id}`, 'caixa', l.id);
      }

      // Contas a receber dos pedidos B2B entregues
      const ecols = db.prepare('PRAGMA table_info(fin_entries)').all().map((c) => c.name);
      if (!ecols.includes('order_id')) db.exec('ALTER TABLE fin_entries ADD COLUMN order_id INTEGER REFERENCES orders(id)');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_order ON fin_entries(order_id) WHERE order_id IS NOT NULL');
      const ccols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
      // prazo em dias; NULL = o padrão da configuração; -1 = não gera conta a receber (loja própria)
      if (!ccols.includes('payment_days')) db.exec('ALTER TABLE customers ADD COLUMN payment_days INTEGER');
      db.prepare('UPDATE customers SET payment_days = -1 WHERE cnpj = ?').run(LOJA2.cnpj);
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('b2b_payment_days', '30')").run();
    },
  },
  {
    version: 11,
    name: 'Exclusão de pedido com o ciclo desfeito (permissão por usuário) e CRM',
    up(db) {
      const ocols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
      if (!ocols.includes('deleted_at')) db.exec('ALTER TABLE orders ADD COLUMN deleted_at TEXT');
      if (!ocols.includes('deleted_by')) db.exec('ALTER TABLE orders ADD COLUMN deleted_by TEXT');
      if (!ocols.includes('delete_reason')) db.exec('ALTER TABLE orders ADD COLUMN delete_reason TEXT');
      const acols = db.prepare('PRAGMA table_info(admins)').all().map((c) => c.name);
      if (!acols.includes('can_delete_orders')) db.exec('ALTER TABLE admins ADD COLUMN can_delete_orders INTEGER NOT NULL DEFAULT 0');
      db.prepare("UPDATE admins SET can_delete_orders = 1 WHERE lower(email) = ? AND role = 'master'").run(ORDER_DELETER_EMAIL);

      db.exec(`
        CREATE TABLE IF NOT EXISTS crm_interactions (
          id               INTEGER PRIMARY KEY,
          customer_id      INTEGER REFERENCES customers(id),
          prospect_name    TEXT,                  -- contato com quem ainda não é cliente
          kind             TEXT NOT NULL DEFAULT 'visita' CHECK (kind IN ('visita', 'ligacao', 'whatsapp', 'email', 'reuniao', 'outro')),
          date             TEXT NOT NULL,
          contact_person   TEXT,
          summary          TEXT NOT NULL,
          next_action      TEXT,
          next_action_date TEXT,
          next_done        INTEGER NOT NULL DEFAULT 0,
          created_by       TEXT,
          created_at       TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (customer_id IS NOT NULL OR prospect_name IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS idx_crm_customer ON crm_interactions(customer_id, date);
        CREATE INDEX IF NOT EXISTS idx_crm_next ON crm_interactions(next_done, next_action_date);
      `);
    },
  },
  {
    version: 12,
    name: 'Novo começo do estoque: apaga pedidos e histórico do estoque; inventário de 13/11/2026 (aplicado ao iniciar)',
    up(db) {
      // Contas a receber dos pedidos: desfaz a conciliação com o banco e apaga.
      const entries = db.prepare('SELECT id FROM fin_entries WHERE order_id IS NOT NULL').all().map((r) => r.id);
      for (const id of entries) {
        db.prepare("UPDATE bank_transactions SET status = 'pendente', entry_id = NULL, link_type = NULL, note = NULL WHERE entry_id = ?").run(id);
      }
      db.prepare('DELETE FROM fin_entries WHERE order_id IS NOT NULL').run();
      // Pedidos e todo o histórico do estoque. Clientes, produtos, CRM e o resto do Financeiro ficam.
      db.exec('DROP TRIGGER IF EXISTS mov_no_delete');
      db.exec('DELETE FROM stock_movements');
      db.exec(MOV_DELETE_GUARD);
      db.exec('DELETE FROM order_items; DELETE FROM orders;');
      db.exec('UPDATE products SET stock_units = 0, stock_value_cents = 0, has_cost = 0');
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
        db.exec("DELETE FROM sqlite_sequence WHERE name IN ('stock_movements', 'orders', 'order_items')");
      }
      // A contagem entra logo depois de o sistema iniciar (applyPendingInventory), já com os produtos carregados.
      db.prepare("INSERT INTO settings (key, value) VALUES ('pending_inventory', '2026-11-13') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    },
  },
  {
    version: 13,
    name: 'Picolé Top Hit de Hawkins: 33 unidades por caixa',
    up(db) {
      const p = db.prepare("SELECT * FROM products WHERE sku = 'OG26-NETFLIX-TOP-HIT'").get();
      if (!p || p.units_per_box === 33) return;
      // preço da caixa calculado (unidade × quantidade) acompanha; preço de caixa digitado à mão fica
      const boxDerived = p.box_price_cents === p.unit_price_cents * p.units_per_box;
      db.prepare("UPDATE products SET units_per_box = 33, box_price_cents = ?, updated_at = datetime('now') WHERE id = ?")
        .run(boxDerived ? p.unit_price_cents * 33 : p.box_price_cents, p.id);
      // O inventário de 13/11 já entrou com 39 por caixa (6 cx = 234 un): corrige para 6 × 33 = 198 un.
      const movs = db.prepare('SELECT * FROM stock_movements WHERE product_id = ?').all(p.id);
      if (p.units_per_box === 39 && p.stock_units === 234 && !p.has_cost && movs.length === 1 && movs[0].type === 'sobra_inventario') {
        db.prepare('UPDATE products SET stock_units = 198 WHERE id = ?').run(p.id);
        db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, balance_after, note, created_by)
          VALUES (?, 'divergencia_inventario', -36, 198, ?, 'Inventário')`)
          .run(p.id, 'Correção do inventário de 13/11: a caixa do Top Hit tem 33 un (6 cx = 198 un)');
      }
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
// Lança o inventário pendente (migração 12) quando os produtos já existem: estoque sem custo, em
// unidades = caixas × unidades por caixa do cadastro. Roda uma vez; o custo é informado depois em Estoque.
function applyPendingInventory(db, { log = console.log } = {}) {
  const pending = db.prepare("SELECT value FROM settings WHERE key = 'pending_inventory'").get();
  if (!pending || pending.value !== '2026-11-13') return null;
  if (!db.prepare('SELECT COUNT(*) n FROM products').get().n) return null;
  const at = '2026-11-13 16:00:00'; // 12h em Cuiabá
  const note = 'Inventário de 13/11/2026 (contagem física da câmara, em caixas)';
  let products = 0;
  let units = 0;
  const missing = [];
  db.transaction(() => {
    for (const [sku, boxes] of INVENTORY_2026_11_13) {
      const p = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
      if (!p) { missing.push(sku); continue; }
      if (p.stock_units !== 0) continue;
      const qty = boxes * p.units_per_box;
      db.prepare('UPDATE products SET stock_units = ?, stock_value_cents = 0, has_cost = 0 WHERE id = ?').run(qty, p.id);
      db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, balance_after, note, created_by, created_at)
        VALUES (?, 'sobra_inventario', ?, ?, ?, 'Inventário', ?)`).run(p.id, qty, qty, note, at);
      products += 1;
      units += qty;
    }
    db.prepare("DELETE FROM settings WHERE key = 'pending_inventory'").run();
  })();
  log(`Inventário de 13/11/2026 lançado: ${products} produto(s), ${units} unidades.${missing.length ? ` Sem cadastro: ${missing.join(', ')}` : ''}`);
  return { products, units, missing };
}

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

module.exports = { runMigrations, applyPendingInventory, INVENTORY_2026_11_13, LATEST_VERSION, LOJA2, TEST_BARCODES, ORDER_DELETER_EMAIL, MOVEMENT_TYPES, MIGRATED_REASON, NONSALE_TYPES, FIN_ACCOUNTS };

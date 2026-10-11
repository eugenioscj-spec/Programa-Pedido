'use strict';

// Cria dados de EXEMPLO para testar o sistema (produtos fictícios, um cliente e estoque inicial).
// Uso: npm run seed   (não roda se já houver produtos cadastrados)

const { openDatabase } = require('../src/db');
const { createInventory } = require('../src/inventory');
const { hashPassword } = require('../src/auth');

const db = openDatabase();

if (db.prepare('SELECT COUNT(*) n FROM products').get().n > 0) {
  console.log('Já existem produtos cadastrados. Nada foi feito.');
  process.exit(0);
}

// [nome, categoria, EAN unidade, código caixa, un/caixa, preço un, preço caixa, estoque inicial em caixas]
const demo = [
  ['Picolé Chocolate (exemplo)', 'Picolés', '7890000000011', '17890000000018', 24, 450, 9800, 10],
  ['Picolé Morango (exemplo)', 'Picolés', '7890000000028', '17890000000025', 24, 450, 9800, 8],
  ['Picolé Limão (exemplo)', 'Picolés', '7890000000035', '17890000000032', 24, 400, 8800, 6],
  ['Cone Crocante Baunilha (exemplo)', 'Cones', '7890000000042', '17890000000049', 12, 800, 8900, 5],
  ['Pote 1,5 L Flocos (exemplo)', 'Potes', '7890000000059', '17890000000056', 6, 3200, 17900, 4],
  ['Pote 1,5 L Napolitano (exemplo)', 'Potes', '7890000000066', '17890000000063', 6, 3200, 17900, 4],
  ['Açaí 2 L (exemplo)', 'Açaí', '7890000000073', '17890000000070', 4, 4500, 16900, 3],
];

const inv = createInventory(db);
const insert = db.prepare(`
  INSERT INTO products (sku, name, category, barcode, box_barcode, units_per_box, unit_price_cents, box_price_cents, min_stock)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

db.transaction(() => {
  demo.forEach(([name, cat, ean, dun, upb, pu, pc, boxes], i) => {
    const id = Number(insert.run(`EX${String(i + 1).padStart(3, '0')}`, name, cat, ean, dun, upb, pu, pc, upb * 2).lastInsertRowid);
    inv.manualMovement({ type: 'entrada', lines: [{ product_id: id, units: boxes * upb }], document: 'NF 0001 (exemplo)', note: 'Estoque inicial de exemplo', user: 'seed' });
  });

  db.prepare(`
    INSERT OR IGNORE INTO customers (cnpj, razao_social, nome_fantasia, contato, telefone, cidade, password_hash, status)
    VALUES ('11222333000181', 'Lanchonete Exemplo LTDA', 'Lanchonete Exemplo', 'Maria', '(11) 99999-0000', 'São Paulo', ?, 'ativo')`)
    .run(hashPassword('cliente123'));
})();

console.log('Dados de exemplo criados.');
console.log('Cliente de teste → CNPJ 11.222.333/0001-81 · senha cliente123');

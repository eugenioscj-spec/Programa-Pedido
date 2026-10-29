'use strict';

// Carrega o Catálogo Oggi 2026 (catalog/oggi-2026.json + fotos em catalog/oggi-2026/).
// Cria só o que ainda não existe (procura pelo SKU OG26-... ou pelo nome).
// Produto já existente não é alterado; se estiver sem foto, recebe a foto do catálogo.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'catalog');
const skuOf = (slug) => `OG26-${slug.toUpperCase()}`;

// Hierarquia do produto: Tipo › Linha (ex.: Picolés › Sensa). A linha é a "categoria" do produto;
// o tipo sai do começo do nome. Ordem em que os tipos aparecem para o cliente:
const PRODUCT_TYPES = ['Picolés', 'Potes', 'Açaí', 'Sundae', 'Cones', 'Bombons'];
function productTypeOf(name) {
  const n = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/^picole/.test(n)) return 'Picolés';
  if (/^pote/.test(n)) return 'Potes';
  if (/^acai/.test(n)) return 'Açaí';
  if (/sundae/.test(n)) return 'Sundae';
  if (/^cone|giratto/.test(n)) return 'Cones';
  if (/bombom|bites/.test(n)) return 'Bombons';
  return 'Outros';
}

function readCatalog() {
  return JSON.parse(fs.readFileSync(path.join(DIR, 'oggi-2026.json'), 'utf8'));
}

function loadOggiCatalog(db, { withImages = true } = {}) {
  const catalog = readCatalog();
  const bySku = db.prepare('SELECT * FROM products WHERE sku = ?');
  const byName = db.prepare('SELECT * FROM products WHERE lower(name) = lower(?)');
  // bancos antigos (antes da versão 8) ainda não têm o tipo; a migração preenche depois
  const hasType = db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'product_type');
  const insert = db.prepare(`
    INSERT INTO products (sku, name, ${hasType ? 'product_type, ' : ''}category, units_per_box, unit_price_cents, box_price_cents,
      retail_price_cents, sell_unit, sell_box, min_stock, active, description)
    VALUES (@sku, @name, ${hasType ? '@product_type, ' : ''}@category, @upb, @price, @box, @price, 1, 1, 0, 1, @desc)`);
  const putImage = db.prepare(`INSERT INTO product_images (product_id, mime, data, updated_at) VALUES (?, 'image/webp', ?, datetime('now'))
    ON CONFLICT(product_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`);
  const stampImage = db.prepare("UPDATE products SET image_updated_at = strftime('%Y%m%d%H%M%f', 'now') WHERE id = ?");

  const result = { created: 0, existing: 0, images: 0, total: catalog.products.length };
  db.transaction(() => {
    for (const item of catalog.products) {
      let p = bySku.get(skuOf(item.slug)) || byName.get(item.name);
      if (p) {
        result.existing++;
      } else {
        const row = { sku: skuOf(item.slug), name: item.name, category: item.category, upb: item.upb, price: item.price,
          box: item.price * item.upb, desc: item.desc || null };
        if (hasType) row.product_type = productTypeOf(item.name);
        const id = Number(insert.run(row).lastInsertRowid);
        p = { id, image_updated_at: null };
        result.created++;
      }
      if (withImages && !p.image_updated_at) {
        const file = path.join(DIR, 'oggi-2026', `${item.slug}.webp`);
        if (fs.existsSync(file)) {
          putImage.run(p.id, fs.readFileSync(file));
          stampImage.run(p.id);
          result.images++;
        }
      }
    }
  })();
  return result;
}

// Linhas liberadas para um cliente (customers.allowed_lines): NULL = tudo; senão lista JSON com
// "Tipo" (o tipo inteiro, inclusive linhas novas) ou "Tipo|Linha" (só aquela linha).
function parseAllowedLines(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map(String) : null;
  } catch {
    return null;
  }
}
function lineFilter(rawAllowed) {
  const list = parseAllowedLines(rawAllowed);
  if (!list) return () => true;
  const set = new Set(list);
  return (p) => set.has(p.product_type) || set.has(`${p.product_type}|${p.category}`);
}

module.exports = { loadOggiCatalog, readCatalog, skuOf, productTypeOf, PRODUCT_TYPES, parseAllowedLines, lineFilter };

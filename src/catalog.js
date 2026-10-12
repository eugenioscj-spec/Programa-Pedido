'use strict';

// Carrega o Catálogo Oggi 2026 (catalog/oggi-2026.json + fotos em catalog/oggi-2026/).
// Cria só o que ainda não existe (procura pelo SKU OG26-... ou pelo nome).
// Produto já existente não é alterado; se estiver sem foto, recebe a foto do catálogo.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'catalog');
const skuOf = (slug) => `OG26-${slug.toUpperCase()}`;

function readCatalog() {
  return JSON.parse(fs.readFileSync(path.join(DIR, 'oggi-2026.json'), 'utf8'));
}

function loadOggiCatalog(db, { withImages = true } = {}) {
  const catalog = readCatalog();
  const bySku = db.prepare('SELECT * FROM products WHERE sku = ?');
  const byName = db.prepare('SELECT * FROM products WHERE lower(name) = lower(?)');
  const insert = db.prepare(`
    INSERT INTO products (sku, name, category, units_per_box, unit_price_cents, box_price_cents, retail_price_cents,
      sell_unit, sell_box, min_stock, active, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 1, ?)`);
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
        const id = Number(insert.run(
          skuOf(item.slug), item.name, item.category, item.upb, item.price, item.price * item.upb, item.price, item.desc || null,
        ).lastInsertRowid);
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

module.exports = { loadOggiCatalog, readCatalog, skuOf };

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const ExcelJS = require('exceljs');
const { getSettings, storageIsPersistent } = require('./db');
const { hashPassword, verifyPassword, createSessionStore, createLoginLimiter } = require('./auth');
const { createInventory, BusinessError, SUBTYPES, OUT_TYPES } = require('./inventory');
const { createReports } = require('./reports');
const { exportReport } = require('./export');
const { loadOggiCatalog } = require('./catalog');
const T = require('./time');
const U = require('./util');

const IMPORT_COLUMNS = [
  ['codigo_barras', 'Código de barras da UNIDADE (EAN, o número embaixo do código no picolé/pote). Obrigatório se não tiver SKU.', 18],
  ['codigo_caixa', 'Código de barras da CAIXA fechada (DUN-14). Opcional.', 18],
  ['sku', 'Código interno/referência da franquia. Opcional.', 10],
  ['nome', 'Nome do produto como o cliente vai ver. Obrigatório.', 34],
  ['categoria', 'Ex.: Picolés, Potes, Cones, Açaí. Agrupa o catálogo.', 14],
  ['unidades_caixa', 'Quantas unidades vêm em uma caixa fechada. Ex.: 24.', 14],
  ['preco_unidade', 'Preço de venda da unidade para o cliente B2B. Ex.: 4,50', 13],
  ['preco_caixa', 'Preço da caixa fechada. Se ficar vazio, usa unidade × quantidade.', 12],
  ['preco_varejo', 'Preço de venda ao consumidor no balcão (opcional). Usado para valorizar o que vai para as lojas.', 12],
  ['estoque_minimo', 'Em UNIDADES. Abaixo disso o painel avisa "estoque baixo".', 14],
  ['vende_unidade', 'sim ou nao: o cliente pode comprar unidade avulsa?', 13],
  ['vende_caixa', 'sim ou nao: o cliente pode comprar caixa fechada?', 12],
];

// Lê a primeira aba de um .xlsx (enviado em base64) como lista de objetos { coluna: texto }.
async function readXlsxRows(base64) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(String(base64), 'base64'));
  } catch {
    throw new BusinessError('Não consegui abrir a planilha. Salve como "Pasta de Trabalho do Excel (.xlsx)" e tente de novo.');
  }
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const text = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map((t) => t.text).join('');
      if (v.result !== undefined) return text(v.result);
      if (v.text !== undefined) return String(v.text);
      if (v instanceof Date) return v.toISOString().slice(0, 10);
    }
    return String(v).trim();
  };
  const header = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { header[col] = text(cell.value).toLowerCase(); });
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const obj = {};
    header.forEach((h, col) => { if (h) obj[h] = text(row.getCell(col).value); });
    if (Object.values(obj).some((v) => v !== '')) rows.push(obj);
  });
  return rows;
}

function createApp(db, { testMode = false } = {}) {
  const app = express();
  const sessions = createSessionStore(db);
  const inv = createInventory(db);
  const reports = createReports(db);
  const loginLimiter = createLoginLimiter();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '15mb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // ---------- helpers ----------
  const PRODUCT_COLS = `p.*,
    (SELECT COALESCE(SUM(oi.units_total), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = p.id AND o.status IN ('novo', 'confirmado')) AS reserved_units`;

  const withAvailability = (p) => ({ ...p, available_units: p.stock_units - p.reserved_units, image_url: imageUrl(p) });
  const imageUrl = (p) => (p.image_updated_at ? `/img/produto/${p.id}?v=${encodeURIComponent(p.image_updated_at)}` : null);

  function requireAdmin(req, res, next) {
    const id = sessions.userId(req, 'admin');
    const admin = id && db.prepare('SELECT id, name, email FROM admins WHERE id = ?').get(id);
    if (!admin) return res.status(401).json({ error: 'Faça login no painel.' });
    req.admin = admin;
    next();
  }

  function requireCustomer(req, res, next) {
    const id = sessions.userId(req, 'customer');
    const c = id && db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) return res.status(401).json({ error: 'Faça login para continuar.' });
    if (c.status !== 'ativo') {
      return res.status(403).json({
        error: c.status === 'pendente'
          ? 'Seu cadastro está em análise. Você será avisado assim que for liberado.'
          : 'Seu acesso está bloqueado. Fale com a loja.',
      });
    }
    req.customer = c;
    next();
  }

  const publicCustomer = (c) => {
    const { password_hash, notes, ...rest } = c;
    return rest;
  };

  function loadOrder(id) {
    const order = db.prepare(`
      SELECT o.*, c.razao_social, c.nome_fantasia, c.cnpj, c.telefone, c.contato, c.endereco, c.cidade, c.email
      FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).get(id);
    if (!order) return null;
    order.items = db.prepare(`
      SELECT oi.*, p.barcode, p.box_barcode, p.sku, p.stock_units
      FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.product_name`).all(id);
    return order;
  }

  const idParam = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new BusinessError('Identificador inválido.', 404);
    return id;
  };

  // ---------- público ----------
  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  app.get('/api/config', (req, res) => {
    const s = getSettings(db);
    res.json({
      store_name: s.store_name,
      store_subtitle: s.store_subtitle,
      whatsapp: s.whatsapp,
      min_order_cents: Number(s.min_order_cents) || 0,
      order_notice: s.order_notice,
      test_mode: testMode,
    });
  });

  // ---------- cliente ----------
  app.post('/api/cliente/cadastro', loginLimiter, (req, res) => {
    const b = req.body || {};
    const cnpj = U.onlyDigits(b.cnpj);
    if (!U.isValidCnpj(cnpj)) throw new BusinessError('CNPJ inválido.');
    const razao = U.cleanText(b.razao_social, 150);
    if (!razao) throw new BusinessError('Informe a razão social.');
    const telefone = U.cleanText(b.telefone, 30);
    if (!telefone) throw new BusinessError('Informe um telefone/WhatsApp.');
    if (!b.senha || String(b.senha).length < 6) throw new BusinessError('A senha precisa ter ao menos 6 caracteres.');
    if (db.prepare('SELECT 1 FROM customers WHERE cnpj = ?').get(cnpj)) {
      throw new BusinessError('Este CNPJ já está cadastrado. Faça login ou fale com a loja.', 409);
    }
    const auto = getSettings(db).auto_approve_customers === '1';
    const info = db.prepare(`
      INSERT INTO customers (cnpj, razao_social, nome_fantasia, contato, telefone, email, endereco, cidade, password_hash, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      cnpj, razao, U.cleanText(b.nome_fantasia, 150), U.cleanText(b.contato, 100), telefone,
      U.cleanText(b.email, 150), U.cleanText(b.endereco, 300), U.cleanText(b.cidade, 100),
      hashPassword(b.senha), auto ? 'ativo' : 'pendente',
    );
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
    sessions.login(res, req, 'customer', c.id);
    res.status(201).json({ customer: publicCustomer(c) });
  });

  app.post('/api/cliente/login', loginLimiter, (req, res) => {
    const cnpj = U.onlyDigits(req.body?.cnpj);
    const c = db.prepare('SELECT * FROM customers WHERE cnpj = ?').get(cnpj);
    if (!c || !verifyPassword(req.body?.senha || '', c.password_hash)) {
      throw new BusinessError('CNPJ ou senha incorretos.', 401);
    }
    sessions.login(res, req, 'customer', c.id);
    res.json({ customer: publicCustomer(c) });
  });

  app.post('/api/cliente/logout', (req, res) => {
    sessions.logout(res, req, 'customer');
    res.json({ ok: true });
  });

  app.get('/api/cliente/me', (req, res) => {
    const id = sessions.userId(req, 'customer');
    const c = id && db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    res.json({ customer: c ? publicCustomer(c) : null });
  });

  // Catálogo do cliente: NÃO informa quantidades, só se o produto está disponível para compra.
  app.get('/api/catalogo', requireCustomer, (req, res) => {
    const products = db.prepare(`SELECT ${PRODUCT_COLS} FROM products p WHERE p.active = 1 ORDER BY p.category, p.name`)
      .all()
      .map(withAvailability)
      .map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        description: p.description,
        barcode: p.barcode,
        units_per_box: p.units_per_box,
        unit_price_cents: p.unit_price_cents,
        box_price_cents: p.box_price_cents,
        sell_unit: !!p.sell_unit,
        sell_box: !!p.sell_box,
        image_url: imageUrl(p),
        // disponível = dá para comprar ao menos a menor embalagem vendida
        in_stock: p.available_units >= (p.sell_unit ? 1 : p.units_per_box),
      }));
    res.json({ products });
  });

  // Confere o carrinho antes de enviar: devolve só os produtos sem a quantidade pedida.
  app.post('/api/pedidos/verificar', requireCustomer, (req, res) => {
    res.json({ unavailable: inv.unavailableProducts(req.body?.items) });
  });

  app.post('/api/pedidos', requireCustomer, (req, res) => {
    const b = req.body || {};
    let deliveryDate = null;
    if (b.delivery_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.delivery_date)) throw new BusinessError('Data de entrega inválida.');
      deliveryDate = b.delivery_date;
    }
    const orderId = inv.createOrder({
      customerId: req.customer.id,
      items: b.items,
      notes: U.cleanText(b.notes, 1000),
      deliveryDate,
      minOrderCents: Number(getSettings(db).min_order_cents) || 0,
    });
    res.status(201).json({ order: loadOrder(orderId) });
  });

  app.get('/api/pedidos', requireCustomer, (req, res) => {
    const orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 100').all(req.customer.id);
    const items = db.prepare('SELECT product_id, product_name, unit_type, quantity, price_cents, subtotal_cents FROM order_items WHERE order_id = ?');
    res.json({ orders: orders.map((o) => ({ ...o, admin_notes: undefined, items: items.all(o.id) })) });
  });

  app.post('/api/pedidos/:id/cancelar', requireCustomer, (req, res) => {
    const id = idParam(req);
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ?').get(id, req.customer.id);
    if (!order) throw new BusinessError('Pedido não encontrado.', 404);
    if (order.status !== 'novo') throw new BusinessError('Este pedido já foi aceito pela loja. Para cancelar, fale conosco.');
    inv.changeStatus({ orderId: id, status: 'cancelado', user: `cliente:${req.customer.cnpj}` });
    res.json({ ok: true });
  });

  // ---------- admin: acesso ----------
  app.get('/api/admin/setup', (req, res) => {
    res.json({ needs_setup: db.prepare('SELECT COUNT(*) n FROM admins').get().n === 0 });
  });

  app.post('/api/admin/setup', loginLimiter, (req, res) => {
    if (db.prepare('SELECT COUNT(*) n FROM admins').get().n > 0) throw new BusinessError('O administrador já foi criado.', 403);
    const { name, email, senha } = req.body || {};
    if (!name || !email || !senha || String(senha).length < 8) {
      throw new BusinessError('Informe nome, e-mail e uma senha com ao menos 8 caracteres.');
    }
    const info = db.prepare('INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)')
      .run(U.cleanText(name, 100), U.cleanText(email, 150), hashPassword(senha));
    sessions.login(res, req, 'admin', Number(info.lastInsertRowid));
    res.status(201).json({ ok: true });
  });

  app.post('/api/admin/login', loginLimiter, (req, res) => {
    const a = db.prepare('SELECT * FROM admins WHERE email = ?').get(String(req.body?.email || '').trim());
    if (!a || !verifyPassword(req.body?.senha || '', a.password_hash)) throw new BusinessError('E-mail ou senha incorretos.', 401);
    sessions.login(res, req, 'admin', a.id);
    res.json({ admin: { id: a.id, name: a.name, email: a.email } });
  });

  app.post('/api/admin/logout', (req, res) => {
    sessions.logout(res, req, 'admin');
    res.json({ ok: true });
  });

  const admin = express.Router();
  admin.use(requireAdmin);
  app.use('/api/admin', admin);

  admin.get('/me', (req, res) => res.json({ admin: req.admin }));

  // ---------- admin: painel ----------
  admin.get('/dashboard', (req, res) => {
    const counts = Object.fromEntries(
      db.prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all().map((r) => [r.status, r.n]),
    );
    const lowStock = db.prepare(`SELECT ${PRODUCT_COLS} FROM products p WHERE p.active = 1`).all()
      .map(withAvailability)
      .filter((p) => p.available_units <= p.min_stock && (p.min_stock > 0 || p.stock_units > 0 || p.has_cost))
      .sort((a, b) => a.available_units - b.available_units)
      .slice(0, 50);
    const pendingCustomers = db.prepare("SELECT COUNT(*) n FROM customers WHERE status = 'pendente'").get().n;
    const [start, end] = T.utcRange(T.localDate(), T.localDate());
    const today = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN quantity > 0 THEN quantity END), 0) AS entradas,
        COALESCE(SUM(CASE WHEN quantity < 0 THEN -quantity END), 0) AS saidas
      FROM stock_movements WHERE created_at >= ? AND created_at < ?`).get(start, end);
    res.json({ counts, lowStock, pendingCustomers, today, ...reports.dashboard(), storage_ok: storageIsPersistent(), test_mode: testMode });
  });

  // ---------- admin: produtos ----------
  function readProduct(b, existing = {}) {
    const name = U.cleanText(b.name ?? existing.name, 150);
    if (!name) throw new BusinessError('Informe o nome do produto.');
    const upb = Number(b.units_per_box ?? existing.units_per_box ?? 1);
    if (!Number.isInteger(upb) || upb < 1) throw new BusinessError('Unidades por caixa deve ser um número inteiro maior que zero.');
    const unitPrice = b.unit_price !== undefined ? U.toCents(b.unit_price) : (existing.unit_price_cents ?? 0);
    // Preço da caixa vazio = unidade × quantidade. Se era calculado assim, continua acompanhando.
    const boxWasDerived = existing.box_price_cents === (existing.unit_price_cents ?? 0) * (existing.units_per_box ?? 1);
    const boxPrice = b.box_price !== undefined ? U.toCents(b.box_price) : (boxWasDerived ? 0 : (existing.box_price_cents ?? 0));
    const hasRetail = b.retail_price !== undefined && b.retail_price !== null && String(b.retail_price).trim() !== '';
    const retailPrice = b.retail_price !== undefined ? (hasRetail ? U.toCents(b.retail_price) : null) : (existing.retail_price_cents ?? null);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(boxPrice) || boxPrice < 0) throw new BusinessError('Preço inválido.');
    if (retailPrice !== null && (!Number.isFinite(retailPrice) || retailPrice < 0)) throw new BusinessError('Preço de varejo inválido.');
    const minStock = Number(b.min_stock ?? existing.min_stock ?? 0);
    if (!Number.isInteger(minStock) || minStock < 0) throw new BusinessError('Estoque mínimo inválido.');
    const bool = (v, d) => (v === undefined ? d : v === true || v === 1 || v === '1' || v === 'sim' || v === 'true' ? 1 : 0);
    const p = {
      sku: U.cleanText(b.sku !== undefined ? b.sku : existing.sku, 50),
      name,
      category: U.cleanText(b.category ?? existing.category, 60) || 'Geral',
      barcode: U.cleanBarcode(b.barcode !== undefined ? b.barcode : existing.barcode),
      box_barcode: U.cleanBarcode(b.box_barcode !== undefined ? b.box_barcode : existing.box_barcode),
      units_per_box: upb,
      unit_price_cents: unitPrice,
      box_price_cents: boxPrice || unitPrice * upb,
      retail_price_cents: retailPrice,
      sell_unit: bool(b.sell_unit, existing.sell_unit ?? 1),
      sell_box: bool(b.sell_box, existing.sell_box ?? 1),
      min_stock: minStock,
      active: bool(b.active, existing.active ?? 1),
      description: U.cleanText(b.description !== undefined ? b.description : existing.description, 500),
    };
    if (!p.sell_unit && !p.sell_box) throw new BusinessError('O produto precisa ser vendido por unidade, por caixa ou ambos.');
    if (p.barcode && p.barcode === p.box_barcode) throw new BusinessError('O código da caixa deve ser diferente do código da unidade.');
    // Um código não pode estar em uso em outro produto (nem como unidade nem como caixa).
    for (const code of [p.barcode, p.box_barcode]) {
      if (!code) continue;
      const clash = db.prepare('SELECT id, name FROM products WHERE (barcode = ? OR box_barcode = ?) AND id <> ?').get(code, code, existing.id ?? 0);
      if (clash) throw new BusinessError(`O código ${code} já está cadastrado no produto "${clash.name}".`, 409);
    }
    return p;
  }

  function saveProduct(p, id = null) {
    if (id) {
      db.prepare(`
        UPDATE products SET sku=@sku, name=@name, category=@category, barcode=@barcode, box_barcode=@box_barcode,
          units_per_box=@units_per_box, unit_price_cents=@unit_price_cents, box_price_cents=@box_price_cents,
          retail_price_cents=@retail_price_cents, sell_unit=@sell_unit, sell_box=@sell_box, min_stock=@min_stock,
          active=@active, description=@description, updated_at=datetime('now')
        WHERE id=@id`).run({ ...p, id });
      return id;
    }
    return Number(db.prepare(`
      INSERT INTO products (sku, name, category, barcode, box_barcode, units_per_box, unit_price_cents, box_price_cents,
        retail_price_cents, sell_unit, sell_box, min_stock, active, description)
      VALUES (@sku, @name, @category, @barcode, @box_barcode, @units_per_box, @unit_price_cents, @box_price_cents,
        @retail_price_cents, @sell_unit, @sell_box, @min_stock, @active, @description)`).run(p).lastInsertRowid);
  }

  admin.get('/produtos', (req, res) => {
    const products = db.prepare(`SELECT ${PRODUCT_COLS} FROM products p ORDER BY p.active DESC, p.category, p.name`).all().map(withAvailability);
    res.json({ products });
  });

  admin.get('/produtos/buscar', (req, res) => {
    const code = U.cleanBarcode(req.query.codigo);
    if (!code) throw new BusinessError('Informe um código.');
    const p = db.prepare(`SELECT ${PRODUCT_COLS} FROM products p WHERE p.barcode = ? OR p.box_barcode = ? OR p.sku = ?`).get(code, code, code);
    if (!p) return res.status(404).json({ error: `Código ${code} não cadastrado.`, code });
    res.json({ product: withAvailability(p), matched: p.box_barcode === code ? 'caixa' : 'unidade' });
  });

  admin.post('/produtos', (req, res) => {
    const id = saveProduct(readProduct(req.body || {}));
    res.status(201).json({ product: db.prepare('SELECT * FROM products WHERE id = ?').get(id) });
  });

  admin.put('/produtos/:id', (req, res) => {
    const id = idParam(req);
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) throw new BusinessError('Produto não encontrado.', 404);
    saveProduct(readProduct(req.body || {}, existing), id);
    res.json({ product: db.prepare('SELECT * FROM products WHERE id = ?').get(id) });
  });

  // Importação CSV: colunas aceitas (cabeçalho): codigo_barras, codigo_caixa, sku, nome, categoria,
  // unidades_caixa, preco_unidade, preco_caixa, estoque_minimo, vende_unidade, vende_caixa
  admin.post('/produtos/importar', async (req, res) => {
    const rows = req.body?.xlsx ? await readXlsxRows(req.body.xlsx) : U.parseCsv(req.body?.csv || '');
    if (rows.length === 0) throw new BusinessError('Arquivo vazio ou sem cabeçalho.');
    const pick = (r, ...keys) => {
      for (const k of keys) if (r[k] !== undefined && r[k] !== '') return r[k];
      return undefined;
    };
    let created = 0;
    let updated = 0;
    const errors = [];
    const run = db.transaction(() => {
      rows.forEach((r, idx) => {
        const line = idx + 2;
        try {
          if (/apague esta linha/i.test(pick(r, 'nome') || '')) return;
          const barcode = U.cleanBarcode(pick(r, 'codigo_barras', 'ean', 'barcode', 'codigo'));
          const sku = U.cleanText(pick(r, 'sku', 'referencia'), 50);
          const existing = (barcode && db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode))
            || (sku && db.prepare('SELECT * FROM products WHERE sku = ?').get(sku));
          const data = {
            name: pick(r, 'nome', 'produto', 'descricao'),
            category: pick(r, 'categoria'),
            barcode,
            box_barcode: pick(r, 'codigo_caixa', 'dun', 'ean_caixa'),
            sku,
            units_per_box: pick(r, 'unidades_caixa', 'qtd_caixa', 'unidades_por_caixa'),
            unit_price: pick(r, 'preco_unidade', 'preco'),
            box_price: pick(r, 'preco_caixa'),
            retail_price: pick(r, 'preco_varejo'),
            min_stock: pick(r, 'estoque_minimo'),
            sell_unit: pick(r, 'vende_unidade'),
            sell_box: pick(r, 'vende_caixa'),
          };
          for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
          if (data.units_per_box !== undefined) data.units_per_box = Number(data.units_per_box);
          if (data.min_stock !== undefined) data.min_stock = Number(data.min_stock);
          if (existing) {
            saveProduct(readProduct(data, existing), existing.id);
            updated++;
          } else {
            saveProduct(readProduct(data));
            created++;
          }
        } catch (e) {
          errors.push(`Linha ${line}: ${e.message}`);
        }
      });
    });
    run();
    res.json({ created, updated, errors });
  });

  admin.get('/produtos/modelo.xlsx', async (req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Produtos');
    ws.columns = IMPORT_COLUMNS.map(([key, , width]) => ({ header: key, key, width }));
    for (const key of ['codigo_barras', 'codigo_caixa', 'sku']) ws.getColumn(key).numFmt = '@';
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6195B' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const existing = db.prepare('SELECT * FROM products ORDER BY category, name').all();
    const rows = existing.length ? existing : [{
      barcode: '7890000000000', box_barcode: '17890000000007', sku: 'PIC01', name: 'Picolé Exemplo (apague esta linha)',
      category: 'Picolés', units_per_box: 24, unit_price_cents: 450, box_price_cents: 9800, min_stock: 48, sell_unit: 1, sell_box: 1,
    }];
    for (const p of rows) {
      ws.addRow({
        codigo_barras: p.barcode || '', codigo_caixa: p.box_barcode || '', sku: p.sku || '', nome: p.name,
        categoria: p.category, unidades_caixa: p.units_per_box, preco_unidade: p.unit_price_cents / 100,
        preco_caixa: p.box_price_cents / 100, preco_varejo: p.retail_price_cents === null || p.retail_price_cents === undefined ? '' : p.retail_price_cents / 100,
        estoque_minimo: p.min_stock,
        vende_unidade: p.sell_unit ? 'sim' : 'nao', vende_caixa: p.sell_box ? 'sim' : 'nao',
      });
    }
    const help = wb.addWorksheet('Como preencher');
    help.getColumn(1).width = 22;
    help.getColumn(2).width = 90;
    help.addRow(['Coluna', 'O que colocar']).font = { bold: true };
    for (const [key, desc] of IMPORT_COLUMNS) help.addRow([key, desc]);
    help.addRow([]);
    help.addRow(['', 'Preencha a aba "Produtos" (uma linha por produto) e importe no painel em Produtos → Importar planilha.']);
    help.addRow(['', 'Produtos com o mesmo código de barras são atualizados; os outros são criados. O estoque NÃO é alterado.']);
    res.attachment('produtos-oggi.xlsx');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  admin.get('/produtos.csv', (req, res) => {
    const rows = db.prepare(`SELECT ${PRODUCT_COLS} FROM products p ORDER BY p.category, p.name`).all().map(withAvailability);
    const csv = U.toCsv(rows, [
      { label: 'codigo_barras', value: 'barcode' },
      { label: 'codigo_caixa', value: 'box_barcode' },
      { label: 'sku', value: 'sku' },
      { label: 'nome', value: 'name' },
      { label: 'categoria', value: 'category' },
      { label: 'unidades_caixa', value: 'units_per_box' },
      { label: 'preco_unidade', value: (r) => U.centsToBr(r.unit_price_cents) },
      { label: 'preco_caixa', value: (r) => U.centsToBr(r.box_price_cents) },
      { label: 'preco_varejo', value: (r) => (r.retail_price_cents === null ? '' : U.centsToBr(r.retail_price_cents)) },
      { label: 'estoque_minimo', value: 'min_stock' },
      { label: 'vende_unidade', value: (r) => (r.sell_unit ? 'sim' : 'nao') },
      { label: 'vende_caixa', value: (r) => (r.sell_box ? 'sim' : 'nao') },
      { label: 'estoque_fisico_un', value: 'stock_units' },
      { label: 'reservado_un', value: 'reserved_units' },
      { label: 'disponivel_un', value: 'available_units' },
      { label: 'custo_medio_un', value: (r) => (r.has_cost && r.stock_units ? U.centsToBr(r.stock_value_cents / r.stock_units) : '') },
      { label: 'valor_a_custo', value: (r) => (r.has_cost ? U.centsToBr(r.stock_value_cents) : 'sem custo') },
      { label: 'ativo', value: (r) => (r.active ? 'sim' : 'nao') },
    ]);
    res.type('text/csv').attachment(`estoque-${T.localDate()}.csv`).send(csv);
  });

  // Excluir só produto que nunca teve movimentação nem pedido (o histórico é permanente).
  admin.delete('/produtos/:id', (req, res) => {
    const id = idParam(req);
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) throw new BusinessError('Produto não encontrado.', 404);
    const used = db.prepare(`SELECT (SELECT COUNT(*) FROM stock_movements WHERE product_id = ?)
      + (SELECT COUNT(*) FROM order_items WHERE product_id = ?) AS n`).get(id, id).n;
    if (used || p.stock_units) {
      throw new BusinessError('Este produto já tem movimentações ou pedidos, e o histórico é permanente. Para tirá-lo do catálogo, desmarque “Ativo”.', 409);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM product_images WHERE product_id = ?').run(id);
      db.prepare('DELETE FROM products WHERE id = ?').run(id);
    })();
    res.json({ ok: true });
  });

  // ---------- admin: imagens e catálogo ----------
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  admin.put('/produtos/:id/imagem', (req, res) => {
    const id = idParam(req);
    if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw new BusinessError('Produto não encontrado.', 404);
    const mime = String(req.body?.mime || '');
    if (!IMAGE_TYPES.includes(mime)) throw new BusinessError('Use uma imagem JPG, PNG ou WebP.');
    const data = Buffer.from(String(req.body?.data || ''), 'base64');
    if (data.length < 100) throw new BusinessError('Imagem vazia.');
    if (data.length > 2 * 1024 * 1024) throw new BusinessError('Imagem muito grande (máx. 2 MB).');
    db.transaction(() => {
      db.prepare(`INSERT INTO product_images (product_id, mime, data, updated_at) VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(product_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`).run(id, mime, data);
      db.prepare("UPDATE products SET image_updated_at = strftime('%Y%m%d%H%M%f', 'now') WHERE id = ?").run(id);
    })();
    res.json({ product: withAvailability(db.prepare(`SELECT ${PRODUCT_COLS} FROM products p WHERE p.id = ?`).get(id)) });
  });

  admin.delete('/produtos/:id/imagem', (req, res) => {
    const id = idParam(req);
    db.prepare('DELETE FROM product_images WHERE product_id = ?').run(id);
    db.prepare('UPDATE products SET image_updated_at = NULL WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  admin.post('/produtos/catalogo-oggi', (req, res) => {
    res.json(loadOggiCatalog(db, { withImages: req.body?.images !== false }));
  });

  // Unidades por caixa de todos os produtos de uma categoria (o preço da caixa calculado acompanha).
  admin.post('/produtos/unidades-por-caixa', (req, res) => {
    const category = String(req.body?.category || '');
    const upb = Number(req.body?.units_per_box);
    if (!Number.isInteger(upb) || upb < 1) throw new BusinessError('Unidades por caixa inválidas.');
    const products = db.prepare('SELECT * FROM products WHERE category = ?').all(category);
    if (!products.length) throw new BusinessError('Categoria sem produtos.');
    db.transaction(() => { for (const p of products) saveProduct(readProduct({ units_per_box: upb }, p), p.id); })();
    res.json({ updated: products.length });
  });

  // ---------- admin: estoque ----------
  admin.get('/estoque/opcoes', (req, res) => {
    const s = getSettings(db);
    res.json({
      locations: db.prepare("SELECT * FROM locations WHERE kind = 'loja' AND active = 1 ORDER BY name").all(),
      reasons: db.prepare('SELECT * FROM loss_reasons WHERE active = 1 ORDER BY sort, name').all(),
      subtypes: Object.entries(SUBTYPES).map(([value, label]) => ({ value, label })),
      customers: db.prepare("SELECT id, razao_social, nome_fantasia FROM customers WHERE status <> 'bloqueado' ORDER BY COALESCE(nome_fantasia, razao_social)").all(),
      note_threshold_cents: Number(s.out_note_threshold_cents) || 0,
      default_supplier: s.default_supplier || '',
    });
  });

  admin.post('/estoque/entrada', (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.lines)) throw new BusinessError('Nenhum item informado.');
    const lines = b.lines.map((l) => {
      const cost = U.toCents(l.cost);
      if (l.cost === undefined || l.cost === null || String(l.cost).trim() === '' || !Number.isFinite(cost)) {
        throw new BusinessError('Informe o custo de todos os itens (pode ser 0 em bonificação, com observação).');
      }
      const opening = l.opening_cost !== undefined && String(l.opening_cost).trim() !== '' ? U.toCents(l.opening_cost) : null;
      if (opening !== null && !Number.isFinite(opening)) throw new BusinessError('Custo inicial inválido.');
      return { product_id: l.product_id, units: l.units, cost_cents: cost, cost_per: l.cost_per, opening_cost_cents: opening, opening_cost_per: l.opening_cost_per };
    });
    const results = inv.receive({
      lines,
      document: U.cleanText(b.document, 100),
      supplier: U.cleanText(b.supplier, 100),
      note: U.cleanText(b.note, 300),
      user: req.admin.name,
    });
    res.json({ results });
  });

  admin.post('/estoque/saida', (req, res) => {
    const b = req.body || {};
    if (!OUT_TYPES.includes(b.type)) throw new BusinessError('Escolha o destino da saída.');
    const results = inv.dispatch({
      type: b.type,
      lines: b.lines,
      locationId: b.location_id ? Number(b.location_id) : null,
      reasonId: b.reason_id ? Number(b.reason_id) : null,
      subtype: b.subtype || null,
      customerId: b.customer_id ? Number(b.customer_id) : null,
      document: U.cleanText(b.document, 100),
      note: U.cleanText(b.note, 300),
      user: req.admin.name,
      noteThresholdCents: Number(getSettings(db).out_note_threshold_cents) || 0,
    });
    res.json({ results });
  });

  admin.post('/estoque/inventario', (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.counts) || b.counts.length === 0) throw new BusinessError('Nenhuma contagem informada.');
    res.json({ results: inv.inventoryCount({ counts: b.counts, note: U.cleanText(b.note, 300), user: req.admin.name }) });
  });

  admin.get('/estoque/sem-custo', (req, res) => {
    const products = db.prepare(`
      SELECT p.id, p.name, p.category, p.units_per_box, p.stock_units, p.barcode,
        (SELECT value_cents * 1.0 / quantity FROM stock_movements WHERE product_id = p.id AND type = 'entrada' AND quantity > 0
          AND value_cents IS NOT NULL ORDER BY id DESC LIMIT 1) AS last_entry_unit_cost
      FROM products p WHERE p.stock_units > 0 AND p.has_cost = 0 ORDER BY p.category, p.name`).all();
    res.json({ products });
  });

  admin.post('/estoque/custo-inicial', (req, res) => {
    const b = req.body || {};
    const cost = U.toCents(b.cost);
    if (b.cost === undefined || String(b.cost).trim() === '' || !Number.isFinite(cost)) throw new BusinessError('Informe o custo.');
    const r = inv.openingCost({ productId: Number(b.product_id), costCents: cost, costPer: b.cost_per, note: U.cleanText(b.note, 300), user: req.admin.name });
    res.json({ result: r });
  });

  admin.post('/estoque/movimentos/:id/estornar', (req, res) => {
    const r = inv.reverse({ movementId: idParam(req), reason: U.cleanText(req.body?.reason, 300), user: req.admin.name });
    res.json({ result: r });
  });

  const MOV_LABELS = {
    entrada: 'Entrada', saida_pedido: 'Venda B2B', transferencia: 'Transferência', perda: 'Perda',
    saida_sem_venda: 'Saída sem venda', sobra_inventario: 'Sobra de inventário', divergencia_inventario: 'Divergência de inventário',
    abertura_custo: 'Custo inicial', estorno: 'Estorno',
  };

  function movementQuery(qs) {
    const where = [];
    const params = [];
    if (qs.product_id) { where.push('m.product_id = ?'); params.push(Number(qs.product_id)); }
    if (qs.type) { where.push('m.type = ?'); params.push(String(qs.type)); }
    if (qs.from && T.isDate(String(qs.from))) { where.push('m.created_at >= ?'); params.push(T.utcStartOfLocalDay(String(qs.from))); }
    if (qs.to && T.isDate(String(qs.to))) { where.push('m.created_at < ?'); params.push(T.utcStartOfLocalDay(T.addDays(String(qs.to), 1))); }
    const sql = `
      SELECT m.*, ${T.sqlLocalDateTime('m.created_at')} AS created_local, p.name AS product_name, p.barcode, p.units_per_box,
        l.name AS location_name, r.name AS reason_name, COALESCE(c.nome_fantasia, c.razao_social) AS customer_name,
        o.type AS reverses_type, (SELECT x.id FROM stock_movements x WHERE x.reverses_movement_id = m.id) AS reversed_by
      FROM stock_movements m JOIN products p ON p.id = m.product_id
      LEFT JOIN locations l ON l.id = m.location_id
      LEFT JOIN loss_reasons r ON r.id = m.reason_id
      LEFT JOIN customers c ON c.id = m.customer_id
      LEFT JOIN stock_movements o ON o.id = m.reverses_movement_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.id DESC LIMIT ${Math.min(Number(qs.limit) || 500, 5000)}`;
    return db.prepare(sql).all(...params).map((m) => ({ ...m, subtype_label: m.subtype ? SUBTYPES[m.subtype] || m.subtype : null }));
  }

  admin.get('/estoque/movimentos', (req, res) => res.json({ movements: movementQuery(req.query) }));

  admin.get('/estoque/movimentos.csv', (req, res) => {
    const csv = U.toCsv(movementQuery({ ...req.query, limit: 5000 }), [
      { label: 'id', value: 'id' },
      { label: 'data (Cuiabá)', value: 'created_local' },
      { label: 'tipo', value: (r) => MOV_LABELS[r.type] || r.type },
      { label: 'estorno de', value: 'reverses_movement_id' },
      { label: 'produto', value: 'product_name' },
      { label: 'codigo_barras', value: 'barcode' },
      { label: 'quantidade_un', value: 'quantity' },
      { label: 'saldo_apos_un', value: 'balance_after' },
      { label: 'custo_unitario', value: (r) => (r.unit_cost_cents === null ? '' : U.centsToBr(r.unit_cost_cents)) },
      { label: 'valor', value: (r) => (r.value_cents === null ? 'sem custo' : U.centsToBr(r.value_cents)) },
      { label: 'valor_apos', value: (r) => (r.value_after_cents === null ? '' : U.centsToBr(r.value_after_cents)) },
      { label: 'receita', value: (r) => (r.revenue_cents === null ? '' : U.centsToBr(r.revenue_cents)) },
      { label: 'destino/motivo', value: (r) => r.location_name || r.reason_name || r.subtype_label || '' },
      { label: 'cliente', value: 'customer_name' },
      { label: 'pedido', value: 'order_id' },
      { label: 'fornecedor', value: 'supplier' },
      { label: 'documento', value: 'document' },
      { label: 'observacao', value: 'note' },
      { label: 'usuario', value: 'created_by' },
    ]);
    res.type('text/csv').attachment('movimentacoes.csv').send(csv);
  });

  // ---------- admin: relatórios ----------
  const REPORTS = {
    posicao: (q) => reports.position(q.date),
    conciliacao: (q) => reports.reconciliation(q.from, q.to),
    vendas: (q) => reports.sales(q.from, q.to),
    perdas: (q) => reports.losses(q.from, q.to),
    transferencias: (q) => reports.transfers(q.from, q.to),
  };
  function reportParams(qs) {
    const today = T.localDate();
    const [mFrom] = T.monthBounds(T.localMonth());
    const date = T.isDate(String(qs.date || '')) ? String(qs.date) : today;
    const from = T.isDate(String(qs.from || '')) ? String(qs.from) : mFrom;
    const to = T.isDate(String(qs.to || '')) ? String(qs.to) : today;
    if (from > to) throw new BusinessError('A data inicial é depois da final.');
    return { date, from, to };
  }
  admin.get('/relatorios/:tipo', async (req, res) => {
    const fn = REPORTS[req.params.tipo];
    if (!fn) throw new BusinessError('Relatório não encontrado.', 404);
    const params = reportParams(req.query);
    const report = fn(params);
    const format = req.query.formato;
    if (format === 'xlsx' || format === 'csv') {
      const { buffer, filename, type } = await exportReport(report, format, `${req.params.tipo}-${req.params.tipo === 'posicao' ? params.date : `${params.from}_${params.to}`}`);
      return res.type(type).attachment(filename).send(buffer);
    }
    res.json({ report, params });
  });

  // ---------- admin: pedidos ----------
  admin.get('/pedidos', (req, res) => {
    const status = req.query.status;
    const rows = db.prepare(`
      SELECT o.*, c.razao_social, c.nome_fantasia, c.cnpj, c.telefone,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
      FROM orders o JOIN customers c ON c.id = o.customer_id
      ${status ? 'WHERE o.status = ?' : ''}
      ORDER BY CASE o.status WHEN 'novo' THEN 0 WHEN 'confirmado' THEN 1 WHEN 'separado' THEN 2 ELSE 3 END, o.id DESC
      LIMIT 300`).all(...(status ? [status] : []));
    res.json({ orders: rows });
  });

  admin.get('/pedidos/:id', (req, res) => {
    const order = loadOrder(idParam(req));
    if (!order) throw new BusinessError('Pedido não encontrado.', 404);
    res.json({ order });
  });

  admin.post('/pedidos/:id/status', (req, res) => {
    const id = idParam(req);
    inv.changeStatus({ orderId: id, status: req.body?.status, user: req.admin.name, adminNotes: req.body?.admin_notes });
    res.json({ order: loadOrder(id) });
  });

  admin.put('/pedidos/:id/itens', (req, res) => {
    const id = idParam(req);
    inv.editOrderItems({ orderId: id, changes: req.body?.changes || [] });
    res.json({ order: loadOrder(id) });
  });

  // ---------- admin: clientes ----------
  admin.get('/clientes', (req, res) => {
    const customers = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM orders WHERE customer_id = c.id AND status <> 'cancelado') AS order_count,
        (SELECT MAX(created_at) FROM orders WHERE customer_id = c.id) AS last_order_at
      FROM customers c ORDER BY CASE c.status WHEN 'pendente' THEN 0 ELSE 1 END, c.razao_social`).all()
      .map(({ password_hash, ...c }) => c);
    res.json({ customers });
  });

  admin.post('/clientes', (req, res) => {
    const b = req.body || {};
    const cnpj = U.onlyDigits(b.cnpj);
    if (!U.isValidCnpj(cnpj)) throw new BusinessError('CNPJ inválido.');
    if (!U.cleanText(b.razao_social)) throw new BusinessError('Informe a razão social.');
    if (!b.senha || String(b.senha).length < 6) throw new BusinessError('Defina uma senha inicial (mín. 6 caracteres).');
    if (db.prepare('SELECT 1 FROM customers WHERE cnpj = ?').get(cnpj)) throw new BusinessError('CNPJ já cadastrado.', 409);
    const info = db.prepare(`
      INSERT INTO customers (cnpj, razao_social, nome_fantasia, contato, telefone, email, endereco, cidade, password_hash, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo', ?)`).run(
      cnpj, U.cleanText(b.razao_social, 150), U.cleanText(b.nome_fantasia, 150), U.cleanText(b.contato, 100),
      U.cleanText(b.telefone, 30), U.cleanText(b.email, 150), U.cleanText(b.endereco, 300), U.cleanText(b.cidade, 100),
      hashPassword(b.senha), U.cleanText(b.notes, 500),
    );
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  admin.put('/clientes/:id', (req, res) => {
    const id = idParam(req);
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) throw new BusinessError('Cliente não encontrado.', 404);
    const b = req.body || {};
    const status = b.status ?? c.status;
    if (!['pendente', 'ativo', 'bloqueado'].includes(status)) throw new BusinessError('Situação inválida.');
    const val = (k, max) => (b[k] !== undefined ? U.cleanText(b[k], max) : c[k]);
    db.prepare(`
      UPDATE customers SET razao_social = ?, nome_fantasia = ?, contato = ?, telefone = ?, email = ?, endereco = ?,
        cidade = ?, status = ?, notes = ? WHERE id = ?`).run(
      val('razao_social', 150) || c.razao_social, val('nome_fantasia', 150), val('contato', 100), val('telefone', 30),
      val('email', 150), val('endereco', 300), val('cidade', 100), status, val('notes', 500), id,
    );
    if (b.senha) {
      if (String(b.senha).length < 6) throw new BusinessError('A senha precisa ter ao menos 6 caracteres.');
      db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(hashPassword(b.senha), id);
      sessions.revokeAll('customer', id);
    }
    if (status === 'bloqueado') sessions.revokeAll('customer', id);
    res.json({ ok: true });
  });

  // ---------- admin: configurações e usuários ----------
  const EDITABLE_SETTINGS = ['store_name', 'store_subtitle', 'whatsapp', 'min_order_cents', 'auto_approve_customers',
    'order_notice', 'out_note_threshold_cents', 'default_supplier'];

  admin.get('/config', (req, res) => res.json({ settings: getSettings(db) }));

  admin.put('/config', (req, res) => {
    const b = req.body || {};
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (b.min_order !== undefined) {
      const cents = U.toCents(b.min_order);
      b.min_order_cents = Number.isFinite(cents) && cents > 0 ? cents : 0;
    }
    if (b.out_note_threshold !== undefined) {
      const cents = U.toCents(b.out_note_threshold);
      b.out_note_threshold_cents = Number.isFinite(cents) && cents > 0 ? cents : 0;
    }
    for (const key of EDITABLE_SETTINGS) {
      if (b[key] === undefined) continue;
      let value = String(b[key]).slice(0, 500);
      if (key === 'whatsapp') value = U.onlyDigits(value);
      if (key === 'auto_approve_customers') value = b[key] === true || b[key] === '1' ? '1' : '0';
      upsert.run(key, value);
    }
    res.json({ settings: getSettings(db) });
  });

  // Locais (lojas) e motivos de perda. Não são apagados: desative para esconder.
  admin.get('/locais', (req, res) => res.json({ locations: db.prepare('SELECT * FROM locations ORDER BY kind, name').all() }));
  admin.post('/locais', (req, res) => {
    const name = U.cleanText(req.body?.name, 80);
    if (!name) throw new BusinessError('Informe o nome da loja.');
    db.prepare("INSERT INTO locations (name, kind, description) VALUES (?, 'loja', ?)").run(name, U.cleanText(req.body?.description, 200));
    res.status(201).json({ ok: true });
  });
  admin.put('/locais/:id', (req, res) => {
    const id = idParam(req);
    const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    if (!l) throw new BusinessError('Local não encontrado.', 404);
    if (l.kind === 'camara' && req.body?.active === false) throw new BusinessError('A câmara não pode ser desativada.');
    db.prepare('UPDATE locations SET name = ?, description = ?, active = ? WHERE id = ?').run(
      U.cleanText(req.body?.name, 80) || l.name,
      req.body?.description !== undefined ? U.cleanText(req.body.description, 200) : l.description,
      req.body?.active === undefined ? l.active : (req.body.active ? 1 : 0), id,
    );
    res.json({ ok: true });
  });
  admin.get('/motivos', (req, res) => res.json({ reasons: db.prepare('SELECT * FROM loss_reasons ORDER BY active DESC, sort, name').all() }));
  admin.post('/motivos', (req, res) => {
    const name = U.cleanText(req.body?.name, 80);
    if (!name) throw new BusinessError('Informe o motivo.');
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 s FROM loss_reasons WHERE sort < 99').get().s;
    db.prepare('INSERT INTO loss_reasons (name, requires_note, sort) VALUES (?, ?, ?)').run(name, req.body?.requires_note ? 1 : 0, sort);
    res.status(201).json({ ok: true });
  });
  admin.put('/motivos/:id', (req, res) => {
    const id = idParam(req);
    const r = db.prepare('SELECT * FROM loss_reasons WHERE id = ?').get(id);
    if (!r) throw new BusinessError('Motivo não encontrado.', 404);
    db.prepare('UPDATE loss_reasons SET name = ?, requires_note = ?, active = ? WHERE id = ?').run(
      U.cleanText(req.body?.name, 80) || r.name,
      req.body?.requires_note === undefined ? r.requires_note : (req.body.requires_note ? 1 : 0),
      req.body?.active === undefined ? r.active : (req.body.active ? 1 : 0), id,
    );
    res.json({ ok: true });
  });

  admin.get('/usuarios', (req, res) => {
    res.json({ admins: db.prepare('SELECT id, name, email, created_at FROM admins ORDER BY name').all() });
  });

  admin.post('/usuarios', (req, res) => {
    const { name, email, senha } = req.body || {};
    if (!name || !email || !senha || String(senha).length < 8) throw new BusinessError('Informe nome, e-mail e senha (mín. 8 caracteres).');
    if (db.prepare('SELECT 1 FROM admins WHERE email = ?').get(String(email).trim())) throw new BusinessError('E-mail já cadastrado.', 409);
    db.prepare('INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)')
      .run(U.cleanText(name, 100), U.cleanText(email, 150), hashPassword(senha));
    res.status(201).json({ ok: true });
  });

  // Cópia completa do banco de dados (produtos, estoque, pedidos, clientes).
  admin.get('/backup', async (req, res) => {
    const file = path.join(os.tmpdir(), `oggi-backup-${Date.now()}.db`);
    await db.backup(file);
    res.download(file, `oggi-backup-${new Date().toISOString().slice(0, 10)}.db`, () => fs.rm(file, { force: true }, () => {}));
  });

  admin.post('/senha', (req, res) => {
    const { atual, nova } = req.body || {};
    const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
    if (!verifyPassword(atual || '', a.password_hash)) throw new BusinessError('Senha atual incorreta.');
    if (!nova || String(nova).length < 8) throw new BusinessError('A nova senha precisa ter ao menos 8 caracteres.');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(nova), a.id);
    res.json({ ok: true });
  });

  // ---------- imagens dos produtos (públicas; o ?v= muda quando a foto muda) ----------
  app.get('/img/produto/:id', (req, res) => {
    const img = db.prepare('SELECT mime, data FROM product_images WHERE product_id = ?').get(Number(req.params.id));
    if (!img) return res.status(404).end();
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.type(img.mime).send(img.data);
  });

  // ---------- arquivos estáticos ----------
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { extensions: ['html'] }));
  app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

  // ---------- erros ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof BusinessError) return res.status(err.status).json({ error: err.message, ...(err.details || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Dados inválidos.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Arquivo muito grande.' });
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Registro duplicado (código, SKU ou CNPJ já existe).' });
    console.error(err);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  });

  return app;
}

module.exports = { createApp };

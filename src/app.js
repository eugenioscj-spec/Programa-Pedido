'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { getSettings } = require('./db');
const { hashPassword, verifyPassword, createSessionStore, createLoginLimiter } = require('./auth');
const { createInventory, BusinessError } = require('./inventory');
const U = require('./util');

function createApp(db) {
  const app = express();
  const sessions = createSessionStore(db);
  const inv = createInventory(db);
  const loginLimiter = createLoginLimiter();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // ---------- helpers ----------
  const PRODUCT_COLS = `p.*,
    (SELECT COALESCE(SUM(oi.units_total), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = p.id AND o.status IN ('novo', 'confirmado')) AS reserved_units`;

  const withAvailability = (p) => ({ ...p, available_units: p.stock_units - p.reserved_units });

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
  app.get('/api/config', (req, res) => {
    const s = getSettings(db);
    res.json({
      store_name: s.store_name,
      store_subtitle: s.store_subtitle,
      whatsapp: s.whatsapp,
      min_order_cents: Number(s.min_order_cents) || 0,
      order_notice: s.order_notice,
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

  app.get('/api/catalogo', requireCustomer, (req, res) => {
    const s = getSettings(db);
    const showQty = s.show_stock_quantity === '1';
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
        available_units: Math.max(0, p.available_units),
        show_quantity: showQty,
      }));
    res.json({ products });
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
      .filter((p) => p.available_units <= p.min_stock)
      .sort((a, b) => a.available_units - b.available_units)
      .slice(0, 50);
    const pendingCustomers = db.prepare("SELECT COUNT(*) n FROM customers WHERE status = 'pendente'").get().n;
    const today = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN quantity > 0 THEN quantity END), 0) AS entradas,
        COALESCE(SUM(CASE WHEN quantity < 0 THEN -quantity END), 0) AS saidas
      FROM stock_movements WHERE date(created_at, 'localtime') = date('now', 'localtime')`).get();
    const month = db.prepare(`
      SELECT COUNT(*) AS pedidos, COALESCE(SUM(total_cents), 0) AS total_cents
      FROM orders WHERE status IN ('separado', 'entregue')
        AND strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')`).get();
    const stockValue = db.prepare('SELECT COALESCE(SUM(stock_units * unit_price_cents), 0) v, COALESCE(SUM(stock_units), 0) u FROM products').get();
    res.json({ counts, lowStock, pendingCustomers, today, month, stockValue });
  });

  // ---------- admin: produtos ----------
  function readProduct(b, existing = {}) {
    const name = U.cleanText(b.name ?? existing.name, 150);
    if (!name) throw new BusinessError('Informe o nome do produto.');
    const upb = Number(b.units_per_box ?? existing.units_per_box ?? 1);
    if (!Number.isInteger(upb) || upb < 1) throw new BusinessError('Unidades por caixa deve ser um número inteiro maior que zero.');
    const unitPrice = b.unit_price !== undefined ? U.toCents(b.unit_price) : (existing.unit_price_cents ?? 0);
    const boxPrice = b.box_price !== undefined ? U.toCents(b.box_price) : (existing.box_price_cents ?? 0);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(boxPrice) || boxPrice < 0) throw new BusinessError('Preço inválido.');
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
    const p = readProduct(req.body || {});
    const info = db.prepare(`
      INSERT INTO products (sku, name, category, barcode, box_barcode, units_per_box, unit_price_cents, box_price_cents,
        sell_unit, sell_box, min_stock, active, description)
      VALUES (@sku, @name, @category, @barcode, @box_barcode, @units_per_box, @unit_price_cents, @box_price_cents,
        @sell_unit, @sell_box, @min_stock, @active, @description)`).run(p);
    res.status(201).json({ product: db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid) });
  });

  admin.put('/produtos/:id', (req, res) => {
    const id = idParam(req);
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) throw new BusinessError('Produto não encontrado.', 404);
    const p = readProduct(req.body || {}, existing);
    db.prepare(`
      UPDATE products SET sku=@sku, name=@name, category=@category, barcode=@barcode, box_barcode=@box_barcode,
        units_per_box=@units_per_box, unit_price_cents=@unit_price_cents, box_price_cents=@box_price_cents,
        sell_unit=@sell_unit, sell_box=@sell_box, min_stock=@min_stock, active=@active, description=@description,
        updated_at=datetime('now')
      WHERE id=@id`).run({ ...p, id });
    res.json({ product: db.prepare('SELECT * FROM products WHERE id = ?').get(id) });
  });

  // Importação CSV: colunas aceitas (cabeçalho): codigo_barras, codigo_caixa, sku, nome, categoria,
  // unidades_caixa, preco_unidade, preco_caixa, estoque_minimo, vende_unidade, vende_caixa
  admin.post('/produtos/importar', (req, res) => {
    const rows = U.parseCsv(req.body?.csv || '');
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
            min_stock: pick(r, 'estoque_minimo'),
            sell_unit: pick(r, 'vende_unidade'),
            sell_box: pick(r, 'vende_caixa'),
          };
          for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
          if (data.units_per_box !== undefined) data.units_per_box = Number(data.units_per_box);
          if (data.min_stock !== undefined) data.min_stock = Number(data.min_stock);
          if (existing) {
            const p = readProduct(data, existing);
            db.prepare(`
              UPDATE products SET sku=@sku, name=@name, category=@category, barcode=@barcode, box_barcode=@box_barcode,
                units_per_box=@units_per_box, unit_price_cents=@unit_price_cents, box_price_cents=@box_price_cents,
                sell_unit=@sell_unit, sell_box=@sell_box, min_stock=@min_stock, updated_at=datetime('now')
              WHERE id=@id`).run({ ...p, id: existing.id });
            updated++;
          } else {
            const p = readProduct(data);
            db.prepare(`
              INSERT INTO products (sku, name, category, barcode, box_barcode, units_per_box, unit_price_cents, box_price_cents,
                sell_unit, sell_box, min_stock, active, description)
              VALUES (@sku, @name, @category, @barcode, @box_barcode, @units_per_box, @unit_price_cents, @box_price_cents,
                @sell_unit, @sell_box, @min_stock, @active, @description)`).run(p);
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
      { label: 'estoque_minimo', value: 'min_stock' },
      { label: 'vende_unidade', value: (r) => (r.sell_unit ? 'sim' : 'nao') },
      { label: 'vende_caixa', value: (r) => (r.sell_box ? 'sim' : 'nao') },
      { label: 'estoque_fisico_un', value: 'stock_units' },
      { label: 'reservado_un', value: 'reserved_units' },
      { label: 'disponivel_un', value: 'available_units' },
      { label: 'ativo', value: (r) => (r.active ? 'sim' : 'nao') },
    ]);
    res.type('text/csv').attachment(`estoque-${new Date().toISOString().slice(0, 10)}.csv`).send(csv);
  });

  // ---------- admin: estoque ----------
  admin.post('/estoque/movimentar', (req, res) => {
    const b = req.body || {};
    const results = inv.manualMovement({
      type: b.type,
      lines: b.lines,
      document: U.cleanText(b.document, 100),
      note: U.cleanText(b.note, 300),
      user: req.admin.name,
    });
    res.json({ results });
  });

  admin.post('/estoque/inventario', (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.counts) || b.counts.length === 0) throw new BusinessError('Nenhuma contagem informada.');
    res.json({ results: inv.inventoryCount({ counts: b.counts, note: U.cleanText(b.note, 300), user: req.admin.name }) });
  });

  function movementQuery(qs) {
    const where = [];
    const params = [];
    if (qs.product_id) { where.push('m.product_id = ?'); params.push(Number(qs.product_id)); }
    if (qs.type) { where.push('m.type = ?'); params.push(String(qs.type)); }
    if (qs.from) { where.push("date(m.created_at, 'localtime') >= ?"); params.push(String(qs.from)); }
    if (qs.to) { where.push("date(m.created_at, 'localtime') <= ?"); params.push(String(qs.to)); }
    const sql = `
      SELECT m.*, datetime(m.created_at, 'localtime') AS created_local, p.name AS product_name, p.barcode, p.units_per_box
      FROM stock_movements m JOIN products p ON p.id = m.product_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.id DESC LIMIT ${Math.min(Number(qs.limit) || 500, 5000)}`;
    return db.prepare(sql).all(...params);
  }

  admin.get('/estoque/movimentos', (req, res) => res.json({ movements: movementQuery(req.query) }));

  admin.get('/estoque/movimentos.csv', (req, res) => {
    const csv = U.toCsv(movementQuery({ ...req.query, limit: 5000 }), [
      { label: 'data', value: 'created_local' },
      { label: 'tipo', value: 'type' },
      { label: 'produto', value: 'product_name' },
      { label: 'codigo_barras', value: 'barcode' },
      { label: 'quantidade_un', value: 'quantity' },
      { label: 'saldo_apos_un', value: 'balance_after' },
      { label: 'pedido', value: 'order_id' },
      { label: 'documento', value: 'document' },
      { label: 'observacao', value: 'note' },
      { label: 'usuario', value: 'created_by' },
    ]);
    res.type('text/csv').attachment('movimentacoes.csv').send(csv);
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
  const EDITABLE_SETTINGS = ['store_name', 'store_subtitle', 'whatsapp', 'min_order_cents', 'auto_approve_customers', 'show_stock_quantity', 'order_notice'];

  admin.get('/config', (req, res) => res.json({ settings: getSettings(db) }));

  admin.put('/config', (req, res) => {
    const b = req.body || {};
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (b.min_order !== undefined) {
      const cents = U.toCents(b.min_order);
      b.min_order_cents = Number.isFinite(cents) && cents > 0 ? cents : 0;
    }
    for (const key of EDITABLE_SETTINGS) {
      if (b[key] === undefined) continue;
      let value = String(b[key]).slice(0, 500);
      if (key === 'whatsapp') value = U.onlyDigits(value);
      if (key === 'auto_approve_customers' || key === 'show_stock_quantity') value = b[key] === true || b[key] === '1' ? '1' : '0';
      upsert.run(key, value);
    }
    res.json({ settings: getSettings(db) });
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

  // ---------- arquivos estáticos ----------
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { extensions: ['html'] }));
  app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin.html')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

  // ---------- erros ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof BusinessError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Dados inválidos.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Arquivo muito grande.' });
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Registro duplicado (código, SKU ou CNPJ já existe).' });
    console.error(err);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  });

  return app;
}

module.exports = { createApp };

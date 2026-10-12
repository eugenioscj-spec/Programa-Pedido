'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

// Cliente HTTP mínimo que guarda cookies (um "navegador" por instância).
function client(base) {
  const jar = {};
  const call = async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      jar[k] = v;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  call.cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  return call;
}

test('fluxo completo: cadastro, aprovação, pedido, separação e entrega', async (t) => {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const adm = client(base);
  const cli = client(base);

  // primeiro acesso cria o administrador
  assert.equal((await adm('GET', '/api/admin/setup')).data.needs_setup, true);
  assert.equal((await adm('POST', '/api/admin/setup', { name: 'Dono', email: 'dono@loja.com', senha: 'senha-forte-1' })).status, 201);
  assert.equal((await cli('POST', '/api/admin/setup', { name: 'X', email: 'x@x.com', senha: 'outrasenha1' })).status, 403);

  // produto + entrada de mercadoria por código de barras
  const prod = await adm('POST', '/api/admin/produtos', {
    name: 'Picolé Uva', category: 'Picolés', barcode: '7891111111111', box_barcode: '17891111111118',
    units_per_box: 20, unit_price: '5,00', box_price: '90,00',
  });
  assert.equal(prod.status, 201);
  const pid = prod.data.product.id;
  const dup = await adm('POST', '/api/admin/produtos', { name: 'Outro', barcode: '17891111111118' });
  assert.equal(dup.status, 409, 'código da caixa não pode ser reutilizado como código de outra unidade');

  const lookup = await adm('GET', '/api/admin/produtos/buscar?codigo=17891111111118');
  assert.equal(lookup.data.matched, 'caixa');
  const semCusto = await adm('POST', '/api/admin/estoque/entrada', { lines: [{ product_id: pid, units: 60, cost: '' }], document: 'NF 123' });
  assert.equal(semCusto.status, 400, 'entrada exige custo');
  await adm('POST', '/api/admin/estoque/entrada', { lines: [{ product_id: pid, units: 60, cost: '60,00', cost_per: 'caixa' }], document: 'NF 123' });

  // cliente se cadastra e fica pendente
  const cad = await cli('POST', '/api/cliente/cadastro', {
    cnpj: '11.222.333/0001-81', razao_social: 'Bar do Zé LTDA', telefone: '11999990000', senha: 'abcdef',
  });
  assert.equal(cad.status, 201);
  assert.equal(cad.data.customer.status, 'pendente');
  assert.equal(cad.data.customer.password_hash, undefined);
  assert.equal((await cli('GET', '/api/catalogo')).status, 403);
  assert.equal((await cli('GET', '/api/admin/produtos')).status, 401, 'cliente não acessa o painel');

  // loja aprova
  const { customers } = (await adm('GET', '/api/admin/clientes')).data;
  await adm('PUT', `/api/admin/clientes/${customers[0].id}`, { status: 'ativo' });

  const cat = await cli('GET', '/api/catalogo');
  assert.equal(cat.status, 200);
  assert.equal(cat.data.products[0].available_units, 60);
  assert.equal(cat.data.products[0].stock_units, undefined, 'não expõe campos internos');

  const ped = await cli('POST', '/api/pedidos', {
    items: [{ product_id: pid, unit_type: 'caixa', quantity: 2 }, { product_id: pid, unit_type: 'unidade', quantity: 3 }],
    notes: 'Entregar cedo',
  });
  assert.equal(ped.status, 201);
  assert.equal(ped.data.order.total_cents, 2 * 9000 + 3 * 500);
  const oid = ped.data.order.id;

  assert.equal((await cli('GET', '/api/catalogo')).data.products[0].available_units, 17);
  const tooMuch = await cli('POST', '/api/pedidos', { items: [{ product_id: pid, unit_type: 'caixa', quantity: 1 }] });
  assert.equal(tooMuch.status, 409);

  // loja confirma, separa (baixa) e entrega
  await adm('POST', `/api/admin/pedidos/${oid}/status`, { status: 'confirmado' });
  assert.equal((await cli('POST', `/api/pedidos/${oid}/cancelar`)).status, 400, 'cliente não cancela pedido já aceito');
  const sep = await adm('POST', `/api/admin/pedidos/${oid}/status`, { status: 'separado' });
  assert.equal(sep.status, 200);
  assert.equal(sep.data.order.items[0].stock_units, 17);
  await adm('POST', `/api/admin/pedidos/${oid}/status`, { status: 'entregue' });

  const movs = (await adm('GET', `/api/admin/estoque/movimentos?product_id=${pid}`)).data.movements;
  assert.deepEqual(movs.map((m) => m.type).sort(), ['entrada', 'saida_pedido', 'saida_pedido']);
  assert.equal(movs.find((m) => m.type === 'entrada').value_cents, 18000, '60 un × R$ 60,00 a caixa de 20');

  const meus = (await cli('GET', '/api/pedidos')).data.orders;
  assert.equal(meus[0].status, 'entregue');
  assert.equal(meus[0].admin_notes, undefined);

  const csv = await adm('GET', '/api/admin/produtos.csv');
  assert.equal((await adm('GET', '/api/health')).data.ok, true);
  const dash = await adm('GET', '/api/admin/dashboard');
  assert.equal(dash.data.storage_ok, true);
  assert.match(csv.data, /Picolé Uva/);

  // bloqueio derruba a sessão do cliente
  await adm('PUT', `/api/admin/clientes/${customers[0].id}`, { status: 'bloqueado' });
  assert.equal((await cli('GET', '/api/catalogo')).status, 401);
});

test('importação de produtos por CSV', async (t) => {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const adm = client(`http://127.0.0.1:${server.address().port}`);
  await adm('POST', '/api/admin/setup', { name: 'Dono', email: 'd@l.com', senha: 'senha-forte-1' });
  const csv = 'codigo_barras;codigo_caixa;nome;categoria;unidades_caixa;preco_unidade;preco_caixa\n'
    + '7890000000001;17890000000008;Pote Flocos;Potes;6;32,00;179,00\n'
    + '7890000000002;;Cone;Cones;12;8,00;\n'
    + ';;;;;;\n'
    + '7890000000003;;;Cones;12;8,00;\n';
  const r = await adm('POST', '/api/admin/produtos/importar', { csv });
  assert.equal(r.data.created, 2);
  assert.equal(r.data.errors.length, 1);
  const again = await adm('POST', '/api/admin/produtos/importar', { csv: 'codigo_barras;preco_unidade\n7890000000002;9,00\n' });
  assert.equal(again.data.updated, 1);
  const cone = db.prepare("SELECT * FROM products WHERE barcode = '7890000000002'").get();
  assert.equal(cone.unit_price_cents, 900);
  assert.equal(cone.name, 'Cone');
  assert.equal(cone.box_price_cents, 10800, 'preço da caixa calculado acompanha o preço da unidade');

  // planilha do Excel (.xlsx): baixa o modelo (já com os produtos), altera e reimporta
  const ExcelJS = require('exceljs');
  const semLogin = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/produtos/modelo.xlsx`);
  assert.equal(semLogin.status, 401, 'modelo exige login');
  assert.equal((await adm('GET', '/api/admin/produtos/modelo.xlsx')).status, 200);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Produtos');
  ws.addRow(['codigo_barras', 'nome', 'categoria', 'unidades_caixa', 'preco_unidade', 'preco_caixa']);
  ws.addRow([7890000000009, 'Açaí 2L', 'Açaí', 4, 45.9, '']);
  ws.addRow(['7890000000002', 'Cone', 'Cones', 12, '9,50', '']);
  ws.addRow(['7890000000000', 'Picolé Exemplo (apague esta linha)', 'Picolés', 24, 4.5, 98]);
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  const rx = await adm('POST', '/api/admin/produtos/importar', { xlsx });
  assert.deepEqual([rx.data.created, rx.data.updated, rx.data.errors.length], [1, 1, 0]);
  const acai = db.prepare("SELECT * FROM products WHERE barcode = '7890000000009'").get();
  assert.equal(acai.unit_price_cents, 4590);
  assert.equal(acai.box_price_cents, 4590 * 4);
  assert.equal((await adm('POST', '/api/admin/produtos/importar', { xlsx: 'bm90IGEgemlw' })).status, 400);

  const backup = await adm('GET', '/api/admin/backup');
  assert.equal(backup.status, 200);
  assert.match(backup.data, /^SQLite format 3/);
});

test('painel v2: destinos, estorno, custo inicial, imagens, catálogo e relatórios', async (t) => {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const adm = client(base);
  await adm('POST', '/api/admin/setup', { name: 'Dono', email: 'd@l.com', senha: 'senha-forte-1' });

  // catálogo Oggi 2026 com fotos
  const cat = await adm('POST', '/api/admin/produtos/catalogo-oggi', {});
  assert.deepEqual([cat.data.created, cat.data.images], [90, 90]);
  const products = (await adm('GET', '/api/admin/produtos')).data.products;
  const sensa = products.find((p) => p.name === 'Picolé Sensa Brigadeiro');
  assert.deepEqual([sensa.units_per_box, sensa.unit_price_cents, sensa.box_price_cents, sensa.retail_price_cents], [20, 599, 11980, 599]);
  assert.ok(sensa.image_url);
  const img = await fetch(base + sensa.image_url);
  assert.equal(img.headers.get('content-type'), 'image/webp');

  // unidades por caixa por linha: o preço da caixa calculado acompanha
  await adm('POST', '/api/admin/produtos/unidades-por-caixa', { category: 'Sensa', units_per_box: 24 });
  const sensa2 = db.prepare('SELECT * FROM products WHERE id = ?').get(sensa.id);
  assert.deepEqual([sensa2.units_per_box, sensa2.box_price_cents], [24, 599 * 24]);

  // imagem própria
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const big = Buffer.concat([png, Buffer.alloc(200)]).toString('base64');
  assert.equal((await adm('PUT', `/api/admin/produtos/${sensa.id}/imagem`, { mime: 'image/gif', data: big })).status, 400);
  const up = await adm('PUT', `/api/admin/produtos/${sensa.id}/imagem`, { mime: 'image/png', data: big });
  assert.notEqual(up.data.product.image_url, sensa.image_url);

  // entrada, saídas com destino, estorno e limite de observação
  const opts = (await adm('GET', '/api/admin/estoque/opcoes')).data;
  assert.deepEqual(opts.locations.map((l) => l.name), ['Loja 1 - Centro', 'Loja 2']);
  assert.equal(opts.default_supplier, 'Franqueadora Oggi');
  await adm('POST', '/api/admin/estoque/entrada', { lines: [{ product_id: sensa.id, units: 48, cost: '144,00', cost_per: 'caixa' }], supplier: 'Franqueadora Oggi', document: 'NF 77' });
  const semDestino = await adm('POST', '/api/admin/estoque/saida', { type: 'transferencia', lines: [{ product_id: sensa.id, units: 2 }] });
  assert.equal(semDestino.status, 400);
  const tr = await adm('POST', '/api/admin/estoque/saida', { type: 'transferencia', location_id: opts.locations[1].id, lines: [{ product_id: sensa.id, units: 2 }] });
  assert.equal(tr.data.results[0].value_cents, -1200);
  const muito = await adm('POST', '/api/admin/estoque/saida', { type: 'saida_sem_venda', subtype: 'consumo_interno', lines: [{ product_id: sensa.id, units: 40 }] });
  assert.match(muito.data.error, /observação/);
  const est = await adm('POST', `/api/admin/estoque/movimentos/${tr.data.results[0].id}/estornar`, { reason: 'Loja errada' });
  assert.equal(est.data.result.value_cents, 1200);
  const movs = (await adm('GET', `/api/admin/estoque/movimentos?product_id=${sensa.id}`)).data.movements;
  assert.equal(movs.find((m) => m.type === 'transferencia').reversed_by, est.data.result.id);
  assert.equal(movs.find((m) => m.type === 'transferencia').location_name, 'Loja 2');

  // custo inicial de produto com saldo sem custo
  const pote = products.find((p) => p.name === 'Pote Seleções Flocos');
  await adm('POST', '/api/admin/estoque/inventario', { counts: [{ product_id: pote.id, counted_units: 8 }] });
  assert.equal((await adm('GET', '/api/admin/estoque/sem-custo')).data.products.length, 1);
  assert.equal((await adm('GET', '/api/admin/dashboard')).data.uncosted, 1);
  await adm('POST', '/api/admin/estoque/custo-inicial', { product_id: pote.id, cost: '52,00', cost_per: 'caixa' });
  assert.equal(db.prepare('SELECT stock_value_cents v FROM products WHERE id = ?').get(pote.id).v, 10400);

  // relatórios (json, xlsx, csv)
  const conc = (await adm('GET', '/api/admin/relatorios/conciliacao')).data;
  assert.deepEqual([conc.report.check.units, conc.report.check.value], [0, 0]);
  const pos = (await adm('GET', '/api/admin/relatorios/posicao')).data.report;
  assert.equal(pos.sections[0].total.value, 48 * 600 + 10400);
  const xlsx = await fetch(`${base}/api/admin/relatorios/vendas?formato=xlsx`, { headers: { Cookie: adm.cookie() } });
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  const csv = await adm('GET', '/api/admin/relatorios/perdas?formato=csv');
  assert.match(csv.data, /Perdas e divergências/);
  assert.equal((await adm('GET', '/api/admin/relatorios/xyz')).status, 404);
  assert.equal((await adm('GET', '/api/admin/relatorios/vendas?from=2026-09-10&to=2026-09-01')).status, 400);

  // locais e motivos editáveis
  await adm('POST', '/api/admin/locais', { name: 'Loja 3' });
  await adm('POST', '/api/admin/motivos', { name: 'Queda de energia', requires_note: true });
  const opts2 = (await adm('GET', '/api/admin/estoque/opcoes')).data;
  assert.equal(opts2.locations.length, 3);
  assert.ok(opts2.reasons.some((r) => r.name === 'Queda de energia' && r.requires_note));
});

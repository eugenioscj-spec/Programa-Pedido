'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

// Cliente HTTP mínimo que guarda cookies (um "navegador" por instância).
function client(base) {
  const jar = {};
  return async function call(method, path, body) {
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
  await adm('POST', '/api/admin/estoque/movimentar', { type: 'entrada', lines: [{ product_id: pid, units: 60 }], document: 'NF 123' });

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

  const meus = (await cli('GET', '/api/pedidos')).data.orders;
  assert.equal(meus[0].status, 'entregue');
  assert.equal(meus[0].admin_notes, undefined);

  const csv = await adm('GET', '/api/admin/produtos.csv');
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
  assert.equal(cone.box_price_cents, 9600);

  const backup = await adm('GET', '/api/admin/backup');
  assert.equal(backup.status, 200);
  assert.match(backup.data, /^SQLite format 3/);
});

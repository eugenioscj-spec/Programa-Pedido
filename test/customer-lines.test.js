'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { loadOggiCatalog, productTypeOf } = require('../src/catalog');
const U = require('../src/util');

function client(base) {
  const jar = {};
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar[k] = v; }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

test('CPF: validação e formato', () => {
  assert.equal(U.isValidCpf('529.982.247-25'), true);
  assert.equal(U.isValidCpf('529.982.247-24'), false);
  assert.equal(U.isValidCpf('111.111.111-11'), false);
  assert.equal(U.isValidDoc('52998224725'), true);
  assert.equal(U.isValidDoc('63532954000246'), true);
  assert.equal(U.docLabel('52998224725'), 'CPF');
});

test('tipo do produto sai do nome', () => {
  assert.equal(productTypeOf('Picolé Sensa Brigadeiro'), 'Picolés');
  assert.equal(productTypeOf('Pote Hello Kitty Morango e Leite Condensado'), 'Potes');
  assert.equal(productTypeOf('Açaí 200g Banana'), 'Açaí');
  assert.equal(productTypeOf('Top Sundae Chocolate'), 'Sundae');
  assert.equal(productTypeOf('Cone Giratto Crocante'), 'Cones');
  assert.equal(productTypeOf('Mini Bombom Stranger Bites'), 'Bombons');
});

test('cliente com CPF, linhas liberadas e favoritos', async (t) => {
  const db = openDatabase(':memory:');
  loadOggiCatalog(db, { withImages: false });
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const adm = client(base);
  const cli = client(base);
  await adm('POST', '/api/admin/setup', { name: 'Dono', email: 'dono@loja.com', senha: 'senha-forte-1' });

  // estoque de um picolé e de um pote
  const id = (name) => db.prepare('SELECT id FROM products WHERE name = ?').get(name).id;
  const picole = id('Picolé Sensa Brigadeiro');
  const pote = id('Pote Seleções Flocos');
  await adm('POST', '/api/admin/estoque/entrada', { lines: [
    { product_id: picole, units: 40, cost: '3,00', cost_per: 'unidade' },
    { product_id: pote, units: 8, cost: '12,00', cost_per: 'unidade' },
  ], document: 'NF 1' });

  // cadastro por CPF (estabelecimento informal)
  assert.equal((await cli('POST', '/api/cliente/cadastro', { cnpj: '529.982.247-24', razao_social: 'X', telefone: '1', senha: 'abcdef' })).status, 400);
  const cad = await cli('POST', '/api/cliente/cadastro', { cnpj: '529.982.247-25', razao_social: 'Maria da Silva', telefone: '66999990000', senha: 'abcdef' });
  assert.equal(cad.status, 201);
  const cid = cad.data.customer.id;

  // só picolés liberados
  await adm('PUT', `/api/admin/clientes/${cid}`, { status: 'ativo', allowed_lines: ['Picolés'] });
  const outro = client(base);
  assert.equal((await outro('POST', '/api/cliente/login', { cnpj: '52998224725', senha: 'abcdef' })).status, 200, 'login pelo CPF');
  let cat = (await outro('GET', '/api/catalogo')).data.products;
  assert.ok(cat.length > 0 && cat.every((p) => p.product_type === 'Picolés'), 'não vê potes');
  const recusa = await outro('POST', '/api/pedidos', { items: [{ product_id: pote, unit_type: 'unidade', quantity: 1 }] });
  assert.equal(recusa.status, 400);
  assert.match(recusa.data.error, /não está liberado/);
  assert.equal((await outro('POST', '/api/pedidos', { items: [{ product_id: picole, unit_type: 'unidade', quantity: 2 }] })).status, 201);

  // uma linha de potes a mais
  await adm('PUT', `/api/admin/clientes/${cid}`, { allowed_lines: ['Picolés', 'Potes|Seleções'] });
  cat = (await outro('GET', '/api/catalogo')).data.products;
  assert.deepEqual([...new Set(cat.map((p) => `${p.product_type}|${p.product_type === 'Potes' ? p.category : ''}`))].sort(), ['Picolés|', 'Potes|Seleções']);
  const lista = (await adm('GET', '/api/admin/clientes')).data.customers.find((c) => c.id === cid);
  assert.deepEqual(lista.allowed_lines, ['Picolés', 'Potes|Seleções']);
  assert.equal((await adm('PUT', `/api/admin/clientes/${cid}`, { allowed_lines: [] })).status, 400, 'ao menos uma linha');
  await adm('PUT', `/api/admin/clientes/${cid}`, { allowed_lines: null });
  assert.ok((await outro('GET', '/api/catalogo')).data.products.some((p) => p.product_type === 'Cones'), 'null = tudo');

  // favoritos
  assert.equal((await outro('PUT', `/api/favoritos/${pote}`, { favorite: true })).status, 200);
  assert.equal((await outro('PUT', `/api/favoritos/${pote}`, { favorite: true })).status, 200, 'repetir não duplica');
  cat = (await outro('GET', '/api/catalogo')).data.products;
  assert.deepEqual(cat.filter((p) => p.favorite).map((p) => p.id), [pote]);
  await outro('PUT', `/api/favoritos/${pote}`, { favorite: false });
  assert.equal((await outro('GET', '/api/catalogo')).data.products.filter((p) => p.favorite).length, 0);
  // não favorita o que não está liberado
  await adm('PUT', `/api/admin/clientes/${cid}`, { allowed_lines: ['Picolés'] });
  assert.equal((await outro('PUT', `/api/favoritos/${pote}`, { favorite: true })).status, 404);
});

test('migração 8: tipo, Disney com personagem e açaí 200g com 12 por caixa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oggi-mig8-'));
  const file = path.join(dir, 'oggi.db');
  const old = openDatabase(file, { log: () => {}, upTo: 7 });
  loadOggiCatalog(old, { withImages: false });
  // como estava antes: nomes antigos e 4 por caixa
  old.prepare("UPDATE products SET name = 'Picolé Disney Morango' WHERE sku = 'OG26-DISNEY-MORANGO'").run();
  old.prepare("UPDATE products SET name = 'Meu nome', units_per_box = 24 WHERE sku = 'OG26-DISNEY-UVA'").run();
  old.prepare("UPDATE products SET units_per_box = 4, box_price_cents = unit_price_cents * 4 WHERE sku LIKE 'OG26-ACAI-%'").run();
  old.close();

  const db = openDatabase(file, { log: () => {} });
  const bySku = (sku) => db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  assert.equal(bySku('OG26-DISNEY-MORANGO').name, 'Picolé Disney Minnie Morango');
  assert.equal(bySku('OG26-DISNEY-UVA').name, 'Meu nome', 'nome trocado à mão fica');
  const acai = bySku('OG26-ACAI-200-BANANA');
  assert.deepEqual([acai.units_per_box, acai.box_price_cents], [12, acai.unit_price_cents * 12]);
  assert.equal(bySku('OG26-ACAI-15-GUARANA').units_per_box, 4, 'açaí 1,5L continua com 4');
  assert.deepEqual(db.prepare("SELECT name FROM products WHERE product_type = 'Outros'").all().map((r) => r.name), ['Meu nome']);
  assert.equal(bySku('OG26-SENSA-BRIGADEIRO').product_type, 'Picolés');
  assert.equal(bySku('OG26-ACAI-200-BANANA').product_type, 'Açaí');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

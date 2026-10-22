'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { createInventory } = require('../src/inventory');
const T = require('../src/time');

function client(base) {
  const jar = {};
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const [k, v] = pair.split('='); jar[k] = v; }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

async function setup(t) {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const master = client(base);
  await master('POST', '/api/admin/setup', { name: 'Dono', email: 'dono@oggi.com', senha: 'senha-forte-1' });
  const pid = Number(db.prepare("INSERT INTO products (name, units_per_box, unit_price_cents, box_price_cents) VALUES ('Picolé', 20, 500, 10000)").run().lastInsertRowid);
  const inv = createInventory(db);
  inv.receive({ lines: [{ product_id: pid, units: 100, cost_cents: 200 }] });
  const loja2 = db.prepare("SELECT id FROM locations WHERE name = 'Loja 2'").get().id;
  const loja1 = db.prepare("SELECT id FROM locations WHERE name = 'Loja 1 - Centro'").get().id;
  return { db, base, master, pid, inv, loja1, loja2 };
}

test('perfis: usuário da loja vê estoque sem valores e só repõe a própria loja', async (t) => {
  const { db, base, master, pid, loja1, loja2 } = await setup(t);
  assert.equal((await master('GET', '/api/admin/me')).data.admin.role, 'master');
  assert.equal((await master('POST', '/api/admin/usuarios', { name: 'Ana', email: 'ana@oggi.com', senha: 'loja2-senha', role: 'loja' })).status, 400, 'loja exige a loja');
  assert.equal((await master('POST', '/api/admin/usuarios', { name: 'Ana', email: 'ana@oggi.com', senha: 'loja2-senha', role: 'loja', location_id: loja2 })).status, 201);

  const loja = client(base);
  assert.equal((await loja('POST', '/api/admin/login', { email: 'ana@oggi.com', senha: 'loja2-senha' })).data.admin.role, 'loja');
  for (const path of ['/api/admin/dashboard', '/api/admin/produtos', '/api/admin/relatorios/dre', '/api/admin/financeiro/lancamentos', '/api/admin/estoque/movimentos', '/api/admin/usuarios', '/api/admin/backup']) {
    assert.equal((await loja('GET', path)).status, 403, `loja não acessa ${path}`);
  }
  assert.equal((await loja('POST', '/api/admin/estoque/entrada', { lines: [] })).status, 403);

  const est = await loja('GET', '/api/admin/loja/estoque');
  assert.equal(est.data.location, 'Loja 2');
  assert.equal(est.data.products[0].stock_units, 100);
  assert.doesNotMatch(JSON.stringify(est.data), /value|cost|price/i, 'sem custos nem preços');

  // tenta mandar para a Loja 1: vai para a Loja 2 (a do usuário)
  const rep = await loja('POST', '/api/admin/loja/reposicao', { lines: [{ product_id: pid, units: 20 }], location_id: loja1 });
  assert.deepEqual(rep.data, { moved: 1, units: 20 });
  const mov = db.prepare("SELECT * FROM stock_movements WHERE type = 'transferencia'").get();
  assert.deepEqual([mov.location_id, mov.created_by, mov.value_cents], [loja2, 'Ana', -4000]);
  const hist = await loja('GET', '/api/admin/loja/reposicoes');
  assert.equal(hist.data.movements.length, 1);
  assert.equal(hist.data.movements[0].value_cents, undefined);

  // a própria senha o usuário da loja pode trocar
  assert.equal((await loja('POST', '/api/admin/senha', { atual: 'loja2-senha', nova: 'nova-senha-1' })).status, 200);

  // master desativa: a sessão cai e o login é recusado
  const ana = db.prepare("SELECT id FROM admins WHERE email = 'ana@oggi.com'").get().id;
  await master('PUT', `/api/admin/usuarios/${ana}`, { active: false });
  assert.equal((await loja('GET', '/api/admin/loja/estoque')).status, 401);
  assert.equal((await client(base)('POST', '/api/admin/login', { email: 'ana@oggi.com', senha: 'nova-senha-1' })).status, 403);

  // sempre sobra um master
  const me = db.prepare("SELECT id FROM admins WHERE email = 'dono@oggi.com'").get().id;
  assert.equal((await master('PUT', `/api/admin/usuarios/${me}`, { role: 'loja', location_id: loja1 })).status, 400);
});

test('saídas sem venda: brinde, parceria (com observação) e tipo novo', async (t) => {
  const { master, pid } = await setup(t);
  const opts = (await master('GET', '/api/admin/estoque/opcoes')).data;
  assert.ok(['brinde', 'parceria', 'doacao'].every((k) => opts.subtypes.some((s) => s.value === k)));
  assert.equal((await master('POST', '/api/admin/estoque/saida', { type: 'saida_sem_venda', subtype: 'brinde', lines: [{ product_id: pid, units: 2 }] })).status, 200);
  const semObs = await master('POST', '/api/admin/estoque/saida', { type: 'saida_sem_venda', subtype: 'parceria', lines: [{ product_id: pid, units: 2 }] });
  assert.match(semObs.data.error, /Parceria \/ patrocínio" precisa de observação/);
  assert.equal((await master('POST', '/api/admin/tipos-saida', { label: 'Evento beneficente' })).status, 201);
  assert.equal((await master('POST', '/api/admin/estoque/saida', { type: 'saida_sem_venda', subtype: 'evento_beneficente', lines: [{ product_id: pid, units: 1 }] })).status, 200);
  const movs = (await master('GET', '/api/admin/estoque/movimentos?type=saida_sem_venda')).data.movements;
  assert.deepEqual(movs.map((m) => m.subtype_label), ['Evento beneficente', 'Brinde']);
});

test('financeiro: DRE soma estoque + lançamentos; DFC usa só o que foi pago', async (t) => {
  const { db, master, pid, inv, loja1 } = await setup(t);
  const today = T.localDate();
  const month = today.slice(0, 7);
  // venda B2B: 20 un × R$ 5,00 = R$ 100 de receita, CMV 20 × R$ 2,00 = R$ 40
  const cid = Number(db.prepare("INSERT INTO customers (cnpj, razao_social, password_hash, status) VALUES ('11222333000181', 'Bar', 'x', 'ativo')").run().lastInsertRowid);
  const oid = inv.createOrder({ customerId: cid, items: [{ product_id: pid, unit_type: 'caixa', quantity: 1 }] });
  inv.changeStatus({ orderId: oid, status: 'separado' });
  inv.dispatch({ type: 'transferencia', locationId: loja1, lines: [{ product_id: pid, units: 10 }] }); // R$ 20 a custo
  inv.dispatch({ type: 'perda', reasonId: 1, lines: [{ product_id: pid, units: 5 }] }); // R$ 10
  inv.dispatch({ type: 'saida_sem_venda', subtype: 'brinde', lines: [{ product_id: pid, units: 5 }] }); // R$ 10

  const { accounts } = (await master('GET', '/api/admin/financeiro/opcoes')).data;
  const acc = (name) => accounts.find((a) => a.name === name).id;
  const post = (body) => master('POST', '/api/admin/financeiro/lancamentos', body);
  assert.equal((await post({ account_id: acc('Vendas Loja 1 - Centro'), amount: '300,00', competence_date: today, paid_date: today })).status, 201);
  await post({ account_id: acc('Aluguel e condomínio'), amount: '120,00', competence_date: today }); // em aberto
  await post({ account_id: acc('Impostos sobre vendas (Simples/ICMS)'), amount: '20,00', competence_date: today, paid_date: today });
  await post({ account_id: acc('Recebimento de clientes B2B'), amount: '100,00', competence_date: today, paid_date: today }); // só caixa
  await post({ account_id: acc('Compra de equipamentos'), amount: '50,00', competence_date: today, paid_date: today }); // só caixa
  assert.equal((await post({ account_id: acc('Aluguel e condomínio'), amount: '0', competence_date: today })).status, 400);
  await master('PUT', '/api/admin/financeiro/saldo-inicial', { valor: '1.000,00' });

  const dre = (await master('GET', `/api/admin/relatorios/dre?from=${month}-01&to=${today}`)).data.report;
  const line = (label) => dre.sections[0].rows.find((r) => r.line === label).total;
  assert.equal(line('Receita bruta'), 10000 + 30000);
  assert.equal(line('= Receita líquida'), 40000 - 2000);
  assert.equal(line('   CMV das vendas B2B (custo médio)'), -4000);
  assert.equal(line('   Mercadoria enviada às lojas (a custo)'), -2000);
  assert.equal(line('   Perdas e ajustes de inventário'), -1000);
  assert.equal(line('= Lucro bruto'), 38000 - 7000);
  assert.equal(line('   Brindes, parcerias e bonificações (a custo)'), -1000);
  assert.equal(line('= Resultado líquido'), 31000 - 1000 - 12000, 'aluguel entra por competência, mesmo em aberto');
  assert.equal(dre.result.resultado_liquido, 18000);

  const dfc = (await master('GET', `/api/admin/relatorios/dfc?from=${month}-01&to=${today}`)).data.report;
  assert.deepEqual(dfc.result, { saldo_inicial: 100000, variacao: 30000 - 2000 + 10000 - 5000, saldo_final: 100000 + 33000 });

  // marcar como pago muda o caixa, não a DRE
  const lanc = (await master('GET', '/api/admin/financeiro/lancamentos?status=aberto')).data;
  assert.equal(lanc.open.despesa, 12000);
  await master('POST', `/api/admin/financeiro/lancamentos/${lanc.entries[0].id}/pagar`, {});
  const dfc2 = (await master('GET', `/api/admin/relatorios/dfc?from=${month}-01&to=${today}`)).data.report;
  assert.equal(dfc2.result.saldo_final, 133000 - 12000);
  const xlsx = await master('GET', `/api/admin/relatorios/dre?from=${month}-01&to=${today}&formato=csv`);
  assert.match(xlsx.data, /DRE gerencial/);
});

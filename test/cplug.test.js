'use strict';

// Conector do CPlug contra um "CPlug de mentira" local, que imita o caminho do site real
// (login com _token e cookie, troca de empresa, relatório de vendas em página HTML).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchDay, parseProducts, parsePayments, cents } = require('../src/cplug');

const PRODUCTS = {
  1: [['---', 'Outras despesas, Descontos e Frete', '', '0', 'R$ -3,99'], ['543', 'SENSA BRIGADEIRO', '13/11/2026', '8.0000', 'R$ 47,92'],
    ['493', 'FESTA MELANCIA 60G', '13/11/2026', '46.0000', 'R$ 69,00']],
  2: [['102', '2 LITROS NAPOLITANO', '13/11/2026', '5.0000', 'R$ 119,95'], ['1205', 'AÇAI COM GUARANA 200G', '13/11/2026', '1.0000', 'R$ 1.012,25']],
};
const PAYMENTS = {
  1: [['Dinheiro', '3', 'R$ 40,00'], ['Cartão de Crédito', '2', 'R$ 52,93'], ['PIX', '1', 'R$ 20,00']],
  2: [['Cartão de Débito', '4', 'R$ 1.132,20']],
};

function fakeCplug({ password = 'certa' } = {}) {
  const sessions = new Map();
  const table = (head, rows) => `<table class="table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td> ${c} </td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const sid = (req.headers.cookie || '').match(/laravel_session=(\w+)/)?.[1];
      const sess = sid && sessions.get(sid);
      const form = Object.fromEntries(new URLSearchParams(body));
      const send = (status, html, headers = {}) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
      if (req.url === '/login' && req.method === 'GET') {
        const id = Math.random().toString(36).slice(2);
        sessions.set(id, { token: `tok${id}`, logged: false, company: 1 });
        return send(200, `<form method="POST"><input type="hidden" name="_token" value="tok${id}"><input name="login_code"><input name="username"><input type="password" name="password"></form>`,
          { 'Set-Cookie': `laravel_session=${id}; path=/; httponly` });
      }
      if (req.url === '/login' && req.method === 'POST') {
        if (!sess || form._token !== sess.token) return send(419, 'Page Expired');
        if (form.login_code !== '1234' || form.username !== 'robo' || form.password !== password) return send(302, '', { Location: '/login' });
        sess.logged = true;
        return send(302, '', { Location: '/sistema' });
      }
      if (!sess || !sess.logged) return send(302, '', { Location: '/login' });
      if (req.url === '/sistema') {
        return send(200, `<ul class="empresas"><li><a href="https://x/sistema/empresa/escolhida/1/back">MT SINOP CENTRO</a></li>
          <li><a href="/sistema/empresa/escolhida/2/back">MT SINOP RESIDENCIAL BURITIS</a></li></ul>`);
      }
      const m = req.url.match(/^\/sistema\/empresa\/escolhida\/(\d+)\/back$/);
      if (m) { sess.company = Number(m[1]); return send(302, '', { Location: '/sistema/relatorios/vendas' }); }
      if (req.url === '/sistema/relatorios/vendas') {
        const header = `<h4>${sess.company === 2 ? 'MT SINOP RESIDENCIAL BURITIS - 63.532.954/0002-46' : 'MT SINOP CENTRO - 11.222.333/0001-81'}</h4>`;
        const tokenInput = `<input type="hidden" name="_token" value="${sess.token}">`;
        if (req.method === 'GET') return send(200, `${header}<form>${tokenInput}</form>`);
        if (form._token !== sess.token) return send(419, 'Page Expired');
        if (form.tab_actived === 'sale' && form.groupProductsByDay === '1' && form.date_start === '13/11/2026') {
          return send(200, `${header}${tokenInput}${table(['Código', 'Produto', 'Data', 'Quantidade', 'Valor'], PRODUCTS[sess.company])}`);
        }
        if (form.tab_actived === 'day' && form.show === 'method' && form.dt_start === '13/11/2026') {
          return send(200, `${header}${tokenInput}${table(['Forma de pagamento', 'Quantidade', 'Valor total'], [...PAYMENTS[sess.company], ['Total', '', 'R$ 0,00']])}`);
        }
        return send(200, `${header}<p>Nenhum resultado</p>`);
      }
      return send(404, 'não achei');
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

test('leitura de valores e tabelas do CPlug', () => {
  assert.equal(cents('R$ 1.234,56'), 123456);
  assert.equal(cents('R$ -3,99'), -399);
  const p = parseProducts('<table><tr><th>Código</th><th>Produto</th><th>Data</th><th>Quantidade</th><th>Valor</th></tr><tr><td>546</td><td>SENSA CLASSICO</td><td>07/11/2026</td><td>8.0000</td><td>R$ 47,92</td></tr></table>');
  assert.deepEqual(p.items, [{ code: '546', name: 'SENSA CLASSICO', date: '07/11/2026', quantity: 8, value_cents: 4792 }]);
  assert.equal(parsePayments('<table><tr><th>Produto</th><th>Valor</th></tr></table>'), null);
});

test('busca do dia: login, as duas lojas, produtos e formas de pagamento', async (t) => {
  const server = await fakeCplug();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetchDay({ date: '2026-11-13', empresa: '1234', usuario: 'robo', senha: 'certa', base });
  assert.equal(r.stores.length, 2);
  const [centro, buritis] = r.stores;
  assert.equal(centro.name, 'MT SINOP CENTRO');
  assert.equal(buritis.cnpj, '63.532.954/0002-46');
  assert.deepEqual(centro.errors, []);
  assert.equal(centro.products.items.length, 2);
  assert.equal(centro.products.other_cents, -399);
  assert.equal(centro.products.total_cents, 4792 + 6900 - 399);
  assert.deepEqual(centro.payments.methods.map((m) => [m.method, m.count, m.value_cents]),
    [['Dinheiro', 3, 4000], ['Cartão de Crédito', 2, 5293], ['PIX', 1, 2000]]);
  assert.equal(centro.payments.total_cents, centro.products.total_cents, 'produtos e pagamentos batem');
  assert.equal(buritis.products.items[1].value_cents, 101225);
  assert.equal(buritis.payments.total_cents, 113220);
  // diagnóstico sem a senha e sem o código de segurança do formulário
  const dump = JSON.stringify(r.pages);
  assert.ok(r.pages.length >= 4);
  assert.ok(!dump.includes('certa') && !/value=\\?"tok/.test(dump));
});

test('login recusado e variáveis faltando dão mensagem clara', async (t) => {
  const server = await fakeCplug({ password: 'outra' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(fetchDay({ date: '2026-11-13', empresa: '1234', usuario: 'robo', senha: 'certa', base }), /recusou o login/);
  await assert.rejects(fetchDay({ date: '2026-11-13', empresa: '', usuario: 'robo', senha: 'x', base }), /CPLUG_EMPRESA/);
});

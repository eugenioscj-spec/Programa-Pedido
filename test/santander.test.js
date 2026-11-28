'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { createBank } = require('../src/bank');
const { createSantanderSync } = require('../src/santander-sync');
const santander = require('../src/santander');

const ENV = { SANTANDER_CLIENT_ID: ' cid ', SANTANDER_CLIENT_SECRET: 'sec', SANTANDER_AMBIENTE: 'producao', SANTANDER_CERT_PFX: Buffer.from('PFX').toString('base64'),
  SANTANDER_CERT_SENHA: 'x', SANTANDER_CONTAS: '4316.13005206-3, 4316/130042277' };

// formato real da produção (17/11/2026): datas dd/mm/aaaa, valor positivo + CREDITO/DEBITO
const tx = (d, v, type, name, comp = '') => ({ transactionDate: d, amount: v, creditDebitType: type, transactionName: name, historicComplement: comp });
function fakeSantander(pages, seen = []) {
  return async (o) => {
    seen.push(o);
    assert.ok(o.pfx && o.passphrase === 'x', 'toda chamada com o e-CNPJ (mTLS)');
    if (o.url === santander.URLS.producao.token) {
      const p = new URLSearchParams(o.body);
      assert.equal(p.get('client_id'), 'cid', 'espaços colados são ignorados');
      return { status: 200, text: '{"access_token":"tok","expires_in":900}' };
    }
    assert.equal(o.headers.Authorization, 'Bearer tok');
    assert.equal(o.headers['X-Application-Key'], 'cid');
    if (o.url.includes('/balances/')) return { status: 422, text: '{"_errors":[{"_message":"Erro na Consulta"}]}' };
    const u = new URL(o.url);
    const id = u.pathname.split('/').pop();
    const page = Number(u.searchParams.get('_offset'));
    assert.equal(u.searchParams.get('initialDate'), '2026-11-20');
    return { status: 200, text: JSON.stringify({ _content: (pages[id] || [])[page - 1] || [] }) };
  };
}

test('Santander: extrato das duas contas (paginado), sinal pelo tipo, saldo 422 não atrapalha, sem duplicar', async () => {
  const db = openDatabase(':memory:');
  const bank = createBank(db);
  const full = Array.from({ length: 50 }, (_, i) => tx('21/11/2026', 1 + i, 'CREDITO', 'PIX RECEBIDO', `CLIENTE ${i}`));
  const pages = {
    '4316.000130052063': [full, [tx('22/11/2026', 250.5, 'DEBITO', 'PIX ENVIADO', 'FORNECEDOR')]],
    '4316.000130042277': [[tx('23/11/2026', 99.9, 'CREDITO', 'TED RECEBIDA')]],
  };
  const sync = createSantanderSync(db, bank, { env: ENV, requestImpl: fakeSantander(pages), log: () => {} });
  assert.ok(sync.configured());
  const r = await sync.run({ startDate: '2026-11-20', endDate: '2026-11-27' });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.results.map((x) => [x.conta, x.new]), [['4316 / 13005206-3', 51], ['4316 / 13004227-7', 1]]);
  assert.equal(r.results[0].saldo_cents, null, 'saldo 422 = sem saldo, mas o extrato entra');
  const deb = db.prepare("SELECT amount_cents, description FROM bank_transactions WHERE description LIKE 'PIX ENVIADO%'").get();
  assert.deepEqual(deb, { amount_cents: -25050, description: 'PIX ENVIADO FORNECEDOR' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bank_accounts WHERE bank_code = '033'").get().n, 2);
  const again = await sync.run({ startDate: '2026-11-20', endDate: '2026-11-27' });
  assert.equal(again.results[0].new + again.results[1].new, 0);
});

test('Santander: conta em vários formatos, ambiente e erro claro sem variáveis', async () => {
  assert.equal(santander.parseAccount('4316.13005206-3').id, '4316.000130052063');
  assert.equal(santander.parseAccount('4316/130042277').label, '4316 / 13004227-7');
  assert.equal(santander.parseAccount('abc'), null);
  assert.equal(santander.config({ SANTANDER_AMBIENTE: 'Produção' }).ambiente, 'producao');
  assert.equal(santander.toTransaction(tx('01/12/2026', '10,50', 'DEBITO', 'TARIFA')).amount_cents, -1050);
  const db = openDatabase(':memory:');
  const r = await createSantanderSync(db, createBank(db), { env: { SANTANDER_CONTAS: '4316.13005206-3' }, log: () => {} }).run({ days: 3 });
  assert.match(r.problems.join(' '), /SANTANDER_CLIENT_ID/);
});

let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }
test('Santander: confere se o certificado .pfx abre com a senha', { skip: !hasOpenssl && 'sem openssl' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=teste'], { stdio: 'ignore' });
  execFileSync('openssl', ['pkcs12', '-export', '-inkey', path.join(dir, 'k.pem'), '-in', path.join(dir, 'c.pem'), '-out', path.join(dir, 'a.pfx'), '-passout', 'pass:certa'], { stdio: 'ignore' });
  const b64 = fs.readFileSync(path.join(dir, 'a.pfx')).toString('base64');
  assert.equal(santander.certCheck(santander.config({ SANTANDER_CERT_PFX: b64, SANTANDER_CERT_SENHA: 'certa' })).ok, true);
  const bad = santander.certCheck(santander.config({ SANTANDER_CERT_PFX: b64, SANTANDER_CERT_SENHA: 'errada' }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /senha/);
});

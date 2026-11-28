'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cert = require('../src/itau-cert');
const { openDatabase } = require('../src/db');
const { createBank } = require('../src/bank');
const { createItauSync } = require('../src/itau-sync');

// "Itaú" de teste: assina o CSR com uma CA própria (precisa do openssl na máquina de teste)
function fakeSts(dir) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'ca.key'), '-out', path.join(dir, 'ca.crt'), '-days', '5', '-subj', '/CN=CA teste'], { stdio: 'ignore' });
  return async ({ token, body }) => {
    if (token !== 'tok-temp') return { status: 401, text: '{"message":"token invalido"}' };
    fs.writeFileSync(path.join(dir, 'req.csr'), body);
    execFileSync('openssl', ['x509', '-req', '-in', path.join(dir, 'req.csr'), '-CA', path.join(dir, 'ca.crt'), '-CAkey', path.join(dir, 'ca.key'), '-CAcreateserial', '-out', path.join(dir, 'out.crt'), '-days', '365'], { stdio: 'ignore' });
    return { status: 200, text: `${fs.readFileSync(path.join(dir, 'out.crt'), 'utf8')}\nSecret: 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n` };
  };
}
let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }

test('certificado Itaú: CSR igual ao do programa oficial, certificado e Client Secret da resposta', { skip: !hasOpenssl && 'sem openssl' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-'));
  const post = fakeSts(dir);
  const out = await cert.requestCertificate({ clientId: 'cid-123', token: 'tok-temp', organization: 'GELARE LOJA MT01 LTDA', city: 'Sinop', state: 'mt', postImpl: post });
  assert.equal(out.clientSecret, '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
  assert.match(out.certPem, /^-----BEGIN CERTIFICATE-----/);
  assert.ok(out.validTo > '2027-01-01', 'validade de ~1 ano');
  const subject = execFileSync('openssl', ['req', '-in', path.join(dir, 'req.csr'), '-noout', '-verify', '-subject'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(subject, /C = BR, ST = MT, L = Sinop, OU = GELARE LOJA MT01 LTDA, CN = cid-123/);
  // a chave privada é a do certificado
  const crypto = require('node:crypto');
  assert.ok(new crypto.X509Certificate(out.certPem).checkPrivateKey(crypto.createPrivateKey(out.keyPem)));
  await assert.rejects(cert.requestCertificate({ clientId: 'cid-123', token: 'vencido', organization: 'X', city: 'Y', state: 'MT', postImpl: post }), /vencido \(vale 7 dias\)/);
});

test('guarda cifrada: com ITAU_CRYPT_KEY cifra; sem ela fica legível; chave errada não abre', () => {
  const env = { ITAU_CRYPT_KEY: 'segredo-longo' };
  const s = cert.seal('minha-senha', env);
  assert.match(s, /^enc:/);
  assert.ok(!s.includes('minha-senha'));
  assert.equal(cert.unseal(s, env), 'minha-senha');
  assert.throws(() => cert.unseal(s, { ITAU_CRYPT_KEY: 'outra' }));
  assert.equal(cert.unseal(cert.seal('abc', {}), {}), 'abc');
});

test('rotina Itaú usa a credencial guardada no banco (uma por CNPJ, com suas contas)', async () => {
  const db = openDatabase(':memory:');
  const env = {};
  db.prepare(`INSERT INTO itau_credentials (label, cnpj, client_id, client_secret, key_pem, cert_pem, valid_to, accounts)
    VALUES ('Filial', '63532954000246', 'cid-f', ?, ?, 'CERT', '2027-11-28', '4776/99822-3')`).run(cert.seal('sec-f', env), cert.seal('KEY', env));
  const seen = [];
  const requestImpl = async (o) => {
    seen.push(o);
    if (o.url.endsWith('/oauth/token')) {
      const p = new URLSearchParams(o.body);
      assert.deepEqual([p.get('client_id'), p.get('client_secret'), String(o.cert), String(o.key)], ['cid-f', 'sec-f', 'CERT', 'KEY']);
      return { status: 200, text: '{"access_token":"t"}' };
    }
    if (o.url.includes('/balances')) return { status: 200, text: '{"data":[]}' };
    assert.match(o.url, /statements\/477600998223\?/);
    return { status: 200, text: JSON.stringify({ data: [{ events: [{ id: 'e1', operation: 'C', date: { accounting: '2026-11-27' }, literal: { complete: 'RECEBIMENTO REDE VISA DB0107531038' }, amount: { value: 10 } }] }] }) };
  };
  const sync = createItauSync(db, createBank(db), { env, requestImpl, log: () => {} });
  assert.ok(sync.configured());
  const r = await sync.run({ startDate: '2026-11-27', endDate: '2026-11-27' });
  assert.deepEqual(r.problems, []);
  assert.equal(r.results[0].conta, '4776 / 99822-3');
  assert.equal(r.results[0].new, 1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { createBank } = require('../src/bank');
const { createItauSync } = require('../src/itau-sync');
const itau = require('../src/itau');

function tmpCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itau-'));
  fs.writeFileSync(path.join(dir, 'itau.crt'), 'CERT');
  fs.writeFileSync(path.join(dir, 'itau.key'), 'KEY');
  return dir;
}
const ev = (id, date, op, value, text, who) => ({ id, type: 'lancamento', operation: op, reversal: false, date: { event: `${date}T10:00:00-03:00`, accounting: date },
  literal: { complete: text }, amount: { value, currency: 'BRL' }, ...(who ? { counterpart: { name: who } } : {}) });

// Itaú simulado: confere mTLS (cert/key passados), token, correlationId e os parâmetros.
function fakeItau(events, seen = []) {
  return async (o) => {
    seen.push(o);
    assert.ok(o.cert && o.key, 'toda chamada vai com o certificado (mTLS)');
    if (o.url.endsWith('/api/oauth/token')) {
      const p = new URLSearchParams(o.body);
      if (p.get('grant_type') !== 'client_credentials' || p.get('client_id') !== 'cid' || p.get('client_secret') !== 'sec') return { status: 401, text: '{"message":"invalid"}' };
      return { status: 200, text: JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
    }
    assert.equal(o.headers.Authorization, 'Bearer tok');
    assert.match(o.headers['x-itau-correlationid'], /^[0-9a-f-]{36}$/);
    if (o.url.includes('/balances')) return { status: 200, text: JSON.stringify({ data: [{ statementId: 150000123456, balances: [{ type: 'saldo_disponivel', amount: { value: 1000.5 } }, { type: 'saldo_total', amount: { value: 1200 } }] }] }) };
    const u = new URL(o.url);
    assert.equal(u.pathname, '/account-statement/v1/statements/150000123456');
    assert.equal(u.searchParams.get('type'), 'current_account');
    return { status: 200, text: JSON.stringify({ data: [{ events }], pagination: { page: 1, total_pages: 1, total_elements: events.length, page_size: 1000 } }) };
  };
}

function setup(events) {
  const db = openDatabase(':memory:');
  const bank = createBank(db);
  const dir = tmpCert();
  const env = { ITAU_CLIENT_ID: 'cid', ITAU_CLIENT_SECRET: 'sec', ITAU_CONTAS: '1500/0012345-6', ITAU_CERT_PATH: path.join(dir, 'itau.crt'), ITAU_KEY_PATH: path.join(dir, 'itau.key') };
  const seen = [];
  const sync = createItauSync(db, bank, { env, requestImpl: fakeItau(events, seen), log: () => {} });
  return { db, bank, sync, seen, env };
}

test('Itaú: lê o extrato e o saldo, grava em Bancos e não duplica na segunda busca', async () => {
  const events = [
    ev('a1', '2026-11-17', 'C', 295.51, 'REDE CARTOES CRED', 'REDECARD'),
    ev('a2', '2026-11-17', 'D', 50, 'SISPAG PIX', 'FORNECEDOR X'),
  ];
  const { db, sync } = setup(events);
  const r = await sync.run({ startDate: '2026-11-15', endDate: '2026-11-18' });
  assert.deepEqual(r.problems, []);
  assert.equal(r.results[0].new, 2);
  assert.equal(r.results[0].saldo_cents, 120000);
  const rows = db.prepare('SELECT posted_date, amount_cents, description FROM bank_transactions ORDER BY amount_cents').all();
  assert.deepEqual(rows, [
    { posted_date: '2026-11-17', amount_cents: -5000, description: 'SISPAG PIX - FORNECEDOR X' },
    { posted_date: '2026-11-17', amount_cents: 29551, description: 'REDE CARTOES CRED - REDECARD' },
  ]);
  const acc = db.prepare('SELECT * FROM bank_accounts WHERE bank_code = ?').get('341');
  assert.equal(acc.account_number, '00123456');
  assert.equal(db.prepare('SELECT ledger_balance_cents FROM bank_imports ORDER BY id DESC').get().ledger_balance_cents, 120000);
  const again = await sync.run({ startDate: '2026-11-15', endDate: '2026-11-18' });
  assert.equal(again.results[0].new, 0);
  assert.equal(again.results[0].duplicate, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_transactions').get().n, 2);
  assert.equal(again.run.status, 'ok');
});

test('Itaú: movimento que já veio por OFX (mesmo dia e valor) não entra de novo', async () => {
  const { db, bank, sync } = setup([ev('b1', '2026-11-17', 'C', 295.51, 'REDE CARTOES'), ev('b2', '2026-11-17', 'C', 10, 'PIX RECEBIDO')]);
  const ofx = `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0341</BANKID><BRANCHID>1500</BRANCHID><ACCTID>123456</ACCTID></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261117</DTSTART><DTEND>20261117</DTEND><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261117</DTPOSTED><TRNAMT>295.51</TRNAMT><FITID>X9</FITID><MEMO>REDE</MEMO></STMTTRN></BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  bank.importFiles({ files: [{ name: 'itau.ofx', buffer: Buffer.from(ofx) }], user: 'x' });
  const r = await sync.run({ startDate: '2026-11-17', endDate: '2026-11-17' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bank_accounts WHERE bank_code = '341'").get().n, 1, 'reconhece a conta do OFX (mesmo número)');
  assert.equal(r.results[0].new, 1, 'só o PIX de R$ 10 é novo');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_transactions').get().n, 2);
});

test('Itaú: agenda a cada 3 h das 6h às 22h; desligável; erros claros', async () => {
  const { db, sync } = setup([]);
  const at = (iso) => new Date(iso);
  assert.equal(sync.due(at('2026-11-18T09:00:00Z')), null, '5h em Cuiabá');
  assert.deepEqual(sync.due(at('2026-11-18T11:00:00Z')), { kind: 'auto', days: 7 }, '7h');
  db.prepare("INSERT INTO sync_runs (source, kind, dates, started_at) VALUES ('itau', 'auto', 'x', '2026-11-18 11:00:00')").run();
  assert.equal(sync.due(at('2026-11-18T12:30:00Z')), null, 'buscou há 1h30');
  assert.deepEqual(sync.due(at('2026-11-18T14:05:00Z')), { kind: 'auto', days: 7 });
  db.prepare("INSERT INTO settings (key, value) VALUES ('itau_auto', '0')").run();
  assert.equal(sync.due(at('2026-11-18T18:00:00Z')), null, 'desligada');

  const db2 = openDatabase(':memory:');
  const s2 = createItauSync(db2, createBank(db2), { env: { ITAU_CLIENT_ID: 'cid', ITAU_CLIENT_SECRET: 'sec', ITAU_CONTAS: '1500/0012345-6', ITAU_CERT_PATH: '/nao/existe.crt' }, log: () => {} });
  const r = await s2.run({ days: 3 });
  assert.match(r.problems.join(' '), /itau\.crt/);
  assert.equal(r.run.status, 'erro');
});

test('Itaú: conta em vários formatos e estorno marcado', () => {
  assert.equal(itau.parseAccount('1500 / 12345-6').id, '150000123456');
  assert.equal(itau.parseAccount('150000123456').label, '1500 / 12345-6');
  assert.equal(itau.parseAccount('abc'), null);
  const t = itau.toTransaction({ ...ev('z', '2026-11-17', 'D', 8.5, 'COMPRA'), reversal: true });
  assert.deepEqual([t.amount_cents, t.description], [-850, 'ESTORNO COMPRA']);
});

test('OFX do Itaú: linhas de SALDO não viram lançamento e o UTF-8 declarado como 1252 sai certo', () => {
  const { parseOfx } = require('../src/ofx');
  const ofx = Buffer.from(`OFXHEADER:100\nENCODING:USASCII\nCHARSET:1252\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0341</BANKID><ACCTID>4776998223</ACCTID></BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261031</DTPOSTED><TRNAMT>35229.00</TRNAMT><FITID>1</FITID><MEMO>SALDO ANTERIOR</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261116</DTPOSTED><TRNAMT>26690.50</TRNAMT><FITID>2</FITID><MEMO>SALDO TOTAL DISPONÍVEL DIA</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261116</DTPOSTED><TRNAMT>14.73</TRNAMT><FITID>3</FITID><MEMO>PIX QR CODE RECEBIDO MARCOS ANDRÉ SBRUZZI</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261117</DTPOSTED><TRNAMT>122.77</TRNAMT><FITID>4</FITID><MEMO>RECEBIMENTO REDE VISA DB0107531038</MEMO></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`, 'utf8');
  const t = parseOfx(ofx)[0].transactions;
  assert.equal(t.length, 2);
  assert.equal(t[0].description, 'PIX QR CODE RECEBIDO MARCOS ANDRÉ SBRUZZI');
});

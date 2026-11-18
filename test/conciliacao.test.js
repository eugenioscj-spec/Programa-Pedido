'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createBank } = require('../src/bank');
const { createRedeSync } = require('../src/rede-sync');
const { createConciliacao, bucket } = require('../src/conciliacao');

// Vendas reais da Loja 2 em 16/11/2026 (Rede): [hora, bandeira, modalidade, bruto, taxa, líquido]
const SALES_16 = [
  ['20:52:19', 'Mastercard', 'DEBIT', 2099, 19, 2080], ['20:48:03', 'Mastercard', 'CREDIT', 4900, 60, 4742], ['20:06:13', 'Visa', 'DEBIT', 2172, 20, 2152],
  ['19:10:09', 'Visa', 'DEBIT', 450, 4, 446], ['18:19:36', 'Mastercard', 'DEBIT', 825, 7, 818], ['18:14:02', 'Mastercard', 'DEBIT', 898, 8, 890],
  ['18:09:19', 'Visa', 'DEBIT', 399, 4, 395], ['17:22:30', 'Visa', 'DEBIT', 2721, 24, 2697], ['17:21:24', 'código 14', 'CREDIT', 1946, 40, 1906],
  ['17:12:05', 'Visa', 'DEBIT', 3997, 36, 3961], ['16:49:46', 'Mastercard', 'DEBIT', 749, 7, 742], ['16:45:13', 'Visa', 'DEBIT', 1425, 13, 1412],
  ['16:03:15', 'Mastercard', 'CREDIT', 1798, 22, 1740], ['16:01:53', 'Mastercard', 'DEBIT', 1050, 9, 1041], ['15:39:55', 'Mastercard', 'DEBIT', 599, 5, 594],
  ['15:38:19', 'Mastercard', 'CREDIT', 150, 2, 148], ['15:17:40', 'Visa', 'DEBIT', 450, 4, 446], ['14:03:47', 'Mastercard', 'CREDIT', 300, 4, 296],
  ['13:58:47', 'Mastercard', 'DEBIT', 150, 1, 149], ['13:03:24', 'Mastercard', 'CREDIT', 2199, 27, 2128], ['12:34:05', 'Visa', 'DEBIT', 775, 7, 768],
].map(([hour, brand, modality, g, f, n]) => ({ date: '2026-11-16', hour, brand, modality, installments: 1, gross_cents: g, fee_cents: f, net_cents: n, other_cents: g - n - f, status: 'APPROVED', nsu: hour }));

const OFX = (lines) => Buffer.from(`OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0341</BANKID><ACCTID>4776998223</ACCTID></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261116</DTSTART><DTEND>20261117</DTEND>${lines.map(([d, v, m], i) => `<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>${d}</DTPOSTED><TRNAMT>${v}</TRNAMT><FITID>${i}</FITID><MEMO>${m}</MEMO></STMTTRN>`).join('')}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);

function setup({ cplugCredit = 11293, cplugDebit = 18759, cplugPix = 2000 } = {}) {
  const db = openDatabase(':memory:');
  const env = { REDE_CLIENT_ID: 'x', REDE_CLIENT_SECRET: 'y', REDE_AMBIENTE: 'producao', REDE_PVS: '107468247,107531038' };
  const sync = createRedeSync(db, { env, log: () => {}, fetchSales: async ({ date, pv }) => ({ summary: pv === '107531038' && date === '2026-11-16' ? SALES_16 : [] }) });
  // CPlug da Loja 2 ligado à nossa Loja 2
  const loja2 = db.prepare("SELECT id FROM locations WHERE name = 'Loja 2'").get().id;
  const sid = Number(db.prepare("INSERT INTO int_stores (source, external_id, name, location_id) VALUES ('cplug', '2', 'BURITIS', ?)").run(loja2).lastInsertRowid);
  db.prepare("INSERT INTO cplug_daily_totals (store_id, date, products_cents, other_cents, payments_cents, item_count) VALUES (?, '2026-11-16', 1, 0, 1, 1)").run(sid);
  const pay = db.prepare('INSERT INTO cplug_daily_payments (store_id, date, method, value_cents, returns_cents) VALUES (?, ?, ?, ?, 0)');
  pay.run(sid, '2026-11-16', 'Cartão de Crédito', cplugCredit); pay.run(sid, '2026-11-16', 'Cartão de Débito', cplugDebit);
  pay.run(sid, '2026-11-16', 'PIX', cplugPix); pay.run(sid, '2026-11-16', 'Dinheiro', 5000);
  createBank(db).importFiles({ user: 't', files: [{ name: 'itau.ofx', buffer: OFX([
    ['20261116', '15.00', 'PIX QR CODE RECEBIDO FULANO'], ['20261116', '5.00', 'PIX QR CODE RECEBIDO BELTRANO'],
    ['20261117', '122.77', 'RECEBIMENTO REDE VISA DB0107531038 REDECARD'], ['20261117', '63.14', 'RECEBIMENTO REDE MAST DB0107531038 REDECARD'],
    ['20261117', '86.10', 'RECEBIMENTO REDE MAST AT0107531038 REDECARD'], ['20261117', '49.69', 'RECEBIMENTO REDE ELO CD0107531038 REDECARD'],
  ]) }] });
  return { db, sync, conc: createConciliacao(db) };
}

test('conferência real de 16/11 (Loja 2): cartão CPlug = Rede, Pix CPlug = Itaú, depósito D+1 = 272,01', async () => {
  const { db, sync, conc } = setup();
  const run = await sync.run(['2026-11-16', '2026-11-17'], 'manual');
  assert.equal(run.status, 'ok');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rede_sales').get().n, 21);
  const [l1, l2] = conc.report({ from: '2026-11-16', to: '2026-11-17' });
  assert.equal(l1.name, 'Loja 1 - Centro');
  const d16 = l2.days[0];
  assert.deepEqual([d16.check.credito.ok, d16.check.debito.ok, d16.check.pix.ok], [true, true, true]);
  assert.equal(d16.rede.fee + d16.rede.other, 501, 'descontos de R$ 5,01 como no relatório da Rede');
  assert.equal(d16.rede.deposit_d1, 27201, 'débito 185,91 + crédito antecipado 86,10');
  assert.equal(d16.rede.credit_later, 2350, 'crédito sem antecipação cai depois');
  const dep = l2.deposits.find((x) => x.date === '2026-11-17');
  assert.deepEqual([dep.expected, dep.received, dep.ok], [27201, 27201, true]);
  assert.equal(dep.credit_cd, 4969, 'CD fica à parte (é de vendas de ~30 dias atrás)');
  assert.equal(d16.deposit.ok, true);
  assert.equal(l2.summary.diff, 0);
  // refazer a busca não duplica
  await sync.run(['2026-11-16'], 'manual');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rede_sales').get().n, 21);
});

test('conferência: diferença de 1 centavo já aparece (valor exato)', async () => {
  const { sync, conc } = setup({ cplugCredit: 11294, cplugPix: 1999 });
  await sync.run(['2026-11-16'], 'manual');
  const l2 = conc.report({ from: '2026-11-16', to: '2026-11-16' })[1];
  assert.deepEqual([l2.days[0].check.credito.ok, l2.days[0].check.credito.diff], [false, 1]);
  assert.equal(l2.days[0].check.pix.diff, -1);
  assert.equal(l2.summary.diff, 2);
});

test('formas de pagamento do CPlug e agenda da Rede', () => {
  assert.deepEqual(['Crédito', 'Cartão de Débito', 'PIX', 'Dinheiro', 'Voucher'].map(bucket), ['credito', 'debito', 'pix', 'dinheiro', 'outros']);
  const { sync, db } = setup();
  assert.equal(sync.due(new Date('2026-11-18T09:00:00Z')), null, '5h: ainda não');
  assert.deepEqual(sync.due(new Date('2026-11-18T10:30:00Z')), { kind: 'auto', dates: ['2026-11-15', '2026-11-16', '2026-11-17'] });
  db.prepare("INSERT INTO sync_runs (source, kind, dates, started_at, status) VALUES ('rede', 'auto', 'x', '2026-11-18 10:30:00', 'ok')").run();
  assert.equal(sync.due(new Date('2026-11-18T15:00:00Z')), null, 'só 8 horas depois');
  assert.ok(sync.due(new Date('2026-11-18T18:40:00Z')));
});

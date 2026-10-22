'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createBank } = require('../src/bank');
const { parseOfx } = require('../src/ofx');
const { createReports } = require('../src/reports');
const { createFinance } = require('../src/finance');

// ---- extratos de exemplo, no formato de cada banco ----
const sgmlHeader = (charset = '1252') => `OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nSECURITY:NONE\r\nENCODING:USASCII\r\nCHARSET:${charset}\r\nCOMPRESSION:NONE\r\nOLDFILEUID:NONE\r\nNEWFILEUID:NONE\r\n\r\n`;
const sgmlTx = ({ type = 'DEBIT', date, amount, fitid, name, memo }) => `<STMTTRN>\n<TRNTYPE>${type}\n<DTPOSTED>${date}120000[-03:EST]\n<TRNAMT>${amount}\n${fitid !== undefined ? `<FITID>${fitid}\n` : ''}${name ? `<NAME>${name}\n` : ''}${memo ? `<MEMO>${memo}\n` : ''}</STMTTRN>\n`;
function sgml({ bank, acct, start, end, txs, balance, balanceDate, charset }) {
  return `${sgmlHeader(charset)}<OFX>\n<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261020<LANGUAGE>POR</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1>\n<STMTTRNRS>\n<TRNUID>1001\n<STMTRS>\n<CURDEF>BRL\n<BANKACCTFROM>\n<BANKID>${bank}\n<BRANCHID>1234\n<ACCTID>${acct}\n<ACCTTYPE>CHECKING\n</BANKACCTFROM>
<BANKTRANLIST>\n<DTSTART>${start}\n<DTEND>${end}\n${txs.map(sgmlTx).join('')}</BANKTRANLIST>\n${balance !== undefined ? `<LEDGERBAL>\n<BALAMT>${balance}\n<DTASOF>${balanceDate}\n</LEDGERBAL>\n` : ''}</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>\n</OFX>\n`;
}
const toFile = (name, text, encoding = 'latin1') => ({ name, buffer: Buffer.from(text, encoding) });

const itauSet = sgml({
  bank: '0341', acct: '12345-6', start: '20260901', end: '20260930', balance: '1850.00', balanceDate: '20260930',
  txs: [
    { type: 'CREDIT', date: '20260902', amount: '3000.00', fitid: 'IT001', memo: 'PIX RECEBIDO LANCHONETE EXEMPLO' },
    { date: '20260905', amount: '-800.00', fitid: 'IT002', memo: 'BOLETO ALUGUEL IMOBILIARIA' },
    { date: '20260910', amount: '-350.00', fitid: 'IT003', memo: 'PAGAMENTO ENERGIA ÁGUA CIA' },
  ],
});
// outubro sobrepõe o fim de setembro (mesma linha IT003) e tem um movimento novo
const itauOut = sgml({
  bank: '0341', acct: '12345-6', start: '20260910', end: '20261015', balance: '1550.00', balanceDate: '20261015',
  txs: [
    { date: '20260910', amount: '-350.00', fitid: 'IT003', memo: 'PAGAMENTO ENERGIA ÁGUA CIA' },
    { date: '20261005', amount: '-800.00', fitid: 'IT004', memo: 'BOLETO ALUGUEL IMOBILIARIA' },
    { type: 'CREDIT', date: '20261008', amount: '500.00', fitid: 'IT005', memo: 'PIX RECEBIDO MERCADINHO' },
  ],
});
// Bradesco: FITID repetido, valor com vírgula
const bradesco = sgml({
  bank: '237', acct: '998877', start: '20261001', end: '20261031', balance: '-1234,56', balanceDate: '20261031',
  txs: [
    { date: '20261003', amount: '-1234,56', fitid: '0', name: 'TARIFA BANCARIA', memo: 'TARIFA BANCARIA' },
    { date: '20261004', amount: '-10,00', fitid: '0', name: 'TARIFA PIX' },
    { date: '20261004', amount: '-10,00', fitid: '0', name: 'TARIFA PIX' },
    { date: '20261020', amount: '10,00', fitid: '0', name: 'ESTORNO TARIFA' },
  ],
});
// C6: OFX 2 em XML (UTF-8)
const c6 = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>336</BANKID><ACCTID>55443322</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001</DTSTART><DTEND>20261031</DTEND>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261002000000[-3:BRT]</DTPOSTED><TRNAMT>1000.00</TRNAMT><FITID>c6-a</FITID><MEMO>Transferência recebida Itaú</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261015000000[-3:BRT]</DTPOSTED><TRNAMT>-99.90</TRNAMT><FITID>c6-b</FITID><MEMO>Royalties franquia Oggi</MEMO></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>900.10</BALAMT><DTASOF>20261031</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const cartao = `${sgmlHeader()}<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL<CCACCTFROM><ACCTID>4111XXXX1234</CCACCTFROM>
<BANKTRANLIST><DTSTART>20261001<DTEND>20261031${sgmlTx({ date: '20261007', amount: '-45.90', fitid: 'cc1', memo: 'POSTO COMBUSTIVEL' })}</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

function setup() {
  const db = openDatabase(':memory:');
  const bank = createBank(db);
  const acc = (name) => db.prepare('SELECT id FROM fin_accounts WHERE name = ?').get(name).id;
  const pending = () => bank.listTransactions({ status: 'pendente' });
  return { db, bank, acc, pending };
}

test('OFX: lê SGML (1252), XML, vírgula, cartão; e não duplica períodos sobrepostos', () => {
  const st = parseOfx(Buffer.from(itauSet, 'latin1'));
  assert.equal(st[0].bank_name, 'Itaú');
  assert.equal(st[0].transactions[2].description, 'PAGAMENTO ENERGIA ÁGUA CIA', 'acento em Windows-1252');
  assert.deepEqual(st[0].transactions.map((t) => t.amount_cents), [300000, -80000, -35000]);
  assert.equal(parseOfx(Buffer.from(c6))[0].transactions[0].description, 'Transferência recebida Itaú');
  assert.equal(parseOfx(Buffer.from(bradesco, 'latin1'))[0].ledger_balance_cents, -123456);
  assert.equal(parseOfx(Buffer.from(cartao, 'latin1'))[0].kind, 'cartao');
  assert.throws(() => parseOfx(Buffer.from('não é ofx')), /não parece ser um extrato OFX/);

  const { db, bank } = setup();
  const r = bank.importFiles({
    files: [toFile('itau-set.ofx', itauSet), toFile('itau-out.ofx', itauOut), toFile('bradesco.ofx', bradesco), toFile('c6.ofx', c6, 'utf8'), toFile('cartao.ofx', cartao), toFile('x.ofx', 'lixo')],
    user: 'Dono',
  });
  assert.deepEqual(r.map((x) => [x.file, x.new, x.duplicate]), [
    ['itau-set.ofx', 3, 0], ['itau-out.ofx', 2, 1], ['bradesco.ofx', 4, 0], ['c6.ofx', 2, 0], ['cartao.ofx', 1, 0], ['x.ofx', undefined, undefined],
  ]);
  assert.match(r[5].error, /OFX/);
  // importar tudo de novo não muda nada
  const again = bank.importFiles({ files: [toFile('itau-set.ofx', itauSet), toFile('bradesco.ofx', bradesco)], user: 'Dono' });
  assert.deepEqual(again.map((x) => x.new), [0, 0]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_transactions').get().n, 12);

  // saldos: Itaú abre com 0 (1550 − 3000 + 800 + 350 + 800 − 500) e confere com setembro e outubro
  const itau = bank.accounts().find((a) => a.bank_code === '341');
  assert.equal(itau.opening_cents, 0);
  assert.equal(itau.balance_cents, 155000);
  assert.ok(itau.ok);
  assert.deepEqual(itau.checks.map((c) => c.diff), [0, 0]);
});

test('saldo não bate quando falta um período', () => {
  const { bank } = setup();
  const semMeio = sgml({
    bank: '0341', acct: '12345-6', start: '20261001', end: '20261031', balance: '2000.00', balanceDate: '20261031',
    txs: [{ type: 'CREDIT', date: '20261005', amount: '100.00', fitid: 'Z1', memo: 'PIX' }],
  });
  bank.importFiles({ files: [toFile('set.ofx', itauSet), toFile('out.ofx', semMeio)], user: 'x' });
  const itau = bank.accounts()[0];
  assert.equal(itau.ok, false, 'setembro termina em 1850 mas outubro diz 2000 com só +100');
  assert.match(bank.report('2026-09-01', '2026-10-31').warnings.join(' '), /falta importar/);
});

test('conciliação: criar, baixar lançamento em aberto, ignorar, regra, lote e desfazer', () => {
  const { db, bank, acc, pending } = setup();
  bank.importFiles({ files: [toFile('itau-set.ofx', itauSet), toFile('itau-out.ofx', itauOut)], user: 'Dono' });
  // aluguel de outubro estava lançado em aberto, vencendo dia 05
  const aluguel = Number(db.prepare(`INSERT INTO fin_entries (account_id, description, amount_cents, competence_date, due_date)
    VALUES (?, 'Aluguel outubro', 80000, '2026-10-01', '2026-10-05')`).run(acc('Aluguel e condomínio')).lastInsertRowid);

  // royalties de R$ 800 no dia 08/10 também batem com o aluguel em aberto: a sugestão fica só com o movimento mais próximo do vencimento
  db.prepare(`INSERT INTO bank_transactions (bank_account_id, dedupe_key, posted_date, amount_cents, description)
    VALUES (1, 'teste-royalties', '2026-10-08', -80000, 'ROYALTIES FRANQUIA')`).run();
  const royalties = pending().find((t) => t.description === 'ROYALTIES FRANQUIA');
  assert.notEqual(royalties.suggestion && royalties.suggestion.type, 'baixar');
  bank.conciliate(royalties.id, { action: 'ignorar' }, 'x');
  const list = pending();
  const byMemo = (txt) => list.find((t) => t.description.includes(txt) && t.posted_date >= '2026-10-01') || list.find((t) => t.description.includes(txt));
  const out = byMemo('ALUGUEL');
  assert.equal(out.suggestion.type, 'baixar');
  assert.equal(out.suggestion.entry.id, aluguel);
  bank.conciliate(out.id, { action: 'baixar', entry_id: aluguel }, 'Dono');
  assert.equal(db.prepare('SELECT paid_date FROM fin_entries WHERE id = ?').get(aluguel).paid_date, '2026-10-05');

  // aluguel de setembro: cria lançamento e "lembra" a regra
  const set = list.find((t) => t.description.includes('ALUGUEL') && t.posted_date < '2026-10-01');
  assert.equal(set.suggestion, null);
  bank.conciliate(set.id, { action: 'criar', account_id: acc('Aluguel e condomínio'), remember: true }, 'Dono');
  assert.equal(db.prepare('SELECT pattern FROM bank_rules').get().pattern, 'BOLETO ALUGUEL IMOBILIARIA');
  // conta de tipo errado é recusada
  const energia = list.find((t) => t.description.includes('ENERGIA'));
  assert.throws(() => bank.conciliate(energia.id, { action: 'criar', account_id: acc('Vendas Loja 2') }, 'x'), /conta de receita/);

  // PIX recebido: lote com conta escolhida
  const pix = pending().filter((t) => t.description.includes('PIX RECEBIDO')).map((t) => t.id);
  assert.deepEqual(bank.conciliateMany({ ids: pix, accountId: acc('Recebimento de clientes B2B'), user: 'x' }), { done: 2, skipped: [] });
  bank.conciliate(energia.id, { action: 'ignorar', note: 'teste' }, 'x');
  assert.equal(pending().length, 0);
  assert.throws(() => bank.conciliate(energia.id, { action: 'ignorar' }, 'x'), /já foi tratado/);

  // desfazer: criado apaga o lançamento; baixado volta a ficar em aberto
  const setTx = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(set.id);
  bank.undo(set.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fin_entries WHERE id = ?').get(setTx.entry_id).n, 0);
  bank.undo(out.id);
  assert.equal(db.prepare('SELECT paid_date FROM fin_entries WHERE id = ?').get(aluguel).paid_date, null);
  assert.equal(pending().length, 2);
  // a regra continua valendo
  assert.equal(pending().find((t) => t.id === set.id).suggestion.source, 'regra');
});

test('DFC usa o saldo dos bancos e os movimentos conciliados; relatório por banco fecha com o extrato', () => {
  const { db, bank, acc } = setup();
  bank.importFiles({ files: [toFile('itau-set.ofx', itauSet), toFile('itau-out.ofx', itauOut)], user: 'Dono' });
  const finance = createFinance(db, createReports(db), { bankOpening: () => bank.openingTotal() });
  const all = bank.listTransactions({});
  for (const t of all) {
    const name = t.amount_cents > 0 ? 'Recebimento de clientes B2B' : t.description.includes('ALUGUEL') ? 'Aluguel e condomínio' : 'Energia elétrica';
    bank.conciliate(t.id, { action: 'criar', account_id: acc(name) }, 'x');
  }
  const dfc = finance.dfc('2026-09-01', '2026-10-31');
  assert.equal(dfc.result.saldo_inicial, 0);
  assert.equal(dfc.result.saldo_final, 155000, 'o caixa da DFC fecha com o saldo do Itaú');
  const rep = bank.report('2026-09-01', '2026-10-31');
  const finalItau = rep.sections.find((x) => x.title.startsWith('Itaú')).rows.find((r) => r.line === '= Saldo final');
  assert.equal(finalItau.total, 155000);
  const dre = finance.dre('2026-09-01', '2026-10-31');
  assert.equal(dre.sections[0].rows.find((r) => r.line === '   Despesas de ocupação').total, -(80000 * 2 + 35000));
});

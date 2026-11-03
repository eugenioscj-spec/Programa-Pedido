'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createBank } = require('../src/bank');
const { createAccounts } = require('../src/accounts');
const { createRecurring, addMonths } = require('../src/recurring');
const { createCashflow } = require('../src/cashflow');
const { createReceivables, nextBusinessDay, dueDate } = require('../src/receivables');
const { createInventory } = require('../src/inventory');
const T = require('../src/time');

const ofx = (balance, date, txs) => Buffer.from(`OFXHEADER:100\nDATA:OFXSGML\nCHARSET:1252\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>0341<BRANCHID>1234<ACCTID>12345-6<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20261001<DTEND>${date}
${txs.map(([d, v, id]) => `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>${d}<TRNAMT>${v}<FITID>${id}<MEMO>MOV ${id}</STMTTRN>`).join('\n')}
</BANKTRANLIST><LEDGERBAL><BALAMT>${balance}<DTASOF>${date}</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`, 'latin1');

function setup() {
  const db = openDatabase(':memory:');
  const bank = createBank(db);
  const accounts = createAccounts(db, bank);
  const recurring = createRecurring(db);
  const acc = (name) => db.prepare('SELECT id FROM fin_accounts WHERE name = ?').get(name).id;
  const entry = (o) => Number(db.prepare(`INSERT INTO fin_entries (account_id, description, amount_cents, competence_date, due_date, paid_date, bank_account_id)
    VALUES (@account_id, @description, @amount_cents, @competence_date, @due_date, @paid_date, @bank_account_id)`)
    .run({ due_date: null, paid_date: null, bank_account_id: null, description: 'x', ...o }).lastInsertRowid);
  return { db, bank, accounts, recurring, acc, entry, cashflow: createCashflow(db, accounts, recurring) };
}

test('dia útil e vencimento B2B: 30 dias + 1 dia útil', () => {
  assert.equal(nextBusinessDay('2026-11-06'), '2026-11-09', 'sexta → segunda');
  assert.equal(nextBusinessDay('2026-11-09'), '2026-11-10');
  assert.equal(dueDate('2026-11-03', 30), '2026-12-04', '03/11 + 30 = 03/12 (qui) → cai 04/12 (sex)');
  assert.equal(dueDate('2026-11-06', 30), '2026-12-07', '06/12 é domingo → segunda');
  assert.equal(dueDate('2026-11-03', 0), '2026-11-03', 'à vista');
});

test('saldos: cofre e caixas criados, saldo manual, transferência e conta com extrato', () => {
  const { db, bank, accounts, acc, entry } = setup();
  const list = accounts.balances();
  assert.deepEqual(list.map((a) => a.type).sort(), ['caixa', 'caixa', 'cofre']);
  const cofre = accounts.vault();
  const caixa2 = accounts.cashOf(db.prepare("SELECT id FROM locations WHERE name = 'Loja 2'").get().id);

  // banco cadastrado à mão, sem número: o OFX do Itaú passa a usar essa conta
  const itau = accounts.create({ type: 'banco', name: 'Itaú', bank_code: '341' });
  bank.importFiles({ files: [{ name: 'out.ofx', buffer: ofx('1000.00', '20261020', [['20261005', '-200.00', 'A']]) }], user: 'x' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_accounts WHERE bank_code = ?').get('341').n, 1, 'não criou outra conta');
  assert.equal(db.prepare('SELECT account_number FROM bank_accounts WHERE id = ?').get(itau).account_number, '12345-6');

  // cofre com saldo inicial; caixa da loja envia R$ 300 ao cofre; cofre paga uma despesa
  accounts.update(cofre.id, { opening_balance: '500,00', opening_date: '2026-10-01' });
  accounts.transfer({ from: caixa2.id, to: cofre.id, amount: '300', date: '2026-10-10', user: 'Loja' });
  entry({ account_id: acc('Fretes e entregas'), amount_cents: 5000, competence_date: '2026-10-12', paid_date: '2026-10-12', bank_account_id: cofre.id });
  // pagamento no Itaú antes do extrato (já está no extrato) e depois dele
  entry({ account_id: acc('Energia elétrica'), amount_cents: 20000, competence_date: '2026-10-05', paid_date: '2026-10-05', bank_account_id: itau });
  entry({ account_id: acc('Energia elétrica'), amount_cents: 10000, competence_date: '2026-10-25', paid_date: '2026-10-25', bank_account_id: itau });
  // depósito do cofre no Itaú depois do extrato
  accounts.transfer({ from: cofre.id, to: itau, amount: '100', date: '2026-10-26', user: 'Dono' });

  const by = (id) => accounts.balances().find((a) => a.id === id);
  assert.equal(by(cofre.id).current_cents, 50000 + 30000 - 5000 - 10000);
  assert.equal(by(itau).current_cents, 100000 - 10000 + 10000, 'extrato + depois do extrato; o de 05/10 já estava no extrato');
  assert.equal(by(caixa2.id).current_cents, -30000);
  assert.equal(by(caixa2.id).in_total, false, 'caixa da loja fora do total');
  assert.equal(accounts.total(), 65000 + 100000);
  assert.throws(() => accounts.transfer({ from: cofre.id, to: cofre.id, amount: '1', user: 'x' }), /diferentes/);
});

test('pedido entregue vira conta a receber; Loja 2 não', () => {
  const { db, acc } = setup();
  const inv = createInventory(db);
  const rec = createReceivables(db);
  const p = Number(db.prepare("INSERT INTO products (name, category, units_per_box, unit_price_cents, box_price_cents) VALUES ('Picolé', 'X', 10, 500, 5000)").run().lastInsertRowid);
  inv.receive({ lines: [{ product_id: p, units: 100, cost_cents: 200 }], document: 'NF', user: 'x' });
  const cli = Number(db.prepare("INSERT INTO customers (cnpj, razao_social, password_hash, status) VALUES ('11222333000181', 'Bar', 'x', 'ativo')").run().lastInsertRowid);
  const loja2 = db.prepare("SELECT id FROM customers WHERE nome_fantasia = 'Loja 2'").get().id;
  const deliver = (c) => {
    const id = inv.createOrder({ customerId: c, items: [{ product_id: p, unit_type: 'unidade', quantity: 4 }] });
    for (const s of ['confirmado', 'separado', 'entregue']) inv.changeStatus({ orderId: id, status: s, user: 'x' });
    return [id, rec.onDelivered(id, '2026-11-03')];
  };
  const [orderId, entryId] = deliver(cli);
  const e = db.prepare('SELECT * FROM fin_entries WHERE id = ?').get(entryId);
  assert.deepEqual([e.account_id, e.amount_cents, e.competence_date, e.due_date, e.order_id, e.paid_date],
    [acc('Recebimento de clientes B2B'), 2000, '2026-11-03', '2026-12-04', orderId, null]);
  assert.equal(rec.onDelivered(orderId, '2026-11-03'), null, 'não duplica');
  assert.equal(deliver(loja2)[1], null, 'Loja 2 (loja própria) não gera');
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'b2b_payment_days'").run();
  assert.equal(db.prepare('SELECT due_date FROM fin_entries WHERE id = ?').get(deliver(cli)[1]).due_date, '2026-11-03', 'à vista');
});

test('fluxo futuro: saldo de hoje + abertos + recorrentes ainda não lançadas; vencidas entram hoje', () => {
  const { accounts, recurring, acc, entry, cashflow } = setup();
  const today = T.localDate();
  const cofre = accounts.vault();
  accounts.update(cofre.id, { opening_balance: '1000', opening_date: T.addDays(today, -10) });
  entry({ account_id: acc('Recebimento de clientes B2B'), amount_cents: 50000, competence_date: today, due_date: T.addDays(today, 5) });
  entry({ account_id: acc('Energia elétrica'), amount_cents: 30000, competence_date: today, due_date: T.addDays(today, -2) }); // vencida
  recurring.create({ account_id: acc('Aluguel e condomínio'), amount: '1000', start_date: T.addDays(today, 3) }, 'x');

  const p = cashflow.projection(90);
  assert.equal(p.start_cents, 100000);
  assert.equal(p.series.length, 91);
  assert.equal(p.series[0].out, 30000, 'vencida sai hoje');
  assert.equal(p.overdue_out, 30000);
  const rentDates = p.events.filter((e) => e.description === 'Aluguel e condomínio' || e.recurrence_id).map((e) => e.date);
  const expected = [];
  for (let k = 0; addMonths(T.addDays(today, 3), k) <= T.addDays(today, 90); k += 1) expected.push(addMonths(T.addDays(today, 3), k));
  assert.deepEqual(rentDates, expected, 'todas as parcelas dos 90 dias, lançadas ou não');
  assert.equal(p.end_cents, 100000 + 50000 - 30000 - 100000 * expected.length);
  assert.equal(p.min.balance, Math.min(...p.series.map((s) => s.balance)));
  assert.ok(p.first_negative, 'aluguel maior que o caixa: fica negativo');
  assert.equal(p.weeks.reduce((s, w) => s + w.in - w.out, 0), p.end_cents - p.start_cents);
  assert.equal(cashflow.report(30).sections.length, 2);
});

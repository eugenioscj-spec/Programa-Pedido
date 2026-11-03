'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createRecurring, addMonths, horizon } = require('../src/recurring');
const T = require('../src/time');

const accountId = (db, name) => db.prepare('SELECT id FROM fin_accounts WHERE name = ?').get(name).id;
const entries = (db, id) => db.prepare('SELECT * FROM fin_entries WHERE recurrence_id = ? ORDER BY due_date').all(id);

test('datas: mesmo dia todo mês, dia 31 vira o último dia do mês', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonths('2026-11-10', 3), '2027-02-10');
  assert.equal(addMonths('2026-03-15', -1), '2026-02-15');
  assert.equal(horizon('2026-11-03'), '2026-12-31');
  assert.equal(horizon('2026-12-20'), '2027-01-31');
});

test('conta recorrente: gera até o fim do mês seguinte, sem duplicar', () => {
  const db = openDatabase(':memory:');
  const rec = createRecurring(db);
  const today = T.localDate();
  const start = addMonths(today, -2); // começou há 2 meses
  const aluguel = accountId(db, db.prepare("SELECT name FROM fin_accounts WHERE kind = 'despesa' ORDER BY sort LIMIT 1").get().name);
  const id = rec.create({ account_id: aluguel, amount: '2.500,00', description: 'Aluguel', start_date: start }, 'Dono', { firstPaidDate: start });

  const list = entries(db, id);
  const expected = [];
  for (let k = 0; addMonths(start, k) <= horizon(); k += 1) expected.push(addMonths(start, k));
  assert.deepEqual(list.map((e) => e.due_date), expected, 'do 1º vencimento até o fim do mês seguinte');
  assert.ok(list.every((e) => e.amount_cents === 250000 && e.competence_date === e.due_date && e.description === 'Aluguel'));
  assert.equal(list[0].paid_date, start, '1ª parcela já paga');
  assert.ok(list.slice(1).every((e) => e.paid_date === null));

  assert.equal(rec.generate(), 0, 'rodar de novo não cria nada');
  // excluir uma parcela não faz ela voltar
  db.prepare('DELETE FROM fin_entries WHERE id = ?').run(list[1].id);
  rec.generate();
  assert.equal(entries(db, id).length, list.length - 1);
  // passa o tempo: o mês seguinte entra
  assert.equal(rec.generate(addMonths(today, 1)), 1);
});

test('conta recorrente: N vezes, competência no mês anterior, alterar e encerrar', () => {
  const db = openDatabase(':memory:');
  const rec = createRecurring(db);
  const today = T.localDate();
  const acc = db.prepare("SELECT id FROM fin_accounts WHERE kind = 'despesa' ORDER BY sort LIMIT 1 OFFSET 1").get().id;

  // 3 vezes, a cada mês, competência no mês anterior (ex.: salário pago no dia 5)
  const first = addMonths(today, -1);
  const id = rec.create({ account_id: acc, amount: '100', start_date: first, times: 3, competence_offset: -1 }, 'Dono');
  let list = entries(db, id);
  assert.deepEqual(list.map((e) => e.due_date), [first, today, addMonths(today, 1)].filter((d) => d <= horizon()));
  assert.equal(rec.get(id).end_date, addMonths(first, 2));
  assert.equal(list[0].competence_date, addMonths(first, -1));

  // alterar o valor: só as parcelas de hoje em diante em aberto mudam
  db.prepare('UPDATE fin_entries SET paid_date = ? WHERE id = ?').run(today, list[1].id); // a de hoje já foi paga
  rec.update(id, { amount: '150' });
  list = entries(db, id);
  assert.deepEqual(list.map((e) => e.amount_cents), [10000, 10000, 15000], 'vencida e paga ficam; futura muda');

  // encerrar: apaga as futuras em aberto e para de gerar
  assert.equal(rec.stop(id), 1);
  assert.deepEqual(entries(db, id).map((e) => e.due_date), [first, today]);
  assert.equal(rec.generate(addMonths(today, 1)), 0);
  assert.equal(rec.list()[0].active, 0);

  assert.throws(() => rec.create({ account_id: acc, amount: '0', start_date: today }, 'x'), /maior que zero/);
  assert.throws(() => rec.create({ account_id: acc, amount: '10', start_date: today, end_date: addMonths(today, -1) }, 'x'), /depois do primeiro/);
});

'use strict';

// Contas recorrentes (aluguel, internet, salários, mensalidades…). Cada série gera sozinha os
// lançamentos do Financeiro até o fim do MÊS SEGUINTE; as próximas parcelas aparecem conforme
// os meses passam. Um lançamento gerado é um lançamento normal: dá para editar, pagar ou excluir
// só aquela parcela, e excluir uma parcela não faz ela voltar.

const T = require('./time');
const U = require('./util');
const { BusinessError } = require('./inventory');

const INTERVALS = { 1: 'Todo mês', 2: 'A cada 2 meses', 3: 'A cada 3 meses', 6: 'A cada 6 meses', 12: 'Todo ano' };

const pad = (n) => String(n).padStart(2, '0');
// Mesmo dia do mês, `months` meses depois; dia 31 vira o último dia em meses mais curtos.
function addMonths(dateStr, months, day = Number(dateStr.slice(8, 10))) {
  const [y, m] = dateStr.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(day, last))}`;
}
const monthDiff = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

// Gera até o último dia do mês seguinte ao de hoje.
const horizon = (today = T.localDate()) => T.monthBounds(addMonths(`${today.slice(0, 7)}-01`, 1).slice(0, 7))[1];

function createRecurring(db) {
  const q = {
    get: db.prepare('SELECT * FROM fin_recurrences WHERE id = ?'),
    active: db.prepare('SELECT * FROM fin_recurrences WHERE active = 1'),
    insert: db.prepare(`INSERT INTO fin_entries (account_id, description, amount_cents, competence_date, due_date, paid_date, location_id,
      counterparty, document, note, created_by, recurrence_id) VALUES (@account_id, @description, @amount_cents, @competence_date,
      @due_date, NULL, @location_id, @counterparty, @document, @note, @created_by, @recurrence_id)`),
    mark: db.prepare("UPDATE fin_recurrences SET generated_until = ?, updated_at = datetime('now') WHERE id = ?"),
    // parcelas futuras ainda em aberto e não conciliadas com o banco
    openFuture: `FROM fin_entries AS e WHERE e.recurrence_id = ? AND e.paid_date IS NULL AND e.due_date >= ?
      AND NOT EXISTS (SELECT 1 FROM bank_transactions t WHERE t.entry_id = e.id)`,
  };

  // Datas de vencimento da série, em ordem, até `until`.
  function* dueDates(r, until) {
    const day = Number(r.start_date.slice(8, 10));
    for (let k = 0; ; k += 1) {
      const due = addMonths(r.start_date, k * r.interval_months, day);
      if (due > until || (r.end_date && due > r.end_date)) return;
      yield due;
    }
  }

  function generateOne(r, until) {
    let last = r.generated_until;
    let created = 0;
    for (const due of dueDates(r, until)) {
      if (last && due <= last) continue;
      q.insert.run({
        account_id: r.account_id, description: r.description, amount_cents: r.amount_cents,
        competence_date: addMonths(due, r.competence_offset), due_date: due, location_id: r.location_id,
        counterparty: r.counterparty, document: r.document, note: r.note, created_by: r.created_by, recurrence_id: r.id,
      });
      last = due;
      created += 1;
    }
    if (last !== r.generated_until) q.mark.run(last, r.id);
    return created;
  }

  // Cria as parcelas que faltam de todas as séries ativas. Pode rodar quantas vezes quiser.
  const generate = db.transaction((today = T.localDate()) => {
    let created = 0;
    for (const r of q.active.all()) created += generateOne(r, horizon(today));
    return created;
  });

  function read(b, existing = {}) {
    const account = db.prepare('SELECT * FROM fin_accounts WHERE id = ?').get(Number(b.account_id ?? existing.account_id));
    if (!account) throw new BusinessError('Escolha a conta.');
    const amount = b.amount !== undefined ? U.toCents(b.amount) : existing.amount_cents;
    if (!Number.isFinite(amount) || amount <= 0) throw new BusinessError('Informe um valor maior que zero.');
    const start = String(b.start_date ?? existing.start_date ?? '').trim();
    if (!T.isDate(start)) throw new BusinessError('Informe a data do primeiro vencimento.');
    const interval = Number(b.interval_months ?? existing.interval_months ?? 1);
    if (!INTERVALS[interval]) throw new BusinessError('Repetição inválida.');
    const offset = Number(b.competence_offset ?? existing.competence_offset ?? 0);
    if (!Number.isInteger(offset) || offset < -12 || offset > 12) throw new BusinessError('Competência inválida.');
    let end = b.end_date !== undefined ? (String(b.end_date || '').trim() || null) : (existing.end_date ?? null);
    const times = b.times !== undefined && b.times !== '' && b.times !== null ? Number(b.times) : null;
    if (times !== null) {
      if (!Number.isInteger(times) || times < 1 || times > 600) throw new BusinessError('Número de vezes inválido.');
      end = addMonths(start, (times - 1) * interval);
    }
    if (end !== null && (!T.isDate(end) || end < start)) throw new BusinessError('A data final precisa ser depois do primeiro vencimento.');
    const loc = (b.location_id ?? existing.location_id) ? db.prepare('SELECT id FROM locations WHERE id = ?').get(Number(b.location_id ?? existing.location_id)) : null;
    const text = (k, max) => U.cleanText(b[k] !== undefined ? b[k] : existing[k], max);
    return {
      account_id: account.id, description: text('description', 200) || account.name, amount_cents: amount,
      start_date: start, interval_months: interval, end_date: end, competence_offset: offset,
      location_id: loc ? loc.id : null, counterparty: text('counterparty', 120), document: text('document', 80), note: text('note', 300),
    };
  }

  const create = db.transaction((b, user, { firstPaidDate = null } = {}) => {
    const r = read(b);
    const id = Number(db.prepare(`INSERT INTO fin_recurrences (account_id, description, amount_cents, start_date, interval_months, end_date,
      competence_offset, location_id, counterparty, document, note, created_by) VALUES (@account_id, @description, @amount_cents,
      @start_date, @interval_months, @end_date, @competence_offset, @location_id, @counterparty, @document, @note, @created_by)`)
      .run({ ...r, created_by: user }).lastInsertRowid);
    generateOne(q.get.get(id), horizon());
    if (firstPaidDate) {
      db.prepare('UPDATE fin_entries SET paid_date = ? WHERE recurrence_id = ? AND due_date = ?').run(firstPaidDate, id, r.start_date);
    }
    return id;
  });

  // Alterar a série muda só as parcelas de hoje em diante que ainda estão em aberto:
  // elas são refeitas com os dados novos. O que já foi pago ou venceu fica como está.
  const update = db.transaction((id, b) => {
    const existing = q.get.get(id);
    if (!existing) throw new BusinessError('Conta recorrente não encontrada.', 404);
    const r = read(b, existing);
    const today = T.localDate();
    db.prepare(`DELETE ${q.openFuture}`).run(id, today);
    const kept = db.prepare('SELECT MAX(due_date) d FROM fin_entries WHERE recurrence_id = ?').get(id).d;
    const generatedUntil = kept || (existing.generated_until ? T.addDays(today, -1) : null);
    db.prepare(`UPDATE fin_recurrences SET account_id = @account_id, description = @description, amount_cents = @amount_cents,
      start_date = @start_date, interval_months = @interval_months, end_date = @end_date, competence_offset = @competence_offset,
      location_id = @location_id, counterparty = @counterparty, document = @document, note = @note,
      generated_until = @generated_until, updated_at = datetime('now') WHERE id = @id`).run({ ...r, generated_until: generatedUntil, id });
    if (existing.active) generateOne(q.get.get(id), horizon());
  });

  // Encerrar: para de gerar e apaga as parcelas futuras em aberto (depois de hoje).
  const stop = db.transaction((id) => {
    if (!q.get.get(id)) throw new BusinessError('Conta recorrente não encontrada.', 404);
    const removed = db.prepare(`DELETE ${q.openFuture}`).run(id, T.addDays(T.localDate(), 1)).changes;
    db.prepare("UPDATE fin_recurrences SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
    return removed;
  });

  function list() {
    const today = T.localDate();
    return db.prepare(`
      SELECT r.*, a.name AS account_name, a.kind, l.name AS location_name,
        (SELECT MIN(due_date) FROM fin_entries e WHERE e.recurrence_id = r.id AND e.paid_date IS NULL AND e.due_date >= ?) AS next_due,
        (SELECT COUNT(*) FROM fin_entries e WHERE e.recurrence_id = r.id AND e.paid_date IS NULL AND e.due_date < ?) AS overdue
      FROM fin_recurrences r JOIN fin_accounts a ON a.id = r.account_id LEFT JOIN locations l ON l.id = r.location_id
      ORDER BY r.active DESC, a.kind DESC, r.description`).all(today, today)
      .map((r) => ({ ...r, interval_label: INTERVALS[r.interval_months] }));
  }

  // Parcelas que ainda não foram lançadas (depois do que já foi gerado), até `until`. Só para projeção:
  // não cria nada.
  function projected(until) {
    const out = [];
    const rows = db.prepare(`SELECT r.*, a.kind, a.name AS account_name FROM fin_recurrences r
      JOIN fin_accounts a ON a.id = r.account_id WHERE r.active = 1`).all();
    for (const r of rows) {
      for (const due of dueDates(r, until)) {
        if (r.generated_until && due <= r.generated_until) continue;
        out.push({ date: due, amount_cents: r.amount_cents, kind: r.kind, description: r.description, account_name: r.account_name, recurrence_id: r.id });
      }
    }
    return out;
  }

  return { generate, create, update, stop, list, projected, get: (id) => q.get.get(id) };
}

module.exports = { createRecurring, addMonths, monthDiff, horizon, INTERVALS };

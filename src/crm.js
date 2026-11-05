'use strict';

// CRM simples: visitas, ligações e mensagens com clientes (ou com quem ainda não é cliente),
// com a próxima ação combinada e a data dela.

const T = require('./time');
const U = require('./util');
const { BusinessError } = require('./inventory');

const KINDS = { visita: 'Visita', ligacao: 'Ligação', whatsapp: 'WhatsApp', email: 'E-mail', reuniao: 'Reunião', outro: 'Outro' };

function createCrm(db) {
  const SELECT = `SELECT i.*, c.razao_social, c.nome_fantasia, c.cnpj
    FROM crm_interactions i LEFT JOIN customers c ON c.id = i.customer_id`;

  function read(b, existing = {}) {
    const customerId = b.customer_id !== undefined ? (Number(b.customer_id) || null) : (existing.customer_id ?? null);
    if (customerId && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) throw new BusinessError('Cliente não encontrado.');
    const prospect = customerId ? null : U.cleanText(b.prospect_name ?? existing.prospect_name, 150);
    if (!customerId && !prospect) throw new BusinessError('Escolha o cliente ou informe o nome do contato.');
    const kind = b.kind ?? existing.kind ?? 'visita';
    if (!KINDS[kind]) throw new BusinessError('Tipo de contato inválido.');
    const date = String(b.date ?? existing.date ?? T.localDate());
    if (!T.isDate(date)) throw new BusinessError('Data inválida.');
    const summary = U.cleanText(b.summary ?? existing.summary, 2000);
    if (!summary) throw new BusinessError('Descreva como foi o contato.');
    const nextDate = b.next_action_date !== undefined ? (String(b.next_action_date || '').trim() || null) : (existing.next_action_date ?? null);
    if (nextDate && !T.isDate(nextDate)) throw new BusinessError('Data da próxima ação inválida.');
    const nextAction = U.cleanText(b.next_action ?? existing.next_action, 300);
    return {
      customer_id: customerId, prospect_name: prospect, kind, date, summary,
      contact_person: U.cleanText(b.contact_person ?? existing.contact_person, 120),
      next_action: nextAction, next_action_date: nextAction || nextDate ? nextDate : null,
      next_done: b.next_done !== undefined ? (b.next_done ? 1 : 0) : (existing.next_done ?? 0),
    };
  }

  function create(b, user) {
    const r = read(b);
    return Number(db.prepare(`INSERT INTO crm_interactions (customer_id, prospect_name, kind, date, contact_person, summary, next_action,
      next_action_date, next_done, created_by) VALUES (@customer_id, @prospect_name, @kind, @date, @contact_person, @summary, @next_action,
      @next_action_date, @next_done, @created_by)`).run({ ...r, created_by: user }).lastInsertRowid);
  }

  function update(id, b) {
    const existing = db.prepare('SELECT * FROM crm_interactions WHERE id = ?').get(id);
    if (!existing) throw new BusinessError('Registro não encontrado.', 404);
    const r = read(b, existing);
    db.prepare(`UPDATE crm_interactions SET customer_id = @customer_id, prospect_name = @prospect_name, kind = @kind, date = @date,
      contact_person = @contact_person, summary = @summary, next_action = @next_action, next_action_date = @next_action_date,
      next_done = @next_done, updated_at = datetime('now') WHERE id = @id`).run({ ...r, id });
  }

  function remove(id) {
    if (!db.prepare('DELETE FROM crm_interactions WHERE id = ?').run(id).changes) throw new BusinessError('Registro não encontrado.', 404);
  }

  function list({ customerId, kind, from, to, q } = {}) {
    const where = [];
    const params = [];
    if (customerId) { where.push('i.customer_id = ?'); params.push(Number(customerId)); }
    if (KINDS[kind]) { where.push('i.kind = ?'); params.push(kind); }
    if (T.isDate(String(from || ''))) { where.push('i.date >= ?'); params.push(from); }
    if (T.isDate(String(to || ''))) { where.push('i.date <= ?'); params.push(to); }
    if (q) {
      where.push("(i.summary LIKE ? OR i.prospect_name LIKE ? OR c.razao_social LIKE ? OR c.nome_fantasia LIKE ? OR i.contact_person LIKE ?)");
      const like = `%${String(q).slice(0, 80)}%`;
      params.push(like, like, like, like, like);
    }
    return db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.date DESC, i.id DESC LIMIT 500`).all(...params);
  }

  // Painel: próximas ações em aberto, clientes ativos sem contato há `days` dias e números do mês.
  function summary({ days = 30, today = T.localDate() } = {}) {
    const pending = db.prepare(`${SELECT} WHERE i.next_done = 0 AND i.next_action IS NOT NULL
      ORDER BY COALESCE(i.next_action_date, '9999-12-31'), i.id`).all();
    const limit = T.addDays(today, -days);
    const quiet = db.prepare(`
      SELECT c.id, c.razao_social, c.nome_fantasia, c.cnpj, c.telefone, c.cidade,
        (SELECT MAX(date) FROM crm_interactions WHERE customer_id = c.id) AS last_contact,
        (SELECT MAX(created_at) FROM orders WHERE customer_id = c.id AND deleted_at IS NULL AND status <> 'cancelado') AS last_order_at
      FROM customers c WHERE c.status = 'ativo' AND (c.payment_days IS NULL OR c.payment_days >= 0)
        AND COALESCE((SELECT MAX(date) FROM crm_interactions WHERE customer_id = c.id), '0000-00-00') < ?
      ORDER BY last_contact IS NOT NULL, last_contact, c.razao_social`).all(limit);
    const month = today.slice(0, 7);
    const monthCount = db.prepare("SELECT kind, COUNT(*) n FROM crm_interactions WHERE substr(date, 1, 7) = ? GROUP BY kind").all(month);
    return {
      today, days,
      pending: pending.map((p) => ({ ...p, overdue: !!p.next_action_date && p.next_action_date < today })),
      quiet,
      month: { total: monthCount.reduce((s, r) => s + r.n, 0), by_kind: Object.fromEntries(monthCount.map((r) => [r.kind, r.n])) },
    };
  }

  return { create, update, remove, list, summary, KINDS };
}

module.exports = { createCrm, KINDS };

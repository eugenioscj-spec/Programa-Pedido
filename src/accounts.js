'use strict';

// Contas onde o dinheiro está: bancos (com ou sem extrato OFX), o cofre e o caixa de cada loja.
//
// Saldo atual de cada conta:
// - Banco com extrato OFX: o saldo do extrato (o banco é a fonte) + o que foi pago/recebido nela e
//   as transferências DEPOIS do último extrato importado. Antes disso o extrato já mostra tudo.
// - Conta sem extrato (cofre, caixa, banco sem OFX): saldo inicial informado + pagamentos,
//   recebimentos e transferências a partir da data desse saldo.
// O caixa das lojas fica fora do total: as vendas do balcão ainda não entram no sistema (virão do PDV),
// então ele só registra o que sai para o cofre.

const T = require('./time');
const U = require('./util');
const { BusinessError } = require('./inventory');
const { BANKS } = require('./ofx');

const TYPES = { banco: 'Banco', cofre: 'Cofre', caixa: 'Caixa da loja' };

function createAccounts(db, bank) {
  const q = {
    entries: db.prepare(`SELECT COALESCE(SUM(CASE a.kind WHEN 'receita' THEN e.amount_cents ELSE -e.amount_cents END), 0) v, COUNT(*) n
      FROM fin_entries e JOIN fin_accounts a ON a.id = e.account_id
      WHERE e.bank_account_id = ? AND e.paid_date IS NOT NULL AND e.paid_date > ?
        AND NOT EXISTS (SELECT 1 FROM bank_transactions t WHERE t.entry_id = e.id)`),
    tin: db.prepare('SELECT COALESCE(SUM(amount_cents), 0) v FROM fin_transfers WHERE to_account_id = ? AND date > ?'),
    tout: db.prepare('SELECT COALESCE(SUM(amount_cents), 0) v FROM fin_transfers WHERE from_account_id = ? AND date > ?'),
    get: db.prepare('SELECT * FROM bank_accounts WHERE id = ?'),
  };

  function balances() {
    return bank.accounts().map((a) => {
      const statement = a.opening_cents !== null;
      let cutoff;
      let base;
      if (statement) {
        cutoff = [a.last, ...a.checks.map((c) => c.date)].filter(Boolean).sort().pop();
        base = a.balance_cents;
      } else {
        cutoff = a.opening_date ? T.addDays(a.opening_date, -1) : '0000-00-00';
        base = a.opening_balance_cents ?? 0;
      }
      const ent = q.entries.get(a.id, cutoff);
      const transfers = q.tin.get(a.id, cutoff).v - q.tout.get(a.id, cutoff).v;
      return {
        ...a,
        type_label: TYPES[a.type] || a.type,
        statement,
        statement_date: statement ? cutoff : null,
        after_statement_cents: ent.v + transfers,
        current_cents: base + ent.v + transfers,
        // entra no total do caixa da empresa: contas correntes ativas, menos o caixa das lojas e cartão de crédito
        in_total: !!a.active && a.kind === 'corrente' && a.type !== 'caixa',
      };
    });
  }

  const total = () => balances().filter((a) => a.in_total).reduce((s, a) => s + a.current_cents, 0);

  function read(b, existing = {}) {
    const type = b.type ?? existing.type ?? 'banco';
    if (!TYPES[type]) throw new BusinessError('Tipo de conta inválido.');
    const name = U.cleanText(b.name ?? existing.name, 80);
    if (!name) throw new BusinessError('Dê um nome para a conta.');
    const bankCode = type === 'banco' ? (String(b.bank_code ?? existing.bank_code ?? '').replace(/\D/g, '').padStart(3, '0').slice(-3) || null) : null;
    const hasOpening = b.opening_balance !== undefined && String(b.opening_balance).trim() !== '';
    const opening = b.opening_balance !== undefined ? (hasOpening ? U.toCents(b.opening_balance) : null) : (existing.opening_balance_cents ?? null);
    if (opening !== null && !Number.isFinite(opening)) throw new BusinessError('Saldo inicial inválido.');
    const date = b.opening_date !== undefined ? (String(b.opening_date || '').trim() || null) : (existing.opening_date ?? null);
    if (date && !T.isDate(date)) throw new BusinessError('Data do saldo inicial inválida.');
    if (opening !== null && !date) throw new BusinessError('Informe a data do saldo inicial.');
    return {
      name, type, bank_code: bankCode, bank_name: bankCode ? (BANKS[bankCode] || `Banco ${bankCode}`) : null,
      branch: U.cleanText(b.branch ?? existing.branch, 20),
      account_number: U.cleanText(b.account_number ?? existing.account_number, 30) || '',
      opening_balance_cents: opening, opening_date: date,
      active: b.active === undefined ? (existing.active ?? 1) : (b.active ? 1 : 0),
    };
  }

  function create(b) {
    const a = read(b);
    if (a.type === 'banco' && !a.bank_code) throw new BusinessError('Escolha o banco.');
    if (db.prepare("SELECT 1 FROM bank_accounts WHERE bank_code IS ? AND account_number = ? AND kind = 'corrente'").get(a.bank_code, a.account_number)) {
      throw new BusinessError('Já existe uma conta com esse banco e número.', 409);
    }
    return Number(db.prepare(`INSERT INTO bank_accounts (name, type, bank_code, bank_name, branch, account_number, kind, opening_balance_cents, opening_date, active)
      VALUES (@name, @type, @bank_code, @bank_name, @branch, @account_number, 'corrente', @opening_balance_cents, @opening_date, @active)`).run(a).lastInsertRowid);
  }

  function update(id, b) {
    const existing = q.get.get(id);
    if (!existing) throw new BusinessError('Conta não encontrada.', 404);
    const a = read(b, existing);
    // número e banco de conta que já recebeu extrato não mudam (é por eles que o OFX acha a conta)
    const hasStatement = db.prepare('SELECT 1 FROM bank_imports WHERE bank_account_id = ? LIMIT 1').get(id);
    db.prepare(`UPDATE bank_accounts SET name = @name, branch = @branch, opening_balance_cents = @opening_balance_cents,
      opening_date = @opening_date, active = @active ${hasStatement ? '' : ', account_number = @account_number'} WHERE id = @id`).run({ ...a, id });
  }

  // ---------- transferências entre contas (não são receita nem despesa) ----------
  function transfer({ from, to, amount, date, note, user }) {
    const a = q.get.get(Number(from));
    const b = q.get.get(Number(to));
    if (!a || !b) throw new BusinessError('Escolha as duas contas.');
    if (a.id === b.id) throw new BusinessError('As contas de origem e destino precisam ser diferentes.');
    const cents = typeof amount === 'number' ? amount : U.toCents(amount);
    if (!Number.isFinite(cents) || cents <= 0) throw new BusinessError('Informe um valor maior que zero.');
    const d = String(date || T.localDate());
    if (!T.isDate(d)) throw new BusinessError('Data inválida.');
    return Number(db.prepare('INSERT INTO fin_transfers (from_account_id, to_account_id, amount_cents, date, note, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.id, b.id, cents, d, U.cleanText(note, 200), user).lastInsertRowid);
  }

  function transfers({ from, to, accountId, locationId, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (T.isDate(String(from || ''))) { where.push('t.date >= ?'); params.push(from); }
    if (T.isDate(String(to || ''))) { where.push('t.date <= ?'); params.push(to); }
    if (accountId) { where.push('(t.from_account_id = ? OR t.to_account_id = ?)'); params.push(accountId, accountId); }
    if (locationId) { where.push('fa.location_id = ?'); params.push(locationId); }
    return db.prepare(`SELECT t.*, fa.name AS from_name, ta.name AS to_name FROM fin_transfers t
      JOIN bank_accounts fa ON fa.id = t.from_account_id JOIN bank_accounts ta ON ta.id = t.to_account_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.date DESC, t.id DESC LIMIT ${Number(limit) || 200}`).all(...params);
  }

  function removeTransfer(id) {
    if (!db.prepare('DELETE FROM fin_transfers WHERE id = ?').run(id).changes) throw new BusinessError('Transferência não encontrada.', 404);
  }

  const cashOf = (locationId) => db.prepare("SELECT * FROM bank_accounts WHERE type = 'caixa' AND location_id = ? AND active = 1").get(locationId);
  const vault = () => db.prepare("SELECT * FROM bank_accounts WHERE type = 'cofre' AND active = 1 ORDER BY id LIMIT 1").get();

  // Caixa de uma loja nova (o master cadastra lojas em Config.).
  function ensureCash(location) {
    db.prepare("INSERT OR IGNORE INTO bank_accounts (name, account_number, kind, type, location_id) VALUES (?, ?, 'corrente', 'caixa', ?)")
      .run(`Caixa ${location.name}`, `CAIXA-${location.id}`, location.id);
  }

  return { balances, total, create, update, transfer, transfers, removeTransfer, cashOf, vault, ensureCash, TYPES };
}

module.exports = { createAccounts, TYPES };

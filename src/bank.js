'use strict';

// Bancos: importação de extratos OFX, conciliação com o Financeiro e relatório por conta.
//
// Cada linha do extrato fica "pendente" até ser conciliada de um destes jeitos:
//   criar   → vira um lançamento novo (já pago na data do extrato) numa conta do plano de contas;
//   baixar  → dá baixa num lançamento que estava em aberto (mesmo valor);
//   ignorar → não é receita nem despesa (transferência entre contas próprias, aplicação/resgate, pagamento de fatura).
// Tudo pode ser desfeito.

const { BusinessError } = require('./inventory');
const { parseOfx, dedupeKeys } = require('./ofx');
const T = require('./time');
const { monthsBetween } = require('./finance');

// "PIX ENVIADO 12/10 JOAO DA SILVA" → "PIX ENVIADO JOAO DA SILVA"
function normalize(desc) {
  return String(desc || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const defaultPattern = (desc) => normalize(desc).split(' ').filter((w) => w.length > 1).slice(0, 3).join(' ');

function createBank(db) {
  const q = {
    findAccount: db.prepare('SELECT * FROM bank_accounts WHERE bank_code IS ? AND account_number = ? AND kind = ?'),
    insertAccount: db.prepare('INSERT INTO bank_accounts (name, bank_code, bank_name, branch, account_number, kind) VALUES (?, ?, ?, ?, ?, ?)'),
    insertImport: db.prepare(`INSERT INTO bank_imports (bank_account_id, file_name, period_start, period_end, ledger_balance_cents, balance_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    updateImport: db.prepare('UPDATE bank_imports SET count_new = ?, count_duplicate = ? WHERE id = ?'),
    insertTx: db.prepare(`INSERT OR IGNORE INTO bank_transactions (bank_account_id, import_id, dedupe_key, fitid, posted_date, amount_cents, description, trntype)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    tx: db.prepare(`SELECT t.*, b.name AS bank_account_name, b.kind AS bank_kind FROM bank_transactions t
      JOIN bank_accounts b ON b.id = t.bank_account_id WHERE t.id = ?`),
    account: db.prepare('SELECT * FROM fin_accounts WHERE id = ?'),
    entry: db.prepare('SELECT e.*, a.kind FROM fin_entries e JOIN fin_accounts a ON a.id = e.account_id WHERE e.id = ?'),
    openMatch: db.prepare(`
      SELECT e.id, e.description, e.amount_cents, e.due_date, e.competence_date, a.name AS account_name,
        ABS(julianday(COALESCE(e.due_date, e.competence_date)) - julianday(?)) AS distance
      FROM fin_entries e JOIN fin_accounts a ON a.id = e.account_id
      WHERE e.paid_date IS NULL AND a.kind = ? AND e.amount_cents = ?
        AND ABS(julianday(COALESCE(e.due_date, e.competence_date)) - julianday(?)) <= 10
        AND NOT EXISTS (SELECT 1 FROM bank_transactions x WHERE x.entry_id = e.id)
      ORDER BY distance LIMIT 5`),
    rules: db.prepare(`SELECT r.*, a.name AS account_name, a.kind FROM bank_rules r JOIN fin_accounts a ON a.id = r.account_id
      WHERE a.active = 1 ORDER BY length(r.pattern) DESC`),
    history: db.prepare(`SELECT t.description, e.account_id, a.name AS account_name, a.kind FROM bank_transactions t
      JOIN fin_entries e ON e.id = t.entry_id JOIN fin_accounts a ON a.id = e.account_id
      WHERE t.status = 'conciliado' AND t.link_type = 'criado' AND a.active = 1 ORDER BY t.id DESC LIMIT 2000`),
    insertEntry: db.prepare(`INSERT INTO fin_entries (account_id, description, amount_cents, competence_date, due_date, paid_date,
      bank_account_id, counterparty, document, note, created_by)
      VALUES (@account_id, @description, @amount_cents, @competence_date, @due_date, @paid_date, @bank_account_id, @counterparty, @document, @note, @created_by)`),
    link: db.prepare("UPDATE bank_transactions SET status = ?, entry_id = ?, link_type = ?, note = ? WHERE id = ?"),
  };

  const kindOf = (amount) => (amount > 0 ? 'receita' : 'despesa');

  // ---------- importação ----------
  const importFiles = db.transaction(({ files, user }) => {
    const results = [];
    for (const f of files) {
      let statements;
      try {
        statements = parseOfx(f.buffer);
      } catch (e) {
        results.push({ file: f.name, error: e.message });
        continue;
      }
      for (const st of statements) {
        let acc = q.findAccount.get(st.bank_code, st.account_number, st.kind);
        if (!acc) {
          const name = `${st.bank_name} ${st.kind === 'cartao' ? 'cartão ' : ''}${st.account_number}`;
          const id = Number(q.insertAccount.run(name, st.bank_code, st.bank_name, st.branch, st.account_number, st.kind).lastInsertRowid);
          acc = { id, name };
        }
        const importId = Number(q.insertImport.run(acc.id, f.name, st.period_start, st.period_end, st.ledger_balance_cents, st.balance_date, user).lastInsertRowid);
        const keys = dedupeKeys(st.transactions);
        let added = 0;
        st.transactions.forEach((t, i) => {
          added += q.insertTx.run(acc.id, importId, keys[i], t.fitid, t.date, t.amount_cents, t.description, t.trntype).changes;
        });
        q.updateImport.run(added, st.transactions.length - added, importId);
        results.push({
          file: f.name, account: acc.name, account_id: acc.id, period_start: st.period_start, period_end: st.period_end,
          new: added, duplicate: st.transactions.length - added,
        });
      }
    }
    return results;
  });

  // ---------- sugestões ----------
  // Lançamentos em aberto que batem (mesmo tipo e valor, até 10 dias de diferença), do mais próximo ao mais distante.
  const openCandidates = (tx) => q.openMatch.all(tx.posted_date, kindOf(tx.amount_cents), Math.abs(tx.amount_cents), tx.posted_date);

  // usedEntries: lançamentos em aberto já sugeridos para outro movimento (cada um só pode ser pago uma vez).
  function suggestFor(tx, rules, history, usedEntries = new Set(), candidates = openCandidates(tx)) {
    const kind = kindOf(tx.amount_cents);
    const match = candidates.find((c) => !usedEntries.has(c.id));
    if (match) return { type: 'baixar', entry: match };
    const norm = normalize(tx.description);
    const rule = rules.find((r) => r.kind === kind && norm.includes(r.pattern));
    if (rule) return { type: 'criar', account_id: rule.account_id, account_name: rule.account_name, source: 'regra' };
    const past = history.find((h) => h.kind === kind && normalize(h.description) === norm);
    if (past) return { type: 'criar', account_id: past.account_id, account_name: past.account_name, source: 'histórico' };
    return null;
  }

  function listTransactions({ accountId, status, from, to, limit = 500 }) {
    const where = [];
    const params = [];
    if (accountId) { where.push('t.bank_account_id = ?'); params.push(Number(accountId)); }
    if (['pendente', 'conciliado', 'ignorado'].includes(status)) { where.push('t.status = ?'); params.push(status); }
    if (T.isDate(String(from || ''))) { where.push('t.posted_date >= ?'); params.push(String(from)); }
    if (T.isDate(String(to || ''))) { where.push('t.posted_date <= ?'); params.push(String(to)); }
    const rows = db.prepare(`
      SELECT t.*, b.name AS bank_account_name, b.kind AS bank_kind, a.name AS entry_account_name
      FROM bank_transactions t JOIN bank_accounts b ON b.id = t.bank_account_id
      LEFT JOIN fin_entries e ON e.id = t.entry_id LEFT JOIN fin_accounts a ON a.id = e.account_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.posted_date DESC, t.id DESC LIMIT ${Math.min(Number(limit) || 500, 3000)}`).all(...params);
    const rules = q.rules.all();
    const history = q.history.all();
    // Distribui os lançamentos em aberto: cada um vai para o movimento de data mais próxima.
    const pend = rows.filter((r) => r.status === 'pendente').map((r) => ({ r, cands: openCandidates(r) }));
    const pairs = pend.flatMap(({ r, cands }) => cands.map((c) => ({ r, c }))).sort((x, y) => x.c.distance - y.c.distance || x.r.id - y.r.id);
    const used = new Set();
    const assigned = new Map();
    for (const { r, c } of pairs) {
      if (assigned.has(r.id) || used.has(c.id)) continue;
      assigned.set(r.id, c);
      used.add(c.id);
    }
    for (const { r } of pend) {
      const c = assigned.get(r.id);
      r.suggestion = c ? { type: 'baixar', entry: c } : suggestFor(r, rules, history, used, []);
    }
    return rows;
  }

  // ---------- conciliação ----------
  function conciliateOne(id, o, user) {
    const tx = q.tx.get(Number(id));
    if (!tx) throw new BusinessError('Lançamento do extrato não encontrado.', 404);
    if (tx.status !== 'pendente') throw new BusinessError('Este lançamento do extrato já foi tratado. Desfaça antes de mudar.');
    const kind = kindOf(tx.amount_cents);
    const amount = Math.abs(tx.amount_cents);

    if (o.action === 'ignorar') {
      q.link.run('ignorado', null, null, String(o.note || '').trim().slice(0, 200) || 'Transferência entre contas próprias', tx.id);
      return { id: tx.id, status: 'ignorado' };
    }
    if (o.action === 'baixar') {
      const e = q.entry.get(Number(o.entry_id));
      if (!e) throw new BusinessError('Lançamento em aberto não encontrado.', 404);
      if (e.paid_date) throw new BusinessError('Esse lançamento já está pago.');
      if (e.kind !== kind) throw new BusinessError(`O extrato é uma ${kind === 'receita' ? 'entrada' : 'saída'}, e o lançamento é ${e.kind === 'receita' ? 'uma receita' : 'uma despesa'}.`);
      if (e.amount_cents !== amount) throw new BusinessError('O valor do extrato é diferente do valor do lançamento.');
      db.prepare("UPDATE fin_entries SET paid_date = ?, bank_account_id = ?, updated_at = datetime('now') WHERE id = ?").run(tx.posted_date, tx.bank_account_id, e.id);
      q.link.run('conciliado', e.id, 'baixado', null, tx.id);
      return { id: tx.id, status: 'conciliado', entry_id: e.id };
    }
    if (o.action === 'criar') {
      const acc = q.account.get(Number(o.account_id));
      if (!acc || !acc.active) throw new BusinessError('Escolha a conta do plano de contas.');
      if (acc.kind !== kind) {
        throw new BusinessError(`“${acc.name}” é conta de ${acc.kind}, mas o extrato é uma ${kind === 'receita' ? 'entrada' : 'saída'}.`);
      }
      const competence = T.isDate(String(o.competence_date || '')) ? String(o.competence_date) : tx.posted_date;
      const entryId = Number(q.insertEntry.run({
        account_id: acc.id,
        description: String(o.description || '').trim().slice(0, 200) || tx.description,
        amount_cents: amount,
        competence_date: competence,
        due_date: tx.posted_date,
        paid_date: tx.posted_date,
        bank_account_id: tx.bank_account_id,
        counterparty: null,
        document: 'Extrato bancário',
        note: null,
        created_by: user,
      }).lastInsertRowid);
      q.link.run('conciliado', entryId, 'criado', null, tx.id);
      if (o.remember) {
        const pattern = normalize(o.pattern || defaultPattern(tx.description));
        if (pattern.length >= 3) {
          db.prepare(`INSERT INTO bank_rules (pattern, account_id) VALUES (?, ?)
            ON CONFLICT(pattern) DO UPDATE SET account_id = excluded.account_id`).run(pattern, acc.id);
        }
      }
      return { id: tx.id, status: 'conciliado', entry_id: entryId };
    }
    throw new BusinessError('Ação inválida.');
  }
  const conciliate = db.transaction((id, o, user) => conciliateOne(id, o, user));

  // Em lote: cada linha vai para a conta indicada ou, se não indicada, para a sugestão dela.
  const conciliateMany = db.transaction(({ ids, accountId, user }) => {
    const rules = q.rules.all();
    const history = q.history.all();
    let done = 0;
    const skipped = [];
    const usedInBatch = new Set();
    for (const id of ids || []) {
      const tx = q.tx.get(Number(id));
      if (!tx || tx.status !== 'pendente') continue;
      const s = accountId ? { type: 'criar', account_id: Number(accountId) } : suggestFor(tx, rules, history, usedInBatch);
      if (s && s.type === 'baixar') usedInBatch.add(s.entry.id);
      if (!s) { skipped.push(tx.id); continue; }
      try {
        conciliateOne(tx.id, s.type === 'baixar' ? { action: 'baixar', entry_id: s.entry.id } : { action: 'criar', account_id: s.account_id }, user);
        done++;
      } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        skipped.push(tx.id);
      }
    }
    return { done, skipped };
  });

  const undo = db.transaction((id) => {
    const tx = q.tx.get(Number(id));
    if (!tx) throw new BusinessError('Lançamento do extrato não encontrado.', 404);
    if (tx.link_type === 'criado' && tx.entry_id) {
      q.link.run('pendente', null, null, null, tx.id);
      db.prepare('DELETE FROM fin_entries WHERE id = ?').run(tx.entry_id);
    } else if (tx.link_type === 'baixado' && tx.entry_id) {
      db.prepare("UPDATE fin_entries SET paid_date = NULL, bank_account_id = NULL, updated_at = datetime('now') WHERE id = ?").run(tx.entry_id);
      q.link.run('pendente', null, null, null, tx.id);
    } else {
      q.link.run('pendente', null, null, null, tx.id);
    }
    return { id: tx.id, status: 'pendente' };
  });

  // ---------- saldos ----------
  // Saldo inicial de cada conta = saldo informado pelo banco no último extrato − movimentos até aquela data.
  // Depois confere cada extrato importado: se o saldo calculado não bate com o do banco, falta (ou sobra) movimento.
  function accounts() {
    const list = db.prepare('SELECT * FROM bank_accounts ORDER BY active DESC, kind, bank_name, account_number').all();
    const sumUntil = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) v FROM bank_transactions WHERE bank_account_id = ? AND posted_date <= ?');
    return list.map((a) => {
      const stats = db.prepare(`SELECT COUNT(*) n, SUM(status = 'pendente') pending, MIN(posted_date) first, MAX(posted_date) last,
        COALESCE(SUM(amount_cents), 0) total FROM bank_transactions WHERE bank_account_id = ?`).get(a.id);
      const imports = db.prepare(`SELECT * FROM bank_imports WHERE bank_account_id = ? AND ledger_balance_cents IS NOT NULL AND balance_date IS NOT NULL
        ORDER BY balance_date DESC, id DESC`).all(a.id);
      let opening = null;
      const checks = [];
      if (imports.length) {
        opening = imports[0].ledger_balance_cents - sumUntil.get(a.id, imports[0].balance_date).v;
        const seen = new Set();
        for (const imp of imports) {
          if (seen.has(imp.balance_date)) continue;
          seen.add(imp.balance_date);
          const computed = opening + sumUntil.get(a.id, imp.balance_date).v;
          checks.push({ date: imp.balance_date, bank: imp.ledger_balance_cents, computed, diff: computed - imp.ledger_balance_cents, file: imp.file_name });
        }
      }
      return {
        ...a, count: stats.n, pending: stats.pending || 0, first: stats.first, last: stats.last,
        opening_cents: opening, balance_cents: opening === null ? null : opening + stats.total,
        checks, ok: checks.every((c) => c.diff === 0),
      };
    });
  }

  // Soma dos saldos iniciais das contas correntes (para a DFC). Cartão de crédito não é caixa.
  function openingTotal() {
    return accounts().filter((a) => a.kind === 'corrente' && a.active && a.opening_cents !== null).reduce((s, a) => s + a.opening_cents, 0);
  }

  // ---------- relatório ----------
  function report(fromAsked, to) {
    // começa no primeiro mês que tem movimento (evita colunas vazias)
    const first = db.prepare('SELECT MIN(posted_date) d FROM bank_transactions').get().d;
    const from = first && first > fromAsked && first <= to ? `${first.slice(0, 7)}-01` : fromAsked;
    const months = monthsBetween(from, to);
    const accs = accounts().filter((a) => a.active);
    const monthLabel = (ym) => `${ym.slice(5)}/${ym.slice(0, 4)}`;
    const cols = (first) => [{ key: 'line', label: first, type: 'text' }, ...months.map((m) => ({ key: m, label: monthLabel(m), type: 'money' })), { key: 'total', label: 'Total', type: 'money' }];
    const sections = [];
    const warnings = [];
    const pendingTotal = db.prepare("SELECT COUNT(*) n FROM bank_transactions WHERE status = 'pendente' AND posted_date BETWEEN ? AND ?").get(from, to).n;
    if (pendingTotal) warnings.push(`${pendingTotal} lançamento(s) do extrato ainda não conciliado(s) no período: aparecem como “Não conciliado”.`);
    for (const a of accs) {
      if (!a.checks.length && a.kind === 'corrente') warnings.push(`${a.name}: o extrato não trouxe saldo, então o saldo da conta não pôde ser calculado.`);
      if (!a.ok) warnings.push(`${a.name}: o saldo calculado não bate com o saldo do banco em alguma data. Provavelmente falta importar algum período.`);
    }

    // Por conta bancária: saldo inicial, entradas, saídas, saldo final, mês a mês
    for (const a of accs) {
      const tx = db.prepare('SELECT substr(posted_date, 1, 7) AS m, amount_cents FROM bank_transactions WHERE bank_account_id = ? AND posted_date BETWEEN ? AND ?').all(a.id, from, to);
      const before = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) v FROM bank_transactions WHERE bank_account_id = ? AND posted_date < ?').get(a.id, from).v;
      let bal = (a.opening_cents ?? 0) + before;
      const ins = { line: 'Entradas', _class: 'sub' };
      const outs = { line: 'Saídas', _class: 'sub' };
      const ini = { line: 'Saldo inicial' };
      const fin = { line: '= Saldo final', _class: 'total' };
      ins.total = 0; outs.total = 0; ini.total = bal;
      for (const m of months) {
        ini[m] = bal;
        ins[m] = tx.filter((t) => t.m === m && t.amount_cents > 0).reduce((s, t) => s + t.amount_cents, 0);
        outs[m] = tx.filter((t) => t.m === m && t.amount_cents < 0).reduce((s, t) => s + t.amount_cents, 0);
        ins.total += ins[m]; outs.total += outs[m];
        bal += ins[m] + outs[m];
        fin[m] = bal;
      }
      fin.total = bal;
      sections.push({ title: `${a.name}${a.kind === 'cartao' ? ' (cartão de crédito)' : ''}`, columns: cols(''), rows: [ini, ins, outs, fin] });
    }

    // Por categoria (conta do plano de contas), mês a mês
    const cat = db.prepare(`
      SELECT substr(t.posted_date, 1, 7) AS m, t.amount_cents, t.status,
        CASE WHEN t.status = 'conciliado' THEN a.name WHEN t.status = 'ignorado' THEN 'Ignorado (transferências, aplicações, faturas)' ELSE 'Não conciliado' END AS cat
      FROM bank_transactions t LEFT JOIN fin_entries e ON e.id = t.entry_id LEFT JOIN fin_accounts a ON a.id = e.account_id
      WHERE t.posted_date BETWEEN ? AND ?`).all(from, to);
    const byCat = new Map();
    for (const r of cat) {
      const row = byCat.get(r.cat) || { line: r.cat, total: 0, _class: r.status === 'pendente' ? 'danger' : undefined };
      row[r.m] = (row[r.m] || 0) + r.amount_cents;
      row.total += r.amount_cents;
      byCat.set(r.cat, row);
    }
    const catRows = [...byCat.values()].sort((x, y) => x.total - y.total);
    for (const r of catRows) for (const m of months) r[m] = r[m] || 0;
    sections.push({ title: 'Por categoria (entradas positivas, saídas negativas)', columns: cols('Categoria'), rows: catRows });

    // Conferência de saldos com o banco
    const checkRows = accs.flatMap((a) => a.checks.map((c) => ({ line: `${a.name} em ${c.date}`, bank: c.bank, computed: c.computed, diff: c.diff, _class: c.diff ? 'danger' : undefined })));
    if (checkRows.length) {
      sections.push({
        title: 'Conferência com o saldo informado pelo banco',
        columns: [{ key: 'line', label: 'Conta e data', type: 'text' }, { key: 'bank', label: 'Saldo do banco', type: 'money' },
          { key: 'computed', label: 'Saldo calculado', type: 'money' }, { key: 'diff', label: 'Diferença', type: 'money' }],
        rows: checkRows,
      });
    }
    return { title: 'Bancos e extratos', subtitle: `${from} a ${to}. Movimentos dos extratos importados.`, warnings, sections };
  }

  return { importFiles, listTransactions, conciliate, conciliateMany, undo, accounts, openingTotal, report, normalize, defaultPattern };
}

module.exports = { createBank, normalize, defaultPattern };

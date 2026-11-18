'use strict';

// Rotina do Itaú: busca o extrato dos últimos dias de cada conta (ITAU_CONTAS) e grava em Bancos
// (mesma tabela e mesma conciliação do OFX, sem duplicar). Também guarda o saldo informado pelo banco.
// Agenda: a cada 3 horas, das 6h às 22h (Cuiabá), olhando os últimos 7 dias (o banco às vezes lança com atraso).
// Só LÊ o banco: não lança nada no Financeiro sozinho (a conciliação continua sendo feita em Bancos).

const T = require('./time');
const itau = require('./itau');

function createItauSync(db, bank, { env = process.env, requestImpl, log = console.log } = {}) {
  let running = null;
  const configured = () => {
    const c = itau.config(env);
    return !!(c.clientId && c.clientSecret && c.accounts.length);
  };

  async function run({ days = 7, kind = 'manual', user = 'Rotina Itaú', startDate, endDate } = {}) {
    if (running) return { busy: true };
    const end = endDate || T.localDate();
    const start = startDate || T.addDays(end, -(Math.max(1, Math.min(90, Number(days) || 7)) - 1));
    const runId = Number(db.prepare("INSERT INTO sync_runs (source, kind, dates) VALUES ('itau', ?, ?)").run(kind, `${start},${end}`).lastInsertRowid);
    running = { id: runId };
    const client = itau.createClient({ env, ...(requestImpl ? { requestImpl } : {}) });
    const results = [];
    const problems = [];
    try {
      if (!client.config.accounts.length) throw new itau.ItauError('Falta a variável ITAU_CONTAS (agência/conta-dígito) no servidor.');
      let balances = [];
      try { balances = await client.balances(); } catch (e) { problems.push(`saldo: ${e.message}`); }
      for (const acc of client.config.accounts) {
        try {
          const st = await client.statement(acc, start, end);
          const bal = balances.find((b) => b.statement_id === acc.id);
          const balanceCents = bal ? (bal.total_cents ?? bal.available_cents) : null;
          const r = bank.importApi({
            account: { bank_code: '341', bank_name: 'Itaú', branch: acc.branch, number: acc.number, digit: acc.digit, label: acc.label },
            transactions: st.events.map(itau.toTransaction),
            periodStart: start, periodEnd: end,
            balanceCents, balanceDate: balanceCents !== null ? T.localDate() : null,
            source: `API Itaú (${start} a ${end})`, user,
          });
          results.push({ ...r, conta: acc.label, eventos: st.events.length, pendentes: st.pending.length, saldo_cents: balanceCents, saldo_disponivel_cents: bal ? bal.available_cents : null });
        } catch (e) {
          problems.push(`${acc.label}: ${e.message}`);
        }
      }
      const status = problems.length ? (results.length ? 'parcial' : 'erro') : 'ok';
      const summary = results.map((r) => `${r.conta}: ${r.new} novo(s), ${r.duplicate} já existia(m)`).join(' | ');
      db.prepare("UPDATE sync_runs SET finished_at = datetime('now'), status = ?, message = ?, stores = ? WHERE id = ?")
        .run(status, [summary, ...problems].filter(Boolean).join(' | ').slice(0, 1000) || null, results.length, runId);
    } catch (e) {
      problems.push(e.message);
      db.prepare("UPDATE sync_runs SET finished_at = datetime('now'), status = 'erro', message = ? WHERE id = ?").run(String(e.message).slice(0, 1000), runId);
      log(`Itaú: busca ${kind} falhou: ${e.message}`);
    } finally {
      running = null;
    }
    return { run: db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(runId), results, problems, log: client.log.slice(0, 8) };
  }

  // Agenda (testável sem relógio de verdade).
  function due(now = new Date()) {
    if (!configured()) return null;
    if (db.prepare("SELECT value FROM settings WHERE key = 'itau_auto'").get()?.value === '0') return null;
    const hour = Number(new Date(now.getTime() - 4 * 3600e3).toISOString().slice(11, 13)); // hora em Cuiabá
    if (hour < 6 || hour > 22) return null;
    const last = db.prepare("SELECT started_at FROM sync_runs WHERE source = 'itau' AND kind = 'auto' ORDER BY id DESC LIMIT 1").get();
    const mins = last ? (now.getTime() - Date.parse(`${last.started_at.replace(' ', 'T')}Z`)) / 60000 : Infinity;
    return mins >= 180 ? { kind: 'auto', days: 7 } : null;
  }

  let timer = null;
  function start({ everyMs = 10 * 60 * 1000 } = {}) {
    if (timer) return;
    const tick = () => { const job = due(); if (job && !running) run(job).catch(() => {}); };
    timer = setInterval(tick, everyMs);
    if (timer.unref) timer.unref();
    setTimeout(tick, 90 * 1000).unref?.();
  }

  return { run, due, start, configured, isRunning: () => running };
}

module.exports = { createItauSync };

'use strict';

// Rotina do Santander: busca o extrato dos últimos dias de cada conta (SANTANDER_CONTAS) e grava em Bancos
// (mesma tabela e conciliação do OFX, sem duplicar). Agenda: a cada 3 horas, das 6h às 22h (Cuiabá), últimos 7 dias.
// Só LÊ: não lança nada no Financeiro sozinho.

const T = require('./time');
const santander = require('./santander');

function createSantanderSync(db, bank, { env = process.env, requestImpl, log = console.log } = {}) {
  let running = null;
  const configured = () => {
    const c = santander.config(env);
    return !!(c.clientId && c.clientSecret && c.pfxBase64 && c.accounts.length);
  };

  async function run({ days = 7, kind = 'manual', user = 'Rotina Santander', startDate, endDate } = {}) {
    if (running) return { busy: true };
    const end = endDate || T.localDate();
    const start = startDate || T.addDays(end, -(Math.max(1, Math.min(90, Number(days) || 7)) - 1));
    const runId = Number(db.prepare("INSERT INTO sync_runs (source, kind, dates) VALUES ('santander', ?, ?)").run(kind, `${start},${end}`).lastInsertRowid);
    running = { id: runId };
    const client = santander.createClient({ env, ...(requestImpl ? { requestImpl } : {}) });
    const results = [];
    const problems = [];
    try {
      if (!client.config.accounts.length) throw new santander.SantanderError('Falta a variável SANTANDER_CONTAS (agência.conta, ex.: 4316.13005206-3) no servidor.');
      for (const acc of client.config.accounts) {
        try {
          const items = await client.statement(acc, start, end);
          let bal = null;
          try { bal = await client.balance(acc); } catch (e) { /* em produção o saldo costuma dar 422: segue só com o extrato */ }
          const r = bank.importApi({
            account: { bank_code: '033', bank_name: 'Santander', branch: acc.branch, number: acc.number, digit: acc.digit, label: acc.label },
            transactions: items.map(santander.toTransaction),
            periodStart: start, periodEnd: end,
            balanceCents: bal ? bal.available_cents : null, balanceDate: bal && bal.available_cents !== null ? T.localDate() : null,
            source: `API Santander (${start} a ${end})`, user,
          });
          results.push({ ...r, conta: acc.label, eventos: items.length, saldo_cents: bal ? bal.available_cents : null });
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
      log(`Santander: busca ${kind} falhou: ${e.message}`);
    } finally {
      running = null;
    }
    return { run: db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(runId), results, problems, log: client.log.slice(0, 10) };
  }

  function due(now = new Date()) {
    if (!configured()) return null;
    if (db.prepare("SELECT value FROM settings WHERE key = 'santander_auto'").get()?.value === '0') return null;
    const hour = Number(new Date(now.getTime() - 4 * 3600e3).toISOString().slice(11, 13));
    if (hour < 6 || hour > 22) return null;
    const last = db.prepare("SELECT started_at FROM sync_runs WHERE source = 'santander' AND kind = 'auto' ORDER BY id DESC LIMIT 1").get();
    const mins = last ? (now.getTime() - Date.parse(`${last.started_at.replace(' ', 'T')}Z`)) / 60000 : Infinity;
    return mins >= 180 ? { kind: 'auto', days: 7 } : null;
  }

  let timer = null;
  function start({ everyMs = 10 * 60 * 1000 } = {}) {
    if (timer) return;
    const tick = () => { const job = due(); if (job && !running) run(job).catch(() => {}); };
    timer = setInterval(tick, everyMs);
    if (timer.unref) timer.unref();
    setTimeout(tick, 3 * 60 * 1000).unref?.();
  }

  return { run, due, start, configured, isRunning: () => running };
}

module.exports = { createSantanderSync };

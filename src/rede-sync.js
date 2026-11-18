'use strict';

// Rotina da Rede: guarda as vendas de cada PV (REDE_PVS) por dia, venda a venda.
// A Rede só fecha o dia seguinte, e as taxas às vezes chegam depois: por isso cada busca refaz os 3 últimos dias
// (ontem, anteontem e o dia anterior), substituindo o que havia — nunca soma duas vezes.
// Agenda: a partir das 6h (Cuiabá), de 8 em 8 horas; se der erro, tenta de novo em 1 hora. Só GUARDA: não lança nada.

const T = require('./time');
const rede = require('./rede');

const isCancelled = (s) => /cancel|estorn|reject|neg|undo|desfeit/i.test(String(s || ''));

function createRedeSync(db, { fetchSales = rede.fetchSales, env = process.env, log = console.log } = {}) {
  let running = null;
  const cfg = () => rede.config(env);
  const configured = () => { const c = cfg(); return !!(c.clientId && c.clientSecret && c.pvs.length && c.ambiente === 'producao'); };

  const saveDay = db.transaction((pv, date, summary) => {
    db.prepare('DELETE FROM rede_sales WHERE pv = ? AND date = ?').run(pv, date);
    const ins = db.prepare(`INSERT INTO rede_sales (pv, date, hour, nsu, brand, modality, installments, gross_cents, fee_cents, other_cents, net_cents, status, cancelled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let fee = 0;
    for (const s of summary) {
      const modality = s.modality ? String(s.modality).toUpperCase() : null;
      ins.run(pv, s.date || date, s.hour, s.nsu, s.brand, modality, s.installments ? Number(s.installments) : null,
        s.gross_cents || 0, s.fee_cents || 0, s.other_cents || 0, s.net_cents || 0, s.status, isCancelled(s.status) ? 1 : 0);
      fee += s.fee_cents || 0;
    }
    db.prepare(`INSERT INTO rede_days (pv, date, sales, fee_cents, fetched_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(pv, date) DO UPDATE SET sales = excluded.sales, fee_cents = excluded.fee_cents, fetched_at = excluded.fetched_at`).run(pv, date, summary.length, fee);
  });

  async function run(dates, kind = 'manual') {
    if (running) return { busy: true };
    const c = cfg();
    const runId = Number(db.prepare("INSERT INTO sync_runs (source, kind, dates) VALUES ('rede', ?, ?)").run(kind, dates.join(',')).lastInsertRowid);
    running = { id: runId };
    const problems = [];
    let saved = 0;
    try {
      if (!c.pvs.length) throw new Error('Falta a variável REDE_PVS no servidor.');
      for (const pv of c.pvs) {
        for (const date of dates) {
          const r = await fetchSales({ date, pv, env });
          if (r.error) { problems.push(`PV ${pv} ${date}: ${r.error}`); continue; }
          saveDay(pv, date, r.summary || []);
          saved += 1;
        }
      }
      const status = problems.length ? (saved ? 'parcial' : 'erro') : 'ok';
      db.prepare("UPDATE sync_runs SET finished_at = datetime('now'), status = ?, message = ?, stores = ? WHERE id = ?")
        .run(status, problems.join(' | ').slice(0, 1000) || null, c.pvs.length, runId);
    } catch (e) {
      db.prepare("UPDATE sync_runs SET finished_at = datetime('now'), status = 'erro', message = ? WHERE id = ?").run(String(e.message).slice(0, 1000), runId);
      log(`Rede: busca ${kind} falhou: ${e.message}`);
    } finally {
      running = null;
    }
    return db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(runId);
  }

  const lastDays = (now = new Date(), n = 3) => {
    const today = T.localDate(now);
    return Array.from({ length: n }, (_, i) => T.addDays(today, -(n - i)));
  };

  function due(now = new Date()) {
    if (!configured()) return null;
    if (db.prepare("SELECT value FROM settings WHERE key = 'rede_auto'").get()?.value === '0') return null;
    const hour = Number(new Date(now.getTime() - 4 * 3600e3).toISOString().slice(11, 13));
    if (hour < 6 || hour > 22) return null;
    const last = db.prepare("SELECT started_at, status FROM sync_runs WHERE source = 'rede' AND kind = 'auto' ORDER BY id DESC LIMIT 1").get();
    const mins = last ? (now.getTime() - Date.parse(`${last.started_at.replace(' ', 'T')}Z`)) / 60000 : Infinity;
    const wait = last && last.status === 'erro' ? 60 : 480;
    return mins >= wait ? { kind: 'auto', dates: lastDays(now) } : null;
  }

  let timer = null;
  function start({ everyMs = 10 * 60 * 1000 } = {}) {
    if (timer) return;
    const tick = () => { const job = due(); if (job && !running) run(job.dates, job.kind).catch(() => {}); };
    timer = setInterval(tick, everyMs);
    if (timer.unref) timer.unref();
    setTimeout(tick, 2 * 60 * 1000).unref?.();
  }

  return { run, due, start, saveDay, configured, lastDays, isRunning: () => running };
}

module.exports = { createRedeSync, isCancelled };

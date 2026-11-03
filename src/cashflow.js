'use strict';

// Fluxo de caixa futuro: parte do saldo de hoje (bancos + cofre) e soma, dia a dia, o que está
// em aberto para receber e para pagar, pela data de vencimento. Inclui as próximas parcelas das
// contas recorrentes, mesmo as que ainda não foram lançadas. Contas vencidas e não pagas entram hoje.

const T = require('./time');

const fmtBr = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function createCashflow(db, accounts, recurring) {
  function projection(days = 90, today = T.localDate()) {
    recurring.generate(today);
    const until = T.addDays(today, days);
    const start = accounts.total();
    const events = db.prepare(`
      SELECT e.id, e.description, e.amount_cents, COALESCE(e.due_date, e.competence_date) AS date, e.counterparty,
        e.recurrence_id, e.order_id, a.kind, a.name AS account_name
      FROM fin_entries e JOIN fin_accounts a ON a.id = e.account_id
      WHERE e.paid_date IS NULL AND COALESCE(e.due_date, e.competence_date) <= ?`).all(until)
      .map((e) => ({ ...e, overdue: e.date < today, date: e.date < today ? today : e.date }))
      .concat(recurring.projected(until).map((r) => ({ ...r, projected: true })))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'receita' ? -1 : 1));

    const byDay = new Map();
    for (const e of events) {
      const d = byDay.get(e.date) || { in: 0, out: 0 };
      if (e.kind === 'receita') d.in += e.amount_cents; else d.out += e.amount_cents;
      byDay.set(e.date, d);
    }
    const series = [];
    let balance = start;
    for (let d = today; d <= until; d = T.addDays(d, 1)) {
      const m = byDay.get(d) || { in: 0, out: 0 };
      balance += m.in - m.out;
      series.push({ date: d, in: m.in, out: m.out, balance });
    }
    const min = series.reduce((lo, p) => (p.balance < lo.balance ? p : lo), series[0]);
    const firstNegative = series.find((p) => p.balance < 0) || null;

    // semanas (segunda a domingo), para a tabela
    const weeks = [];
    for (const p of series) {
      const dow = new Date(`${p.date}T12:00:00Z`).getUTCDay();
      if (!weeks.length || dow === 1) weeks.push({ from: p.date, to: p.date, in: 0, out: 0, start: p.balance - p.in + p.out, end: p.balance });
      const w = weeks[weeks.length - 1];
      w.to = p.date; w.in += p.in; w.out += p.out; w.end = p.balance;
    }
    const overdue = events.filter((e) => e.overdue);
    return {
      today, until, days, start_cents: start, end_cents: balance, series, events, weeks, min, first_negative: firstNegative,
      total_in: series.reduce((s, p) => s + p.in, 0), total_out: series.reduce((s, p) => s + p.out, 0),
      overdue_in: overdue.filter((e) => e.kind === 'receita').reduce((s, e) => s + e.amount_cents, 0),
      overdue_out: overdue.filter((e) => e.kind === 'despesa').reduce((s, e) => s + e.amount_cents, 0),
    };
  }

  // Mesmo conteúdo no formato dos relatórios (para Excel/CSV).
  function report(days) {
    const p = projection(days);
    const money = (key, label) => ({ key, label, type: 'money' });
    return {
      title: `Fluxo de caixa futuro — próximos ${p.days} dias`,
      subtitle: `${fmtBr(p.today)} a ${fmtBr(p.until)}. Começa no saldo de hoje dos bancos e do cofre (${brl(p.start_cents)}).`,
      warnings: [
        ...(p.first_negative ? [`O saldo fica negativo em ${fmtBr(p.first_negative.date)} (${brl(p.first_negative.balance)}).`] : []),
        ...(p.overdue_out || p.overdue_in ? [`Contas vencidas e não pagas entram como se fossem pagas hoje: a pagar ${brl(p.overdue_out)}, a receber ${brl(p.overdue_in)}.`] : []),
        'As vendas do balcão das lojas ainda não entram na projeção (virão do PDV).',
      ],
      sections: [
        {
          title: 'Por semana',
          columns: [{ key: 'line', label: 'Semana', type: 'text' }, money('start', 'Saldo inicial'), money('in', 'Entradas'), money('out', 'Saídas'), money('end', 'Saldo final')],
          rows: p.weeks.map((w) => ({ line: `${fmtBr(w.from)} a ${fmtBr(w.to)}`, start: w.start, in: w.in, out: -w.out, end: w.end })),
        },
        {
          title: 'Contas previstas',
          columns: [{ key: 'date', label: 'Data', type: 'text' }, { key: 'line', label: 'Descrição', type: 'text' },
            { key: 'account', label: 'Conta', type: 'text' }, money('value', 'Valor')],
          rows: p.events.map((e) => ({
            date: fmtBr(e.date), line: `${e.description}${e.counterparty ? ` · ${e.counterparty}` : ''}${e.overdue ? ' (vencida)' : ''}${e.projected ? ' (recorrente, a lançar)' : ''}`,
            account: e.account_name, value: e.kind === 'receita' ? e.amount_cents : -e.amount_cents,
          })),
        },
      ],
    };
  }

  return { projection, report };
}

module.exports = { createCashflow };

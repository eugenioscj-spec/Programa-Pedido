'use strict';

// Fuso horário da loja: America/Cuiaba (UTC−4, sem horário de verão).
// O banco grava sempre em UTC ("YYYY-MM-DD HH:MM:SS"). TODA conversão para o
// dia/mês local passa por aqui — nunca usar 'localtime' do SQLite, que depende
// do fuso do servidor (no Railway é UTC).

const TZ_NAME = 'America/Cuiaba';
const OFFSET_HOURS = -4;
const OFFSET_SQL = `${OFFSET_HOURS} hours`; // '-4 hours'

// Expressões SQL para uma coluna em UTC.
const sqlLocalDate = (col) => `date(${col}, '${OFFSET_SQL}')`;
const sqlLocalDateTime = (col) => `datetime(${col}, '${OFFSET_SQL}')`;
const sqlLocalMonth = (col) => `strftime('%Y-%m', ${col}, '${OFFSET_SQL}')`;

const pad = (n) => String(n).padStart(2, '0');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// Data local (YYYY-MM-DD) de um instante JS.
function localDate(when = new Date()) {
  const d = new Date(when.getTime() + OFFSET_HOURS * 3600e3);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const localMonth = (when = new Date()) => localDate(when).slice(0, 7);

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Instante UTC (formato do banco) da meia-noite local de uma data.
function utcStartOfLocalDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCHours(d.getUTCHours() - OFFSET_HOURS);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Intervalo [início, fim) em UTC que cobre os dias locais de `from` até `to` (inclusive).
function utcRange(from, to) {
  return [utcStartOfLocalDay(from), utcStartOfLocalDay(addDays(to, 1))];
}

// Primeiro e último dia de um mês local ('YYYY-MM').
function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${pad(last)}`];
}

// Converte um instante local "YYYY-MM-DD HH:MM" para UTC no formato do banco (usado em testes/seed).
function localToUtc(localDateTime) {
  const [d, t = '00:00:00'] = localDateTime.split(' ');
  const base = new Date(`${d}T${t.length === 5 ? `${t}:00` : t}Z`);
  base.setUTCHours(base.getUTCHours() - OFFSET_HOURS);
  return base.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  TZ_NAME, OFFSET_SQL, sqlLocalDate, sqlLocalDateTime, sqlLocalMonth,
  isDate, localDate, localMonth, addDays, utcStartOfLocalDay, utcRange, monthBounds, localToUtc,
};

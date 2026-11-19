'use strict';

// Feriados para o "dia útil" (depósitos da Rede no banco, vencimento do B2B).
// Calendário bancário nacional: os fixos + os que dependem da Páscoa (Carnaval segunda e terça, Sexta-feira Santa,
// Corpus Christi), dias em que os bancos não têm expediente. Feriados extras (municipais, pontes) podem ser
// cadastrados na tela de Lojas → Feriados e entram por setExtras().

const FIXED = {
  '01-01': 'Confraternização Universal', '04-21': 'Tiradentes', '05-01': 'Dia do Trabalho', '09-07': 'Independência',
  '10-12': 'Nossa Senhora Aparecida', '11-02': 'Finados', '11-15': 'Proclamação da República',
  '11-20': 'Dia da Consciência Negra', '12-25': 'Natal',
};

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher).
function easter(year) {
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30; const i = Math.floor(c / 4); const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

const cache = new Map();
function national(year) {
  if (cache.has(year)) return cache.get(year);
  const p = easter(year);
  const list = [
    ...Object.entries(FIXED).map(([md, name]) => ({ date: `${year}-${md}`, name })),
    { date: shift(p, -48), name: 'Carnaval (segunda)' }, { date: shift(p, -47), name: 'Carnaval (terça)' },
    { date: shift(p, -2), name: 'Sexta-feira Santa' }, { date: shift(p, 60), name: 'Corpus Christi' },
  ].sort((x, y) => x.date.localeCompare(y.date));
  cache.set(year, list);
  return list;
}

// Extras: [{ date: 'AAAA-MM-DD' | 'MM-DD' (todo ano), name }]
let extras = [];
function setExtras(list) {
  extras = (Array.isArray(list) ? list : []).filter((x) => x && /^(\d{4}-)?\d{2}-\d{2}$/.test(String(x.date || '')))
    .map((x) => ({ date: String(x.date), name: String(x.name || 'Feriado').slice(0, 80) }));
}
const getExtras = () => extras.slice();

function list(year) {
  const ext = extras.map((x) => ({ date: x.date.length === 5 ? `${year}-${x.date}` : x.date, name: x.name, extra: true }))
    .filter((x) => x.date.startsWith(`${year}-`));
  return [...national(year), ...ext].sort((a, b) => a.date.localeCompare(b.date));
}

function holidayName(date) {
  const y = Number(String(date).slice(0, 4));
  const hit = list(y).find((x) => x.date === date);
  return hit ? hit.name : null;
}
const isWeekend = (date) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const isBusinessDay = (date) => !isWeekend(date) && !holidayName(date);

module.exports = { easter, national, list, holidayName, isBusinessDay, isWeekend, setExtras, getExtras };

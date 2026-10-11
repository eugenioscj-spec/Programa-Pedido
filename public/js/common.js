/* Utilitários compartilhados entre o portal do cliente e o painel. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const money = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const centsToInput = (cents) => (Number(cents || 0) / 100).toFixed(2).replace('.', ',');

function fmtDate(sqlDate, withTime = true) {
  if (!sqlDate) return '';
  // datas do banco estão em UTC ("YYYY-MM-DD HH:MM:SS")
  const d = sqlDate.length > 10 ? new Date(sqlDate.replace(' ', 'T') + 'Z') : new Date(sqlDate + 'T12:00:00');
  return withTime
    ? d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR');
}

function fmtCnpj(c) {
  const d = String(c || '').replace(/\D/g, '');
  return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : c;
}

function maskCnpj(input) {
  input.addEventListener('input', () => {
    const d = input.value.replace(/\D/g, '').slice(0, 14);
    let v = d;
    if (d.length > 12) v = d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})$/, '$1.$2.$3/$4-$5');
    else if (d.length > 8) v = d.replace(/^(\d{2})(\d{3})(\d{3})(\d{0,4})$/, '$1.$2.$3/$4');
    else if (d.length > 5) v = d.replace(/^(\d{2})(\d{3})(\d{0,3})$/, '$1.$2.$3');
    else if (d.length > 2) v = d.replace(/^(\d{2})(\d{0,3})$/, '$1.$2');
    input.value = v;
  });
}

// Quantidade em unidades → "3 cx + 5 un"
function boxesLabel(units, perBox) {
  units = Number(units) || 0;
  if (!perBox || perBox <= 1) return `${units} un`;
  const neg = units < 0;
  const abs = Math.abs(units);
  const cx = Math.floor(abs / perBox);
  const un = abs % perBox;
  const parts = [];
  if (cx) parts.push(`${cx} cx`);
  if (un || !cx) parts.push(`${un} un`);
  return (neg ? '-' : '') + parts.join(' + ');
}

const STATUS_LABEL = {
  novo: 'Novo',
  confirmado: 'Confirmado',
  separado: 'Separado',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
  pendente: 'Em análise',
  ativo: 'Ativo',
  bloqueado: 'Bloqueado',
};
const statusTag = (s) => `<span class="tag tag-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;

async function api(url, { method = 'GET', body } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw Object.assign(new Error('Sem conexão com o servidor. Verifique a internet.'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erro ${res.status}`), { status: res.status, data });
  return data;
}

let toastTimer;
function toast(message, type = '') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, type === 'error' ? 5000 : 3000);
}

function openModal(html, { wide = false } = {}) {
  closeModal();
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'modal';
  bg.innerHTML = `<div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) closeModal(); });
  document.body.appendChild(bg);
  $$('[data-close]', bg).forEach((b) => b.addEventListener('click', closeModal));
  const first = $('input:not([type=hidden]), select, textarea', bg);
  if (first) setTimeout(() => first.focus(), 30);
  return bg;
}
function closeModal() {
  const m = $('#modal');
  if (m) m.remove();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

// Envia o formulário tratando erro/sucesso e travando o botão durante a requisição.
async function submitWith(form, fn) {
  const btn = $('button[type=submit]', form);
  if (btn) btn.disabled = true;
  try {
    return await fn(formData(form));
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Bipe curto para o leitor de código de barras (ok/erro).
function beep(ok = true) {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 1200 : 300;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.08 : 0.3));
  } catch { /* sem áudio */ }
}

function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function applyBranding() {
  try {
    const cfg = await api('/api/config');
    $$('[data-store-name]').forEach((el) => { el.textContent = cfg.store_name; });
    $$('[data-store-sub]').forEach((el) => { el.textContent = cfg.store_subtitle; });
    return cfg;
  } catch {
    return {};
  }
}

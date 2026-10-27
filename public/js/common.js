/* Utilitários compartilhados entre o portal do cliente e o painel. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const money = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
// Custo unitário pode ter frações de centavo (ex.: R$ 7,275).
const moneyPrecise = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4,
});
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

// Fuso da loja: America/Cuiaba (UTC−4). Todas as datas da tela usam este fuso.
const TZ = 'America/Cuiaba';
const todayLocal = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
const centsToInput = (cents) => (Number(cents || 0) / 100).toFixed(2).replace('.', ',');

function fmtDate(sqlDate, withTime = true) {
  if (!sqlDate) return '';
  // datas do banco estão em UTC ("YYYY-MM-DD HH:MM:SS")
  const d = sqlDate.length > 10 ? new Date(sqlDate.replace(' ', 'T') + 'Z') : new Date(sqlDate + 'T12:00:00Z');
  return withTime
    ? d.toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR', { timeZone: sqlDate.length > 10 ? TZ : 'UTC' });
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
    if (cfg.test_mode && !$('#test-strip')) {
      const strip = document.createElement('div');
      strip.id = 'test-strip';
      strip.className = 'test-strip';
      strip.textContent = 'Ambiente de teste — pedidos e estoque de exemplo';
      document.body.prepend(strip);
    }
    return cfg;
  } catch {
    return {};
  }
}

// Reduz a foto no navegador (lado maior até `max` px) antes de enviar. Fundo branco para fotos com transparência.
function resizeImage(file, max = 800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      let dataUrl = canvas.toDataURL('image/webp', 0.85);
      if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const [head, data] = dataUrl.split(',');
      resolve({ mime: head.slice(5, head.indexOf(';')), data, preview: dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não consegui abrir esta imagem.')); };
    img.src = url;
  });
}

// ---------------- sugestões de produto enquanto digita ----------------
// Texto sem acento e em minúsculas, para "acai" achar "Açaí".
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Produtos que contêm o termo (nome, categoria, código de barras ou SKU); quem começa com o termo vem primeiro.
function matchProducts(products, term, limit = 12) {
  const t = fold(term).trim();
  if (!t) return [];
  const words = t.split(/\s+/);
  const scored = [];
  for (const p of products) {
    const name = fold(p.name);
    const hay = `${name} ${fold(p.category)} ${p.barcode || ''} ${p.box_barcode || ''} ${fold(p.sku)}`;
    if (!words.every((w) => hay.includes(w))) continue;
    scored.push([name.startsWith(t) ? 0 : name.includes(t) ? 1 : 2, name, p]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, limit).map((s) => s[2]);
}

// Destaca o termo digitado no nome.
function markTerm(text, term) {
  const t = fold(term).trim();
  const i = t ? fold(text).indexOf(t) : -1;
  if (i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + t.length))}</mark>${esc(text.slice(i + t.length))}`;
}

// Menu suspenso com os produtos que contêm o termo, abaixo do campo.
// - products(): lista atual · onPick(p): o que fazer ao escolher · detail(p): texto à direita (estoque, preço…)
// - Setas ↑↓ escolhem, Enter confirma o destacado, Esc fecha. Sem item destacado, o Enter segue o fluxo normal
//   do campo (ex.: leitor de código de barras).
function productSuggest(input, { products, onPick, detail = () => '', clearOnPick = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'suggest-wrap';
  if (input.style.maxWidth) { wrap.style.maxWidth = input.style.maxWidth; input.style.maxWidth = ''; }
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.setAttribute('autocomplete', 'off');
  const menu = document.createElement('div');
  menu.className = 'suggest-menu hidden';
  menu.setAttribute('role', 'listbox');
  wrap.appendChild(menu);
  let items = [];
  let active = -1;

  const close = () => { menu.classList.add('hidden'); items = []; active = -1; };
  const highlight = (i) => {
    active = i;
    $$('.suggest-item', menu).forEach((el, j) => el.classList.toggle('active', j === i));
    const el = menu.children[i];
    if (el) el.scrollIntoView({ block: 'nearest' });
  };
  const pick = (p) => {
    close();
    input.value = clearOnPick ? '' : p.name;
    onPick(p);
  };
  const open = () => {
    const term = input.value;
    items = matchProducts(products() || [], term);
    active = -1;
    if (!fold(term).trim()) return close();
    menu.innerHTML = items.length
      ? items.map((p, i) => `
        <div class="suggest-item" data-i="${i}" role="option">
          ${p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">` : '<span class="suggest-noimg"></span>'}
          <span class="suggest-name">${markTerm(p.name, term)}<small>${esc(p.category || '')}</small></span>
          <span class="suggest-detail">${detail(p) || ''}</span>
        </div>`).join('')
      : '<div class="suggest-empty">Nenhum produto com esse nome.</div>';
    menu.classList.remove('hidden');
    $$('.suggest-item', menu).forEach((el) => {
      // mousedown (e não click) para escolher antes de o campo perder o foco
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(items[Number(el.dataset.i)]); });
      el.addEventListener('mousemove', () => { if (active !== Number(el.dataset.i)) highlight(Number(el.dataset.i)); });
    });
  };

  input.addEventListener('input', open);
  input.addEventListener('focus', () => { if (input.value.trim()) open(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  // captura: roda antes do Enter do próprio campo, que só recebe o Enter quando nada está destacado
  input.addEventListener('keydown', (e) => {
    if (menu.classList.contains('hidden') || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active <= 0 ? items.length - 1 : active - 1); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(items[active]); }
    else if (e.key === 'Enter') close();
  }, true);
  return { close };
}

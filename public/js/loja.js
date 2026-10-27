/* Portal do cliente B2B: cadastro/login, catálogo, carrinho e pedidos. */
'use strict';

const state = {
  config: {},
  customer: null,
  products: [],
  category: 'Todos',
  search: '',
  showSoldOut: false,
  cart: loadCart(),
};
const app = $('#app');

function loadCart() {
  try { return JSON.parse(localStorage.getItem('oggi_cart') || '{}'); } catch { return {}; }
}
function saveCart() {
  try { localStorage.setItem('oggi_cart', JSON.stringify(state.cart)); } catch { /* modo privado */ }
}
const cartKey = (id, type) => `${id}:${type}`;

function productById(id) {
  return state.products.find((p) => p.id === Number(id));
}

// Unidades já no carrinho para um produto (caixa + unidade).
function unitsInCart(p, except) {
  let units = 0;
  for (const type of ['caixa', 'unidade']) {
    if (type === except) continue;
    const q = state.cart[cartKey(p.id, type)] || 0;
    units += type === 'caixa' ? q * p.units_per_box : q;
  }
  return units;
}

function cartLines() {
  const lines = [];
  for (const [key, qty] of Object.entries(state.cart)) {
    const [id, type] = key.split(':');
    const p = productById(id);
    if (!p || qty <= 0) continue;
    const price = type === 'caixa' ? p.box_price_cents : p.unit_price_cents;
    lines.push({ p, type, qty, price, subtotal: price * qty });
  }
  return lines;
}

// O cliente não sabe quanto temos em estoque: a quantidade é conferida na revisão e no envio do pedido.
function setQty(p, type, qty) {
  qty = Math.min(9999, Math.max(0, Math.floor(Number(qty) || 0)));
  const key = cartKey(p.id, type);
  if (qty > 0) state.cart[key] = qty;
  else delete state.cart[key];
  saveCart();
  updateCartBar();
  return qty;
}

function updateCartBar() {
  const lines = cartLines();
  const bar = $('#cart-bar');
  const onCatalog = !!$('#catalog-view');
  if (!lines.length || !onCatalog) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const total = lines.reduce((s, l) => s + l.subtotal, 0);
  $('#cart-total').textContent = money(total);
  $('#cart-count').textContent = `${lines.length} ${lines.length === 1 ? 'item' : 'itens'} no carrinho`;
}

function setNav(view) {
  $$('#nav [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

// ---------------- autenticação ----------------
function renderAuth(mode = 'login') {
  $('#nav').classList.add('hidden');
  $('#cart-bar').classList.add('hidden');
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="card">
        <h1 class="center">Bem-vindo!</h1>
        <p class="center muted">Faça seu pedido de sorvetes para sua empresa — caixa fechada ou unidade.</p>
        <div class="tabs">
          <button data-mode="login" class="${mode === 'login' ? 'active' : ''}">Já sou cliente</button>
          <button data-mode="cadastro" class="${mode === 'cadastro' ? 'active' : ''}">Quero me cadastrar</button>
        </div>
        ${mode === 'login' ? `
          <form id="form-auth">
            <div class="field"><label>CNPJ</label><input name="cnpj" inputmode="numeric" placeholder="00.000.000/0000-00" required autocomplete="username"></div>
            <div class="field"><label>Senha</label><input name="senha" type="password" required autocomplete="current-password"></div>
            <button type="submit" class="btn-block">Entrar</button>
            <p class="small muted center" style="margin-top:12px">Esqueceu a senha? Fale com a loja${state.config.whatsapp ? ` pelo <a href="https://wa.me/${esc(state.config.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}.</p>
          </form>` : `
          <form id="form-auth">
            <div class="field"><label>CNPJ *</label><input name="cnpj" inputmode="numeric" placeholder="00.000.000/0000-00" required></div>
            <div class="field"><label>Razão social *</label><input name="razao_social" required></div>
            <div class="field"><label>Nome fantasia</label><input name="nome_fantasia"></div>
            <div class="form-grid">
              <div class="field"><label>Responsável</label><input name="contato"></div>
              <div class="field"><label>Telefone / WhatsApp *</label><input name="telefone" inputmode="tel" required></div>
            </div>
            <div class="field"><label>E-mail</label><input name="email" type="email"></div>
            <div class="field"><label>Endereço de entrega</label><input name="endereco"></div>
            <div class="field"><label>Cidade</label><input name="cidade"></div>
            <div class="field"><label>Crie uma senha * (mín. 6 caracteres)</label><input name="senha" type="password" minlength="6" required autocomplete="new-password"></div>
            <button type="submit" class="btn-block">Enviar cadastro</button>
          </form>`}
      </div>
    </div>`;
  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.mode)));
  const form = $('#form-auth');
  maskCnpj(form.cnpj);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(form, async (data) => {
      const url = mode === 'login' ? '/api/cliente/login' : '/api/cliente/cadastro';
      const r = await api(url, { method: 'POST', body: data });
      state.customer = r.customer;
      route();
    });
  });
}

function renderPending() {
  $('#nav').classList.remove('hidden');
  $$('#nav [data-view]').forEach((b) => b.classList.add('hidden'));
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="card center">
        <h1>${state.customer.status === 'bloqueado' ? 'Acesso bloqueado' : 'Cadastro recebido! 🎉'}</h1>
        <p>${state.customer.status === 'bloqueado'
          ? 'Seu acesso está bloqueado no momento. Fale com a loja para mais informações.'
          : `Olá, <strong>${esc(state.customer.nome_fantasia || state.customer.razao_social)}</strong>. Seu cadastro está em análise pela loja. Assim que for liberado você já poderá fazer pedidos por aqui.`}</p>
        ${state.config.whatsapp ? `<a class="btn" href="https://wa.me/${esc(state.config.whatsapp)}?text=${encodeURIComponent(`Olá! Fiz meu cadastro no portal de pedidos. CNPJ ${fmtCnpj(state.customer.cnpj)}`)}" target="_blank" rel="noopener">Avisar a loja no WhatsApp</a>` : ''}
        <p><button class="btn-link" id="btn-recheck">Já fui liberado — atualizar</button></p>
      </div>
    </div>`;
  $('#btn-recheck').addEventListener('click', boot);
}

// ---------------- catálogo ----------------
async function renderCatalog() {
  setNav('catalogo');
  app.innerHTML = '<div class="empty">Carregando produtos…</div>';
  try {
    state.products = (await api('/api/catalogo')).products;
  } catch (e) {
    if (e.status === 401 || e.status === 403) return boot();
    app.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
    return;
  }
  // remove do carrinho o que não existe mais
  for (const key of Object.keys(state.cart)) if (!productById(key.split(':')[0])) delete state.cart[key];
  saveCart();

  const categories = ['Todos', ...new Set(state.products.map((p) => p.category))];
  app.innerHTML = `
    <div id="catalog-view">
      <div class="section-head">
        <h1>Catálogo</h1>
        <span class="spacer"></span>
        <input id="search" type="search" placeholder="Buscar produto…" style="max-width:280px" value="${esc(state.search)}">
      </div>
      ${state.config.order_notice ? `<div class="alert alert-info small">${esc(state.config.order_notice)}</div>` : ''}
      <div class="chips">${categories.map((c) => `<button class="chip ${c === state.category ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="products" id="product-list"></div>
      <p class="center" id="soldout-wrap"></p>
    </div>`;
  $$('.chip').forEach((b) => b.addEventListener('click', () => {
    state.category = b.dataset.cat;
    $$('.chip').forEach((x) => x.classList.toggle('active', x === b));
    renderProductList();
  }));
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderProductList(); });
  productSuggest($('#search'), {
    products: () => state.products,
    detail: (p) => (p.in_stock ? money(p.unit_price_cents) : 'Esgotado'),
    onPick: (p) => {
      state.search = p.name;
      state.category = 'Todos';
      if (!p.in_stock) state.showSoldOut = true;
      $$('.chip').forEach((x) => x.classList.toggle('active', x.dataset.cat === 'Todos'));
      renderProductList();
    },
  });
  renderProductList();
  updateCartBar();
}

function stockLabel(p) {
  return p.in_stock ? '<span class="tag tag-ok">Disponível</span>' : '<span class="tag tag-out">Esgotado</span>';
}

function buyLine(p, type) {
  const qty = state.cart[cartKey(p.id, type)] || 0;
  const isBox = type === 'caixa';
  const price = isBox ? p.box_price_cents : p.unit_price_cents;
  const sub = isBox
    ? `Caixa c/ ${p.units_per_box} un · ${money(p.box_price_cents / p.units_per_box)}/un`
    : 'Unidade avulsa';
  return `
    <div class="buy-line">
      <div><div class="price">${money(price)}</div><div class="unit-label">${esc(sub)}</div></div>
      <div class="stepper" data-id="${p.id}" data-type="${type}">
        <button type="button" data-step="-1" aria-label="Diminuir">−</button>
        <input type="number" min="0" inputmode="numeric" value="${qty}" aria-label="Quantidade">
        <button type="button" data-step="1" aria-label="Aumentar">+</button>
      </div>
    </div>`;
}

function renderProductList() {
  const term = state.search.trim().toLowerCase();
  const matching = state.products.filter((p) =>
    (state.category === 'Todos' || p.category === state.category)
    && (!term || p.name.toLowerCase().includes(term) || (p.barcode || '').includes(term)));
  // esgotados ficam escondidos (e por último) até o cliente pedir para ver
  const soldOut = matching.filter((p) => !p.in_stock);
  const list = matching.filter((p) => p.in_stock).concat(state.showSoldOut ? soldOut : []);
  const wrap = $('#soldout-wrap');
  wrap.innerHTML = soldOut.length
    ? `<button class="btn-secondary btn-sm" id="btn-soldout">${state.showSoldOut ? 'Esconder' : 'Mostrar'} esgotados (${soldOut.length})</button>` : '';
  if (soldOut.length) $('#btn-soldout').addEventListener('click', () => { state.showSoldOut = !state.showSoldOut; renderProductList(); });
  const el = $('#product-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${matching.length ? 'Nenhum produto disponível agora nesta categoria.' : 'Nenhum produto encontrado.'}</div>`;
    return;
  }
  el.innerHTML = list.map((p) => `
    <div class="product">
      ${p.image_url ? `<img class="p-img" src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy">` : '<div class="p-img-empty" aria-hidden="true"></div>'}
      <div class="p-cat">${esc(p.category)}</div>
      <div class="p-name">${esc(p.name)}</div>
      ${p.description ? `<div class="small muted">${esc(p.description)}</div>` : ''}
      <div class="p-stock">${stockLabel(p)}</div>
      ${p.in_stock ? `${p.sell_box ? buyLine(p, 'caixa') : ''}${p.sell_unit ? buyLine(p, 'unidade') : ''}` : ''}
    </div>`).join('');
  $$('.stepper', el).forEach((st) => {
    const p = productById(st.dataset.id);
    const type = st.dataset.type;
    const input = $('input', st);
    $$('button', st).forEach((b) => b.addEventListener('click', () => {
      input.value = setQty(p, type, Number(input.value) + Number(b.dataset.step));
    }));
    input.addEventListener('change', () => { input.value = setQty(p, type, input.value); });
  });
}

// ---------------- checkout ----------------
// Pergunta ao servidor quais itens não temos na quantidade pedida (a resposta não traz quantidades).
async function cartUnavailable(lines) {
  try {
    const items = lines.map((l) => ({ product_id: l.p.id, unit_type: l.type, quantity: l.qty }));
    return new Set((await api('/api/pedidos/verificar', { method: 'POST', body: { items } })).unavailable);
  } catch {
    return new Set();
  }
}

function renderCheckout(unavailable = null) {
  const lines = cartLines();
  if (!lines.length) return renderCatalog();
  $('#cart-bar').classList.add('hidden');
  const total = lines.reduce((s, l) => s + l.subtotal, 0);
  const min = state.config.min_order_cents || 0;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const short = unavailable || new Set();
  const blocked = (min && total < min) || short.size > 0;
  // preserva o que o cliente já digitou ao redesenhar a tela
  const prev = $('#form-checkout') ? formData($('#form-checkout')) : {};
  if (!unavailable) window.scrollTo(0, 0);
  app.innerHTML = `
    <div class="section-head">
      <button class="btn-secondary" id="btn-back">← Continuar comprando</button>
      <h1>Revisar pedido</h1>
    </div>
    ${short.size ? `<div class="alert alert-error">Não temos no momento a quantidade pedida dos itens marcados em vermelho.
      Diminua a quantidade ou remova o item para enviar o pedido.</div>` : ''}
    <div class="grid grid-2" style="align-items:start">
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Produto</th><th class="num">Qtd</th><th class="num hide-sm">Preço</th><th class="num">Subtotal</th><th></th></tr></thead>
            <tbody>
              ${lines.map((l) => `
                <tr class="${short.has(l.p.id) ? 'row-danger' : ''}">
                  <td>${esc(l.p.name)}<div class="small ${short.has(l.p.id) ? '' : 'muted'}">${l.type === 'caixa' ? `Caixa (${l.p.units_per_box} un)` : 'Unidade'}${short.has(l.p.id) ? ' · quantidade indisponível' : ''}</div></td>
                  <td class="num"><input type="number" min="0" inputmode="numeric" value="${l.qty}" data-qty="${cartKey(l.p.id, l.type)}" class="qty-input" aria-label="Quantidade"></td>
                  <td class="num nowrap hide-sm">${money(l.price)}</td>
                  <td class="num nowrap">${money(l.subtotal)}</td>
                  <td><button class="btn-danger btn-sm" data-remove="${cartKey(l.p.id, l.type)}" title="Remover">✕</button></td>
                </tr>`).join('')}
            </tbody>
            <tfoot><tr><th colspan="2">Total</th><th class="hide-sm"></th><th class="num nowrap" style="font-size:1.1rem">${money(total)}</th><th></th></tr></tfoot>
          </table>
        </div>
      </div>
      <form class="card" id="form-checkout">
        <h2>Finalizar</h2>
        <p class="small muted">Pedido de <strong>${esc(state.customer.nome_fantasia || state.customer.razao_social)}</strong> · CNPJ ${esc(fmtCnpj(state.customer.cnpj))}</p>
        ${min && total < min ? `<div class="alert alert-warn">Pedido mínimo: <strong>${money(min)}</strong>. Faltam ${money(min - total)}.</div>` : ''}
        <div class="field"><label>Data desejada de entrega/retirada</label><input type="date" name="delivery_date" min="${tomorrow}" value="${esc(prev.delivery_date || '')}"></div>
        <div class="field"><label>Observações</label><textarea name="notes" placeholder="Ex.: entregar pela manhã, retirar na loja…">${esc(prev.notes || '')}</textarea></div>
        <button type="submit" class="btn-block btn-ok" ${blocked ? 'disabled' : ''}>Enviar pedido · ${money(total)}</button>
      </form>
    </div>`;
  $('#btn-back').addEventListener('click', renderCatalog);
  $$('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    delete state.cart[b.dataset.remove];
    saveCart();
    refreshCheckout();
  }));
  $$('[data-qty]').forEach((inp) => inp.addEventListener('change', () => {
    const [id, type] = inp.dataset.qty.split(':');
    setQty(productById(id), type, inp.value);
    refreshCheckout();
  }));
  const form = $('#form-checkout');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(form, async (data) => {
      const items = lines.map((l) => ({ product_id: l.p.id, unit_type: l.type, quantity: l.qty }));
      try {
        const r = await api('/api/pedidos', { method: 'POST', body: { ...data, items } });
        state.cart = {};
        saveCart();
        renderSuccess(r.order);
      } catch (err) {
        if (err.status === 409 && err.data && err.data.unavailable) {
          // estoque mudou desde a revisão: marca os itens e recarrega o catálogo
          state.products = (await api('/api/catalogo')).products;
          renderCheckout(new Set(err.data.unavailable));
        }
        throw err;
      }
    });
  });
  if (!unavailable) refreshCheckout();
}

async function refreshCheckout() {
  const lines = cartLines();
  if (!lines.length) return renderCatalog();
  renderCheckout(await cartUnavailable(lines));
}

function renderSuccess(order) {
  const wa = state.config.whatsapp;
  window.scrollTo(0, 0);
  const msg = `Olá! Acabei de enviar o pedido #${order.id} pelo portal (${order.nome_fantasia || order.razao_social}) no valor de ${money(order.total_cents)}.`;
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="card center">
        <div style="font-size:3rem">✅</div>
        <h1>Pedido #${order.id} enviado!</h1>
        <p>Total: <strong>${money(order.total_cents)}</strong></p>
        <p class="muted">A loja vai conferir e confirmar seu pedido. Você acompanha o andamento em “Meus pedidos”.</p>
        <div class="row" style="justify-content:center">
          ${wa ? `<a class="btn btn-ok" target="_blank" rel="noopener" href="https://wa.me/${esc(wa)}?text=${encodeURIComponent(msg)}">Avisar no WhatsApp</a>` : ''}
          <button class="btn-secondary" data-go="pedidos">Ver meus pedidos</button>
        </div>
      </div>
    </div>`;
  $('[data-go]').addEventListener('click', renderOrders);
}

// ---------------- meus pedidos ----------------
async function renderOrders() {
  setNav('pedidos');
  $('#cart-bar').classList.add('hidden');
  app.innerHTML = '<div class="empty">Carregando…</div>';
  let orders;
  try {
    orders = (await api('/api/pedidos')).orders;
  } catch (e) {
    if (e.status === 401 || e.status === 403) return boot();
    app.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
    return;
  }
  app.innerHTML = `
    <div class="section-head"><h1>Meus pedidos</h1></div>
    ${orders.length ? orders.map((o) => `
      <div class="card order-card">
        <div class="order-head">
          <strong>Pedido #${o.id}</strong> ${statusTag(o.status)}
          <span class="spacer"></span>
          <span class="muted small">${fmtDate(o.created_at)}</span>
          <strong>${money(o.total_cents)}</strong>
        </div>
        <ul class="small">
          ${o.items.map((i) => `<li>${i.quantity} ${i.unit_type === 'caixa' ? (i.quantity > 1 ? 'caixas' : 'caixa') : 'un'} · ${esc(i.product_name)} — ${money(i.subtotal_cents)}</li>`).join('')}
        </ul>
        ${o.delivery_date ? `<div class="small muted" style="margin-top:6px">Entrega desejada: ${fmtDate(o.delivery_date, false)}</div>` : ''}
        <div class="row" style="margin-top:10px">
          <button class="btn-secondary btn-sm" data-repeat="${o.id}">Repetir pedido</button>
          ${o.status === 'novo' ? `<button class="btn-danger btn-sm" data-cancel="${o.id}">Cancelar</button>` : ''}
        </div>
      </div>`).join('') : '<div class="card empty">Você ainda não fez pedidos.</div>'}`;

  $$('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Cancelar o pedido #${b.dataset.cancel}?`)) return;
    try {
      await api(`/api/pedidos/${b.dataset.cancel}/cancelar`, { method: 'POST' });
      toast('Pedido cancelado.', 'ok');
      renderOrders();
    } catch (e) { toast(e.message, 'error'); }
  }));
  $$('[data-repeat]').forEach((b) => b.addEventListener('click', () => {
    const o = orders.find((x) => x.id === Number(b.dataset.repeat));
    for (const i of o.items) {
      const key = cartKey(i.product_id, i.unit_type);
      state.cart[key] = (state.cart[key] || 0) + i.quantity;
    }
    saveCart();
    toast('Itens adicionados ao carrinho. Confira a disponibilidade.', 'ok');
    renderCatalog().then(() => {
      // ajusta ao estoque disponível
      for (const key of Object.keys(state.cart)) {
        const [id, type] = key.split(':');
        const p = productById(id);
        if (p) setQty(p, type, state.cart[key]);
      }
      renderProductList();
    });
  }));
}

// ---------------- inicialização ----------------
function route() {
  if (!state.customer) return renderAuth();
  if (state.customer.status !== 'ativo') return renderPending();
  $('#nav').classList.remove('hidden');
  $$('#nav [data-view]').forEach((b) => b.classList.remove('hidden'));
  return renderCatalog();
}

async function boot() {
  state.config = await applyBranding();
  try {
    state.customer = (await api('/api/cliente/me')).customer;
  } catch {
    state.customer = null;
  }
  route();
}

$$('#nav [data-view]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view === 'pedidos') renderOrders();
  else renderCatalog();
}));
$('#btn-logout').addEventListener('click', async () => {
  await api('/api/cliente/logout', { method: 'POST' }).catch(() => {});
  state.customer = null;
  route();
});
$('#btn-checkout').addEventListener('click', () => renderCheckout());

boot();

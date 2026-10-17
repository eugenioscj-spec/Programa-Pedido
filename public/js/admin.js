/* Painel da loja: pedidos, estoque (leitor de código de barras, custo médio), relatórios, produtos e clientes. */
'use strict';

const app = $('#app');
const A = {
  admin: null,
  products: [],
  options: null,
  view: 'painel',
};

const MOV_LABEL = {
  entrada: 'Entrada',
  saida_pedido: 'Venda B2B',
  transferencia: 'Transferência p/ loja',
  perda: 'Perda',
  saida_sem_venda: 'Saída sem venda',
  sobra_inventario: 'Sobra de inventário',
  divergencia_inventario: 'Divergência de inventário',
  abertura_custo: 'Custo inicial',
  estorno: 'Estorno',
};

async function loadProducts() {
  A.products = (await api('/api/admin/produtos')).products;
  return A.products;
}
const productById = (id) => A.products.find((p) => p.id === Number(id));
async function loadOptions() {
  A.options = await api('/api/admin/estoque/opcoes');
  return A.options;
}

// Custo médio por unidade (centavos, com frações) ou null quando o produto não tem custo.
const avgCost = (p) => (p.has_cost && p.stock_units > 0 ? p.stock_value_cents / p.stock_units : null);

// "12,50" / "1.234,56" / "12.5" → centavos (NaN se inválido, null se vazio)
function parseMoney(value) {
  let s = String(value ?? '').trim().replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
}

function stockTag(p) {
  if (p.available_units <= 0) return '<span class="tag tag-out">Sem estoque</span>';
  if (p.available_units <= p.min_stock) return '<span class="tag tag-low">Baixo</span>';
  return '<span class="tag tag-ok">OK</span>';
}

const thumb = (p) => (p.image_url
  ? `<img class="thumb" src="${esc(p.image_url)}" alt="" loading="lazy">`
  : '<span class="thumb thumb-empty" aria-hidden="true"></span>');

async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.status === 401) return renderLogin();
    toast(e.message, 'error');
    return undefined;
  }
}

function setView(view) {
  A.view = view;
  $$('#nav [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  closeModal();
  const views = {
    painel: renderDashboard,
    pedidos: renderOrders,
    movimentar: () => renderScanner(),
    estoque: renderStock,
    movimentos: renderMovements,
    relatorios: renderReports,
    produtos: renderProducts,
    clientes: renderCustomers,
    config: renderConfig,
  };
  try { history.replaceState(null, '', `#${view}`); } catch { /* ignore */ }
  window.scrollTo(0, 0);
  guard(views[view] || renderDashboard);
}

async function refreshBadges() {
  try {
    const d = await api('/api/admin/dashboard');
    const novos = d.counts.novo || 0;
    const b1 = $('#badge-novos');
    b1.textContent = novos;
    b1.classList.toggle('hidden', !novos);
    const b2 = $('#badge-clientes');
    b2.textContent = d.pendingCustomers;
    b2.classList.toggle('hidden', !d.pendingCustomers);
    return d;
  } catch { return null; }
}

// ======================= LOGIN / SETUP =======================
async function renderLogin() {
  $('#nav').classList.add('hidden');
  const { needs_setup: setup } = await api('/api/admin/setup');
  app.innerHTML = `
    <div class="auth-wrap">
      <form class="card" id="form-login">
        <h1>${setup ? 'Primeiro acesso' : 'Entrar no painel'}</h1>
        ${setup ? '<p class="muted">Crie o usuário administrador da loja.</p><div class="field"><label>Seu nome</label><input name="name" required></div>' : ''}
        <div class="field"><label>E-mail</label><input name="email" type="email" required autocomplete="username"></div>
        <div class="field"><label>Senha${setup ? ' (mín. 8 caracteres)' : ''}</label><input name="senha" type="password" required ${setup ? 'minlength="8" autocomplete="new-password"' : 'autocomplete="current-password"'}></div>
        <button type="submit" class="btn-block">${setup ? 'Criar e entrar' : 'Entrar'}</button>
      </form>
    </div>`;
  const form = $('#form-login');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(form, async (data) => {
      await api(setup ? '/api/admin/setup' : '/api/admin/login', { method: 'POST', body: data });
      boot();
    });
  });
}

// ======================= PAINEL =======================
async function renderDashboard() {
  const d = await refreshBadges();
  if (!d) throw Object.assign(new Error('Faça login'), { status: 401 });
  const c = d.counts;
  const m = d.month;
  app.innerHTML = `
    ${d.storage_ok ? '' : `<div class="alert alert-error"><strong>Atenção: os dados NÃO estão sendo salvos de forma permanente.</strong>
      Falta conectar um <strong>Volume</strong> (disco) ao serviço no Railway. Sem ele, tudo o que for cadastrado some na próxima atualização.
      Veja o passo “Criar o disco” no guia de instalação.</div>`}
    ${d.uncosted ? `<div class="alert alert-warn row"><span class="grow"><strong>${d.uncosted} produto(s) com estoque e sem custo cadastrado.</strong>
      Os valores em R$ deixam esses produtos à parte até você informar o custo.</span>
      <button class="btn-sm" id="btn-go-cost">Informar custo inicial</button></div>` : ''}
    <div class="section-head"><h1>Olá, ${esc(A.admin.name.split(' ')[0])}!</h1><span class="spacer"></span>
      <button data-go="movimentar">+ Entrada de mercadoria</button></div>
    <div class="grid grid-4">
      <div class="card stat clickable" data-go="pedidos"><div class="label">Pedidos novos</div><div class="value" style="color:var(--info)">${c.novo || 0}</div></div>
      <div class="card stat clickable" data-go="pedidos"><div class="label">A separar (confirmados)</div><div class="value" style="color:var(--accent)">${c.confirmado || 0}</div></div>
      <div class="card stat clickable" data-go="pedidos"><div class="label">Separados p/ entrega</div><div class="value" style="color:var(--warn)">${c.separado || 0}</div></div>
      <div class="card stat"><div class="label">Movimento hoje</div><div class="value"><span class="qty-pos">+${d.today.entradas}</span> / <span class="qty-neg">${d.today.saidas ? `-${d.today.saidas}` : 0}</span></div><div class="small muted">unidades entrada / saída</div></div>
      <div class="card stat clickable" data-report="vendas"><div class="label">Vendas B2B no mês</div><div class="value">${money(m.revenue)}</div>
        <div class="small muted">Margem: ${m.margin === null ? '—' : `${money(m.margin)} (${pct(m.margin_pct)})`}</div></div>
      <div class="card stat clickable" data-report="posicao"><div class="label">Estoque a custo</div><div class="value">${money(d.stock.cost)}</div>
        <div class="small muted">${d.stock.units.toLocaleString('pt-BR')} un · a preço B2B: ${money(d.stock.b2b)}</div></div>
      <div class="card stat clickable" data-report="perdas"><div class="label">Perdas no mês</div><div class="value" style="color:var(--danger)">${m.losses_value === null ? '—' : money(m.losses_value)}</div>
        <div class="small muted">${m.losses_units} un (perdas + divergências)</div></div>
      ${d.pendingCustomers ? `<div class="card stat clickable" data-go="clientes"><div class="label">Cadastros p/ aprovar</div><div class="value" style="color:var(--warn)">${d.pendingCustomers}</div></div>` : ''}
    </div>
    <div class="card" style="margin-top:16px">
      <div class="section-head"><h2>Estoque baixo / zerado</h2><span class="spacer"></span><button class="btn-secondary btn-sm" data-go="estoque">Ver estoque completo</button></div>
      ${d.lowStock.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>Produto</th><th class="num">Disponível</th><th class="num hide-sm">Mínimo</th><th></th></tr></thead>
          <tbody>${d.lowStock.map((p) => `
            <tr><td>${esc(p.name)}<div class="small muted">${esc(p.category)}</div></td>
              <td class="num nowrap">${boxesLabel(p.available_units, p.units_per_box)}</td>
              <td class="num nowrap hide-sm">${boxesLabel(p.min_stock, p.units_per_box)}</td>
              <td>${stockTag(p)}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">Tudo certo — nenhum produto abaixo do mínimo.</p>'}
    </div>`;
  $$('[data-go]').forEach((el) => el.addEventListener('click', () => setView(el.dataset.go)));
  $$('[data-report]').forEach((el) => el.addEventListener('click', () => { R.tipo = el.dataset.report; setView('relatorios'); }));
  const goCost = $('#btn-go-cost');
  if (goCost) goCost.addEventListener('click', () => guard(openOpeningCost));
}

// ======================= PEDIDOS =======================
let orderFilter = '';
async function renderOrders() {
  const { orders } = await api(`/api/admin/pedidos${orderFilter ? `?status=${orderFilter}` : ''}`);
  refreshBadges();
  const filters = [['', 'Todos'], ['novo', 'Novos'], ['confirmado', 'Confirmados'], ['separado', 'Separados'], ['entregue', 'Entregues'], ['cancelado', 'Cancelados']];
  app.innerHTML = `
    <div class="section-head"><h1>Pedidos</h1><span class="spacer"></span><button class="btn-secondary btn-sm" id="btn-reload">Atualizar</button></div>
    <div class="chips">${filters.map(([v, l]) => `<button class="chip ${v === orderFilter ? 'active' : ''}" data-f="${v}">${l}</button>`).join('')}</div>
    <div class="card" style="padding:0">
      ${orders.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Cliente</th><th class="hide-sm">Data</th><th class="hide-sm">Entrega</th><th class="num">Itens</th><th class="num">Total</th><th>Situação</th></tr></thead>
        <tbody>${orders.map((o) => `
          <tr class="clickable" data-id="${o.id}">
            <td><strong>${o.id}</strong></td>
            <td>${esc(o.nome_fantasia || o.razao_social)}<div class="small muted">${esc(fmtCnpj(o.cnpj))}</div></td>
            <td class="hide-sm nowrap">${fmtDate(o.created_at)}</td>
            <td class="hide-sm nowrap">${o.delivery_date ? fmtDate(o.delivery_date, false) : '—'}</td>
            <td class="num">${o.item_count}</td>
            <td class="num nowrap">${money(o.total_cents)}</td>
            <td>${statusTag(o.status)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nenhum pedido aqui.</div>'}
    </div>`;
  $$('[data-f]').forEach((b) => b.addEventListener('click', () => { orderFilter = b.dataset.f; guard(renderOrders); }));
  $('#btn-reload').addEventListener('click', () => guard(renderOrders));
  $$('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => guard(() => openOrder(Number(tr.dataset.id)))));
}

function itemQtyLabel(i) {
  return i.unit_type === 'caixa' ? `${i.quantity} cx (${i.units_total} un)` : `${i.quantity} un`;
}

async function openOrder(id) {
  const { order: o } = await api(`/api/admin/pedidos/${id}`);
  const editable = ['novo', 'confirmado'].includes(o.status);
  const phone = String(o.telefone || '').replace(/\D/g, '');
  const waPhone = phone ? (phone.length <= 11 ? `55${phone}` : phone) : '';
  const waMsg = `Olá! Aqui é da ${$('[data-store-name]').textContent}. Sobre seu pedido #${o.id}: `;
  const m = openModal(`
    <div class="modal-head"><h2>Pedido #${o.id}</h2>${statusTag(o.status)}<button class="modal-close" data-close>×</button></div>
    <div class="grid grid-2" style="gap:6px 16px">
      <div><strong>${esc(o.razao_social)}</strong>${o.nome_fantasia ? `<div>${esc(o.nome_fantasia)}</div>` : ''}<div class="small muted">CNPJ ${esc(fmtCnpj(o.cnpj))}</div></div>
      <div class="small">
        ${o.contato ? `${esc(o.contato)} · ` : ''}${esc(o.telefone || '')}
        ${o.endereco ? `<div>${esc(o.endereco)}${o.cidade ? ` — ${esc(o.cidade)}` : ''}</div>` : ''}
        <div class="muted">Feito em ${fmtDate(o.created_at)}${o.delivery_date ? ` · Entrega desejada: <strong>${fmtDate(o.delivery_date, false)}</strong>` : ''}</div>
      </div>
    </div>
    ${o.notes ? `<div class="alert alert-info small" style="margin-top:12px"><strong>Obs. do cliente:</strong> ${esc(o.notes)}</div>` : ''}
    <div class="table-wrap" style="margin-top:12px"><table>
      <thead><tr><th>Produto</th><th class="num">Qtd</th><th class="num hide-sm">Estoque físico</th><th class="num">Preço</th><th class="num">Subtotal</th></tr></thead>
      <tbody>${o.items.map((i) => `
        <tr>
          <td>${esc(i.product_name)}<div class="small muted mono">${esc(i.unit_type === 'caixa' ? (i.box_barcode || i.barcode || '') : (i.barcode || ''))}</div></td>
          <td class="num nowrap">${editable
            ? `<input type="number" min="0" value="${i.quantity}" data-item="${i.id}" style="width:72px;text-align:right"> ${i.unit_type === 'caixa' ? 'cx' : 'un'}`
            : itemQtyLabel(i)}</td>
          <td class="num nowrap hide-sm">${i.stock_units} un</td>
          <td class="num nowrap">${money(i.price_cents)}</td>
          <td class="num nowrap">${money(i.subtotal_cents)}</td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><th colspan="3" class="hide-sm"></th><th>Total</th><th class="num nowrap">${money(o.total_cents)}</th></tr></tfoot>
    </table></div>
    ${editable ? '<div class="row" style="margin-top:8px"><button class="btn-secondary btn-sm" id="btn-save-items">Salvar quantidades</button><span class="small muted">Use para atender parcialmente (0 remove o item).</span></div>' : ''}
    <div class="field" style="margin-top:12px"><label>Observação interna</label><textarea id="admin-notes" placeholder="Visível só para a loja">${esc(o.admin_notes || '')}</textarea></div>
    <div class="row no-print" style="margin-top:6px">
      ${o.status === 'novo' ? '<button data-status="confirmado">✔ Confirmar pedido</button>' : ''}
      ${editable ? '<button class="btn-ok" id="btn-pick">📦 Separar (conferir e dar baixa)</button>' : ''}
      ${o.status === 'separado' ? '<button class="btn-ok" data-status="entregue">🚚 Marcar como entregue</button>' : ''}
      <button class="btn-secondary" id="btn-print">🖨 Imprimir</button>
      ${waPhone ? `<a class="btn btn-secondary" target="_blank" rel="noopener" href="https://wa.me/${waPhone}?text=${encodeURIComponent(waMsg)}">WhatsApp do cliente</a>` : ''}
      <span style="flex:1"></span>
      ${['novo', 'confirmado', 'separado'].includes(o.status) ? '<button class="btn-danger" data-status="cancelado">Cancelar pedido</button>' : ''}
    </div>
    ${o.status === 'separado' ? '<p class="small muted">A baixa no estoque já foi feita. Se cancelar, os produtos voltam para o estoque (estorno).</p>' : ''}
  `, { wide: true });

  const notes = () => $('#admin-notes', m).value;
  $$('[data-status]', m).forEach((b) => b.addEventListener('click', () => guard(async () => {
    const s = b.dataset.status;
    if (s === 'cancelado' && !confirm(`Cancelar o pedido #${o.id}?${o.stock_deducted ? ' Os itens voltarão ao estoque.' : ''}`)) return;
    await api(`/api/admin/pedidos/${o.id}/status`, { method: 'POST', body: { status: s, admin_notes: notes() } });
    toast(`Pedido #${o.id}: ${STATUS_LABEL[s]}.`, 'ok');
    closeModal();
    renderOrders();
  })));
  const save = $('#btn-save-items', m);
  if (save) save.addEventListener('click', () => guard(async () => {
    const changes = $$('[data-item]', m).map((inp) => ({ item_id: Number(inp.dataset.item), quantity: Number(inp.value) }));
    await api(`/api/admin/pedidos/${o.id}/itens`, { method: 'PUT', body: { changes } });
    toast('Quantidades atualizadas.', 'ok');
    openOrder(o.id);
  }));
  const pick = $('#btn-pick', m);
  if (pick) pick.addEventListener('click', () => openPicking(o, notes()));
  $('#btn-print', m).addEventListener('click', () => printOrder(o));
}

function printOrder(o) {
  const w = window.open('', '_blank');
  if (!w) return toast('Permita pop-ups para imprimir.', 'error');
  const rows = o.items.map((i) => `<tr><td>☐</td><td>${esc(i.product_name)}</td><td>${esc(i.unit_type === 'caixa' ? (i.box_barcode || i.barcode || '') : (i.barcode || ''))}</td><td style="text-align:right">${itemQtyLabel(i)}</td><td style="text-align:right">${money(i.subtotal_cents)}</td></tr>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Pedido ${o.id}</title>
    <style>body{font-family:system-ui,Arial,sans-serif;padding:20px;color:#000}table{width:100%;border-collapse:collapse;margin-top:12px}td,th{border-bottom:1px solid #999;padding:6px;text-align:left;font-size:14px}h1{margin:0 0 4px}</style></head>
    <body><h1>Pedido #${o.id} — ${esc(STATUS_LABEL[o.status])}</h1>
    <div><strong>${esc(o.razao_social)}</strong>${o.nome_fantasia ? ` (${esc(o.nome_fantasia)})` : ''} · CNPJ ${esc(fmtCnpj(o.cnpj))}</div>
    <div>${esc(o.contato || '')} ${esc(o.telefone || '')} · ${esc(o.endereco || '')} ${esc(o.cidade || '')}</div>
    <div>Pedido em ${fmtDate(o.created_at)}${o.delivery_date ? ` · Entrega: ${fmtDate(o.delivery_date, false)}` : ''}</div>
    ${o.notes ? `<p><strong>Obs.:</strong> ${esc(o.notes)}</p>` : ''}
    <table><thead><tr><th></th><th>Produto</th><th>Código</th><th style="text-align:right">Qtd</th><th style="text-align:right">Subtotal</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><th colspan="4" style="text-align:right">Total</th><th style="text-align:right">${money(o.total_cents)}</th></tr></tfoot></table>
    <p style="margin-top:40px">Separado por: ____________________ &nbsp; Recebido por: ____________________</p>
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}

// Conferência da separação com leitor de código de barras.
function openPicking(o, adminNotes) {
  const lines = new Map(); // product_id -> { name, need, got, upb, barcode, box_barcode }
  for (const i of o.items) {
    const l = lines.get(i.product_id) || { name: i.product_name, need: 0, got: 0, upb: i.units_per_box, barcode: i.barcode, box_barcode: i.box_barcode };
    l.need += i.units_total;
    lines.set(i.product_id, l);
  }
  const m = openModal(`
    <div class="modal-head"><h2>Separação · Pedido #${o.id}</h2><button class="modal-close" data-close>×</button></div>
    <p class="small muted">Bipe os produtos com o leitor (código da caixa conta a caixa inteira). Ou marque manualmente.</p>
    <input class="scan-input" id="pick-scan" placeholder="Bipe o código de barras aqui…" autocomplete="off">
    <div class="progress" style="margin:12px 0"><div id="pick-progress" style="width:0"></div></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Produto</th><th class="num">Pedido</th><th class="num">Conferido</th><th></th></tr></thead>
      <tbody id="pick-body"></tbody>
    </table></div>
    <div class="row" style="margin-top:14px">
      <button class="btn-ok" id="btn-pick-done">Concluir separação e dar baixa no estoque</button>
      <button class="btn-secondary" data-close>Voltar</button>
    </div>`, { wide: true });

  const draw = () => {
    let need = 0;
    let got = 0;
    $('#pick-body', m).innerHTML = [...lines.entries()].map(([pid, l]) => {
      need += l.need;
      got += Math.min(l.got, l.need);
      const cls = l.got === l.need ? 'pick-ok' : l.got > l.need ? 'pick-over' : '';
      return `<tr class="${cls}"><td>${esc(l.name)}<div class="small muted mono">${esc(l.barcode || '')}</div></td>
        <td class="num nowrap">${boxesLabel(l.need, l.upb)}</td>
        <td class="num nowrap"><strong>${boxesLabel(l.got, l.upb)}</strong></td>
        <td class="nowrap"><button class="btn-secondary btn-sm" data-all="${pid}">Tudo</button> <button class="btn-secondary btn-sm" data-zero="${pid}">Zerar</button></td></tr>`;
    }).join('');
    $('#pick-progress', m).style.width = `${need ? Math.round((got / need) * 100) : 0}%`;
    $$('[data-all]', m).forEach((b) => b.addEventListener('click', () => { const l = lines.get(Number(b.dataset.all)); l.got = l.need; draw(); }));
    $$('[data-zero]', m).forEach((b) => b.addEventListener('click', () => { lines.get(Number(b.dataset.zero)).got = 0; draw(); }));
  };
  draw();

  const scan = $('#pick-scan', m);
  scan.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = scan.value.trim();
    scan.value = '';
    if (!code) return;
    for (const l of lines.values()) {
      if (code === l.box_barcode || code === l.barcode) {
        l.got += code === l.box_barcode ? l.upb : 1;
        beep(l.got <= l.need);
        if (l.got > l.need) toast(`Atenção: ${l.name} passou da quantidade do pedido.`, 'error');
        draw();
        return;
      }
    }
    beep(false);
    toast(`Código ${code} não faz parte deste pedido.`, 'error');
  });

  $('#btn-pick-done', m).addEventListener('click', () => guard(async () => {
    const diff = [...lines.values()].filter((l) => l.got !== l.need);
    if (diff.length) {
      const msg = diff.map((l) => `• ${l.name}: pedido ${l.need} un, conferido ${l.got} un`).join('\n');
      if (!confirm(`A conferência não bate com o pedido:\n${msg}\n\nA baixa será feita pelas quantidades DO PEDIDO. Para atender parcialmente, ajuste as quantidades antes. Continuar mesmo assim?`)) return;
    }
    await api(`/api/admin/pedidos/${o.id}/status`, { method: 'POST', body: { status: 'separado', admin_notes: adminNotes } });
    toast(`Pedido #${o.id} separado. Baixa no estoque realizada.`, 'ok');
    closeModal();
    renderOrders();
  }));
}

// ======================= ENTRADA / SAÍDA (LEITOR) =======================
const SCAN_TYPES = {
  entrada: { label: 'Entrada (nota)', help: 'Mercadoria chegando na câmara. Informe o custo de cada item (por caixa ou por unidade).', button: 'Confirmar entrada' },
  transferencia: { label: 'Transferência p/ loja', help: 'Produtos que saem da câmara para uma loja.', button: 'Confirmar transferência' },
  perda: { label: 'Perda', help: 'Produto perdido: escolha o motivo.', button: 'Registrar perda' },
  saida_sem_venda: { label: 'Saída sem venda', help: 'Bonificação a cliente, amostra/degustação, consumo interno…', button: 'Registrar saída' },
  inventario: { label: 'Inventário (contagem)', help: 'Conte o estoque físico: o sistema lança a sobra ou a divergência dos produtos contados.', button: 'Aplicar contagem' },
};

let scanType = 'entrada';
let scanLines = []; // { product_id, units, cost, cost_per, opening_cost, opening_cost_per }

function scanHeaderFields() {
  const o = A.options;
  const note = '<div class="field"><label for="scan-note">Observação</label><input id="scan-note"></div>';
  if (scanType === 'entrada') {
    return `
      <div class="field"><label for="scan-doc">Nº da nota fiscal</label><input id="scan-doc"></div>
      <div class="field"><label for="scan-supplier">Fornecedor</label><input id="scan-supplier" value="${esc(o.default_supplier)}"></div>
      ${note}`;
  }
  if (scanType === 'transferencia') {
    return `
      <div class="field"><label for="scan-location">Loja de destino *</label><select id="scan-location"><option value="">Escolha…</option>
        ${o.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="scan-doc">Referência</label><input id="scan-doc"></div>
      ${note}`;
  }
  if (scanType === 'perda') {
    return `
      <div class="field"><label for="scan-reason">Motivo *</label><select id="scan-reason"><option value="">Escolha…</option>
        ${o.reasons.map((r) => `<option value="${r.id}" data-note="${r.requires_note}">${esc(r.name)}${r.requires_note ? ' (exige observação)' : ''}</option>`).join('')}</select></div>
      ${note}`;
  }
  if (scanType === 'saida_sem_venda') {
    return `
      <div class="field"><label for="scan-subtype">Tipo *</label><select id="scan-subtype"><option value="">Escolha…</option>
        ${o.subtypes.map((s) => `<option value="${s.value}">${esc(s.label)}</option>`).join('')}</select></div>
      <div class="field"><label for="scan-customer">Cliente (opcional)</label><select id="scan-customer"><option value="">—</option>
        ${o.customers.map((c) => `<option value="${c.id}">${esc(c.nome_fantasia || c.razao_social)}</option>`).join('')}</select></div>
      ${note}`;
  }
  return note;
}

async function renderScanner(type = scanType) {
  scanType = type;
  await Promise.all([loadProducts(), loadOptions()]);
  const t = SCAN_TYPES[scanType];
  app.innerHTML = `
    <div class="section-head"><h1>Entrada / Saída de estoque</h1></div>
    <div class="chips">${Object.entries(SCAN_TYPES).map(([k, v]) => `<button class="chip ${k === scanType ? 'active' : ''}" data-t="${k}">${v.label}</button>`).join('')}</div>
    <div class="card">
      <p class="muted" style="margin-top:0">${esc(t.help)}</p>
      <input class="scan-input" id="scan" placeholder="Bipe o código de barras ou digite o nome do produto e Enter" autocomplete="off">
      <div id="scan-picker"></div>
      <div class="table-wrap" style="margin-top:14px"><table>
        <thead id="scan-head"></thead>
        <tbody id="scan-body"></tbody>
        <tfoot id="scan-foot"></tfoot>
      </table></div>
      <div class="form-grid" style="margin-top:14px">${scanHeaderFields()}</div>
      <div id="scan-hint" class="small muted" style="margin-bottom:10px"></div>
      <div class="row">
        <button class="btn-ok" id="btn-scan-confirm">${t.button}</button>
        <button class="btn-secondary" id="btn-scan-clear">Limpar lista</button>
      </div>
    </div>`;
  $$('[data-t]').forEach((b) => b.addEventListener('click', () => guard(() => renderScanner(b.dataset.t))));
  drawScanLines();
  const scan = $('#scan');
  scan.focus();
  scan.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const term = scan.value.trim();
    scan.value = '';
    if (term) guard(() => handleScan(term));
  });
  $('#btn-scan-clear').addEventListener('click', () => { scanLines = []; drawScanLines(); });
  $('#btn-scan-confirm').addEventListener('click', () => guard(confirmScan));
}

function addScanUnits(p, units) {
  let line = scanLines.find((l) => l.product_id === p.id);
  if (!line) {
    line = { product_id: p.id, units: 0, cost: '', cost_per: p.units_per_box > 1 ? 'caixa' : 'unidade', opening_cost: '', opening_cost_per: 'unidade' };
    scanLines.unshift(line);
  }
  line.units += units;
  drawScanLines(p.id);
}

async function handleScan(term) {
  $('#scan-picker').innerHTML = '';
  // 1) código exato (unidade, caixa ou SKU)
  const exact = A.products.find((p) => p.barcode === term || p.box_barcode === term || p.sku === term);
  if (exact) {
    beep(true);
    addScanUnits(exact, exact.box_barcode === term ? exact.units_per_box : 1);
    return;
  }
  // 2) busca por nome
  const lower = term.toLowerCase();
  const matches = A.products.filter((p) => p.name.toLowerCase().includes(lower));
  if (matches.length === 1) {
    addScanUnits(matches[0], 0);
    return;
  }
  if (matches.length > 1) {
    $('#scan-picker').innerHTML = `<div class="chips" style="margin-top:10px">${matches.slice(0, 30).map((p) => `<button class="chip" data-pick="${p.id}">${esc(p.name)}</button>`).join('')}</div>`;
    $$('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      addScanUnits(productById(b.dataset.pick), 0);
      $('#scan-picker').innerHTML = '';
      $('#scan').focus();
    }));
    return;
  }
  // 3) não cadastrado
  beep(false);
  if (/^\d{8,14}$/.test(term) && confirm(`Código ${term} não cadastrado. Deseja cadastrar o produto agora?`)) {
    openProductForm(null, { barcode: term }, async (created) => {
      await loadProducts();
      const p = productById(created.id);
      if (p) addScanUnits(p, scanType === 'inventario' ? 0 : 1);
    });
  } else {
    toast(`Nada encontrado para "${term}".`, 'error');
  }
}

// Valor (centavos) da linha: na entrada, pelo custo digitado; nas saídas, estimado pelo custo médio atual.
function scanLineValue(l) {
  const p = productById(l.product_id);
  if (scanType === 'entrada') {
    const cost = parseMoney(l.cost);
    if (cost === null || Number.isNaN(cost)) return null;
    return l.cost_per === 'caixa' ? Math.round((l.units * cost) / p.units_per_box) : l.units * cost;
  }
  const avg = avgCost(p);
  return avg === null ? null : Math.round(l.units * avg);
}

function drawScanLines(highlightId) {
  const body = $('#scan-body');
  if (!body) return;
  const isIn = scanType === 'entrada';
  const isOut = ['transferencia', 'perda', 'saida_sem_venda'].includes(scanType);
  const isInv = scanType === 'inventario';
  $('#scan-head').innerHTML = `<tr><th>Produto</th>${isInv ? '<th class="num">No sistema</th>' : ''}<th class="num">Caixas</th><th class="num">Unid.</th><th class="num">Total un</th>
    ${isIn ? '<th>Custo</th><th class="num">Valor</th>' : ''}${isOut ? '<th class="num">Valor a custo (estim.)</th>' : ''}<th></th></tr>`;
  const cols = 5 + (isInv ? 1 : 0) + (isIn ? 2 : 0) + (isOut ? 1 : 0);
  if (!scanLines.length) {
    body.innerHTML = `<tr><td colspan="${cols}" class="empty">Nenhum item. Bipe o primeiro produto.</td></tr>`;
    $('#scan-foot').innerHTML = '';
    $('#scan-hint').innerHTML = '';
    return;
  }
  body.innerHTML = scanLines.map((l, idx) => {
    const p = productById(l.product_id);
    const upb = p.units_per_box;
    const cx = Math.floor(l.units / upb);
    const un = l.units - cx * upb;
    const value = scanLineValue(l);
    const needsOpening = isIn && !p.has_cost && p.stock_units > 0;
    return `<tr ${l.product_id === highlightId ? 'style="background:var(--ok-soft)"' : ''}>
      <td>${esc(p.name)}<div class="small muted">${upb > 1 ? `Caixa c/ ${upb} un` : 'Unidade'}${p.barcode ? ` · <span class="mono">${esc(p.barcode)}</span>` : ''}
        ${!isIn ? ` · estoque ${boxesLabel(p.stock_units, upb)}` : ''}</div></td>
      ${isInv ? `<td class="num nowrap">${boxesLabel(p.stock_units, upb)}</td>` : ''}
      <td class="num"><input type="number" min="0" value="${cx}" data-cx="${idx}" class="qty-input" ${upb <= 1 ? 'disabled' : ''}></td>
      <td class="num"><input type="number" min="0" value="${un}" data-un="${idx}" class="qty-input"></td>
      <td class="num"><strong>${l.units}</strong></td>
      ${isIn ? `<td class="nowrap"><input inputmode="decimal" placeholder="R$" value="${esc(l.cost)}" data-cost="${idx}" class="money-input">
        <select data-per="${idx}" class="per-select"><option value="caixa" ${l.cost_per === 'caixa' ? 'selected' : ''}>por caixa</option><option value="unidade" ${l.cost_per === 'unidade' ? 'selected' : ''}>por un</option></select></td>
        <td class="num nowrap">${value === null ? '<span class="muted">—</span>' : money(value)}</td>` : ''}
      ${isOut ? `<td class="num nowrap">${value === null ? '<span class="tag tag-low">sem custo</span>' : money(value)}</td>` : ''}
      <td><button class="btn-danger btn-sm" data-del="${idx}" aria-label="Remover">✕</button></td>
    </tr>
    ${needsOpening ? `<tr class="sub-row"><td colspan="${cols}">
      <span class="tag tag-low">sem custo</span> Este produto já tem <strong>${boxesLabel(p.stock_units, upb)}</strong> na câmara sem custo.
      Ele será valorizado <strong>pelo custo desta nota</strong>, ou informe o custo atual:
      <input inputmode="decimal" placeholder="R$ (opcional)" value="${esc(l.opening_cost)}" data-ocost="${idx}" class="money-input">
      <select data-oper="${idx}" class="per-select"><option value="unidade" ${l.opening_cost_per === 'unidade' ? 'selected' : ''}>por un</option><option value="caixa" ${l.opening_cost_per === 'caixa' ? 'selected' : ''}>por caixa</option></select>
    </td></tr>` : ''}`;
  }).join('');

  const totalUnits = scanLines.reduce((s, l) => s + l.units, 0);
  const values = scanLines.map(scanLineValue);
  const totalValue = values.reduce((s, v) => s + (v || 0), 0);
  $('#scan-foot').innerHTML = isInv ? '' : `<tr class="total-row"><td>${scanLines.length} produto(s)</td><td></td><td></td><td class="num">${totalUnits}</td>
    ${isIn ? `<td></td><td class="num nowrap">${money(totalValue)}</td>` : ''}${isOut ? `<td class="num nowrap">${money(totalValue)}</td>` : ''}<td></td></tr>`;
  const limit = A.options.note_threshold_cents;
  let hint = '';
  if (isOut && limit && totalValue > limit) hint = `Saída acima de ${money(limit)}: a observação é obrigatória.`;
  if (isIn && values.some((v) => v === 0)) hint = 'Há item com custo zero (bonificação): a observação é obrigatória.';
  $('#scan-hint').innerHTML = hint ? `<span class="tag tag-low">${esc(hint)}</span>` : '';

  const recompute = (idx) => {
    const p = productById(scanLines[idx].product_id);
    const cx = Math.max(0, Number($(`[data-cx="${idx}"]`).value) || 0);
    const un = Math.max(0, Number($(`[data-un="${idx}"]`).value) || 0);
    scanLines[idx].units = cx * p.units_per_box + un;
    drawScanLines();
  };
  $$('[data-cx]', body).forEach((i) => i.addEventListener('change', () => recompute(Number(i.dataset.cx))));
  $$('[data-un]', body).forEach((i) => i.addEventListener('change', () => recompute(Number(i.dataset.un))));
  $$('[data-cost]', body).forEach((i) => i.addEventListener('change', () => { scanLines[Number(i.dataset.cost)].cost = i.value; drawScanLines(); }));
  $$('[data-per]', body).forEach((i) => i.addEventListener('change', () => { scanLines[Number(i.dataset.per)].cost_per = i.value; drawScanLines(); }));
  $$('[data-ocost]', body).forEach((i) => i.addEventListener('change', () => { scanLines[Number(i.dataset.ocost)].opening_cost = i.value; }));
  $$('[data-oper]', body).forEach((i) => i.addEventListener('change', () => { scanLines[Number(i.dataset.oper)].opening_cost_per = i.value; }));
  $$('[data-del]', body).forEach((b) => b.addEventListener('click', () => { scanLines.splice(Number(b.dataset.del), 1); drawScanLines(); }));
}

async function confirmScan() {
  const t = SCAN_TYPES[scanType];
  const note = $('#scan-note').value.trim();
  const val = (id) => ($(`#${id}`) ? $(`#${id}`).value : '');
  if (scanType === 'inventario') {
    if (!scanLines.length) return toast('Nenhum produto contado.', 'error');
    const resumo = scanLines.map((l) => { const p = productById(l.product_id); return `• ${p.name}: sistema ${p.stock_units} → contado ${l.units}`; }).join('\n');
    if (!confirm(`Aplicar contagem?\n${resumo}`)) return;
    await api('/api/admin/estoque/inventario', { method: 'POST', body: { counts: scanLines.map((l) => ({ product_id: l.product_id, counted_units: l.units })), note } });
  } else {
    const lines = scanLines.filter((l) => l.units > 0);
    if (!lines.length) return toast('Informe as quantidades.', 'error');
    const total = lines.reduce((s, l) => s + l.units, 0);
    if (scanType === 'entrada') {
      const missing = lines.find((l) => { const c = parseMoney(l.cost); return c === null || Number.isNaN(c); });
      if (missing) return toast(`Informe o custo de "${productById(missing.product_id).name}".`, 'error');
      const value = lines.reduce((s, l) => s + scanLineValue(l), 0);
      if (!confirm(`${t.button}: ${lines.length} produto(s), ${total} unidades, ${money(value)} a custo?`)) return;
      await api('/api/admin/estoque/entrada', {
        method: 'POST',
        body: {
          lines: lines.map((l) => ({ product_id: l.product_id, units: l.units, cost: l.cost, cost_per: l.cost_per, opening_cost: l.opening_cost, opening_cost_per: l.opening_cost_per })),
          document: val('scan-doc'), supplier: val('scan-supplier'), note,
        },
      });
    } else {
      if (scanType === 'transferencia' && !val('scan-location')) return toast('Escolha a loja de destino.', 'error');
      if (scanType === 'perda' && !val('scan-reason')) return toast('Escolha o motivo da perda.', 'error');
      if (scanType === 'saida_sem_venda' && !val('scan-subtype')) return toast('Escolha o tipo da saída.', 'error');
      if (!confirm(`${t.button}: ${lines.length} produto(s), ${total} unidades?`)) return;
      await api('/api/admin/estoque/saida', {
        method: 'POST',
        body: {
          type: scanType, lines: lines.map((l) => ({ product_id: l.product_id, units: l.units })),
          location_id: val('scan-location'), reason_id: val('scan-reason'), subtype: val('scan-subtype'), customer_id: val('scan-customer'),
          document: val('scan-doc'), note,
        },
      });
    }
  }
  toast('Estoque atualizado!', 'ok');
  scanLines = [];
  renderScanner(scanType);
}

// ======================= ESTOQUE =======================
let stockSearch = '';
async function renderStock() {
  await loadProducts();
  const uncosted = A.products.filter((p) => p.stock_units > 0 && !p.has_cost).length;
  const totalCost = A.products.reduce((s, p) => s + (p.has_cost ? p.stock_value_cents : 0), 0);
  app.innerHTML = `
    <div class="section-head"><h1>Estoque da câmara</h1><span class="spacer"></span>
      <input type="search" id="stock-search" placeholder="Buscar…" style="max-width:240px" value="${esc(stockSearch)}">
      <button class="btn-secondary" id="btn-stock-csv">Exportar planilha</button>
      ${uncosted ? `<button class="btn-secondary" id="btn-opening">Informar custo inicial (${uncosted})</button>` : ''}
      <button id="btn-count">Fazer inventário</button></div>
    <p class="small muted">Físico = o que está na câmara. Reservado = pedidos novos/confirmados ainda não separados. Disponível = o que o cliente consegue pedir.
      Valor a custo total: <strong>${money(totalCost)}</strong>.</p>
    <div class="card" style="padding:0"><div class="table-wrap"><table>
      <thead><tr><th>Produto</th><th class="num">Físico</th><th class="num hide-sm">Reservado</th><th class="num">Disponível</th>
        <th class="num">Custo médio</th><th class="num">Valor a custo</th><th></th><th></th></tr></thead>
      <tbody id="stock-body"></tbody></table></div></div>`;
  const draw = () => {
    const term = stockSearch.toLowerCase();
    const list = A.products.filter((p) => (p.active || p.stock_units) && (!term || p.name.toLowerCase().includes(term)
      || (p.barcode || '').includes(term) || (p.box_barcode || '').includes(term) || p.category.toLowerCase().includes(term)));
    $('#stock-body').innerHTML = list.map((p) => {
      const avg = avgCost(p);
      return `
      <tr>
        <td>${esc(p.name)}<div class="small muted">${esc(p.category)}${p.barcode ? ` · <span class="mono">${esc(p.barcode)}</span>` : ''}</div></td>
        <td class="num nowrap">${boxesLabel(p.stock_units, p.units_per_box)}<div class="small muted">${p.stock_units} un</div></td>
        <td class="num nowrap hide-sm">${p.reserved_units ? boxesLabel(p.reserved_units, p.units_per_box) : '—'}</td>
        <td class="num nowrap"><strong>${boxesLabel(p.available_units, p.units_per_box)}</strong></td>
        <td class="num nowrap">${avg === null ? '—' : `${moneyPrecise(avg)}<div class="small muted">${money(avg * p.units_per_box)}/cx</div>`}</td>
        <td class="num nowrap">${p.stock_units > 0 && !p.has_cost ? '<span class="tag tag-low">sem custo</span>' : money(p.stock_value_cents)}</td>
        <td>${stockTag(p)}</td>
        <td><button class="btn-secondary btn-sm" data-hist="${p.id}">Histórico</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" class="empty">Nenhum produto.</td></tr>';
    $$('[data-hist]').forEach((b) => b.addEventListener('click', () => { movFilter = { product_id: b.dataset.hist }; setView('movimentos'); }));
  };
  draw();
  $('#stock-search').addEventListener('input', (e) => { stockSearch = e.target.value; draw(); });
  $('#btn-stock-csv').addEventListener('click', () => downloadUrl('/api/admin/produtos.csv'));
  $('#btn-count').addEventListener('click', () => { scanType = 'inventario'; setView('movimentar'); });
  const op = $('#btn-opening');
  if (op) op.addEventListener('click', () => guard(openOpeningCost));
}

// Custo inicial dos produtos que têm saldo e não têm custo (dados antigos ou sobra antes da 1ª entrada).
async function openOpeningCost() {
  const { products } = await api('/api/admin/estoque/sem-custo');
  if (!products.length) return toast('Nenhum produto sem custo.', 'ok');
  const m = openModal(`
    <div class="modal-head"><h2>Custo inicial</h2><button class="modal-close" data-close>×</button></div>
    <p class="small">Estes produtos têm estoque mas o sistema não sabe quanto custaram. Informe o custo de cada um:
      o sistema lança um <strong>custo inicial</strong> que valoriza o saldo <strong>sem mudar as unidades</strong>.
      Se preferir, deixe para a próxima entrada: o custo da nota será usado.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Produto</th><th class="num">Saldo</th><th>Custo</th><th></th></tr></thead>
      <tbody>${products.map((p) => `
        <tr data-row="${p.id}">
          <td>${esc(p.name)}<div class="small muted">${esc(p.category)}${p.last_entry_unit_cost ? ` · última entrada: ${moneyPrecise(p.last_entry_unit_cost)}/un` : ''}</div></td>
          <td class="num nowrap">${boxesLabel(p.stock_units, p.units_per_box)}</td>
          <td class="nowrap"><input inputmode="decimal" placeholder="R$" class="money-input" data-oc="${p.id}">
            <select class="per-select" data-ocp="${p.id}"><option value="caixa">por caixa</option><option value="unidade">por un</option></select></td>
          <td><button class="btn-sm" data-save="${p.id}">Salvar</button></td>
        </tr>`).join('')}</tbody>
    </table></div>
    <div class="row" style="margin-top:12px"><button class="btn-secondary" data-close>Fechar</button></div>`, { wide: true });
  $$('[data-save]', m).forEach((b) => b.addEventListener('click', () => guard(async () => {
    const id = b.dataset.save;
    const cost = $(`[data-oc="${id}"]`, m).value;
    if (parseMoney(cost) === null) return toast('Informe o custo.', 'error');
    await api('/api/admin/estoque/custo-inicial', { method: 'POST', body: { product_id: Number(id), cost, cost_per: $(`[data-ocp="${id}"]`, m).value } });
    $(`[data-row="${id}"]`, m).remove();
    toast('Custo inicial lançado.', 'ok');
    if (!$('[data-row]', m)) { closeModal(); }
    if (A.view === 'estoque') renderStock();
    if (A.view === 'painel') renderDashboard();
  })));
}

// ======================= HISTÓRICO =======================
let movFilter = {};
function movDetail(m) {
  const parts = [];
  if (m.location_name) parts.push(`→ ${m.location_name}`);
  if (m.reason_name) parts.push(m.reason_name);
  if (m.subtype_label) parts.push(m.subtype_label);
  if (m.customer_name) parts.push(m.customer_name);
  if (m.supplier) parts.push(m.supplier);
  return parts.join(' · ');
}

async function renderMovements() {
  await loadProducts();
  const qs = new URLSearchParams(Object.entries(movFilter).filter(([, v]) => v)).toString();
  const { movements } = await api(`/api/admin/estoque/movimentos${qs ? `?${qs}` : ''}`);
  app.innerHTML = `
    <div class="section-head"><h1>Histórico de movimentações</h1><span class="spacer"></span>
      <button class="btn-secondary" id="btn-mov-csv">Exportar planilha</button></div>
    <p class="small muted">Lançamentos nunca são editados nem apagados. Para corrigir, use <strong>Estornar</strong>: o sistema lança o contrário, pelo mesmo valor.</p>
    <form class="card" id="mov-filter">
      <div class="form-grid">
        <div class="field"><label>Produto</label><select name="product_id"><option value="">Todos</option>${A.products.map((p) => `<option value="${p.id}" ${String(p.id) === String(movFilter.product_id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Tipo</label><select name="type"><option value="">Todos</option>${Object.entries(MOV_LABEL).map(([k, v]) => `<option value="${k}" ${k === movFilter.type ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>De</label><input type="date" name="from" value="${esc(movFilter.from || '')}"></div>
        <div class="field"><label>Até</label><input type="date" name="to" value="${esc(movFilter.to || '')}"></div>
      </div>
      <div class="row"><button type="submit">Filtrar</button><button type="button" class="btn-secondary" id="btn-mov-clear">Limpar</button></div>
    </form>
    <div class="card" style="padding:0"><div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Data</th><th>Tipo</th><th>Produto</th><th class="num">Qtd</th><th class="num">Valor</th><th class="num hide-sm">Saldo</th>
        <th class="hide-sm">Documento / obs.</th><th class="hide-sm">Usuário</th><th></th></tr></thead>
      <tbody>${movements.map((m) => `
        <tr>
          <td class="small muted">${m.id}</td>
          <td class="nowrap">${fmtDate(m.created_at)}</td>
          <td>${esc(MOV_LABEL[m.type] || m.type)}${m.type === 'estorno' ? `<div class="small muted">de #${m.reverses_movement_id ?? '?'}${m.reverses_type ? ` (${esc(MOV_LABEL[m.reverses_type] || m.reverses_type)})` : ''}</div>` : ''}
            ${movDetail(m) ? `<div class="small muted">${esc(movDetail(m))}</div>` : ''}</td>
          <td>${esc(m.product_name)}</td>
          <td class="num nowrap ${m.quantity > 0 ? 'qty-pos' : m.quantity < 0 ? 'qty-neg' : ''}">${m.quantity > 0 ? '+' : ''}${m.quantity ? boxesLabel(m.quantity, m.units_per_box) : '—'}</td>
          <td class="num nowrap">${m.value_cents === null ? '<span class="muted small">sem custo</span>' : money(m.value_cents)}
            ${m.revenue_cents !== null ? `<div class="small muted">receita ${money(m.revenue_cents)}</div>` : ''}</td>
          <td class="num nowrap hide-sm">${m.balance_after} un${m.value_after_cents !== null ? `<div class="small muted">${money(m.value_after_cents)}</div>` : ''}</td>
          <td class="hide-sm small">${m.order_id ? `<button class="btn-link" data-order="${m.order_id}">Pedido #${m.order_id}</button>` : esc(m.document || '')}${m.note ? `<div class="muted">${esc(m.note)}</div>` : ''}</td>
          <td class="hide-sm small">${esc(m.created_by || '')}</td>
          <td>${m.reversed_by ? `<span class="tag tag-cancelado">estornado #${m.reversed_by}</span>`
            : (m.type !== 'estorno' && m.type !== 'saida_pedido' ? `<button class="btn-danger btn-sm" data-rev="${m.id}">Estornar</button>` : '')}</td>
        </tr>`).join('') || '<tr><td colspan="10" class="empty">Nenhuma movimentação encontrada.</td></tr>'}
      </tbody></table></div></div>`;
  const form = $('#mov-filter');
  form.addEventListener('submit', (e) => { e.preventDefault(); movFilter = formData(form); guard(renderMovements); });
  $('#btn-mov-clear').addEventListener('click', () => { movFilter = {}; guard(renderMovements); });
  $('#btn-mov-csv').addEventListener('click', () => downloadUrl(`/api/admin/estoque/movimentos.csv${qs ? `?${qs}` : ''}`));
  $$('[data-order]').forEach((b) => b.addEventListener('click', () => guard(() => openOrder(Number(b.dataset.order)))));
  $$('[data-rev]').forEach((b) => b.addEventListener('click', () => openReverse(movements.find((x) => x.id === Number(b.dataset.rev)))));
}

function openReverse(mv) {
  const m = openModal(`
    <div class="modal-head"><h2>Estornar lançamento #${mv.id}</h2><button class="modal-close" data-close>×</button></div>
    <p><strong>${esc(MOV_LABEL[mv.type] || mv.type)}</strong> · ${esc(mv.product_name)} · ${mv.quantity ? boxesLabel(mv.quantity, mv.units_per_box) : ''}
      ${mv.value_cents !== null ? ` · ${money(mv.value_cents)}` : ''}<br><span class="small muted">${fmtDate(mv.created_at)} ${esc(movDetail(mv))}</span></p>
    <p class="small">O estorno lança o contrário deste lançamento (unidades e <strong>o mesmo valor</strong>). O original continua no histórico.</p>
    <form id="form-rev">
      <div class="field"><label for="rev-reason">Motivo do estorno *</label><input id="rev-reason" name="reason" required placeholder="Ex.: lançado no produto errado"></div>
      <div class="row"><button type="submit" class="btn-danger">Estornar</button><button type="button" class="btn-secondary" data-close>Cancelar</button></div>
    </form>`);
  const form = $('#form-rev', m);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(form, async (data) => {
      await api(`/api/admin/estoque/movimentos/${mv.id}/estornar`, { method: 'POST', body: data });
      toast('Estorno lançado.', 'ok');
      closeModal();
      renderMovements();
    });
  });
}

// ======================= PRODUTOS =======================
let productSearch = '';
async function renderProducts() {
  await loadProducts();
  app.innerHTML = `
    <div class="section-head"><h1>Produtos</h1><span class="spacer"></span>
      <input type="search" id="prod-search" placeholder="Buscar nome ou código…" style="max-width:240px" value="${esc(productSearch)}">
      <button class="btn-secondary" id="btn-catalog">Catálogo Oggi 2026</button>
      <button class="btn-secondary" id="btn-upb">Unidades por caixa</button>
      <button class="btn-secondary" id="btn-import">Importar planilha</button>
      <button id="btn-new-product">+ Novo produto</button></div>
    <div class="card" style="padding:0"><div class="table-wrap"><table>
      <thead><tr><th></th><th>Produto</th><th class="hide-sm">Código un. / caixa</th><th class="num">Un/cx</th><th class="num">Preço un</th><th class="num">Preço cx</th>
        <th class="num hide-sm">Varejo</th><th class="hide-sm">Venda</th><th></th></tr></thead>
      <tbody id="prod-body"></tbody></table></div></div>`;
  const draw = () => {
    const term = productSearch.toLowerCase();
    const list = A.products.filter((p) => !term || p.name.toLowerCase().includes(term) || p.category.toLowerCase().includes(term)
      || (p.barcode || '').includes(term) || (p.box_barcode || '').includes(term) || (p.sku || '').toLowerCase().includes(term));
    $('#prod-body').innerHTML = list.map((p) => `
      <tr class="clickable" data-id="${p.id}" ${p.active ? '' : 'style="opacity:.5"'}>
        <td style="width:52px">${thumb(p)}</td>
        <td>${esc(p.name)}<div class="small muted">${esc(p.category)}${p.sku ? ` · ${esc(p.sku)}` : ''}${p.active ? '' : ' · INATIVO'}</div></td>
        <td class="hide-sm mono small">${esc(p.barcode || '—')}<br>${esc(p.box_barcode || '—')}</td>
        <td class="num">${p.units_per_box}</td>
        <td class="num nowrap">${money(p.unit_price_cents)}</td>
        <td class="num nowrap">${money(p.box_price_cents)}</td>
        <td class="num nowrap hide-sm">${p.retail_price_cents === null ? '—' : money(p.retail_price_cents)}</td>
        <td class="small hide-sm">${[p.sell_box ? 'Caixa' : '', p.sell_unit ? 'Unidade' : ''].filter(Boolean).join(' + ')}</td>
        <td><button class="btn-secondary btn-sm">Editar</button></td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">Nenhum produto. Carregue o Catálogo Oggi 2026, cadastre um produto ou importe uma planilha.</td></tr>';
    $$('#prod-body tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openProductForm(productById(tr.dataset.id))));
  };
  draw();
  $('#prod-search').addEventListener('input', (e) => { productSearch = e.target.value; draw(); });
  $('#btn-new-product').addEventListener('click', () => openProductForm(null));
  $('#btn-import').addEventListener('click', openImport);
  $('#btn-catalog').addEventListener('click', openCatalogLoader);
  $('#btn-upb').addEventListener('click', openUnitsPerBox);
}

function openProductForm(p, preset = {}, onSaved) {
  const v = p || { units_per_box: 1, sell_box: 1, sell_unit: 1, active: 1, min_stock: 0, category: '', retail_price_cents: null, ...preset };
  const categories = [...new Set(A.products.map((x) => x.category))];
  // preço da caixa calculado (unidade × quantidade) fica vazio: assim acompanha mudanças de preço e de unidades/caixa
  const boxDerived = !p || v.box_price_cents === v.unit_price_cents * v.units_per_box;
  let pendingImage = null;
  const m = openModal(`
    <div class="modal-head"><h2>${p ? 'Editar produto' : 'Novo produto'}</h2><button class="modal-close" data-close>×</button></div>
    <form id="form-product">
      <div class="product-photo">
        <div id="photo-preview">${v.image_url ? `<img src="${esc(v.image_url)}" alt="Foto do produto">` : '<span class="muted small">Sem foto</span>'}</div>
        <div>
          <label class="btn btn-secondary btn-sm" for="photo-file">${v.image_url ? 'Trocar foto' : 'Adicionar foto'}</label>
          <input type="file" id="photo-file" accept="image/*" class="hidden">
          ${v.image_url ? '<button type="button" class="btn-link small" id="photo-remove">Remover foto</button>' : ''}
          <p class="small muted" style="margin:6px 0 0">A foto aparece no catálogo do cliente. Pode ser tirada pelo celular.</p>
        </div>
      </div>
      <div class="field"><label>Nome *</label><input name="name" required value="${esc(v.name || '')}"></div>
      <div class="form-grid">
        <div class="field"><label>Categoria / linha</label><input name="category" list="cat-list" value="${esc(v.category || '')}" placeholder="Sensa, Potes, Açaí…"><datalist id="cat-list">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="field"><label>SKU / código interno</label><input name="sku" value="${esc(v.sku || '')}"></div>
        <div class="field"><label>Código de barras da UNIDADE (EAN)</label><input name="barcode" class="mono" value="${esc(v.barcode || '')}" placeholder="Bipe aqui"></div>
        <div class="field"><label>Código de barras da CAIXA (DUN)</label><input name="box_barcode" class="mono" value="${esc(v.box_barcode || '')}" placeholder="Bipe aqui (opcional)"></div>
        <div class="field"><label>Unidades por caixa *</label><input name="units_per_box" type="number" min="1" required value="${v.units_per_box}"></div>
        <div class="field"><label>Estoque mínimo (unidades)</label><input name="min_stock" type="number" min="0" value="${v.min_stock}"></div>
        <div class="field"><label>Preço B2B da unidade (R$)</label><input name="unit_price" inputmode="decimal" value="${centsToInput(v.unit_price_cents)}"></div>
        <div class="field"><label>Preço B2B da caixa (R$)</label><input name="box_price" inputmode="decimal" value="${boxDerived ? '' : centsToInput(v.box_price_cents)}" placeholder="Vazio = unidade × quantidade"></div>
        <div class="field"><label>Preço de varejo no balcão (R$)</label><input name="retail_price" inputmode="decimal" value="${v.retail_price_cents === null || v.retail_price_cents === undefined ? '' : centsToInput(v.retail_price_cents)}" placeholder="Opcional"></div>
      </div>
      <div class="field"><label>Descrição (aparece para o cliente)</label><input name="description" value="${esc(v.description || '')}"></div>
      <div class="row" style="margin-bottom:14px">
        <label class="check"><input type="checkbox" name="sell_box" ${v.sell_box ? 'checked' : ''}> Vende caixa fechada</label>
        <label class="check"><input type="checkbox" name="sell_unit" ${v.sell_unit ? 'checked' : ''}> Vende unidade avulsa</label>
        <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Ativo (aparece no catálogo)</label>
      </div>
      ${p ? `<p class="small muted">Estoque atual: ${boxesLabel(p.stock_units, p.units_per_box)} (${p.stock_units} un)${avgCost(p) !== null ? ` · custo médio ${moneyPrecise(avgCost(p))}/un` : ''}. Para alterar o estoque use “Entrada / Saída”.</p>` : ''}
      <div class="row"><button type="submit">Salvar</button><button type="button" class="btn-secondary" data-close>Cancelar</button>
        ${p ? '<span style="flex:1"></span><button type="button" class="btn-danger" id="btn-delete-product">Excluir produto</button>' : ''}</div>
    </form>`);
  // leitores de código de barras enviam Enter: não submeter o form ao bipar
  $$('input[name=barcode], input[name=box_barcode]', m).forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); }));
  const del = $('#btn-delete-product', m);
  if (del) del.addEventListener('click', () => guard(async () => {
    if (!confirm(`Excluir "${p.name}"? Só é possível se o produto nunca teve estoque nem pedidos.`)) return;
    await api(`/api/admin/produtos/${p.id}`, { method: 'DELETE' });
    toast('Produto excluído.', 'ok');
    closeModal();
    renderProducts();
  }));

  const uploadImage = async (productId, img) => {
    const r = await api(`/api/admin/produtos/${productId}/imagem`, { method: 'PUT', body: { mime: img.mime, data: img.data } });
    return r.product;
  };
  $('#photo-file', m).addEventListener('change', (e) => guard(async () => {
    const file = e.target.files[0];
    if (!file) return;
    const img = await resizeImage(file);
    $('#photo-preview', m).innerHTML = `<img src="${img.preview}" alt="Foto do produto">`;
    if (p) {
      await uploadImage(p.id, img);
      toast('Foto salva.', 'ok');
      await loadProducts();
    } else {
      pendingImage = img; // envia depois de criar o produto
    }
  }));
  const rm = $('#photo-remove', m);
  if (rm) rm.addEventListener('click', () => guard(async () => {
    await api(`/api/admin/produtos/${p.id}/imagem`, { method: 'DELETE' });
    $('#photo-preview', m).innerHTML = '<span class="muted small">Sem foto</span>';
    rm.remove();
    toast('Foto removida.', 'ok');
  }));

  const form = $('#form-product', m);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(form, async (data) => {
      let r = p
        ? await api(`/api/admin/produtos/${p.id}`, { method: 'PUT', body: data })
        : await api('/api/admin/produtos', { method: 'POST', body: data });
      if (pendingImage) r = { product: await uploadImage(r.product.id, pendingImage) };
      toast('Produto salvo.', 'ok');
      closeModal();
      if (onSaved) await onSaved(r.product);
      else renderProducts();
    });
  });
}

function openCatalogLoader() {
  const m = openModal(`
    <div class="modal-head"><h2>Catálogo Oggi 2026</h2><button class="modal-close" data-close>×</button></div>
    <p>Cadastra os <strong>90 produtos</strong> do catálogo 2026 (Netflix, Disney, Festa no Palito, Hello Kitty, Frutos, Fazenda, Delícia,
      Sabores Regionais, Clássicos, Sensa, potes, Açaí, Top Sundae, Giratto e Sensa Bombom), <strong>com foto</strong>,
      preço do catálogo (B2B e varejo) e unidades por caixa.</p>
    <ul class="small">
      <li>Produtos que já existem (mesmo nome ou SKU <span class="mono">OG26-…</span>) <strong>não são alterados</strong>. Se estiverem sem foto, recebem a foto do catálogo.</li>
      <li>Os produtos entram <strong>sem código de barras e sem estoque</strong>. Bipe os códigos na tela de cada produto ou pela planilha
        (baixe o modelo em “Importar planilha”: ele vem com todos os produtos e o SKU de cada um).</li>
      <li>Unidades por caixa: picolés 39 (Sensa 20, Clássicos 33, Disney e Demogorgon 24), potes 4, Top Sundae 16, Giratto 18, bombons 12. Confira em “Unidades por caixa”.</li>
    </ul>
    <div id="catalog-result"></div>
    <div class="row" style="margin-top:12px"><button id="btn-load-catalog">Carregar catálogo</button><button class="btn-secondary" data-close>Fechar</button></div>`);
  $('#btn-load-catalog', m).addEventListener('click', () => guard(async () => {
    const btn = $('#btn-load-catalog', m);
    btn.disabled = true;
    try {
      const r = await api('/api/admin/produtos/catalogo-oggi', { method: 'POST', body: {} });
      $('#catalog-result', m).innerHTML = `<div class="alert alert-ok">${r.created} produtos criados · ${r.existing} já existiam · ${r.images} fotos adicionadas.</div>`;
      if (A.view === 'produtos') await renderProducts();
    } finally {
      btn.disabled = false;
    }
  }));
}

function openUnitsPerBox() {
  const cats = new Map();
  for (const p of A.products) {
    const c = cats.get(p.category) || { name: p.category, values: new Set(), count: 0 };
    c.values.add(p.units_per_box);
    c.count++;
    cats.set(p.category, c);
  }
  const list = [...cats.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const m = openModal(`
    <div class="modal-head"><h2>Unidades por caixa</h2><button class="modal-close" data-close>×</button></div>
    <p class="small">Defina quantas unidades vêm em cada caixa fechada, por linha. Para um produto diferente dentro da linha, ajuste na tela do produto.
      O estoque não muda (ele é guardado em unidades); o preço da caixa calculado acompanha.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Linha / categoria</th><th class="num">Produtos</th><th class="num">Atual</th><th>Nova quantidade</th></tr></thead>
      <tbody>${list.map((c, i) => `
        <tr><td>${esc(c.name)}</td><td class="num">${c.count}</td>
          <td class="num">${c.values.size === 1 ? [...c.values][0] : `vários (${[...c.values].sort((a, b) => a - b).join(', ')})`}</td>
          <td class="nowrap"><input type="number" min="1" class="qty-input" data-upb="${i}" value="${c.values.size === 1 ? [...c.values][0] : ''}">
            <button class="btn-sm" data-apply="${i}">Aplicar</button></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="row" style="margin-top:12px"><button class="btn-secondary" data-close>Fechar</button></div>`, { wide: true });
  $$('[data-apply]', m).forEach((b) => b.addEventListener('click', () => guard(async () => {
    const i = Number(b.dataset.apply);
    const upb = Number($(`[data-upb="${i}"]`, m).value);
    if (!Number.isInteger(upb) || upb < 1) return toast('Informe um número inteiro.', 'error');
    const r = await api('/api/admin/produtos/unidades-por-caixa', { method: 'POST', body: { category: list[i].name, units_per_box: upb } });
    toast(`${list[i].name}: ${r.updated} produto(s) com ${upb} un/caixa.`, 'ok');
    if (A.view === 'produtos') await renderProducts();
    else await loadProducts();
  })));
}

function openImport() {
  const m = openModal(`
    <div class="modal-head"><h2>Importar produtos</h2><button class="modal-close" data-close>×</button></div>
    <ol class="small" style="padding-left:18px">
      <li><button class="btn-link" id="btn-template">Baixe a planilha modelo (Excel)</button>. Se você já tem produtos cadastrados, ela vem com eles preenchidos.</li>
      <li>Preencha uma linha por produto. A aba “Como preencher” explica cada coluna.</li>
      <li>Salve e escolha o arquivo abaixo.</li>
    </ol>
    <p class="small muted">Produtos com o mesmo código de barras são <strong>atualizados</strong>; os outros são criados. O estoque <strong>não</strong> é alterado: para lançar o estoque use “Entrada / Saída”.</p>
    <input type="file" id="import-file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv">
    <div id="import-result" style="margin-top:12px"></div>
    <div class="row" style="margin-top:12px"><button id="btn-do-import">Importar</button><button class="btn-secondary" data-close>Fechar</button></div>`);
  $('#btn-template', m).addEventListener('click', () => downloadUrl('/api/admin/produtos/modelo.xlsx'));
  $('#btn-do-import', m).addEventListener('click', () => guard(async () => {
    const file = $('#import-file', m).files[0];
    if (!file) return toast('Escolha um arquivo.', 'error');
    const buf = await file.arrayBuffer();
    let body;
    if (/\.xlsx$/i.test(file.name)) {
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
      body = { xlsx: btoa(bin) };
    } else if (/\.xls$/i.test(file.name)) {
      return toast('Arquivo .xls antigo: no Excel use "Salvar como" → "Pasta de Trabalho do Excel (.xlsx)".', 'error');
    } else {
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(buf); // Excel em PT-BR
      body = { csv: text };
    }
    const r = await api('/api/admin/produtos/importar', { method: 'POST', body });
    $('#import-result', m).innerHTML = `
      <div class="alert ${r.errors.length ? 'alert-warn' : 'alert-ok'}">${r.created} criados · ${r.updated} atualizados${r.errors.length ? ` · ${r.errors.length} com erro` : ''}</div>
      ${r.errors.length ? `<ul class="small">${r.errors.slice(0, 50).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}`;
    // o modal fica no <body>, então dá para atualizar a lista ao fundo
    if (A.view === 'produtos') await renderProducts();
    else await loadProducts();
  }));
}

// ======================= CLIENTES =======================
async function renderCustomers() {
  const { customers } = await api('/api/admin/clientes');
  refreshBadges();
  app.innerHTML = `
    <div class="section-head"><h1>Clientes</h1><span class="spacer"></span>
      <input type="search" id="cust-search" placeholder="Buscar…" style="max-width:240px">
      <button id="btn-new-customer">+ Cadastrar cliente</button></div>
    <p class="small muted">Envie o link <strong class="mono">${esc(location.origin)}/</strong> para seus clientes se cadastrarem e fazerem pedidos.</p>
    <div class="card" style="padding:0"><div class="table-wrap"><table>
      <thead><tr><th>Cliente</th><th class="hide-sm">Contato</th><th class="num">Pedidos</th><th>Situação</th><th></th></tr></thead>
      <tbody id="cust-body"></tbody></table></div></div>`;
  const draw = (term = '') => {
    const t = term.toLowerCase();
    const list = customers.filter((c) => !t || `${c.razao_social} ${c.nome_fantasia || ''} ${c.cnpj} ${c.cidade || ''}`.toLowerCase().includes(t));
    $('#cust-body').innerHTML = list.map((c) => `
      <tr>
        <td><strong>${esc(c.nome_fantasia || c.razao_social)}</strong><div class="small muted">${esc(c.razao_social)} · ${esc(fmtCnpj(c.cnpj))}</div></td>
        <td class="hide-sm small">${esc(c.contato || '')} ${esc(c.telefone || '')}<div class="muted">${esc(c.cidade || '')}</div></td>
        <td class="num">${c.order_count}</td>
        <td>${statusTag(c.status)}</td>
        <td class="nowrap">
          ${c.status === 'pendente' ? `<button class="btn-ok btn-sm" data-approve="${c.id}">Aprovar</button>` : ''}
          <button class="btn-secondary btn-sm" data-edit="${c.id}">Editar</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum cliente ainda.</td></tr>';
    $$('[data-approve]').forEach((b) => b.addEventListener('click', () => guard(async () => {
      await api(`/api/admin/clientes/${b.dataset.approve}`, { method: 'PUT', body: { status: 'ativo' } });
      toast('Cliente aprovado! Avise pelo WhatsApp que já pode pedir.', 'ok');
      renderCustomers();
    })));
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => openCustomerForm(customers.find((c) => c.id === Number(b.dataset.edit)))));
  };
  draw();
  $('#cust-search').addEventListener('input', (e) => draw(e.target.value));
  $('#btn-new-customer').addEventListener('click', () => openCustomerForm(null));
}

function openCustomerForm(c) {
  const v = c || {};
  const m = openModal(`
    <div class="modal-head"><h2>${c ? 'Editar cliente' : 'Cadastrar cliente'}</h2><button class="modal-close" data-close>×</button></div>
    <form id="form-customer">
      <div class="form-grid">
        <div class="field"><label>CNPJ *</label><input name="cnpj" value="${esc(fmtCnpj(v.cnpj || ''))}" ${c ? 'disabled' : 'required'}></div>
        ${c ? `<div class="field"><label>Situação</label><select name="status">${['pendente', 'ativo', 'bloqueado'].map((s) => `<option value="${s}" ${s === v.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label>Razão social *</label><input name="razao_social" required value="${esc(v.razao_social || '')}"></div>
        <div class="field"><label>Nome fantasia</label><input name="nome_fantasia" value="${esc(v.nome_fantasia || '')}"></div>
        <div class="field"><label>Responsável</label><input name="contato" value="${esc(v.contato || '')}"></div>
        <div class="field"><label>Telefone / WhatsApp</label><input name="telefone" value="${esc(v.telefone || '')}"></div>
        <div class="field"><label>E-mail</label><input name="email" type="email" value="${esc(v.email || '')}"></div>
        <div class="field"><label>Cidade</label><input name="cidade" value="${esc(v.cidade || '')}"></div>
      </div>
      <div class="field"><label>Endereço</label><input name="endereco" value="${esc(v.endereco || '')}"></div>
      <div class="field"><label>Observações internas</label><input name="notes" value="${esc(v.notes || '')}"></div>
      <div class="field"><label>${c ? 'Nova senha (deixe vazio para manter)' : 'Senha inicial * (mín. 6)'}</label><input name="senha" type="text" ${c ? '' : 'required minlength="6"'} autocomplete="off"></div>
      <div class="row"><button type="submit">Salvar</button><button type="button" class="btn-secondary" data-close>Cancelar</button></div>
    </form>`);
  const form = $('#form-customer', m);
  if (!c) maskCnpj(form.cnpj);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(form, async (data) => {
      if (c) {
        if (!data.senha) delete data.senha;
        delete data.cnpj;
        await api(`/api/admin/clientes/${c.id}`, { method: 'PUT', body: data });
      } else {
        await api('/api/admin/clientes', { method: 'POST', body: data });
      }
      toast('Cliente salvo.', 'ok');
      closeModal();
      renderCustomers();
    });
  });
}

// ======================= CONFIGURAÇÕES =======================
async function renderConfig() {
  const [{ settings: s }, { admins }, { locations }, { reasons }] = await Promise.all([
    api('/api/admin/config'), api('/api/admin/usuarios'), api('/api/admin/locais'), api('/api/admin/motivos'),
  ]);
  app.innerHTML = `
    <div class="section-head"><h1>Configurações</h1></div>
    <div class="grid grid-2" style="align-items:start">
      <div>
        <form class="card" id="form-settings">
          <h2>Loja e portal</h2>
          <div class="field"><label>Nome da loja</label><input name="store_name" value="${esc(s.store_name)}"></div>
          <div class="field"><label>Subtítulo</label><input name="store_subtitle" value="${esc(s.store_subtitle)}"></div>
          <div class="field"><label>WhatsApp da loja (com DDD, ex.: 5566999990000)</label><input name="whatsapp" inputmode="tel" value="${esc(s.whatsapp)}"></div>
          <div class="field"><label>Pedido mínimo (R$, 0 = sem mínimo)</label><input name="min_order" inputmode="decimal" value="${centsToInput(s.min_order_cents)}"></div>
          <div class="field"><label>Aviso no catálogo</label><textarea name="order_notice">${esc(s.order_notice)}</textarea></div>
          <label class="check" style="margin-bottom:6px"><input type="checkbox" name="auto_approve_customers" ${s.auto_approve_customers === '1' ? 'checked' : ''}> Liberar novos clientes automaticamente (sem aprovação)</label>
          <p class="small muted" style="margin:0 0 14px">O cliente nunca vê a quantidade em estoque: só “Disponível” ou “Esgotado”. Se pedir mais do que temos, o pedido é recusado.</p>
          <h2 style="margin-top:8px">Estoque</h2>
          <div class="field"><label>Observação obrigatória em saída manual acima de (R$, 0 = nunca)</label><input name="out_note_threshold" inputmode="decimal" value="${centsToInput(s.out_note_threshold_cents)}"></div>
          <div class="field"><label>Fornecedor padrão na entrada</label><input name="default_supplier" value="${esc(s.default_supplier || '')}"></div>
          <button type="submit">Salvar</button>
        </form>
        <div class="card">
          <h2>Lojas (destinos de transferência)</h2>
          <div class="table-wrap"><table><tbody>${locations.filter((l) => l.kind === 'loja').map((l) => `
            <tr ${l.active ? '' : 'style="opacity:.5"'}><td><input value="${esc(l.name)}" data-loc-name="${l.id}"><div class="small muted">${esc(l.description || '')}</div></td>
              <td class="nowrap"><button class="btn-secondary btn-sm" data-loc-save="${l.id}">Salvar</button>
                <button class="btn-secondary btn-sm" data-loc-toggle="${l.id}" data-active="${l.active}">${l.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('')}
          </tbody></table></div>
          <form id="form-loc" class="row" style="margin-top:10px"><input name="name" class="grow" placeholder="Nova loja" required><button type="submit" class="btn-secondary">+ Adicionar</button></form>
        </div>
        <div class="card">
          <h2>Motivos de perda</h2>
          <div class="table-wrap"><table><tbody>${reasons.map((r) => `
            <tr ${r.active ? '' : 'style="opacity:.5"'}><td><input value="${esc(r.name)}" data-rs-name="${r.id}"></td>
              <td><label class="check small"><input type="checkbox" data-rs-note="${r.id}" ${r.requires_note ? 'checked' : ''}> exige obs.</label></td>
              <td class="nowrap"><button class="btn-secondary btn-sm" data-rs-save="${r.id}">Salvar</button>
                <button class="btn-secondary btn-sm" data-rs-toggle="${r.id}" data-active="${r.active}">${r.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('')}
          </tbody></table></div>
          <form id="form-reason" class="row" style="margin-top:10px"><input name="name" class="grow" placeholder="Novo motivo" required>
            <label class="check small"><input type="checkbox" name="requires_note"> exige obs.</label><button type="submit" class="btn-secondary">+ Adicionar</button></form>
        </div>
      </div>
      <div>
        <form class="card" id="form-pass">
          <h2>Minha senha</h2>
          <div class="field"><label>Senha atual</label><input name="atual" type="password" required autocomplete="current-password"></div>
          <div class="field"><label>Nova senha (mín. 8)</label><input name="nova" type="password" minlength="8" required autocomplete="new-password"></div>
          <button type="submit">Alterar senha</button>
        </form>
        <div class="card">
          <h2>Usuários do painel</h2>
          <ul>${admins.map((a) => `<li>${esc(a.name)} <span class="muted small">${esc(a.email)}</span></li>`).join('')}</ul>
          <form id="form-user">
            <div class="form-grid">
              <div class="field"><label>Nome</label><input name="name" required></div>
              <div class="field"><label>E-mail</label><input name="email" type="email" required></div>
              <div class="field"><label>Senha (mín. 8)</label><input name="senha" type="text" minlength="8" required autocomplete="off"></div>
            </div>
            <button type="submit" class="btn-secondary">+ Adicionar usuário</button>
          </form>
        </div>
        <div class="card">
          <h2>Backup</h2>
          <p class="small muted">Baixa uma cópia completa do sistema (produtos, fotos, estoque, pedidos e clientes). Recomendado fazer toda semana.</p>
          <button class="btn-secondary" id="btn-backup">Baixar backup</button>
        </div>
      </div>
    </div>`;
  $('#btn-backup').addEventListener('click', () => downloadUrl('/api/admin/backup'));
  const onSubmit = (id, fn) => {
    const f = $(id);
    f.addEventListener('submit', (e) => { e.preventDefault(); submitWith(f, fn); });
  };
  onSubmit('#form-settings', async (data) => {
    await api('/api/admin/config', { method: 'PUT', body: data });
    toast('Configurações salvas.', 'ok');
    applyBranding();
  });
  onSubmit('#form-pass', async (data) => {
    await api('/api/admin/senha', { method: 'POST', body: data });
    toast('Senha alterada.', 'ok');
    $('#form-pass').reset();
  });
  onSubmit('#form-user', async (data) => {
    await api('/api/admin/usuarios', { method: 'POST', body: data });
    toast('Usuário criado.', 'ok');
    renderConfig();
  });
  onSubmit('#form-loc', async (data) => {
    await api('/api/admin/locais', { method: 'POST', body: data });
    toast('Loja adicionada.', 'ok');
    renderConfig();
  });
  onSubmit('#form-reason', async (data) => {
    await api('/api/admin/motivos', { method: 'POST', body: data });
    toast('Motivo adicionado.', 'ok');
    renderConfig();
  });
  const act = (sel, fn) => $$(sel).forEach((b) => b.addEventListener('click', () => guard(async () => { await fn(b); toast('Salvo.', 'ok'); renderConfig(); })));
  act('[data-loc-save]', (b) => api(`/api/admin/locais/${b.dataset.locSave}`, { method: 'PUT', body: { name: $(`[data-loc-name="${b.dataset.locSave}"]`).value } }));
  act('[data-loc-toggle]', (b) => api(`/api/admin/locais/${b.dataset.locToggle}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } }));
  act('[data-rs-save]', (b) => api(`/api/admin/motivos/${b.dataset.rsSave}`, {
    method: 'PUT', body: { name: $(`[data-rs-name="${b.dataset.rsSave}"]`).value, requires_note: $(`[data-rs-note="${b.dataset.rsSave}"]`).checked },
  }));
  act('[data-rs-toggle]', (b) => api(`/api/admin/motivos/${b.dataset.rsToggle}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } }));
}

// ======================= RELATÓRIOS =======================
const REPORT_TYPES = {
  conciliacao: 'Conciliação',
  posicao: 'Posição de estoque',
  vendas: 'Vendas B2B',
  perdas: 'Perdas e divergências',
  transferencias: 'Transferências',
};
const R = { tipo: 'conciliacao', date: null, from: null, to: null };

function monthRange(offset = 0) {
  const [y, m] = todayLocal().split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return [d.toISOString().slice(0, 10), offset === 0 ? todayLocal() : last.toISOString().slice(0, 10)];
}

function reportCell(col, row) {
  const v = row[col.key];
  if (v === null || v === undefined) return col.type === 'text' ? '' : '<span class="muted">—</span>';
  switch (col.type) {
    case 'money': return money(v);
    case 'unitcost': return moneyPrecise(v);
    case 'pct': return pct(v);
    case 'int': return Number(v).toLocaleString('pt-BR');
    case 'units': return `${boxesLabel(v, row.upb)}<div class="small muted">${v} un</div>`;
    default: return esc(v);
  }
}

function reportTable(sec) {
  const right = (c) => (c.type === 'text' ? '' : 'num nowrap');
  return `
    <div class="card report-section">
      <h2>${esc(sec.title)}</h2>
      ${sec.rows.length ? `<div class="table-wrap"><table>
        <thead><tr>${sec.columns.map((c) => `<th class="${right(c)}">${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${sec.rows.map((r) => `<tr class="${r._class === 'danger' ? 'row-danger' : ''}">${sec.columns.map((c) => `<td class="${right(c)}">${reportCell(c, r)}</td>`).join('')}</tr>`).join('')}</tbody>
        ${sec.total ? `<tfoot><tr class="total-row">${sec.columns.map((c, i) => `<td class="${right(c)}">${i === 0 ? 'Total' : reportCell(c, sec.total)}</td>`).join('')}</tr></tfoot>` : ''}
      </table></div>` : '<p class="muted">Nada no período.</p>'}
    </div>`;
}

async function renderReports() {
  if (!R.from) [R.from, R.to] = monthRange(0);
  if (!R.date) R.date = todayLocal();
  const isPos = R.tipo === 'posicao';
  const query = () => new URLSearchParams(isPos ? { date: R.date } : { from: R.from, to: R.to }).toString();
  app.innerHTML = `
    <div class="section-head"><h1>Relatórios</h1></div>
    <div class="chips">${Object.entries(REPORT_TYPES).map(([k, v]) => `<button class="chip ${k === R.tipo ? 'active' : ''}" data-rt="${k}">${v}</button>`).join('')}</div>
    <form class="card" id="report-filter">
      <div class="row">
        ${isPos ? `<div class="field"><label for="r-date">Posição no fim do dia</label><input type="date" id="r-date" value="${R.date}" max="${todayLocal()}"></div>` : `
          <div class="field"><label for="r-from">De</label><input type="date" id="r-from" value="${R.from}"></div>
          <div class="field"><label for="r-to">Até</label><input type="date" id="r-to" value="${R.to}"></div>
          <div class="field"><label>&nbsp;</label><div class="row">
            <button type="button" class="btn-secondary btn-sm" data-preset="0">Este mês</button>
            <button type="button" class="btn-secondary btn-sm" data-preset="-1">Mês passado</button>
            <button type="button" class="btn-secondary btn-sm" data-preset="year">Este ano</button></div></div>`}
        <span class="grow"></span>
        <div class="field"><label>&nbsp;</label><div class="row">
          <button type="submit">Atualizar</button>
          <button type="button" class="btn-secondary" data-export="xlsx">Excel</button>
          <button type="button" class="btn-secondary" data-export="csv">CSV</button></div></div>
      </div>
    </form>
    <div id="report-body"><div class="empty">Carregando…</div></div>`;

  $$('[data-rt]').forEach((b) => b.addEventListener('click', () => { R.tipo = b.dataset.rt; guard(renderReports); }));
  $$('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.preset === 'year') [R.from, R.to] = [`${todayLocal().slice(0, 4)}-01-01`, todayLocal()];
    else [R.from, R.to] = monthRange(Number(b.dataset.preset));
    guard(renderReports);
  }));
  $('#report-filter').addEventListener('submit', (e) => {
    e.preventDefault();
    if (isPos) R.date = $('#r-date').value || todayLocal();
    else { R.from = $('#r-from').value; R.to = $('#r-to').value; }
    guard(renderReports);
  });
  $$('[data-export]').forEach((b) => b.addEventListener('click', () => downloadUrl(`/api/admin/relatorios/${R.tipo}?${query()}&formato=${b.dataset.export}`)));

  const { report } = await api(`/api/admin/relatorios/${R.tipo}?${query()}`);
  const closes = R.tipo === 'conciliacao' && report.check && !report.check.units && !report.check.value;
  $('#report-body').innerHTML = `
    <div class="report-head"><h2>${esc(report.title)}</h2><p class="small muted">${esc(report.subtitle || '')}</p></div>
    ${closes ? '<div class="alert alert-ok"><strong>A conciliação fecha:</strong> estoque inicial + movimentações = estoque final, em unidades e em R$.</div>' : ''}
    ${(report.warnings || []).map((w) => `<div class="alert ${/NÃO fecha/.test(w) ? 'alert-error' : 'alert-warn'}">${esc(w)}</div>`).join('')}
    ${report.sections.map(reportTable).join('')}`;
}

// ======================= INICIALIZAÇÃO =======================
async function boot() {
  applyBranding();
  try {
    A.admin = (await api('/api/admin/me')).admin;
  } catch {
    return renderLogin();
  }
  $('#nav').classList.remove('hidden');
  const initial = location.hash.slice(1);
  setView(initial && $(`#nav [data-view="${initial}"]`) ? initial : 'painel');
}

$$('#nav [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('#btn-logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  A.admin = null;
  renderLogin();
});

// atualiza o contador de pedidos novos a cada minuto
setInterval(() => { if (A.admin) refreshBadges(); }, 60000);

boot();

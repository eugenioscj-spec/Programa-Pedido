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
  A.products = sortByHierarchy((await api('/api/admin/produtos')).products);
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

const STORE_VIEWS = ['loja-estoque', 'loja-repor'];
const isMaster = () => A.admin && A.admin.role === 'master';

function setView(view) {
  if (!isMaster() && !STORE_VIEWS.includes(view)) view = 'loja-estoque';
  if (isMaster() && STORE_VIEWS.includes(view)) view = 'painel';
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
    financeiro: renderFinance,
    'loja-estoque': renderStoreStock,
    'loja-repor': renderRestock,
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
      A hospedagem está sem disco permanente (no Render, o plano gratuito não tem). Toda vez que o sistema reinicia ou é atualizado,
      tudo volta ao início: senhas, clientes, estoque e lançamentos. Contrate o plano pago com disco (veja “Colocar no ar” no README).</div>`}
    ${d.test_mode ? `<div class="alert alert-info"><strong>Ambiente de TESTE</strong> (variável MODO_TESTE ligada).
      Quando for usar de verdade, apague a variável MODO_TESTE na hospedagem.</div>` : ''}
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
            <tr><td>${esc(p.name)}<div class="small muted">${esc(productPath(p))}</div></td>
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
      <div><strong>${esc(o.razao_social)}</strong>${o.nome_fantasia ? `<div>${esc(o.nome_fantasia)}</div>` : ''}<div class="small muted">${docLabel(o.cnpj)} ${esc(fmtCnpj(o.cnpj))}</div></div>
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
    <div><strong>${esc(o.razao_social)}</strong>${o.nome_fantasia ? ` (${esc(o.nome_fantasia)})` : ''} · ${docLabel(o.cnpj)} ${esc(fmtCnpj(o.cnpj))}</div>
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
  saida_sem_venda: { label: 'Brinde / parceria / outras', help: 'Saída sem venda: brinde, parceria, bonificação a cliente, amostra, doação, consumo interno…', button: 'Registrar saída' },
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
        ${o.subtypes.map((s) => `<option value="${s.value}">${esc(s.label)}${s.requires_note ? ' (exige observação)' : ''}</option>`).join('')}</select></div>
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
      <input class="scan-input" id="scan" placeholder="Bipe o código de barras ou comece a digitar o nome do produto" autocomplete="off">
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
  productSuggest(scan, {
    products: () => A.products.filter((p) => p.active || p.stock_units),
    detail: (p) => `na câmara: ${boxesLabel(p.stock_units, p.units_per_box)}`,
    clearOnPick: true,
    onPick: (p) => { $('#scan-picker').innerHTML = ''; addScanUnits(p, 0); scan.focus(); },
  });
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
    const over = isOut ? outExcess(l) : null;
    return `<tr class="${over ? `row-${over.level}` : ''}" ${l.product_id === highlightId && !over ? 'style="background:var(--ok-soft)"' : ''}>
      <td>${esc(p.name)}<div class="small muted">${upb > 1 ? `Caixa c/ ${upb} un` : 'Unidade'}${p.barcode ? ` · <span class="mono">${esc(p.barcode)}</span>` : ''}
        ${!isIn ? ` · estoque ${boxesLabel(p.stock_units, upb)}` : ''}</div>
        ${over ? `<div class="small over-msg">⚠ ${esc(over.message)}</div>` : ''}</td>
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
  const excess = isOut ? scanLines.map(outExcess).filter(Boolean) : [];
  let hint = '';
  if (isOut && limit && totalValue > limit) hint = `Saída acima de ${money(limit)}: a observação é obrigatória.`;
  if (isIn && values.some((v) => v === 0)) hint = 'Há item com custo zero (bonificação): a observação é obrigatória.';
  $('#scan-hint').innerHTML = (excess.length ? `<div class="alert ${excess.some((x) => x.level === 'danger') ? 'alert-error' : 'alert-warn'}">
      <strong>Atenção: ${excess.length} produto(s) acima do disponível na câmara.</strong> Confira as linhas marcadas.</div>` : '')
    + (hint ? `<span class="tag tag-low">${esc(hint)}</span>` : '');

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

// Saída maior que o disponível: acima do físico a saída é recusada; entre o disponível e o físico
// ela usa unidades já reservadas para pedidos de clientes.
function outExcess(l) {
  const p = productById(l.product_id);
  const free = Math.max(0, p.available_units ?? p.stock_units);
  if (l.units <= free) return null;
  const upb = p.units_per_box;
  if (l.units > p.stock_units) {
    return { level: 'danger', name: p.name, message: `Ultrapassa o estoque: há só ${boxesLabel(p.stock_units, upb)} na câmara. A saída não será aceita.` };
  }
  return {
    level: 'warn', name: p.name,
    message: `Ultrapassa o disponível: ${boxesLabel(free, upb)} livre; ${boxesLabel(p.reserved_units, upb)} reservado para pedidos de clientes.`,
  };
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
      const excess = lines.map(outExcess).filter(Boolean);
      const blocked = excess.filter((x) => x.level === 'danger');
      if (blocked.length) return toast(`Quantidade maior que o estoque da câmara: ${blocked.map((x) => x.name).join(', ')}.`, 'error');
      const warn = excess.length ? `\n\nATENÇÃO: acima do disponível (vai usar o que está reservado para pedidos):\n${excess.map((x) => `• ${x.name}`).join('\n')}` : '';
      if (!confirm(`${t.button}: ${lines.length} produto(s), ${total} unidades?${warn}`)) return;
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
  const totalB2b = A.products.reduce((s, p) => s + p.stock_units * p.unit_price_cents, 0);
  const totalRetail = A.products.reduce((s, p) => s + p.stock_units * (p.retail_price_cents ?? p.unit_price_cents), 0);
  const totalUnits = A.products.reduce((s, p) => s + p.stock_units, 0);
  app.innerHTML = `
    <div class="section-head"><h1>Estoque da câmara</h1><span class="spacer"></span>
      <input type="search" id="stock-search" placeholder="Buscar…" style="max-width:240px" value="${esc(stockSearch)}">
      <button class="btn-secondary" id="btn-stock-csv">Exportar planilha</button>
      ${uncosted ? `<button class="btn-secondary" id="btn-opening">Informar custo inicial (${uncosted})</button>` : ''}
      <button id="btn-count">Fazer inventário</button></div>
    <div class="grid grid-4" style="margin-bottom:14px">
      <div class="card stat"><div class="label">Estoque a custo</div><div class="value">${money(totalCost)}</div><div class="small muted">${totalUnits.toLocaleString('pt-BR')} un na câmara</div></div>
      <div class="card stat"><div class="label">Faturamento potencial (B2B)</div><div class="value">${money(totalB2b)}</div><div class="small muted">${money(totalB2b - totalCost)} acima do custo</div></div>
      <div class="card stat"><div class="label">Faturamento potencial (varejo)</div><div class="value">${money(totalRetail)}</div><div class="small muted">se tudo fosse vendido no balcão</div></div>
    </div>
    <p class="small muted">Físico = o que está na câmara. Reservado = pedidos novos/confirmados ainda não separados. Disponível = o que o cliente consegue pedir.</p>
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
        <td>${esc(p.name)}<div class="small muted">${esc(productPath(p))}${p.barcode ? ` · <span class="mono">${esc(p.barcode)}</span>` : ''}</div></td>
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
  productSuggest($('#stock-search'), {
    products: () => A.products.filter((p) => p.active || p.stock_units),
    detail: (p) => `disp.: ${boxesLabel(p.available_units, p.units_per_box)}`,
    onPick: (p) => { stockSearch = p.name; draw(); },
  });
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
          <td>${esc(p.name)}<div class="small muted">${esc(productPath(p))}${p.last_entry_unit_cost ? ` · última entrada: ${moneyPrecise(p.last_entry_unit_cost)}/un` : ''}</div></td>
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
        <div class="field"><label>Produto</label><input type="search" id="mov-product" placeholder="Todos — digite para buscar" value="${esc(productById(movFilter.product_id)?.name || '')}">
          <input type="hidden" name="product_id" value="${esc(movFilter.product_id || '')}"></div>
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
  const movProduct = $('#mov-product');
  const movProductId = $('input[name=product_id]', form);
  movProduct.addEventListener('input', () => { movProductId.value = ''; });
  productSuggest(movProduct, {
    products: () => A.products,
    onPick: (p) => { movProductId.value = p.id; form.requestSubmit(); },
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (movProduct.value.trim() && !movProductId.value) {
      const [first, second] = matchProducts(A.products, movProduct.value, 2);
      if (!first || second) return toast('Escolha o produto na lista que aparece ao digitar.', 'error');
      movProductId.value = first.id;
    }
    movFilter = formData(form);
    guard(renderMovements);
  });
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
        <td>${esc(p.name)}<div class="small muted">${esc(productPath(p))}${p.sku ? ` · ${esc(p.sku)}` : ''}${p.active ? '' : ' · INATIVO'}</div></td>
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
  productSuggest($('#prod-search'), {
    products: () => A.products,
    detail: (p) => `${money(p.unit_price_cents)}/un${p.active ? '' : ' · inativo'}`,
    onPick: (p) => { productSearch = p.name; draw(); },
  });
  $('#btn-new-product').addEventListener('click', () => openProductForm(null));
  $('#btn-import').addEventListener('click', openImport);
  $('#btn-catalog').addEventListener('click', openCatalogLoader);
  $('#btn-upb').addEventListener('click', openUnitsPerBox);
}

function openProductForm(p, preset = {}, onSaved) {
  const v = p || { units_per_box: 1, sell_box: 1, sell_unit: 1, active: 1, min_stock: 0, category: '', retail_price_cents: null, ...preset };
  const categories = [...new Set(A.products.map((x) => x.category))];
  const types = [...new Set([...PRODUCT_TYPES, ...A.products.map((x) => x.product_type).filter(Boolean)])];
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
        <div class="field"><label>Tipo</label><input name="product_type" list="type-list" value="${esc(v.product_type || '')}" placeholder="Picolés, Potes… (vazio = pelo nome)"><datalist id="type-list">${types.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="field"><label>Linha</label><input name="category" list="cat-list" value="${esc(v.category || '')}" placeholder="Sensa, Clássicos, Disney…"><datalist id="cat-list">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
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
        <td><strong>${esc(c.nome_fantasia || c.razao_social)}</strong><div class="small muted">${esc(c.razao_social)} · ${docLabel(c.cnpj)} ${esc(fmtCnpj(c.cnpj))}</div>
          ${c.allowed_lines ? `<div class="small"><span class="tag tag-low">vê só: ${esc(c.allowed_lines.map((x) => x.replace('|', ' › ')).join(', '))}</span></div>` : ''}</td>
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
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => guard(() => openCustomerForm(customers.find((c) => c.id === Number(b.dataset.edit))))));
  };
  draw();
  $('#cust-search').addEventListener('input', (e) => draw(e.target.value));
  $('#btn-new-customer').addEventListener('click', () => guard(() => openCustomerForm(null)));
}

// Linhas liberadas: árvore Tipo › Linha. Tipo marcado inteiro = "Tipo" (inclui linhas novas);
// só algumas linhas = "Tipo|Linha". Tudo marcado = sem restrição (null).
function allowedLinesHtml(tree, allowed) {
  const has = (key) => !allowed || allowed.includes(key);
  return tree.map(({ type, lines }) => {
    const whole = has(type);
    return `<div class="lines-type">
      <label class="check"><input type="checkbox" data-ltype="${esc(type)}" ${whole || lines.every((l) => has(`${type}|${l}`)) ? 'checked' : ''}> <strong>${esc(type)}</strong></label>
      ${lines.length > 1 || lines[0] !== type ? `<div class="lines-sub">${lines.map((l) => `<label class="check"><input type="checkbox" data-lline="${esc(`${type}|${l}`)}" ${whole || has(`${type}|${l}`) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
}
function readAllowedLinesForm(root, tree) {
  const out = [];
  let all = true;
  for (const { type, lines } of tree) {
    const subs = $$(`[data-lline^="${CSS.escape(type)}|"]`, root).filter((x) => x.dataset.lline.split('|')[0] === type);
    const typeBox = $(`[data-ltype="${CSS.escape(type)}"]`, root);
    if (!subs.length) { if (typeBox.checked) out.push(type); else all = false; continue; }
    const on = subs.filter((x) => x.checked).map((x) => x.dataset.lline);
    if (on.length === lines.length) out.push(type);
    else { all = false; out.push(...on); }
  }
  return all ? null : out;
}

async function openCustomerForm(c) {
  await loadProducts();
  const tree = productTree(A.products.filter((p) => p.active));
  const v = c || {};
  const m = openModal(`
    <div class="modal-head"><h2>${c ? 'Editar cliente' : 'Cadastrar cliente'}</h2><button class="modal-close" data-close>×</button></div>
    <form id="form-customer">
      <div class="form-grid">
        <div class="field"><label>CNPJ ou CPF *</label><input name="cnpj" inputmode="numeric" value="${esc(fmtCnpj(v.cnpj || ''))}" ${c ? 'disabled' : 'required'}></div>
        ${c ? `<div class="field"><label>Situação</label><select name="status">${['pendente', 'ativo', 'bloqueado'].map((s) => `<option value="${s}" ${s === v.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label>Razão social (ou nome, se CPF) *</label><input name="razao_social" required value="${esc(v.razao_social || '')}"></div>
        <div class="field"><label>Nome fantasia</label><input name="nome_fantasia" value="${esc(v.nome_fantasia || '')}"></div>
        <div class="field"><label>Responsável</label><input name="contato" value="${esc(v.contato || '')}"></div>
        <div class="field"><label>Telefone / WhatsApp</label><input name="telefone" value="${esc(v.telefone || '')}"></div>
        <div class="field"><label>E-mail</label><input name="email" type="email" value="${esc(v.email || '')}"></div>
        <div class="field"><label>Cidade</label><input name="cidade" value="${esc(v.cidade || '')}"></div>
      </div>
      <div class="field"><label>Endereço</label><input name="endereco" value="${esc(v.endereco || '')}"></div>
      <div class="field"><label>Observações internas</label><input name="notes" value="${esc(v.notes || '')}"></div>
      <div class="field"><label>Linhas que o cliente pode ver e pedir</label>
        <div class="small muted" style="margin-bottom:6px">Desmarque o que ele não compra. Tipo inteiro marcado inclui as linhas novas que forem cadastradas.</div>
        <div class="row" style="margin-bottom:6px"><button type="button" class="btn-secondary btn-sm" id="lines-all">Marcar tudo</button><button type="button" class="btn-secondary btn-sm" id="lines-none">Desmarcar tudo</button></div>
        <div class="lines-box" id="lines-box">${allowedLinesHtml(tree, v.allowed_lines || null)}</div></div>
      <div class="field"><label>${c ? 'Nova senha (deixe vazio para manter)' : 'Senha inicial * (mín. 6)'}</label><input name="senha" type="text" ${c ? '' : 'required minlength="6"'} autocomplete="off"></div>
      <div class="row"><button type="submit">Salvar</button><button type="button" class="btn-secondary" data-close>Cancelar</button></div>
    </form>`);
  const form = $('#form-customer', m);
  if (!c) maskCnpj(form.cnpj);
  const box = $('#lines-box', m);
  // tipo liga/desliga todas as linhas dele; linhas atualizam o tipo
  $$('[data-ltype]', box).forEach((t) => t.addEventListener('change', () => {
    $$('[data-lline]', t.closest('.lines-type')).forEach((x) => { x.checked = t.checked; });
  }));
  $$('[data-lline]', box).forEach((x) => x.addEventListener('change', () => {
    const group = x.closest('.lines-type');
    $('[data-ltype]', group).checked = $$('[data-lline]', group).every((y) => y.checked);
  }));
  $('#lines-all', m).addEventListener('click', () => $$('input[type=checkbox]', box).forEach((x) => { x.checked = true; }));
  $('#lines-none', m).addEventListener('click', () => $$('input[type=checkbox]', box).forEach((x) => { x.checked = false; }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(form, async (data) => {
      data.allowed_lines = readAllowedLinesForm(box, tree);
      if (Array.isArray(data.allowed_lines) && !data.allowed_lines.length) throw new Error('Libere ao menos uma linha para o cliente.');
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
  const [{ settings: s }, { admins }, { locations }, { reasons }, { types }] = await Promise.all([
    api('/api/admin/config'), api('/api/admin/usuarios'), api('/api/admin/locais'), api('/api/admin/motivos'), api('/api/admin/tipos-saida'),
  ]);
  const stores = locations.filter((l) => l.kind === 'loja' && l.active);
  const storeOptions = (sel) => stores.map((l) => `<option value="${l.id}" ${l.id === sel ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
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
        <div class="card">
          <h2>Saídas sem venda (brinde, parceria…)</h2>
          <div class="table-wrap"><table><tbody>${types.map((t) => `
            <tr ${t.active ? '' : 'style="opacity:.5"'}><td><input value="${esc(t.label)}" data-st-name="${esc(t.key)}"></td>
              <td><label class="check small"><input type="checkbox" data-st-note="${esc(t.key)}" ${t.requires_note ? 'checked' : ''}> exige obs.</label></td>
              <td class="nowrap"><button class="btn-secondary btn-sm" data-st-save="${esc(t.key)}">Salvar</button>
                <button class="btn-secondary btn-sm" data-st-toggle="${esc(t.key)}" data-active="${t.active}">${t.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('')}
          </tbody></table></div>
          <form id="form-stype" class="row" style="margin-top:10px"><input name="label" class="grow" placeholder="Novo tipo (ex.: Evento)" required>
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
          <p class="small muted"><strong>Master</strong>: acesso a tudo (custos, financeiro, configurações).
            <strong>Loja</strong>: vê o estoque da câmara (sem valores) e registra a reposição da própria loja.</p>
          <div class="table-wrap"><table><tbody>${admins.map((a) => `
            <tr ${a.active ? '' : 'style="opacity:.5"'}>
              <td>${esc(a.name)}<div class="small muted">${esc(a.email)}</div></td>
              <td><span class="tag ${a.role === 'master' ? 'tag-confirmado' : 'tag-novo'}">${a.role === 'master' ? 'Master' : `Loja · ${esc(a.location_name || '?')}`}</span>
                ${a.active ? '' : '<span class="tag tag-cancelado">desativado</span>'}</td>
              <td class="nowrap"><button class="btn-secondary btn-sm" data-user="${a.id}">Editar</button></td>
            </tr>`).join('')}</tbody></table></div>
          <form id="form-user" style="margin-top:12px">
            <div class="form-grid">
              <div class="field"><label>Nome</label><input name="name" required></div>
              <div class="field"><label>E-mail</label><input name="email" type="email" required></div>
              <div class="field"><label>Senha (mín. 8)</label><input name="senha" type="text" minlength="8" required autocomplete="off"></div>
              <div class="field"><label>Perfil</label><select name="role" id="new-role"><option value="loja">Loja</option><option value="master">Master</option></select></div>
              <div class="field" id="new-loc-field"><label>Loja</label><select name="location_id">${storeOptions(stores[0]?.id)}</select></div>
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
  act('[data-st-save]', (b) => api(`/api/admin/tipos-saida/${encodeURIComponent(b.dataset.stSave)}`, {
    method: 'PUT', body: { label: $(`[data-st-name="${b.dataset.stSave}"]`).value, requires_note: $(`[data-st-note="${b.dataset.stSave}"]`).checked },
  }));
  act('[data-st-toggle]', (b) => api(`/api/admin/tipos-saida/${encodeURIComponent(b.dataset.stToggle)}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } }));
  onSubmit('#form-stype', async (data) => {
    await api('/api/admin/tipos-saida', { method: 'POST', body: data });
    toast('Tipo adicionado.', 'ok');
    renderConfig();
  });
  const roleSel = $('#new-role');
  const syncRole = () => $('#new-loc-field').classList.toggle('hidden', roleSel.value !== 'loja');
  roleSel.addEventListener('change', syncRole);
  syncRole();
  $$('[data-user]').forEach((b) => b.addEventListener('click', () => openUserForm(admins.find((a) => a.id === Number(b.dataset.user)), storeOptions)));
}

function openUserForm(u, storeOptions) {
  const m = openModal(`
    <div class="modal-head"><h2>Usuário: ${esc(u.name)}</h2><button class="modal-close" data-close>×</button></div>
    <form id="form-edit-user">
      <div class="form-grid">
        <div class="field"><label>Nome</label><input name="name" value="${esc(u.name)}" required></div>
        <div class="field"><label>Perfil</label><select name="role" id="edit-role">
          <option value="master" ${u.role === 'master' ? 'selected' : ''}>Master</option><option value="loja" ${u.role === 'loja' ? 'selected' : ''}>Loja</option></select></div>
        <div class="field" id="edit-loc-field"><label>Loja</label><select name="location_id">${storeOptions(u.location_id)}</select></div>
        <div class="field"><label>Nova senha (vazio = manter)</label><input name="senha" type="text" minlength="8" autocomplete="off"></div>
      </div>
      <label class="check" style="margin-bottom:12px"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Ativo (pode entrar no painel)</label>
      <div class="row"><button type="submit">Salvar</button><button type="button" class="btn-secondary" data-close>Cancelar</button></div>
    </form>`);
  const sel = $('#edit-role', m);
  const sync = () => $('#edit-loc-field', m).classList.toggle('hidden', sel.value !== 'loja');
  sel.addEventListener('change', sync);
  sync();
  const form = $('#form-edit-user', m);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(form, async (data) => {
      if (!data.senha) delete data.senha;
      await api(`/api/admin/usuarios/${u.id}`, { method: 'PUT', body: data });
      toast('Usuário salvo.', 'ok');
      closeModal();
      renderConfig();
    });
  });
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

// _class das linhas: 'danger' (vermelho) e, no financeiro, 'sub', 'total', 'strong'.
const rowClass = (c) => String(c || '').split(' ').filter(Boolean).map((k) => (k === 'danger' ? 'row-danger' : `r-${k}`)).join(' ');

function reportTable(sec) {
  const right = (c) => (c.type === 'text' ? '' : 'num nowrap');
  return `
    <div class="card report-section">
      <h2>${esc(sec.title)}</h2>
      ${sec.rows.length ? `<div class="table-wrap"><table>
        <thead><tr>${sec.columns.map((c) => `<th class="${right(c)}">${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${sec.rows.map((r) => `<tr class="${rowClass(r._class)}">${sec.columns.map((c) => `<td class="${right(c)}">${reportCell(c, r)}</td>`).join('')}</tr>`).join('')}</tbody>
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

// ======================= USUÁRIO DA LOJA =======================
let storeSearch = '';
async function renderStoreStock() {
  const { products, location: loc } = await api('/api/admin/loja/estoque');
  A.products = sortByHierarchy(products);
  app.innerHTML = `
    <div class="section-head"><h1>Estoque da câmara</h1><span class="spacer"></span>
      <input type="search" id="store-search" placeholder="Buscar produto…" style="max-width:260px" value="${esc(storeSearch)}">
      <button id="btn-go-restock">Repor ${esc(loc || 'loja')}</button></div>
    <p class="small muted">Quantidades na câmara agora. “Reservado” são pedidos de clientes ainda não separados: não use esses produtos para repor a loja.</p>
    <div class="card" style="padding:0"><div class="table-wrap"><table>
      <thead><tr><th></th><th>Produto</th><th class="num">Na câmara</th><th class="num hide-sm">Reservado</th><th class="num">Livre para repor</th></tr></thead>
      <tbody id="store-body"></tbody></table></div></div>`;
  const draw = () => {
    const term = storeSearch.toLowerCase();
    const list = A.products.filter((p) => !term || p.name.toLowerCase().includes(term) || p.category.toLowerCase().includes(term) || (p.barcode || '').includes(term));
    $('#store-body').innerHTML = list.map((p) => `
      <tr ${p.stock_units ? '' : 'style="opacity:.55"'}>
        <td style="width:52px">${thumb(p)}</td>
        <td>${esc(p.name)}<div class="small muted">${esc(productPath(p))}</div></td>
        <td class="num nowrap">${boxesLabel(p.stock_units, p.units_per_box)}</td>
        <td class="num nowrap hide-sm">${p.reserved_units ? boxesLabel(p.reserved_units, p.units_per_box) : '—'}</td>
        <td class="num nowrap"><strong>${boxesLabel(Math.max(0, p.available_units), p.units_per_box)}</strong></td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum produto.</td></tr>';
  };
  draw();
  $('#store-search').addEventListener('input', (e) => { storeSearch = e.target.value; draw(); });
  productSuggest($('#store-search'), {
    products: () => products,
    detail: (p) => `livre: ${boxesLabel(Math.max(0, p.available_units), p.units_per_box)}`,
    onPick: (p) => { storeSearch = p.name; draw(); },
  });
  $('#btn-go-restock').addEventListener('click', () => setView('loja-repor'));
}

let restockLines = [];
async function renderRestock() {
  const [{ products, location: loc }, { movements }] = await Promise.all([api('/api/admin/loja/estoque'), api('/api/admin/loja/reposicoes')]);
  A.products = products;
  app.innerHTML = `
    <div class="section-head"><h1>Repor ${esc(loc || 'loja')}</h1></div>
    <div class="card">
      <p class="muted" style="margin-top:0">Bipe o que você está levando da câmara para a loja (o código da caixa conta a caixa inteira), ou digite o nome do produto e Enter.</p>
      <input class="scan-input" id="rs-scan" placeholder="Bipe o código de barras ou comece a digitar o nome" autocomplete="off">
      <div id="rs-picker"></div>
      <div class="table-wrap" style="margin-top:14px"><table>
        <thead><tr><th>Produto</th><th class="num">Caixas</th><th class="num">Unid.</th><th class="num">Total un</th><th></th></tr></thead>
        <tbody id="rs-body"></tbody>
      </table></div>
      <div class="field" style="margin-top:12px"><label for="rs-note">Observação</label><input id="rs-note" placeholder="Opcional"></div>
      <div class="row"><button class="btn-ok" id="rs-confirm">Confirmar reposição</button><button class="btn-secondary" id="rs-clear">Limpar lista</button></div>
    </div>
    <div class="card">
      <h2>Últimas reposições</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Data</th><th>Produto</th><th class="num">Qtd</th><th class="hide-sm">Por</th></tr></thead>
        <tbody>${movements.slice(0, 50).map((m) => `
          <tr ${m.reversed ? 'style="opacity:.5"' : ''}><td class="nowrap">${fmtDate(m.created_at)}</td><td>${esc(m.product_name)}${m.reversed ? ' <span class="tag tag-cancelado">estornado</span>' : ''}</td>
            <td class="num nowrap">${boxesLabel(-m.quantity, m.units_per_box)}</td><td class="hide-sm small">${esc(m.created_by || '')}</td></tr>`).join('')
          || '<tr><td colspan="4" class="empty">Nenhuma reposição ainda.</td></tr>'}</tbody>
      </table></div>
    </div>`;
  const draw = (hl) => {
    $('#rs-body').innerHTML = restockLines.map((l, i) => {
      const p = productById(l.product_id);
      const cx = Math.floor(l.units / p.units_per_box);
      const over = l.units > Math.max(0, p.available_units);
      return `<tr ${l.product_id === hl ? 'style="background:var(--ok-soft)"' : ''} class="${over ? 'row-danger' : ''}">
        <td>${esc(p.name)}<div class="small ${over ? '' : 'muted'}">${over ? `só há ${boxesLabel(Math.max(0, p.available_units), p.units_per_box)} livre na câmara` : `Caixa c/ ${p.units_per_box} un`}</div></td>
        <td class="num"><input type="number" min="0" class="qty-input" data-rcx="${i}" value="${cx}" ${p.units_per_box <= 1 ? 'disabled' : ''}></td>
        <td class="num"><input type="number" min="0" class="qty-input" data-run="${i}" value="${l.units - cx * p.units_per_box}"></td>
        <td class="num"><strong>${l.units}</strong></td>
        <td><button class="btn-danger btn-sm" data-rdel="${i}">✕</button></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">Nenhum item. Bipe o primeiro produto.</td></tr>';
    const upd = (i) => {
      const p = productById(restockLines[i].product_id);
      restockLines[i].units = Math.max(0, Number($(`[data-rcx="${i}"]`).value) || 0) * p.units_per_box + Math.max(0, Number($(`[data-run="${i}"]`).value) || 0);
      draw();
    };
    $$('[data-rcx]').forEach((x) => x.addEventListener('change', () => upd(Number(x.dataset.rcx))));
    $$('[data-run]').forEach((x) => x.addEventListener('change', () => upd(Number(x.dataset.run))));
    $$('[data-rdel]').forEach((x) => x.addEventListener('click', () => { restockLines.splice(Number(x.dataset.rdel), 1); draw(); }));
  };
  const addUnits = (p, units) => {
    let l = restockLines.find((x) => x.product_id === p.id);
    if (!l) { l = { product_id: p.id, units: 0 }; restockLines.unshift(l); }
    l.units += units;
    draw(p.id);
  };
  draw();
  const scan = $('#rs-scan');
  productSuggest(scan, {
    products: () => products,
    detail: (p) => `livre: ${boxesLabel(Math.max(0, p.available_units), p.units_per_box)}`,
    clearOnPick: true,
    onPick: (p) => { $('#rs-picker').innerHTML = ''; addUnits(p, 0); scan.focus(); },
  });
  scan.focus();
  scan.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const term = scan.value.trim();
    scan.value = '';
    $('#rs-picker').innerHTML = '';
    if (!term) return;
    const exact = products.find((p) => p.barcode === term || p.box_barcode === term || p.sku === term);
    if (exact) { beep(true); addUnits(exact, exact.box_barcode === term ? exact.units_per_box : 1); return; }
    const matches = products.filter((p) => p.name.toLowerCase().includes(term.toLowerCase()));
    if (matches.length === 1) { addUnits(matches[0], 0); return; }
    if (!matches.length) { beep(false); toast(`Nada encontrado para "${term}".`, 'error'); return; }
    $('#rs-picker').innerHTML = `<div class="chips" style="margin-top:10px">${matches.slice(0, 30).map((p) => `<button class="chip" data-rpick="${p.id}">${esc(p.name)}</button>`).join('')}</div>`;
    $$('[data-rpick]').forEach((b) => b.addEventListener('click', () => { addUnits(productById(b.dataset.rpick), 0); $('#rs-picker').innerHTML = ''; scan.focus(); }));
  });
  $('#rs-clear').addEventListener('click', () => { restockLines = []; draw(); });
  $('#rs-confirm').addEventListener('click', () => guard(async () => {
    const lines = restockLines.filter((l) => l.units > 0);
    if (!lines.length) return toast('Informe as quantidades.', 'error');
    const total = lines.reduce((s, l) => s + l.units, 0);
    if (!confirm(`Confirmar reposição de ${lines.length} produto(s), ${total} unidades, para ${loc || 'a loja'}?`)) return;
    await api('/api/admin/loja/reposicao', { method: 'POST', body: { lines, note: $('#rs-note').value } });
    toast('Reposição registrada!', 'ok');
    restockLines = [];
    renderRestock();
  }));
}

// ======================= FINANCEIRO (DRE / DFC) =======================
const F = { tab: 'lancamentos', from: null, to: null, campo: 'competencia', status: '', kind: '', opts: null };

async function renderFinance() {
  if (!F.from) [F.from, F.to] = monthRange(0);
  F.opts = await api('/api/admin/financeiro/opcoes');
  const tabs = { lancamentos: 'Lançamentos', bancos: 'Bancos e conciliação', dre: 'DRE', dfc: 'DFC (caixa)', extratos: 'Extratos por banco', contas: 'Plano de contas' };
  app.innerHTML = `
    <div class="section-head"><h1>Financeiro</h1><span class="spacer"></span>
      ${F.tab === 'lancamentos' ? '<button id="btn-new-entry">+ Novo lançamento</button>' : ''}</div>
    <div class="chips">${Object.entries(tabs).map(([k, v]) => `<button class="chip ${k === F.tab ? 'active' : ''}" data-ft="${k}">${v}</button>`).join('')}</div>
    ${F.tab !== 'contas' && F.tab !== 'bancos' ? `
    <form class="card" id="fin-filter"><div class="row">
      ${F.tab === 'lancamentos' ? `<div class="field"><label>Período por</label><select id="f-campo">
        <option value="competencia" ${F.campo === 'competencia' ? 'selected' : ''}>Competência</option>
        <option value="vencimento" ${F.campo === 'vencimento' ? 'selected' : ''}>Vencimento</option>
        <option value="pagamento" ${F.campo === 'pagamento' ? 'selected' : ''}>Pagamento</option></select></div>` : ''}
      <div class="field"><label for="f-from">De</label><input type="date" id="f-from" value="${F.from}"></div>
      <div class="field"><label for="f-to">Até</label><input type="date" id="f-to" value="${F.to}"></div>
      ${F.tab === 'lancamentos' ? `<div class="field"><label>Situação</label><select id="f-status">
        <option value="">Todos</option><option value="aberto" ${F.status === 'aberto' ? 'selected' : ''}>Em aberto</option><option value="pago" ${F.status === 'pago' ? 'selected' : ''}>Pagos</option></select></div>
        <div class="field"><label>Tipo</label><select id="f-kind"><option value="">Receitas e despesas</option>
        <option value="receita" ${F.kind === 'receita' ? 'selected' : ''}>Receitas</option><option value="despesa" ${F.kind === 'despesa' ? 'selected' : ''}>Despesas</option></select></div>` : ''}
      <div class="field"><label>&nbsp;</label><div class="row">
        <button type="button" class="btn-secondary btn-sm" data-fp="0">Este mês</button>
        <button type="button" class="btn-secondary btn-sm" data-fp="-1">Mês passado</button>
        <button type="button" class="btn-secondary btn-sm" data-fp="year">Este ano</button></div></div>
      <span class="grow"></span>
      <div class="field"><label>&nbsp;</label><div class="row"><button type="submit">Atualizar</button>
        ${F.tab !== 'lancamentos' ? '<button type="button" class="btn-secondary" data-fexp="xlsx">Excel</button><button type="button" class="btn-secondary" data-fexp="csv">CSV</button>' : ''}</div></div>
    </div></form>` : ''}
    <div id="fin-body"><div class="empty">Carregando…</div></div>`;
  $$('[data-ft]').forEach((b) => b.addEventListener('click', () => { F.tab = b.dataset.ft; guard(renderFinance); }));
  const filter = $('#fin-filter');
  if (filter) {
    filter.addEventListener('submit', (e) => {
      e.preventDefault();
      F.from = $('#f-from').value; F.to = $('#f-to').value;
      if ($('#f-campo')) { F.campo = $('#f-campo').value; F.status = $('#f-status').value; F.kind = $('#f-kind').value; }
      guard(renderFinance);
    });
    $$('[data-fp]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.fp === 'year') [F.from, F.to] = [`${todayLocal().slice(0, 4)}-01-01`, todayLocal()];
      else [F.from, F.to] = monthRange(Number(b.dataset.fp));
      guard(renderFinance);
    }));
    $$('[data-fexp]').forEach((b) => b.addEventListener('click', () => downloadUrl(`/api/admin/relatorios/${F.tab === 'extratos' ? 'bancos' : F.tab}?from=${F.from}&to=${F.to}&formato=${b.dataset.fexp}`)));
  }
  const nb = $('#btn-new-entry');
  if (nb) nb.addEventListener('click', () => openEntryForm(null));
  if (F.tab === 'lancamentos') return renderEntries();
  if (F.tab === 'contas') return renderAccounts();
  if (F.tab === 'bancos') return renderBanks();
  const { report } = await api(`/api/admin/relatorios/${F.tab === 'extratos' ? 'bancos' : F.tab}?from=${F.from}&to=${F.to}`);
  $('#fin-body').innerHTML = `
    <div class="report-head"><h2>${esc(report.title)}</h2><p class="small muted">${esc(report.subtitle || '')}</p></div>
    ${(report.warnings || []).map((w) => `<div class="alert alert-info small">${esc(w)}</div>`).join('')}
    ${report.sections.map(reportTable).join('')}`;
}

async function renderEntries() {
  const qs = new URLSearchParams({ from: F.from, to: F.to, campo: F.campo, status: F.status, kind: F.kind }).toString();
  const { entries, open } = await api(`/api/admin/financeiro/lancamentos?${qs}`);
  const sign = (e) => (e.kind === 'receita' ? 1 : -1);
  const net = entries.reduce((s, e) => s + sign(e) * e.amount_cents, 0);
  $('#fin-body').innerHTML = `
    <div class="grid grid-4" style="margin-bottom:16px">
      <div class="card stat"><div class="label">A receber (em aberto)</div><div class="value qty-pos">${money(open.receita || 0)}</div></div>
      <div class="card stat"><div class="label">A pagar (em aberto)</div><div class="value qty-neg">${money(open.despesa || 0)}</div></div>
      <div class="card stat"><div class="label">Saldo dos lançamentos listados</div><div class="value">${money(net)}</div><div class="small muted">${entries.length} lançamento(s)</div></div>
    </div>
    <div class="card" style="padding:0"><div class="table-wrap"><table>
      <thead><tr><th>${F.campo === 'pagamento' ? 'Pago em' : F.campo === 'vencimento' ? 'Vencimento' : 'Competência'}</th><th>Conta</th><th>Descrição</th><th class="num">Valor</th>
        <th class="hide-sm">Vencimento</th><th>Situação</th><th></th></tr></thead>
      <tbody>${entries.map((e) => `
        <tr>
          <td class="nowrap">${fmtDate(F.campo === 'pagamento' ? e.paid_date : F.campo === 'vencimento' ? e.due_date : e.competence_date, false)}</td>
          <td>${esc(e.account_name)}${e.location_name ? `<div class="small muted">${esc(e.location_name)}</div>` : ''}</td>
          <td>${esc(e.description)}${e.counterparty ? `<div class="small muted">${esc(e.counterparty)}</div>` : ''}</td>
          <td class="num nowrap ${e.kind === 'receita' ? 'qty-pos' : 'qty-neg'}">${e.kind === 'receita' ? '' : '−'}${money(e.amount_cents)}</td>
          <td class="hide-sm nowrap">${e.due_date ? fmtDate(e.due_date, false) : '—'}</td>
          <td>${e.paid_date ? `<span class="tag tag-entregue">${e.kind === 'receita' ? 'recebido' : 'pago'} ${fmtDate(e.paid_date, false)}</span>`
            : `<button class="btn-ok btn-sm" data-pay="${e.id}">${e.kind === 'receita' ? 'Recebido hoje' : 'Pago hoje'}</button>`}</td>
          <td class="nowrap"><button class="btn-secondary btn-sm" data-edit-entry="${e.id}">Editar</button></td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty">Nenhum lançamento no período. Use “+ Novo lançamento”.</td></tr>'}</tbody>
    </table></div></div>`;
  $$('[data-pay]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    await api(`/api/admin/financeiro/lancamentos/${b.dataset.pay}/pagar`, { method: 'POST', body: {} });
    toast('Baixa registrada.', 'ok');
    renderEntries();
  })));
  $$('[data-edit-entry]').forEach((b) => b.addEventListener('click', () => openEntryForm(entries.find((e) => e.id === Number(b.dataset.editEntry)))));
}

function openEntryForm(e) {
  const accounts = F.opts.accounts.filter((a) => a.active || (e && a.id === e.account_id));
  const v = e || { kind: 'despesa', competence_date: todayLocal() };
  const kind = e ? e.kind : 'despesa';
  const accOptions = (k) => accounts.filter((a) => a.kind === k).map((a) => `<option value="${a.id}" ${e && a.id === e.account_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const m = openModal(`
    <div class="modal-head"><h2>${e ? 'Editar lançamento' : 'Novo lançamento'}</h2><button class="modal-close" data-close>×</button></div>
    <form id="form-entry">
      <div class="tabs"><button type="button" data-k="despesa" class="${kind === 'despesa' ? 'active' : ''}">Despesa / pagamento</button>
        <button type="button" data-k="receita" class="${kind === 'receita' ? 'active' : ''}">Receita / recebimento</button></div>
      <div class="form-grid">
        <div class="field"><label>Conta *</label><select name="account_id" id="entry-account">${accOptions(kind)}</select></div>
        <div class="field"><label>Valor (R$) *</label><input name="amount" inputmode="decimal" required value="${e ? centsToInput(e.amount_cents) : ''}"></div>
        <div class="field"><label>Descrição</label><input name="description" value="${esc(v.description || '')}" placeholder="Ex.: aluguel de outubro"></div>
        <div class="field"><label>Favorecido / cliente</label><input name="counterparty" value="${esc(v.counterparty || '')}"></div>
        <div class="field"><label>Competência * (mês do resultado)</label><input type="date" name="competence_date" required value="${esc(v.competence_date || '')}"></div>
        <div class="field"><label>Vencimento</label><input type="date" name="due_date" value="${esc(v.due_date || '')}"></div>
        <div class="field"><label>Pago / recebido em (vazio = em aberto)</label><input type="date" name="paid_date" value="${esc(v.paid_date || '')}"></div>
        <div class="field"><label>Loja / local (opcional)</label><select name="location_id"><option value="">—</option>
          ${F.opts.locations.map((l) => `<option value="${l.id}" ${v.location_id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Documento</label><input name="document" value="${esc(v.document || '')}" placeholder="NF, boleto…"></div>
      </div>
      <div class="field"><label>Observação</label><input name="note" value="${esc(v.note || '')}"></div>
      <p class="small muted" id="entry-hint"></p>
      <div class="row"><button type="submit">Salvar</button><button type="button" class="btn-secondary" data-close>Cancelar</button>
        ${e ? '<span style="flex:1"></span><button type="button" class="btn-danger" id="btn-del-entry">Excluir</button>' : ''}</div>
    </form>`, { wide: true });
  const hint = () => {
    const a = F.opts.accounts.find((x) => x.id === Number($('#entry-account', m).value));
    $('#entry-hint', m).textContent = !a ? '' : `${a.dre_group ? `Entra na DRE em “${F.opts.dre_groups[a.dre_group]}”` : 'Não entra na DRE (o estoque já calcula, ou é só movimento de caixa)'}`
      + ` · na DFC: ${F.opts.dfc_activities[a.dfc_activity || 'operacional']}.`;
  };
  $$('[data-k]', m).forEach((b) => b.addEventListener('click', () => {
    $$('[data-k]', m).forEach((x) => x.classList.toggle('active', x === b));
    $('#entry-account', m).innerHTML = accOptions(b.dataset.k);
    hint();
  }));
  $('#entry-account', m).addEventListener('change', hint);
  hint();
  const form = $('#form-entry', m);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitWith(form, async (data) => {
      if (e) await api(`/api/admin/financeiro/lancamentos/${e.id}`, { method: 'PUT', body: data });
      else await api('/api/admin/financeiro/lancamentos', { method: 'POST', body: data });
      toast('Lançamento salvo.', 'ok');
      closeModal();
      renderEntries();
    });
  });
  const del = $('#btn-del-entry', m);
  if (del) del.addEventListener('click', () => guard(async () => {
    if (!confirm('Excluir este lançamento?')) return;
    await api(`/api/admin/financeiro/lancamentos/${e.id}`, { method: 'DELETE' });
    toast('Lançamento excluído.', 'ok');
    closeModal();
    renderEntries();
  }));
}

function renderAccounts() {
  const o = F.opts;
  const dreOptions = (sel) => `<option value="">— não entra na DRE —</option>${Object.entries(o.dre_groups).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('')}`;
  const dfcOptions = (sel) => Object.entries(o.dfc_activities).map(([k, v]) => `<option value="${k}" ${k === (sel || 'operacional') ? 'selected' : ''}>${esc(v)}</option>`).join('');
  $('#fin-body').innerHTML = `
    <form class="card row" id="form-opening">
      <div class="field grow"><label>Saldo inicial em dinheiro (fora dos bancos). O saldo dos bancos vem sozinho dos extratos OFX.</label>
        <input name="valor" inputmode="decimal" value="${centsToInput(o.cash_opening_cents)}"></div>
      <div class="field"><label>&nbsp;</label><button type="submit">Salvar saldo inicial</button></div>
    </form>
    <div class="alert alert-info small">Venda B2B, CMV, perdas, brindes e transferências para as lojas entram <strong>sozinhos</strong> na DRE, vindos do estoque.
      Por isso “Recebimento de clientes B2B” e “Pagamento de notas de mercadoria” não entram na DRE, só no caixa (DFC): assim nada é contado duas vezes.</div>
    <div class="card" style="padding:0"><div class="table-wrap"><table>
      <thead><tr><th>Conta</th><th>Tipo</th><th>Linha da DRE</th><th>DFC</th><th></th></tr></thead>
      <tbody>${o.accounts.map((a) => `
        <tr ${a.active ? '' : 'style="opacity:.5"'}>
          <td><input value="${esc(a.name)}" data-acc-name="${a.id}"></td>
          <td>${a.kind === 'receita' ? '<span class="tag tag-ok">receita</span>' : '<span class="tag tag-out">despesa</span>'}</td>
          <td><select data-acc-dre="${a.id}">${dreOptions(a.dre_group)}</select></td>
          <td><select data-acc-dfc="${a.id}">${dfcOptions(a.dfc_activity)}</select></td>
          <td class="nowrap"><button class="btn-secondary btn-sm" data-acc-save="${a.id}">Salvar</button>
            <button class="btn-secondary btn-sm" data-acc-toggle="${a.id}" data-active="${a.active}">${a.active ? 'Desativar' : 'Ativar'}</button></td>
        </tr>`).join('')}</tbody>
    </table></div></div>
    <form class="card" id="form-acc">
      <h2>Nova conta</h2>
      <div class="form-grid">
        <div class="field"><label>Nome</label><input name="name" required></div>
        <div class="field"><label>Tipo</label><select name="kind"><option value="despesa">Despesa</option><option value="receita">Receita</option></select></div>
        <div class="field"><label>Linha da DRE</label><select name="dre_group">${dreOptions('despesas_administrativas')}</select></div>
        <div class="field"><label>DFC</label><select name="dfc_activity">${dfcOptions('operacional')}</select></div>
      </div>
      <button type="submit" class="btn-secondary">+ Adicionar conta</button>
    </form>`;
  const reload = async () => { F.opts = await api('/api/admin/financeiro/opcoes'); renderAccounts(); };
  const fo = $('#form-opening');
  fo.addEventListener('submit', (e) => { e.preventDefault(); submitWith(fo, async (d) => { await api('/api/admin/financeiro/saldo-inicial', { method: 'PUT', body: d }); toast('Saldo inicial salvo.', 'ok'); await reload(); }); });
  const fa = $('#form-acc');
  fa.addEventListener('submit', (e) => { e.preventDefault(); submitWith(fa, async (d) => { await api('/api/admin/financeiro/contas', { method: 'POST', body: d }); toast('Conta criada.', 'ok'); await reload(); }); });
  $$('[data-acc-save]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    const id = b.dataset.accSave;
    await api(`/api/admin/financeiro/contas/${id}`, { method: 'PUT', body: { name: $(`[data-acc-name="${id}"]`).value, dre_group: $(`[data-acc-dre="${id}"]`).value, dfc_activity: $(`[data-acc-dfc="${id}"]`).value } });
    toast('Conta salva.', 'ok');
    await reload();
  })));
  $$('[data-acc-toggle]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    await api(`/api/admin/financeiro/contas/${b.dataset.accToggle}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } });
    await reload();
  })));
}

// ======================= BANCOS (OFX) E CONCILIAÇÃO =======================
const BK = { conta: '', status: 'pendente', from: '', to: '', selected: new Set() };
const IGNORE_REASONS = ['Transferência entre contas próprias', 'Aplicação / resgate financeiro', 'Pagamento de fatura do cartão (já lançado no cartão)', 'Outro'];

function toBase64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
  return btoa(bin);
}

async function renderBanks() {
  const [{ accounts }, { transactions }, { rules }] = await Promise.all([
    api('/api/admin/banco/contas'),
    api(`/api/admin/banco/transacoes?${new URLSearchParams({ conta: BK.conta, status: BK.status, from: BK.from, to: BK.to })}`),
    api('/api/admin/banco/regras'),
  ]);
  BK.selected = new Set([...BK.selected].filter((id) => transactions.some((t) => t.id === id && t.status === 'pendente')));
  const finAcc = F.opts.accounts.filter((a) => a.active);
  const accOptions = (kind, sel) => `<option value="">Escolha a conta…</option>${finAcc.filter((a) => a.kind === kind)
    .map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}`;
  const pendingCount = accounts.reduce((s, a) => s + a.pending, 0);
  $('#fin-body').innerHTML = `
    <div class="card">
      <h2>Importar extratos (OFX)</h2>
      <p class="small muted">No internet banking, exporte o extrato em <strong>OFX</strong> (Itaú, Santander, Bradesco, C6 e outros). Pode enviar vários arquivos e meses de uma vez:
        o que já foi importado é ignorado, mesmo que os períodos se sobreponham.</p>
      <div class="row"><input type="file" id="ofx-files" accept=".ofx,.OFX" multiple class="grow"><button id="btn-ofx">Importar</button></div>
      <div id="ofx-result" style="margin-top:10px"></div>
    </div>
    ${accounts.length ? `
    <div class="card" style="padding:0"><div class="table-wrap"><table>
      <thead><tr><th>Conta</th><th>Período importado</th><th class="num">Saldo (pelos extratos)</th><th>Conferência</th><th class="num">Pendentes</th><th></th></tr></thead>
      <tbody>${accounts.map((a) => `
        <tr ${a.active ? '' : 'style="opacity:.5"'}>
          <td><input value="${esc(a.name)}" data-bk-name="${a.id}"><div class="small muted">${esc(a.bank_name || '')} · ${a.kind === 'cartao' ? 'cartão de crédito' : `ag. ${esc(a.branch || '—')} c/c ${esc(a.account_number)}`}</div></td>
          <td class="small nowrap">${a.first ? `${fmtDate(a.first, false)} a ${fmtDate(a.last, false)}` : '—'}<div class="muted">${a.count} movimentos</div></td>
          <td class="num nowrap">${a.balance_cents === null ? '—' : money(a.balance_cents)}</td>
          <td>${!a.checks.length ? '<span class="tag tag-low">sem saldo no OFX</span>' : a.ok ? '<span class="tag tag-ok">bate com o banco</span>' : '<span class="tag tag-out">não bate: falta período?</span>'}</td>
          <td class="num">${a.pending ? `<button class="btn-link" data-bk-filter="${a.id}">${a.pending}</button>` : '0'}</td>
          <td class="nowrap"><button class="btn-secondary btn-sm" data-bk-save="${a.id}">Salvar nome</button>
            <button class="btn-secondary btn-sm" data-bk-toggle="${a.id}" data-active="${a.active}">${a.active ? 'Desativar' : 'Ativar'}</button></td>
        </tr>`).join('')}</tbody>
    </table></div></div>` : ''}
    <div class="card">
      <div class="section-head"><h2>Conciliação ${pendingCount ? `<span class="tag tag-low">${pendingCount} pendente(s)</span>` : '<span class="tag tag-ok">tudo conciliado</span>'}</h2></div>
      <form class="row" id="bk-filter">
        <div class="field"><label>Conta</label><select id="bk-conta"><option value="">Todas</option>${accounts.map((a) => `<option value="${a.id}" ${String(a.id) === String(BK.conta) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Situação</label><select id="bk-status">
          ${[['pendente', 'Pendentes'], ['conciliado', 'Conciliados'], ['ignorado', 'Ignorados'], ['', 'Todos']].map(([v, l]) => `<option value="${v}" ${v === BK.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>De</label><input type="date" id="bk-from" value="${BK.from}"></div>
        <div class="field"><label>Até</label><input type="date" id="bk-to" value="${BK.to}"></div>
        <div class="field"><label>&nbsp;</label><button type="submit" class="btn-secondary">Filtrar</button></div>
      </form>
      ${BK.status === 'pendente' && transactions.length ? `
      <div class="row bulk-bar">
        <label class="check"><input type="checkbox" id="bk-all"> Selecionar todos</label>
        <span class="small muted" id="bk-count"></span><span class="grow"></span>
        <button class="btn-secondary btn-sm" id="bk-accept">Aceitar sugestões dos selecionados</button>
        <select id="bk-bulk-acc" class="per-select"><option value="">ou lançar todos na conta…</option>
          <optgroup label="Entradas">${finAcc.filter((a) => a.kind === 'receita').map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</optgroup>
          <optgroup label="Saídas">${finAcc.filter((a) => a.kind === 'despesa').map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</optgroup></select>
        <button class="btn-sm" id="bk-bulk">Lançar</button>
      </div>` : ''}
      <div class="table-wrap"><table>
        <thead><tr>${BK.status === 'pendente' ? '<th></th>' : ''}<th>Data</th><th>Descrição no extrato</th><th class="num">Valor</th><th>Conciliação</th></tr></thead>
        <tbody>${transactions.map((t) => {
          const kind = t.amount_cents > 0 ? 'receita' : 'despesa';
          const s = t.suggestion;
          let action;
          if (t.status === 'conciliado') {
            action = `<span class="tag tag-entregue">${t.link_type === 'baixado' ? 'baixa em' : 'lançado em'}</span> ${esc(t.entry_account_name || '')} <button class="btn-link small" data-bk-undo="${t.id}">desfazer</button>`;
          } else if (t.status === 'ignorado') {
            action = `<span class="tag tag-cancelado">ignorado</span> <span class="small muted">${esc(t.note || '')}</span> <button class="btn-link small" data-bk-undo="${t.id}">desfazer</button>`;
          } else if (s && s.type === 'baixar') {
            action = `<div class="small">Paga o lançamento em aberto <strong>${esc(s.entry.description)}</strong> (${esc(s.entry.account_name)}, venc. ${fmtDate(s.entry.due_date || s.entry.competence_date, false)})</div>
              <div class="row"><button class="btn-ok btn-sm" data-bk-pay="${t.id}" data-entry="${s.entry.id}">Dar baixa</button>
              <button class="btn-link small" data-bk-other="${t.id}">lançar em outra conta</button> <button class="btn-link small" data-bk-ignore="${t.id}">ignorar</button></div>`;
          } else {
            action = `<div class="row conc-row"><select data-bk-acc="${t.id}" class="per-select">${accOptions(kind, s ? s.account_id : null)}</select>
              <button class="btn-sm" data-bk-create="${t.id}">Lançar</button>
              <label class="check small"><input type="checkbox" data-bk-remember="${t.id}" ${s ? '' : 'checked'}> lembrar</label>
              <button class="btn-link small" data-bk-ignore="${t.id}">ignorar</button></div>
              ${s ? `<div class="small muted">sugestão pelo ${esc(s.source)}</div>` : ''}`;
          }
          return `<tr data-row="${t.id}">
            ${BK.status === 'pendente' ? `<td><input type="checkbox" data-bk-sel="${t.id}" ${BK.selected.has(t.id) ? 'checked' : ''}></td>` : ''}
            <td class="nowrap">${fmtDate(t.posted_date, false)}<div class="small muted">${esc(t.bank_account_name)}</div></td>
            <td>${esc(t.description)}</td>
            <td class="num nowrap ${t.amount_cents > 0 ? 'qty-pos' : 'qty-neg'}">${money(t.amount_cents)}</td>
            <td>${action}</td></tr>`;
        }).join('') || `<tr><td colspan="5" class="empty">${BK.status === 'pendente' ? 'Nada pendente. Importe extratos acima.' : 'Nada encontrado.'}</td></tr>`}</tbody>
      </table></div>
    </div>
    ${rules.length ? `<div class="card"><h2>Regras aprendidas</h2><p class="small muted">Quando a descrição do extrato contém o texto, o sistema sugere a conta.</p>
      <div class="table-wrap"><table><tbody>${rules.map((r) => `<tr><td class="mono small">${esc(r.pattern)}</td><td>${esc(r.account_name)}</td>
        <td><button class="btn-danger btn-sm" data-rule-del="${r.id}">Apagar</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}`;

  const reload = () => guard(renderBanks);
  const count = () => { const el = $('#bk-count'); if (el) el.textContent = BK.selected.size ? `${BK.selected.size} selecionado(s)` : ''; };
  count();
  $('#btn-ofx').addEventListener('click', () => guard(async () => {
    const files = [...$('#ofx-files').files];
    if (!files.length) return toast('Escolha os arquivos OFX.', 'error');
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: toBase64(await f.arrayBuffer()) })));
    const { results } = await api('/api/admin/banco/importar', { method: 'POST', body: { files: payload } });
    const ok = results.filter((r) => !r.error);
    toast(`${ok.reduce((s, r) => s + r.new, 0)} movimento(s) novos importados.`, 'ok');
    await renderBanks();
    $('#ofx-result').innerHTML = `<div class="table-wrap"><table class="small"><tbody>${results.map((r) => `<tr class="${r.error ? 'row-danger' : ''}">
      <td>${esc(r.file)}</td><td>${r.error ? esc(r.error) : `${esc(r.account)} · ${r.period_start ? `${fmtDate(r.period_start, false)} a ${fmtDate(r.period_end, false)}` : ''}`}</td>
      <td class="num">${r.error ? '' : `${r.new} novos · ${r.duplicate} já importados`}</td></tr>`).join('')}</tbody></table></div>`;
  }));
  const bf = $('#bk-filter');
  bf.addEventListener('submit', (e) => {
    e.preventDefault();
    Object.assign(BK, { conta: $('#bk-conta').value, status: $('#bk-status').value, from: $('#bk-from').value, to: $('#bk-to').value });
    reload();
  });
  $$('[data-bk-filter]').forEach((b) => b.addEventListener('click', () => { Object.assign(BK, { conta: b.dataset.bkFilter, status: 'pendente' }); reload(); }));
  $$('[data-bk-save]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    await api(`/api/admin/banco/contas/${b.dataset.bkSave}`, { method: 'PUT', body: { name: $(`[data-bk-name="${b.dataset.bkSave}"]`).value } });
    toast('Nome salvo.', 'ok');
  })));
  $$('[data-bk-toggle]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    await api(`/api/admin/banco/contas/${b.dataset.bkToggle}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } });
    reload();
  })));
  const conc = (id, body) => guard(async () => {
    await api(`/api/admin/banco/transacoes/${id}/conciliar`, { method: 'POST', body });
    BK.selected.delete(Number(id));
    const row = $(`[data-row="${id}"]`);
    if (row) row.remove();
    toast('Conciliado.', 'ok');
  });
  $$('[data-bk-create]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.bkCreate;
    const accountId = $(`[data-bk-acc="${id}"]`).value;
    if (!accountId) return toast('Escolha a conta.', 'error');
    conc(id, { action: 'criar', account_id: accountId, remember: $(`[data-bk-remember="${id}"]`).checked });
  }));
  $$('[data-bk-pay]').forEach((b) => b.addEventListener('click', () => conc(b.dataset.bkPay, { action: 'baixar', entry_id: b.dataset.entry })));
  $$('[data-bk-other]').forEach((b) => b.addEventListener('click', () => {
    const t = transactions.find((x) => x.id === Number(b.dataset.bkOther));
    t.suggestion = null;
    const cell = b.closest('td');
    cell.innerHTML = `<div class="row"><select data-bk-acc="${t.id}" class="per-select">${accOptions(t.amount_cents > 0 ? 'receita' : 'despesa', null)}</select>
      <button class="btn-sm" data-bk-create2="${t.id}">Lançar</button></div>`;
    $(`[data-bk-create2="${t.id}"]`).addEventListener('click', () => {
      const accountId = $(`[data-bk-acc="${t.id}"]`).value;
      if (!accountId) return toast('Escolha a conta.', 'error');
      conc(t.id, { action: 'criar', account_id: accountId });
    });
  }));
  $$('[data-bk-ignore]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.bkIgnore;
    const m = openModal(`
      <div class="modal-head"><h2>Ignorar movimento</h2><button class="modal-close" data-close>×</button></div>
      <p class="small">Use para o que <strong>não é receita nem despesa</strong>: dinheiro que só mudou de lugar. Não entra na DRE nem no caixa.</p>
      <div class="field"><label for="ign-reason">Motivo</label><select id="ign-reason">${IGNORE_REASONS.map((r) => `<option>${esc(r)}</option>`).join('')}</select></div>
      <div class="row"><button id="ign-ok">Ignorar</button><button class="btn-secondary" data-close>Cancelar</button></div>`);
    $('#ign-ok', m).addEventListener('click', () => { closeModal(); conc(id, { action: 'ignorar', note: $('#ign-reason', m).value }); });
  }));
  $$('[data-bk-undo]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    await api(`/api/admin/banco/transacoes/${b.dataset.bkUndo}/desfazer`, { method: 'POST', body: {} });
    toast('Desfeito: voltou para pendente.', 'ok');
    reload();
  })));
  $$('[data-bk-sel]').forEach((c) => c.addEventListener('change', () => {
    const id = Number(c.dataset.bkSel);
    if (c.checked) BK.selected.add(id); else BK.selected.delete(id);
    count();
  }));
  const all = $('#bk-all');
  if (all) all.addEventListener('change', () => {
    $$('[data-bk-sel]').forEach((c) => { c.checked = all.checked; const id = Number(c.dataset.bkSel); if (all.checked) BK.selected.add(id); else BK.selected.delete(id); });
    count();
  });
  const bulk = async (accountId) => {
    if (!BK.selected.size) return toast('Selecione os movimentos.', 'error');
    const r = await api('/api/admin/banco/conciliar-lote', { method: 'POST', body: { ids: [...BK.selected], account_id: accountId || null } });
    toast(`${r.done} conciliado(s)${r.skipped.length ? ` · ${r.skipped.length} sem sugestão ou de tipo diferente (ficaram pendentes)` : ''}.`, 'ok');
    BK.selected.clear();
    reload();
  };
  const acc = $('#bk-accept');
  if (acc) acc.addEventListener('click', () => guard(() => bulk(null)));
  const bb = $('#bk-bulk');
  if (bb) bb.addEventListener('click', () => guard(() => { if (!$('#bk-bulk-acc').value) return toast('Escolha a conta.', 'error'); return bulk($('#bk-bulk-acc').value); }));
  $$('[data-rule-del]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    await api(`/api/admin/banco/regras/${b.dataset.ruleDel}`, { method: 'DELETE' });
    reload();
  })));
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
  // cada perfil vê só o seu menu
  const role = A.admin.role === 'master' ? 'master' : 'loja';
  $$('#nav [data-roles]').forEach((b) => b.classList.toggle('hidden', !b.dataset.roles.split(',').includes(role)));
  const initial = location.hash.slice(1);
  setView(initial && $(`#nav [data-view="${initial}"]:not(.hidden)`) ? initial : (role === 'master' ? 'painel' : 'loja-estoque'));
}

$$('#nav [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('#btn-logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  A.admin = null;
  renderLogin();
});

// atualiza o contador de pedidos novos a cada minuto
setInterval(() => { if (isMaster()) refreshBadges(); }, 60000);
$('#btn-my-pass').addEventListener('click', openMyPassword);

function openMyPassword() {
  const m = openModal(`
    <div class="modal-head"><h2>Minha senha</h2><button class="modal-close" data-close>×</button></div>
    <form id="form-my-pass">
      <div class="field"><label>Senha atual</label><input name="atual" type="password" required autocomplete="current-password"></div>
      <div class="field"><label>Nova senha (mín. 8)</label><input name="nova" type="password" minlength="8" required autocomplete="new-password"></div>
      <div class="row"><button type="submit">Alterar senha</button><button type="button" class="btn-secondary" data-close>Cancelar</button></div>
    </form>`);
  const form = $('#form-my-pass', m);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(form, async (data) => {
      await api('/api/admin/senha', { method: 'POST', body: data });
      toast('Senha alterada.', 'ok');
      closeModal();
    });
  });
}

boot();

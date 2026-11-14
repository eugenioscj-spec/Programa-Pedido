'use strict';

// Conector do CPlug (ConnectPlug) pelo login do usuário: faz o mesmo caminho do navegador.
//   1. GET /login (pega o _token do formulário e o cookie de sessão)
//   2. POST /login com código da empresa, usuário e senha
//   3. lista as empresas (lojas) e, para cada uma, GET /sistema/empresa/escolhida/{id}/back
//   4. POST /sistema/relatorios/vendas: vendas por produto do dia e vendas por forma de pagamento
// As credenciais vêm das variáveis do servidor (CPLUG_EMPRESA, CPLUG_USUARIO, CPLUG_SENHA) e nunca
// são gravadas no banco nem mostradas na tela. O relatório vem como página pronta: lemos a tabela dela.

const BASE = process.env.CPLUG_URL || 'https://connectplug.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

class CplugError extends Error {}

// ---------- leitura de HTML (sem bibliotecas) ----------
const decode = (s) => String(s)
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const text = (html) => decode(String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Todas as tabelas da página: [{ head: [...], rows: [[...], ...] }]
function tables(html) {
  const out = [];
  for (const m of String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...m[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map((c) => ({ th: c[1].toLowerCase() === 'h', v: text(c[2]) })));
    const useful = rows.filter((r) => r.length);
    if (!useful.length) continue;
    const headIdx = useful.findIndex((r) => r.every((c) => c.th)) >= 0 ? useful.findIndex((r) => r.every((c) => c.th)) : 0;
    out.push({ head: useful[headIdx].map((c) => c.v), rows: useful.slice(headIdx + 1).map((r) => r.map((c) => c.v)) });
  }
  return out;
}

// "R$ 1.234,56" → 123456 centavos; "8.0000" → 8 (quantidade com 4 casas, ponto decimal)
function cents(v) {
  let s = String(v || '').replace(/[^\d,.-]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function qty(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) ? n : null;
}
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const col = (head, ...names) => head.findIndex((h) => names.some((n) => norm(h).includes(n)));

// Listas de dados que a página entrega para as tabelas desenharem ("data": [ {...}, ... ]).
function dataArrays(html) {
  const out = [];
  const src = String(html);
  const re = /["']?data["']?\s*:\s*\[/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length - 1; // no "["
    const start = i;
    let depth = 0;
    let quote = null;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[') depth += 1;
      else if (ch === ']') { depth -= 1; if (depth === 0) break; }
    }
    try {
      const arr = JSON.parse(src.slice(start, i + 1));
      if (Array.isArray(arr) && arr.length && arr.every((x) => x && typeof x === 'object' && !Array.isArray(x))) out.push(arr);
    } catch { /* não era JSON */ }
    re.lastIndex = i;
  }
  return out;
}
const keyOf = (obj, re, avoid) => Object.keys(obj).find((k) => re.test(norm(k)) && !(avoid && avoid.test(norm(k))));

// Vendas por produto: lista de dados da página (code_product, name_product, sale_date, amount_product, total_value)
// ou, se vier assim, a tabela HTML com Produto + Quantidade + Valor.
function parseProducts(html) {
  const arr = dataArrays(html).find((a) => keyOf(a[0], /name_product|produto/) && keyOf(a[0], /amount|quantidade|qtd/));
  if (arr) {
    const k = {
      code: keyOf(arr[0], /code_product|codigo/), name: keyOf(arr[0], /name_product|produto/), date: keyOf(arr[0], /date|data/),
      qty: keyOf(arr[0], /amount|quantidade|qtd/), value: keyOf(arr[0], /total|valor|value/),
    };
    const items = [];
    let other = 0;
    for (const r of arr) {
      const name = text(r[k.name] ?? '');
      const value = cents(r[k.value]);
      if (!name || value === null) continue;
      const code = k.code ? String(r[k.code] ?? '').trim() : null;
      if (/outras despesas|descontos|frete/i.test(name) && (!code || /^-+$/.test(code))) { other += value; continue; }
      items.push({ code, name, date: k.date ? r[k.date] : null, quantity: qty(r[k.qty]), value_cents: value });
    }
    return { items, other_cents: other, total_cents: items.reduce((x, i) => x + i.value_cents, 0) + other, source: 'data', keys: Object.keys(arr[0]) };
  }
  return parseProductsTable(html);
}

function parseProductsTable(html) {
  const t = tables(html).find((x) => col(x.head, 'produto') >= 0 && col(x.head, 'quantidade', 'qtd') >= 0 && col(x.head, 'valor', 'total') >= 0);
  if (!t) return null;
  const iCode = col(t.head, 'codigo', 'cod');
  const iName = col(t.head, 'produto');
  const iDate = col(t.head, 'data');
  const iQty = col(t.head, 'quantidade', 'qtd');
  const iVal = col(t.head, 'valor', 'total');
  const items = [];
  let other = 0;
  for (const r of t.rows) {
    const name = r[iName];
    const value = cents(r[iVal]);
    if (!name || value === null || /^total/i.test(norm(name)) || /^total/i.test(norm(r[0]))) continue;
    if (/outras despesas|descontos|frete/i.test(name) && (!r[iCode] || /^-+$/.test(r[iCode]))) { other += value; continue; }
    items.push({ code: iCode >= 0 ? r[iCode] : null, name, date: iDate >= 0 ? r[iDate] : null, quantity: qty(r[iQty]), value_cents: value });
  }
  return { items, other_cents: other, total_cents: items.reduce((s, i) => s + i.value_cents, 0) + other, head: t.head };
}

// Vendas por forma de pagamento: lista de dados com a forma/meio de pagamento + valor, ou a tabela HTML.
function parsePayments(html) {
  const arr = dataArrays(html).find((a) => keyOf(a[0], /method|payment|forma|pagamento|finaliz|meio/) && keyOf(a[0], /total|valor|value/));
  if (arr) {
    const kName = keyOf(arr[0], /name|nome|descri/, /product|produto/) || keyOf(arr[0], /method|payment|forma|pagamento|finaliz|meio/, /id$|_id|code/)
      || keyOf(arr[0], /method|payment|forma|pagamento|finaliz|meio/);
    const kVal = keyOf(arr[0], /total/) || keyOf(arr[0], /valor|value/);
    const kCount = keyOf(arr[0], /quantidade|qtd|count|vendas|cupons/);
    const methods = [];
    for (const r of arr) {
      const name = text(r[kName] ?? '');
      const value = cents(r[kVal]);
      if (!name || value === null || /^total/.test(norm(name))) continue;
      methods.push({ method: name, count: kCount ? qty(r[kCount]) : null, value_cents: value });
    }
    return { methods, total_cents: methods.reduce((x, m) => x + m.value_cents, 0), source: 'data', keys: Object.keys(arr[0]) };
  }
  return parsePaymentsTable(html);
}

function parsePaymentsTable(html) {
  const candidates = tables(html).filter((x) => col(x.head, 'valor', 'total') >= 0);
  const t = candidates.find((x) => col(x.head, 'forma', 'pagamento', 'meio', 'metodo', 'finalizadora') >= 0) || null;
  if (!t) return null;
  const iName = col(t.head, 'forma', 'pagamento', 'meio', 'metodo', 'finalizadora');
  const iVal = (() => {
    const all = t.head.map((h, i) => [norm(h), i]).filter(([h]) => /valor|total/.test(h));
    return (all.find(([h]) => /total/.test(h)) || all[all.length - 1])[1];
  })();
  const iCount = col(t.head, 'quantidade', 'qtd', 'vendas', 'cupons');
  const methods = [];
  for (const r of t.rows) {
    const name = r[iName];
    const value = cents(r[iVal]);
    if (!name || value === null || /^total/.test(norm(name))) continue;
    methods.push({ method: name, count: iCount >= 0 ? qty(r[iCount]) : null, value_cents: value });
  }
  return { methods, total_cents: methods.reduce((s, m) => s + m.value_cents, 0), head: t.head };
}

// Lojas (empresas) da conta: links /sistema/empresa/escolhida/{id}/...
function parseCompanies(html) {
  const map = new Map();
  for (const m of String(html).matchAll(/<a\b[^>]*href=["'][^"']*\/sistema\/empresa\/escolhida\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = text(m[2]);
    if (!map.has(m[1]) || (name && name.length > (map.get(m[1]) || '').length)) map.set(m[1], name);
  }
  for (const m of String(html).matchAll(/\/sistema\/empresa\/escolhida\/(\d+)/g)) if (!map.has(m[1])) map.set(m[1], '');
  return [...map].map(([id, name]) => ({ id: Number(id), name: name || `Empresa ${id}` }));
}

const formToken = (html) => (String(html).match(/name=["']_token["'][^>]*value=["']([^"']+)/i)
  || String(html).match(/value=["']([^"']+)["'][^>]*name=["']_token["']/i)
  || String(html).match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)/i) || [])[1] || null;

// Página do diagnóstico: sem códigos de segurança (o mesmo cuidado do gravador).
const redactHtml = (html) => String(html)
  .replace(/(name=["']?_token["']?[^>]*?value=["'])[^"']*/gi, '$1***')
  .replace(/(value=["'])[^"']*(["'][^>]*name=["']?_token)/gi, '$1***$2')
  .replace(/(<meta[^>]+name=["']csrf-token["'][^>]+content=["'])[^"']*/gi, '$1***')
  .replace(/(["']?(?:_token|csrf_token|csrfToken|api_token|access_token|token|password|senha)["']?\s*[:=]\s*["'])[^"']*/gi, '$1***')
  .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '***');

// ---------- sessão HTTP com cookies ----------
function createSession({ base = BASE, fetchImpl = fetch } = {}) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function request(path, { method = 'GET', form, referer } = {}) {
    let url = new URL(path, base).toString();
    let body = form ? new URLSearchParams(form).toString() : undefined;
    for (let hop = 0; hop < 6; hop += 1) {
      const xsrf = jar.get('XSRF-TOKEN');
      let res;
      try {
        res = await fetchImpl(url, {
          method, redirect: 'manual', body,
          headers: {
            'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'pt-BR,pt;q=0.9',
            ...(jar.size ? { Cookie: cookieHeader() } : {}),
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
            ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}),
            ...(referer ? { Referer: new URL(referer, base).toString() } : {}),
          },
          signal: AbortSignal.timeout(45000),
        });
      } catch (e) {
        throw new CplugError(e.name === 'TimeoutError' ? 'O CPlug demorou demais para responder. Tente de novo em alguns minutos.'
          : `Não consegui conectar ao CPlug (${e.cause?.code || e.message}). Pode ser instabilidade do CPlug ou da internet do servidor.`);
      }
      for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url).toString();
        if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
        continue;
      }
      return { status: res.status, url, html: await res.text() };
    }
    throw new CplugError('O CPlug redirecionou demais (talvez a sessão tenha caído).');
  }
  return { request };
}

// Campos do formulário do relatório de vendas, como o navegador envia (gravação de 07/11/2026).
const BLANK = ['per_start', 'per_end', 'dt_start', 'dt_end', 'mo_start2', 'mo_start', 'mo_end2', 'mo_end', 'hour_dt_start',
  'hour_dt_end', 'hr_end', 'date_start', 'date_end', 'vendor_start', 'vendor_end', 'customer_start', 'customer_end',
  'devolution_start', 'devolution_end', 'origin_start', 'origin_end', 'pdv_start', 'pdv_end', 'interval_start', 'interval_end',
  'interval_hr_start', 'interval_hr_end', 'attr_start', 'attr_end', 'sale_canceled_start', 'sale_canceled_end',
  'sale_additionals_start', 'sale_additionals_end', 'show'];
function reportForm(token, extra) {
  const f = { _token: token, tab_actived: 'sale', day_group: 'dayeach1', month_group: 'montheach1', hour_group: 'houreach1', hr_start: '00', grouping_option: 'none' };
  for (const k of BLANK) f[k] = '';
  return { ...f, ...extra };
}
const br = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// O CPlug só deixa gerar um relatório a cada poucos segundos: quando a página responde "Aguarde N
// segundo(s) para gerar esse relatório", esperamos o tempo pedido e pedimos de novo (até 5 vezes).
const WAIT_RE = /Aguarde\s+(\d+)\s+segundo/i;
const hasReport = (html) => /class=["'][^"']*title-report/i.test(html) || dataArrays(html).length > 0;
async function reportRequest(s, form, { wait = sleep } = {}) {
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = await s.request('/sistema/relatorios/vendas', { method: 'POST', referer: '/sistema/relatorios/vendas', form });
    if (hasReport(last.html)) return last;
    const m = last.html.match(WAIT_RE);
    if (!m) return last;
    await wait((Number(m[1]) + 1) * 1000 + (attempt ? 1000 : 0));
    form = { ...form, _token: formToken(last.html) || form._token };
  }
  return last;
}

// Busca as vendas de um dia (YYYY-MM-DD) em todas as lojas da conta.
async function fetchDay({ date, empresa, usuario, senha, base, fetchImpl, keepPages = true, wait = sleep, gap = 3500 } = {}) {
  if (!empresa || !usuario || !senha) throw new CplugError('Faltam as variáveis CPLUG_EMPRESA, CPLUG_USUARIO e CPLUG_SENHA no servidor.');
  const s = createSession({ base, fetchImpl });
  const pages = [];
  const keep = (name, html) => { if (keepPages) pages.push({ name, html: redactHtml(html) }); };

  const login = await s.request('/login');
  keep('login', login.html);
  const token = formToken(login.html);
  if (!token) throw Object.assign(new CplugError('Não achei o formulário de login do CPlug.'), { pages });
  // Envia o mesmo formulário que o navegador envia (código da empresa, usuário e senha). Se o CPlug
  // exigir verificação "não sou um robô", ele recusa e a busca para: não tentamos resolver nem contornar.
  const home = await s.request('/login', { method: 'POST', form: { _token: token, login_code: empresa, username: usuario, password: senha }, referer: '/login' });
  if (/\/login\b/.test(new URL(home.url).pathname) || /name=["']password["']/i.test(home.html)) {
    keep('login-recusado', home.html);
    const msg = text(home.html);
    const captcha = /captcha|n[aã]o (sou|[eé]) (um )?rob[oô]|verifica[cç][aã]o de seguran[cç]a/i.test(msg)
      || /class=["'][^"']*(g-recaptcha|h-captcha|cf-turnstile)[^"']*["'][^>]*data-sitekey/i.test(home.html);
    throw Object.assign(new CplugError(captcha
      ? 'O CPlug pediu a verificação "não sou um robô" no login. A busca automática não vai contornar: nesse caso o caminho é a API do CPlug.'
      : 'O CPlug recusou o login. Confira o código da empresa, o usuário e a senha nas variáveis do Render.'), { pages });
  }
  keep('inicio', home.html);

  let companies = parseCompanies(home.html);
  if (!companies.length) {
    const rel = await s.request('/sistema/relatorios/vendas');
    companies = parseCompanies(rel.html);
  }
  if (!companies.length) companies = [{ id: null, name: 'Empresa atual' }];

  const stores = [];
  for (const c of companies) {
    const store = { id: c.id, name: c.name, products: null, payments: null, errors: [] };
    try {
      if (c.id !== null) await s.request(`/sistema/empresa/escolhida/${c.id}/back`, { referer: '/sistema/relatorios/vendas' });
      const page = await s.request('/sistema/relatorios/vendas');
      const t = formToken(page.html);
      // nome da loja como aparece no topo/relatório (ex.: "MT SINOP ... - 63.532.954/0002-46")
      const cnpj = text(page.html).match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
      if (cnpj) store.cnpj = cnpj[0];

      const prod = await reportRequest(s, reportForm(t, { date_start: br(date), date_end: br(date), groupProductsByDay: '1' }), { wait });
      keep(`loja-${c.id}-produtos`, prod.html);
      store.products = parseProducts(prod.html);
      if (!store.products) store.errors.push(WAIT_RE.test(prod.html) && !hasReport(prod.html)
        ? 'O CPlug pediu para aguardar e não gerou o relatório de produtos. Tente de novo em 1 minuto.'
        : 'Não achei a tabela de vendas por produto.');

      await wait(gap); // intervalo entre relatórios, para não esbarrar no limite do CPlug
      const t2 = formToken(prod.html) || t;
      const pay = await reportRequest(s, reportForm(t2, { tab_actived: 'day', dt_start: br(date), dt_end: br(date), show: 'method' }), { wait });
      keep(`loja-${c.id}-pagamentos`, pay.html);
      store.payments = parsePayments(pay.html);
      if (!store.payments) store.errors.push(WAIT_RE.test(pay.html) && !hasReport(pay.html)
        ? 'O CPlug pediu para aguardar e não gerou o relatório de formas de pagamento. Tente de novo em 1 minuto.'
        : 'Não achei a tabela de vendas por forma de pagamento.');
      await wait(gap);
    } catch (e) {
      store.errors.push(e.message);
    }
    stores.push(store);
  }
  return { date, fetched_at: new Date().toISOString(), stores, pages };
}

module.exports = { fetchDay, parseProducts, parsePayments, dataArrays, parseCompanies, tables, cents, qty, formToken, redactHtml, CplugError };

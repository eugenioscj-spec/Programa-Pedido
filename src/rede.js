'use strict';

// Conector da Rede (maquininhas): API oficial "Gestão de Vendas" (merchant-statement), com OAuth 2.0.
// Credenciais nas variáveis do servidor: REDE_CLIENT_ID e REDE_CLIENT_SECRET (do projeto criado no portal
// de desenvolvedores). REDE_AMBIENTE = "sandbox" (padrão, dados de teste da Rede) ou "producao".
// Endereços conforme a documentação (Gestão de Vendas, URLs). O do token pode ser trocado por REDE_TOKEN_URL.

const ENVS = {
  sandbox: { base: 'https://rl7-sandbox-api.useredecloud.com.br', token: 'https://rl7-sandbox-api.useredecloud.com.br/oauth/token' },
  producao: { base: 'https://api.userede.com.br/redelabs', token: 'https://api.userede.com.br/redelabs/oauth/token' },
};
// Pontos de venda de teste publicados no Tutorial Sandbox da Rede.
const SANDBOX_PVS = ['13381369', '22523510'];

class RedeError extends Error {}

const SECRET = /(token|secret|password|senha|authorization)/i;
function redact(v, depth = 0) {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) && typeof x !== 'object' ? '***' : redact(x, depth + 1)]));
}

function config(env = process.env) {
  const ambiente = env.REDE_AMBIENTE === 'producao' ? 'producao' : 'sandbox';
  return {
    ambiente, clientId: env.REDE_CLIENT_ID, clientSecret: env.REDE_CLIENT_SECRET,
    base: env.REDE_BASE_URL || ENVS[ambiente].base, tokenUrl: env.REDE_TOKEN_URL || ENVS[ambiente].token,
    pvs: String(env.REDE_PVS || '').split(/[,;\s]+/).filter(Boolean),
  };
}

async function call(fetchImpl, url, opts, log) {
  let res;
  try {
    res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(45000) });
  } catch (e) {
    throw new RedeError(`Não consegui conectar à Rede (${e.cause?.code || e.message}).`);
  }
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw.slice(0, 2000); }
  log.push({ url: url.replace(/client_secret=[^&]+/, 'client_secret=***'), status: res.status, body: redact(body) });
  return { status: res.status, body };
}

// Token OAuth 2.0 (client credentials: Client ID e Secret no cabeçalho Basic).
async function getToken(cfg, fetchImpl, log) {
  if (!cfg.clientId || !cfg.clientSecret) throw new RedeError('Faltam as variáveis REDE_CLIENT_ID e REDE_CLIENT_SECRET no servidor.');
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const r = await call(fetchImpl, cfg.tokenUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials',
  }, log);
  const token = r.body && (r.body.access_token || r.body.accessToken);
  if (r.status >= 400 || !token) {
    throw new RedeError(r.status === 401 || r.status === 403
      ? 'A Rede recusou as credenciais (Client ID / Client Secret). Confira as variáveis no Render e o ambiente (sandbox ou produção).'
      : `A Rede não devolveu o token de acesso (resposta ${r.status}).`);
  }
  return token;
}

// Lista de vendas dentro da resposta, qualquer que seja o nome do campo (content, sales, transactions…).
function findList(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const k of ['content', 'sales', 'transactions', 'items', 'data', 'results']) {
    if (Array.isArray(body[k])) return body[k];
    if (body[k] && typeof body[k] === 'object') { const inner = findList(body[k]); if (inner.length) return inner; }
  }
  for (const v of Object.values(body)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  return [];
}
const pick = (o, ...names) => {
  for (const n of names) {
    const k = Object.keys(o).find((x) => x.toLowerCase() === n.toLowerCase());
    if (k !== undefined && o[k] !== null && o[k] !== undefined && typeof o[k] !== 'object') return o[k];
  }
  return null;
};
const toCents = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100));

// Venda resumida com os campos mais prováveis; o registro original vai junto para o diagnóstico.
function summarizeSale(s) {
  const flat = { ...s };
  for (const [k, v] of Object.entries(s)) if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) flat[`${k}.${k2}`] = v2;
  return {
    date: pick(flat, 'saleDate', 'movementDate', 'date', 'transactionDate'),
    gross_cents: toCents(pick(flat, 'amount', 'grossAmount', 'saleAmount', 'totalAmount')),
    net_cents: toCents(pick(flat, 'netAmount', 'liquidAmount')),
    fee_cents: toCents(pick(flat, 'mdrAmount', 'discountAmount', 'feeAmount', 'mdrFee')),
    brand: pick(flat, 'brandName', 'brand', 'brand.name', 'brandCode', 'brand.code'),
    modality: pick(flat, 'modality', 'modality.type', 'modalityType', 'modality.code', 'productType'),
    installments: pick(flat, 'installmentQuantity', 'installments', 'installmentsNumber'),
    nsu: pick(flat, 'nsu', 'authorizationCode'),
    status: pick(flat, 'status', 'saleStatus'),
  };
}

// Vendas de um dia (YYYY-MM-DD) de um ponto de venda (PV).
async function fetchSales({ date, pv, env = process.env, fetchImpl = fetch } = {}) {
  const cfg = config(env);
  const log = [];
  const out = { ambiente: cfg.ambiente, date, pv, sales: [], total_cents: 0, log };
  try {
    const token = await getToken(cfg, fetchImpl, log);
    const qs = new URLSearchParams({ parentCompanyNumber: pv, subsidiaries: pv, startDate: date, endDate: date, size: '100' });
    let url = `${cfg.base}/merchant-statement/v1/sales?${qs}`;
    for (let page = 0; page < 30 && url; page += 1) {
      const r = await call(fetchImpl, url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, log);
      if (r.status >= 400) throw new RedeError(`A Rede respondeu ${r.status} na consulta de vendas.`);
      const list = findList(r.body);
      out.sales.push(...list);
      // paginação por cursor (CursorModel na documentação)
      const cursor = r.body && (r.body.cursor || r.body.cursorModel || r.body.pagination);
      const next = cursor && (cursor.nextKey || cursor.next || cursor.nextCursor);
      url = cursor && cursor.hasNextKey !== false && next ? `${cfg.base}/merchant-statement/v1/sales?${new URLSearchParams({ ...Object.fromEntries(qs), pageKey: next })}` : null;
      if (!list.length) break;
    }
    out.summary = out.sales.map(summarizeSale);
    out.total_cents = out.summary.reduce((s, x) => s + (x.gross_cents || 0), 0);
  } catch (e) {
    out.error = e.message;
  }
  // log só com as primeiras respostas, sem token
  out.log = log.slice(0, 6);
  return out;
}

module.exports = { fetchSales, config, findList, summarizeSale, SANDBOX_PVS, RedeError };

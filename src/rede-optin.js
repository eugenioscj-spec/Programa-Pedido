'use strict';

// Opt-in da Rede (API "Gestão de Acessos"): o sistema pede à Rede acesso aos extratos de um estabelecimento (PV).
// A Rede deixa o pedido PENDENTE; o dono aprova no portal da Rede (Minha Rede → PV → Conciliação → Compartilhar).
// Só depois a API de Gestão de Vendas responde para aquele PV.
//   POST /partner/v1/organizations/requests/features/merchant-statement              (criação)
//   GET  /partner/v1/organizations/requests/{requestId}/features/merchant-statement  (consulta)
// Os campos do pedido vêm da documentação oficial (swagger.yaml), lida na hora. Se houver campo obrigatório que o
// sistema não sabe preencher, NÃO envia: devolve a lista para conferirmos. Nada é mandado no chute.

const YAML = require('yaml');
const rede = require('./rede');

const DOCS_URL = 'https://developer.userede.com.br/dev-portal-swaggers/gestao-acessos/swagger.yaml';
const CREATE_PATH = '/partner/v1/organizations/requests/features/merchant-statement';
const statusPath = (id) => `/partner/v1/organizations/requests/${encodeURIComponent(id)}/features/merchant-statement`;

// ---------- leitura da documentação ----------
function deref(spec, s, depth = 0) {
  let cur = s;
  while (cur && cur.$ref && depth < 20) {
    const parts = cur.$ref.replace(/^#\//, '').split('/').map((k) => decodeURIComponent(k).replace(/~1/g, '/').replace(/~0/g, '~'));
    cur = parts.reduce((o, k) => (o ? o[k] : undefined), spec);
    depth += 1;
  }
  if (cur && Array.isArray(cur.allOf)) {
    const merged = { type: 'object', properties: {}, required: [] };
    for (const part of cur.allOf) {
      const p = deref(spec, part, depth + 1) || {};
      Object.assign(merged.properties, p.properties || {});
      merged.required.push(...(p.required || []));
      if (p.example && !merged.example) merged.example = p.example;
    }
    return merged;
  }
  return cur;
}

// A operação de criação na documentação: corpo (schema) e exemplo.
function createOperation(spec) {
  const paths = spec && spec.paths ? spec.paths : {};
  const key = Object.keys(paths).find((k) => k.replace(/\/+$/, '').endsWith('requests/features/merchant-statement') && !k.includes('{'));
  const op = key && paths[key] && paths[key].post;
  if (!op) return null;
  const content = (op.requestBody && (deref(spec, op.requestBody) || {}).content) || {};
  const media = content['application/json'] || Object.values(content)[0] || {};
  const schema = deref(spec, media.schema) || null;
  let example = media.example;
  if (example === undefined && media.examples) {
    const first = Object.values(media.examples)[0];
    example = first && (deref(spec, first) || {}).value;
  }
  if (example === undefined && schema) example = schema.example;
  return { path: key, schema, example, summary: op.summary || op.description || null };
}

// ---------- montagem do corpo ----------
const isPvField = (n) => /(request)?company.?number|merchant.?(id|number)|establishment|estabelecimento|^pv$|pointofsale|pontodevenda/i.test(n);
const isListOfPvs = (n) => /subsidiar|branch|filia|companynumbers|merchants|establishments|estabelecimentos/i.test(n);
const isTypeField = (n) => /type|tipo/i.test(n);

function valueFor(ps, pv) {
  return ps && (ps.type === 'integer' || ps.type === 'number') ? Number(pv) : String(pv);
}

// Devolve { body, missing: [{campo, descricao}], notes: [] }.
function buildBody(spec, schema, ctx, prefix = '', out = { missing: [], notes: [] }) {
  const s = deref(spec, schema) || {};
  const props = s.properties || {};
  const required = new Set(s.required || []);
  const body = {};
  for (const [name, raw] of Object.entries(props)) {
    const ps = deref(spec, raw) || {};
    const full = prefix ? `${prefix}.${name}` : name;
    const req = required.has(name);
    if (ps.type === 'object' || ps.properties) {
      const inner = buildBody(spec, ps, ctx, full, out).body;
      if (req || Object.keys(inner).length) body[name] = inner;
    } else if (ps.type === 'array' && isListOfPvs(name)) {
      const item = deref(spec, ps.items) || {};
      if (ctx.tipo === 'PARCIAL') body[name] = ctx.filiais.map((p) => (item.type === 'object' ? null : valueFor(item, p))).filter((x) => x !== null);
      else if (req) body[name] = [];
      if (item.type === 'object') out.missing.push({ campo: full, descricao: 'lista de filiais em formato que o sistema ainda não conhece' });
    } else if (/^requesttype$/i.test(name) && !Array.isArray(ps.enum)) {
      // documentação oficial (2024): I = individual, P = parcial (matriz + filiais informadas), T = total (matriz + todas as filiais)
      body[name] = ctx.tipo === 'PARCIAL' ? 'P' : 'T';
    } else if (/^permissions?$/i.test(name) && !Array.isArray(ps.enum)) {
      // R = só leitura (o sistema só lê os extratos; nunca pede escrita nem exclusão)
      body[name] = ps.type === 'array' ? ['R'] : 'R';
    } else if (Array.isArray(ps.enum) && isTypeField(name)) {
      const want = ctx.tipo === 'PARCIAL' ? /parc|partial/i : /total/i;
      const v = ps.enum.find((x) => want.test(String(x)));
      if (v !== undefined) body[name] = v;
      else if (req) out.missing.push({ campo: full, descricao: `valores aceitos: ${ps.enum.join(', ')}` });
    } else if (isPvField(name) && ps.type !== 'array') {
      body[name] = valueFor(ps, ctx.matriz);
    } else if (req) {
      out.missing.push({ campo: full, descricao: ps.description || ps.title || '(sem descrição)' });
    } else {
      out.notes.push(`campo opcional não enviado: ${full}`);
    }
  }
  return { body, ...out };
}

// ---------- chamadas ----------
async function loadDocs({ env = process.env, fetchImpl = fetch, log }) {
  const url = env.REDE_DOCS_URL || DOCS_URL;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new rede.RedeError(`Não consegui baixar a documentação da Rede (${e.cause?.code || e.message}).`);
  }
  const text = await res.text();
  log.push({ url, status: res.status, bytes: text.length });
  if (res.status >= 400) throw new rede.RedeError(`A documentação da Rede não abriu (resposta ${res.status}).`);
  try {
    return YAML.parse(text);
  } catch {
    try { return JSON.parse(text); } catch { throw new rede.RedeError('Não consegui ler a documentação da Rede (formato inesperado).'); }
  }
}

const pickId = (b) => b && typeof b === 'object' && (b.requestId ?? b.id ?? (b.content && (b.content.requestId ?? b.content.id)) ?? (b.data && (b.data.requestId ?? b.data.id)));
const pickStatus = (b) => b && typeof b === 'object' && (b.status ?? b.requestStatus ?? (b.content && (b.content.status ?? b.content.requestStatus)) ?? (b.data && (b.data.status ?? b.data.requestStatus)));

// Pede o acesso aos extratos. tipo = 'TOTAL' (matriz e todas as filiais) ou 'PARCIAL' (matriz + filiais informadas).
async function requestAccess({ matriz, filiais = [], tipo = 'TOTAL', env = process.env, fetchImpl = fetch, send = true } = {}) {
  const cfg = rede.config(env);
  const log = [];
  const out = { ambiente: cfg.ambiente, matriz: String(matriz), tipo, filiais, log };
  try {
    if (!/^\d+$/.test(String(matriz || ''))) throw new rede.RedeError('Informe o PV da matriz.');
    const spec = await loadDocs({ env, fetchImpl, log });
    const op = createOperation(spec);
    if (!op || !op.schema) throw new rede.RedeError('Não achei na documentação da Rede o formato do pedido de acesso ao extrato.');
    out.docs = { path: op.path, schema: op.schema, example: op.example ?? null };
    const built = buildBody(spec, op.schema, { matriz: String(matriz), filiais: filiais.map(String), tipo });
    out.body = built.body;
    out.notes = built.notes;
    if (built.missing.length) {
      out.missing = built.missing;
      throw new rede.RedeError(`O pedido tem campo(s) obrigatório(s) que o sistema não sabe preencher: ${built.missing.map((m) => m.campo).join(', ')}. Nada foi enviado; baixe o diagnóstico e mande para o suporte do sistema.`);
    }
    if (!Object.values(out.body).some((v) => String(v) === String(matriz) || Number(v) === Number(matriz))) {
      throw new rede.RedeError('Não achei na documentação o campo do número do estabelecimento. Nada foi enviado.');
    }
    if (!send) return out;
    const token = await rede.getToken(cfg, fetchImpl, log);
    const r = await rede.call(fetchImpl, `${cfg.base}${CREATE_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(out.body),
    }, log);
    out.http_status = r.status;
    out.response = r.body;
    if (r.status >= 400) {
      const msg = r.body && typeof r.body === 'object' ? (r.body.message || r.body.returnMessage || r.body.error_description || r.body.error) : null;
      throw new rede.RedeError(`A Rede recusou o pedido (resposta ${r.status}${msg ? `: ${msg}` : ''}).`);
    }
    out.request_id = pickId(r.body) ?? null;
    out.status = pickStatus(r.body) ?? null;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// Consulta a situação de um pedido.
async function checkAccess({ requestId, env = process.env, fetchImpl = fetch } = {}) {
  const cfg = rede.config(env);
  const log = [];
  const out = { ambiente: cfg.ambiente, request_id: String(requestId), log };
  try {
    const token = await rede.getToken(cfg, fetchImpl, log);
    const r = await rede.call(fetchImpl, `${cfg.base}${statusPath(requestId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, log);
    out.http_status = r.status;
    out.response = r.body;
    if (r.status >= 400) throw new rede.RedeError(`A Rede respondeu ${r.status} na consulta do pedido.`);
    out.status = pickStatus(r.body) ?? null;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// Nome amigável do status.
function statusLabel(s) {
  const v = String(s || '').toUpperCase();
  if (/APPROV|APROV|ACTIVE|ATIV/.test(v)) return 'Aprovado';
  if (/PEND/.test(v)) return 'Pendente (aprovar no portal da Rede)';
  if (/REJECT|REPROV|FAIL|DENI|NEGA/.test(v)) return 'Recusado';
  if (/EXPIR/.test(v)) return 'Expirado';
  if (/CANCEL/.test(v)) return 'Cancelado';
  return s ? String(s) : '—';
}

module.exports = { requestAccess, checkAccess, buildBody, createOperation, statusLabel, DOCS_URL, CREATE_PATH };

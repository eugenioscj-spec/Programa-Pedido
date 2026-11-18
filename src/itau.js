'use strict';

// Conector do Itaú (API oficial "Account Statement" — extrato e saldo da conta corrente PJ).
// Segurança: mTLS com o certificado dinâmico emitido no Itaú for Developers + OAuth2 client_credentials.
//   Token:   POST https://sts.itau.com.br/api/oauth/token   (form: grant_type, client_id, client_secret; vale ~5 min)
//   Extrato: GET  https://account-statement.api.itau.com/account-statement/v1/statements/{agência4+conta7+dígito1}
//            ?type=current_account&start_date=AAAA-MM-DD&end_date=AAAA-MM-DD&page=N&page_size=N
//   Saldos:  GET  .../balances
//   Cabeçalhos: Authorization: Bearer …, x-itau-correlationid: <uuid novo por chamada>
// Variáveis no Render: ITAU_CLIENT_ID, ITAU_CLIENT_SECRET, ITAU_CONTAS (ex.: "1234/0012345-6");
// certificado em Secret Files: itau.crt e itau.key (/etc/secrets/…; ou ITAU_CERT_PATH / ITAU_KEY_PATH).
// Só LÊ. Nunca movimenta a conta.

const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DEFAULTS = {
  tokenUrl: 'https://sts.itau.com.br/api/oauth/token',
  base: 'https://account-statement.api.itau.com/account-statement/v1',
  certPath: '/etc/secrets/itau.crt',
  keyPath: '/etc/secrets/itau.key',
};

class ItauError extends Error {}

// "1234/0012345-6", "1234 12345-6", "123400123456" → { id: '123400123456', branch: '1234', number: '0012345', digit: '6' }
function parseAccount(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let branch; let number; let digit;
  const parts = s.split(/[^0-9]+/).filter(Boolean);
  if (parts.length === 1 && parts[0].length === 12) {
    [branch, number, digit] = [parts[0].slice(0, 4), parts[0].slice(4, 11), parts[0].slice(11)];
  } else if (parts.length >= 3) {
    [branch, number, digit] = [parts[0], parts[1], parts[2]];
  } else if (parts.length === 2 && parts[1].length >= 2) {
    [branch, number, digit] = [parts[0], parts[1].slice(0, -1), parts[1].slice(-1)];
  } else return null;
  if (branch.length > 4 || number.length > 7 || digit.length !== 1) return null;
  branch = branch.padStart(4, '0');
  number = number.padStart(7, '0');
  return { id: `${branch}${number}${digit}`, branch, number, digit, label: `${branch} / ${number.replace(/^0+/, '')}-${digit}` };
}

function config(env = process.env) {
  const certPath = env.ITAU_CERT_PATH || DEFAULTS.certPath;
  const keyPath = env.ITAU_KEY_PATH || DEFAULTS.keyPath;
  const accounts = String(env.ITAU_CONTAS || '').split(/[,;]+/).map(parseAccount).filter(Boolean);
  return {
    clientId: env.ITAU_CLIENT_ID, clientSecret: env.ITAU_CLIENT_SECRET,
    tokenUrl: env.ITAU_TOKEN_URL || DEFAULTS.tokenUrl, base: env.ITAU_BASE_URL || DEFAULTS.base,
    certPath, keyPath, accounts,
  };
}

// Validade do certificado (sem expor nada sigiloso).
function certInfo(cfg) {
  const out = { cert_found: false, key_found: false };
  try { out.key_found = fs.existsSync(cfg.keyPath); } catch { /* sem acesso */ }
  try {
    const pem = fs.readFileSync(cfg.certPath);
    out.cert_found = true;
    const x = new crypto.X509Certificate(pem);
    const end = new Date(x.validTo);
    out.valid_to = end.toISOString().slice(0, 10);
    out.days_left = Math.floor((end.getTime() - Date.now()) / 86400000);
    out.subject = x.subject.replace(/\n/g, ', ');
  } catch (e) {
    if (out.cert_found) out.cert_error = 'Não consegui ler o certificado (formato inesperado).';
  }
  return out;
}

const SECRET = /(token|secret|password|senha|authorization)/i;
function redact(v, depth = 0) {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) && typeof x !== 'object' ? '***' : redact(x, depth + 1)]));
}

// Requisição HTTPS com o certificado do cliente (mTLS). requestImpl troca nos testes.
function httpsCall({ url, method = 'GET', headers = {}, body, cert, key, ca, timeoutMs = 45000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, method, headers, cert, key, ca,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createClient({ env = process.env, requestImpl = httpsCall } = {}) {
  const cfg = config(env);
  const log = [];
  let creds = null;
  const loadCreds = () => {
    if (creds) return creds;
    if (!cfg.clientId || !cfg.clientSecret) throw new ItauError('Faltam as variáveis ITAU_CLIENT_ID e ITAU_CLIENT_SECRET no servidor.');
    let cert; let key;
    try { cert = fs.readFileSync(cfg.certPath); } catch { throw new ItauError(`Não achei o certificado do Itaú (${cfg.certPath}). Cadastre o arquivo itau.crt em Secret Files no Render.`); }
    try { key = fs.readFileSync(cfg.keyPath); } catch { throw new ItauError(`Não achei a chave do certificado (${cfg.keyPath}). Cadastre o arquivo itau.key em Secret Files no Render.`); }
    const ca = env.ITAU_CA_PATH ? fs.readFileSync(env.ITAU_CA_PATH) : undefined;
    creds = { cert, key, ca };
    return creds;
  };
  async function call(opts, what) {
    const { cert, key, ca } = loadCreds();
    let r;
    try {
      r = await requestImpl({ ...opts, cert, key, ca });
    } catch (e) {
      throw new ItauError(`Não consegui conectar ao Itaú (${what}: ${e.code || e.message}).`);
    }
    let body;
    try { body = JSON.parse(r.text); } catch { body = String(r.text || '').slice(0, 1500); }
    log.push({ url: opts.url, status: r.status, body: redact(body) });
    return { status: r.status, body };
  }

  let token = null; let tokenAt = 0;
  async function getToken() {
    if (token && Date.now() - tokenAt < 4 * 60 * 1000) return token; // o token vale ~5 min
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId || '', client_secret: cfg.clientSecret || '' }).toString();
    const r = await call({ url: cfg.tokenUrl, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, body: form }, 'token');
    const t = r.body && r.body.access_token;
    if (r.status >= 400 || !t) {
      throw new ItauError(r.status === 401 || r.status === 400 || r.status === 403
        ? `O Itaú recusou as credenciais (resposta ${r.status}). Confira ITAU_CLIENT_ID, ITAU_CLIENT_SECRET e o certificado no Render.`
        : `O Itaú não devolveu o token de acesso (resposta ${r.status}).`);
    }
    token = t; tokenAt = Date.now();
    return t;
  }
  const apiHeaders = async () => ({ Authorization: `Bearer ${await getToken()}`, 'x-itau-correlationid': crypto.randomUUID(), Accept: 'application/json' });
  const errMsg = (r) => {
    const b = r.body;
    if (b && typeof b === 'object') return b.message || (Array.isArray(b.messages) && b.messages[0] && (b.messages[0].mensagem || b.messages[0].message)) || null;
    return null;
  };

  // Saldos de todas as contas liberadas para a aplicação.
  async function balances() {
    const r = await call({ url: `${cfg.base}/balances`, headers: await apiHeaders() }, 'saldos');
    if (r.status >= 400) throw new ItauError(`O Itaú respondeu ${r.status} na consulta de saldo${errMsg(r) ? `: ${errMsg(r)}` : ''}.`);
    return (r.body && Array.isArray(r.body.data) ? r.body.data : []).map((d) => {
      const pick = (type) => { const b = (d.balances || []).find((x) => x.type === type); return b && b.amount ? Math.round(Number(b.amount.value) * 100) : null; };
      const any = (d.balances || [])[0];
      return {
        statement_id: String(d.statementId).padStart(12, '0'),
        available_cents: pick('saldo_disponivel'), total_cents: pick('saldo_total'), blocked_cents: pick('saldo_bloqueado'), auto_invest_cents: pick('saldo_aplic_aut'),
        at: any && any.date ? (any.date.event || any.date.accounting || null) : null,
      };
    });
  }

  // Lançamentos de um período (todas as páginas).
  async function statement(account, startDate, endDate) {
    const events = [];
    const pending = [];
    let lastBalance = null;
    for (let page = 1; page <= 50; page += 1) {
      const qs = new URLSearchParams({ type: 'current_account', start_date: startDate, end_date: endDate, page: String(page), page_size: '1000' });
      const r = await call({ url: `${cfg.base}/statements/${account.id}?${qs}`, headers: await apiHeaders() }, 'extrato');
      if (r.status >= 400) throw new ItauError(`O Itaú respondeu ${r.status} na consulta do extrato da conta ${account.label}${errMsg(r) ? `: ${errMsg(r)}` : ''}.`);
      for (const item of (r.body && r.body.data) || []) {
        if (Array.isArray(item.events)) events.push(...item.events);
        if (Array.isArray(item.pendingEvents)) pending.push(...item.pendingEvents);
        if (Array.isArray(item.balances) && item.balances.length) lastBalance = item.balances[item.balances.length - 1];
      }
      const p = r.body && r.body.pagination;
      if (!p || !p.total_pages || page >= p.total_pages) break;
    }
    return { events, pending, lastBalance };
  }

  return { config: cfg, getToken, balances, statement, log };
}

// Evento do extrato → linha no formato dos extratos do sistema (o mesmo do OFX).
function toTransaction(ev) {
  const value = Math.round(Number(ev.amount && ev.amount.value) * 100);
  if (!Number.isFinite(value) || value === 0) return null;
  const sign = String(ev.operation || '').toUpperCase() === 'D' ? -1 : 1;
  const lit = ev.literal || {};
  const who = ev.counterpart && ev.counterpart.name ? String(ev.counterpart.name).trim() : '';
  let description = String(lit.complete || lit.shortened || ev.type || 'Lançamento').replace(/\s+/g, ' ').trim();
  if (who && !description.toUpperCase().includes(who.toUpperCase())) description = `${description} - ${who}`;
  const date = (ev.date && (ev.date.accounting || String(ev.date.event || '').slice(0, 10))) || null;
  if (!date) return null;
  return {
    fitid: ev.id ? `itau:${ev.id}` : null,
    date,
    amount_cents: sign * Math.abs(value),
    description: ev.reversal ? `ESTORNO ${description}` : description,
    trntype: (ev.origin && ev.origin.type) || lit.tip || ev.type || null,
  };
}

module.exports = { createClient, parseAccount, config, certInfo, toTransaction, httpsCall, ItauError, DEFAULTS };

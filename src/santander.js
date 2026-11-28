'use strict';

// Conector do Santander (Portal do Desenvolvedor, API "Bank Account Information") — extrato da conta corrente PJ.
// Mesmo caminho que funcionou em produção no sistema da consultoria (17/11/2026, conta da GELARE):
//   login:   POST https://trust-open.api.santander.com.br/auth/oauth/v2/token  (client_credentials; mTLS com o e-CNPJ A1)
//   extrato: GET  https://trust-open.api.santander.com.br/bank_account_information/v1/transactions/{agência.conta}
//            ?initialDate=AAAA-MM-DD&finalDate=AAAA-MM-DD&_limit=50&_offset=N
//            resposta: _content[] com transactionDate (dd/mm/aaaa), transactionName, historicComplement,
//            amount (sempre positivo) e creditDebitType (CREDITO | DEBITO)
//   saldo:   GET .../banks/0033/balances/{agência.conta} (em produção deu 422; quando falha, segue só com o extrato)
// Variáveis (as mesmas da consultoria, para copiar de um Render para o outro):
//   SANTANDER_CLIENT_ID, SANTANDER_CLIENT_SECRET, SANTANDER_AMBIENTE (sandbox | producao),
//   SANTANDER_CERT_PFX (o arquivo .pfx do e-CNPJ A1 em base64), SANTANDER_CERT_SENHA,
//   SANTANDER_CONTAS (agência.conta separadas por vírgula, ex.: 4316.13005206-3).
// Só LÊ. Nunca movimenta a conta.

const https = require('node:https');
const tls = require('node:tls');

const URLS = {
  sandbox: { token: 'https://trust-sandbox.api.santander.com.br/auth/oauth/v2/token', api: 'https://trust-sandbox.api.santander.com.br/bank_account_information/v1' },
  producao: { token: 'https://trust-open.api.santander.com.br/auth/oauth/v2/token', api: 'https://trust-open.api.santander.com.br/bank_account_information/v1' },
};
const BANK = '0033';

class SantanderError extends Error {}

const clean = (v) => String(v || '').trim();

// "4316.13005206-3" ou "4316/130052063" → { id: '4316.000130052063', branch: '4316', number: '13005206', digit: '3', label }
function parseAccount(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,4})[./\s-]+([\d.\s-]+)$/);
  if (!m) return null;
  const all = m[2].replace(/\D/g, '');
  if (all.length < 2) return null;
  const branch = m[1].padStart(4, '0');
  const number = all.slice(0, -1);
  const digit = all.slice(-1);
  return { id: `${branch}.${all.padStart(12, '0')}`, branch, number, digit, label: `${branch} / ${number.replace(/^0+/, '')}-${digit}` };
}

function config(env = process.env) {
  const ambiente = /prod/i.test(env.SANTANDER_AMBIENTE || '') ? 'producao' : 'sandbox';
  return {
    ambiente,
    clientId: clean(env.SANTANDER_CLIENT_ID), clientSecret: clean(env.SANTANDER_CLIENT_SECRET),
    pfxBase64: String(env.SANTANDER_CERT_PFX || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    senha: env.SANTANDER_CERT_SENHA || '',
    tokenUrl: clean(env.SANTANDER_URL_TOKEN) || URLS[ambiente].token,
    api: (clean(env.SANTANDER_URL_API) || URLS[ambiente].api).replace(/\/+$/, ''),
    accounts: String(env.SANTANDER_CONTAS || '').split(/[,;]+/).map(parseAccount).filter(Boolean),
  };
}

// Confere se o certificado abre com a senha (sem mostrar nada sigiloso).
function certCheck(cfg) {
  if (!cfg.pfxBase64) return { ok: false, error: 'falta SANTANDER_CERT_PFX' };
  try {
    tls.createSecureContext({ pfx: Buffer.from(cfg.pfxBase64, 'base64'), passphrase: cfg.senha });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: /mac verify|password|bad decrypt/i.test(e.message) ? 'a senha do certificado não confere' : 'o arquivo do certificado não abriu (confira se o texto em base64 foi colado inteiro)' };
  }
}

const SECRET = /(token|secret|password|senha|authorization)/i;
function redact(v, depth = 0) {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) && typeof x !== 'object' ? '***' : redact(x, depth + 1)]));
}

function httpsCall({ url, method = 'GET', headers = {}, body, pfx, passphrase, timeoutMs = 45000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, method, headers, pfx, passphrase }, (res) => {
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
  const pfx = cfg.pfxBase64 ? Buffer.from(cfg.pfxBase64, 'base64') : null;
  async function call(opts, what) {
    if (!cfg.clientId || !cfg.clientSecret) throw new SantanderError('Faltam as variáveis SANTANDER_CLIENT_ID e SANTANDER_CLIENT_SECRET no servidor.');
    if (!pfx) throw new SantanderError('Falta a variável SANTANDER_CERT_PFX (o certificado e-CNPJ A1 em base64) no servidor.');
    let r;
    try {
      r = await requestImpl({ ...opts, pfx, passphrase: cfg.senha });
    } catch (e) {
      const m = String(e.message || '');
      if (/mac verify|bad decrypt|password/i.test(m)) throw new SantanderError('A senha do certificado (SANTANDER_CERT_SENHA) não confere.');
      throw new SantanderError(`Não consegui conectar ao Santander (${what}: ${e.code || m}).`);
    }
    let body;
    try { body = JSON.parse(r.text); } catch { body = String(r.text || '').slice(0, 1500); }
    log.push({ url: opts.url, status: r.status, body: redact(body) });
    return { status: r.status, body };
  }

  let token = null; let tokenAt = 0;
  async function getToken() {
    if (token && Date.now() - tokenAt < 4 * 60 * 1000) return token;
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }).toString();
    const r = await call({ url: cfg.tokenUrl, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, body: form }, 'login');
    const t = r.body && r.body.access_token;
    if (r.status >= 400 || !t) {
      throw new SantanderError(r.status === 401 || r.status === 400 || r.status === 403
        ? `O Santander recusou o login (resposta ${r.status}). Confira Client ID, Client Secret, o certificado e o ambiente (${cfg.ambiente}).`
        : `O Santander não devolveu o token (resposta ${r.status}).`);
    }
    token = t; tokenAt = Date.now();
    return t;
  }
  const headers = async () => ({ Authorization: `Bearer ${await getToken()}`, 'X-Application-Key': cfg.clientId, Accept: 'application/json' });
  const errText = (r) => (r.body && typeof r.body === 'object' ? (r.body.message || r.body.detail || (Array.isArray(r.body._errors) && r.body._errors[0] && (r.body._errors[0]._message || r.body._errors[0].message)) || '') : String(r.body || '').slice(0, 200));

  async function balance(account) {
    const r = await call({ url: `${cfg.api}/banks/${BANK}/balances/${account.id}`, headers: await headers() }, 'saldo');
    if (r.status >= 400) throw new SantanderError(`saldo: resposta ${r.status}${errText(r) ? ` (${errText(r)})` : ''}`);
    const b = r.body || {};
    const n = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(String(v).replace(',', '.')) * 100));
    return { available_cents: n(b.availableAmount), auto_invest_cents: n(b.automaticallyInvestedAmount), blocked_cents: n(b.blockedAmount) };
  }

  // Lançamentos de um período, página a página (para quando a página vier repetida ou incompleta).
  async function statement(account, startDate, endDate, { limit = 50 } = {}) {
    const items = [];
    let prevFirst = null;
    for (let page = 1; page <= 100; page += 1) {
      const qs = new URLSearchParams({ initialDate: startDate, finalDate: endDate, _limit: String(limit), _offset: String(page) });
      const r = await call({ url: `${cfg.api}/transactions/${account.id}?${qs}`, headers: await headers() }, 'extrato');
      if (r.status >= 400) throw new SantanderError(`O Santander respondeu ${r.status} no extrato da conta ${account.label}${errText(r) ? `: ${errText(r)}` : ''}.`);
      const list = (r.body && (r.body._content || r.body.content || r.body.data)) || [];
      if (!Array.isArray(list) || !list.length) break;
      const first = JSON.stringify(list[0]);
      if (first === prevFirst) break; // o banco ignorou a paginação: não repete
      prevFirst = first;
      items.push(...list);
      const next = r.body && r.body._pageable && r.body._pageable._next;
      if (list.length < limit && !next) break;
    }
    return items;
  }

  return { config: cfg, getToken, balance, statement, log };
}

// "21/11/2026" ou "2026-11-21" → "2026-11-21"
function isoDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Lançamento do Santander → linha do extrato do sistema (o mesmo formato do OFX).
function toTransaction(t) {
  const value = Math.round(Number(String(t.amount ?? '').replace(',', '.')) * 100);
  const date = isoDate(t.transactionDate || t.accountingDate || t.date);
  if (!date || !Number.isFinite(value) || value === 0) return null;
  const debit = /^D/i.test(String(t.creditDebitType || t.type || ''));
  const description = `${t.transactionName || ''} ${t.historicComplement || ''}`.replace(/\s+/g, ' ').trim() || 'Lançamento';
  return {
    fitid: t.transactionId || t.documentNumber ? `santander:${t.transactionId || t.documentNumber}` : null,
    date, amount_cents: (debit ? -1 : 1) * Math.abs(value), description, trntype: debit ? 'DEBIT' : 'CREDIT',
  };
}

module.exports = { createClient, config, certCheck, parseAccount, toTransaction, isoDate, httpsCall, SantanderError, URLS };

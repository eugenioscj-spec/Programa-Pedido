'use strict';

// Certificado dinâmico do Itaú gerado pelo próprio sistema (fluxo "varejo": o Itaú manda por e-mail uma planilha com
// o Client ID de produção e um TOKEN TEMPORÁRIO de cada CNPJ, válido por 7 dias).
//   1. O sistema cria a chave privada (RSA 2048) e o pedido de certificado (CSR) com CN = Client ID — igual ao programa
//      oficial do Itaú (certificado-dinamico, Node), incluindo os campos C, ST, L, OU e a assinatura SHA-512.
//   2. Envia o CSR para POST https://sts.itau.com.br/seguranca/v1/certificado/solicitacao (Bearer = token temporário).
//   3. O Itaú devolve o certificado assinado e, numa linha "Secret: <uuid>", o Client Secret (só aparece essa vez).
// A chave privada e o Client Secret ficam guardados no banco (cifrados com ITAU_CRYPT_KEY, se existir no servidor).

const crypto = require('node:crypto');
const https = require('node:https');

const STS_HOST = 'sts.itau.com.br';
const CERT_PATH = '/seguranca/v1/certificado/solicitacao';

// ---------- DER mínimo (o mesmo do programa oficial) ----------
function derEncode(tag, content) {
  const len = content.length;
  let header;
  if (len < 128) header = Buffer.from([tag, len]);
  else if (len < 256) header = Buffer.from([tag, 0x81, len]);
  else header = Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([header, content]);
}
const seq = (...els) => derEncode(0x30, Buffer.concat(els));
const set = (...els) => derEncode(0x31, Buffer.concat(els));
const bitString = (data) => derEncode(0x03, Buffer.concat([Buffer.from([0x00]), data]));
function rdn(oid, value, printable) {
  const val = printable ? derEncode(0x13, Buffer.from(value, 'ascii')) : derEncode(0x0c, Buffer.from(value, 'utf8'));
  return set(seq(derEncode(0x06, Buffer.from(oid)), val));
}

// Texto sem acento (o portal do Itaú pede só letras sem acento e números)
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-&]/g, '').trim();

// Gera a chave privada (PEM) e o CSR (PEM).
function buildCsr({ clientId, organization, city, state, country = 'BR' }) {
  if (!clientId) throw new Error('Informe o Client ID.');
  const fields = { organization: plain(organization), city: plain(city), state: plain(state).toUpperCase(), country: plain(country).toUpperCase() || 'BR' };
  for (const [k, v] of Object.entries(fields)) if (!v) throw new Error(`Campo obrigatório vazio: ${k}.`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const subject = seq(
    rdn([0x55, 0x04, 0x06], fields.country, true),
    rdn([0x55, 0x04, 0x08], fields.state),
    rdn([0x55, 0x04, 0x07], fields.city),
    rdn([0x55, 0x04, 0x0b], fields.organization),
    rdn([0x55, 0x04, 0x03], String(clientId).trim()),
  );
  const info = seq(derEncode(0x02, Buffer.from([0x00])), subject, publicKey, Buffer.from([0xa0, 0x00]));
  const signer = crypto.createSign('SHA512');
  signer.update(info);
  const sha512WithRSA = Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d, 0x05, 0x00]);
  const der = seq(info, sha512WithRSA, bitString(signer.sign(privateKey)));
  const csrPem = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
  return { keyPem: privateKey, csrPem, fields };
}

function stsPost({ token, body, insecure = false }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: STS_HOST, path: CERT_PATH, method: 'POST',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: !insecure,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.setTimeout(45000, () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Separa o certificado e o Client Secret da resposta do Itaú.
function parseResponse(text) {
  const uuid = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
  let secret = null;
  const certLines = [];
  for (const line of String(text || '').split('\n')) {
    if (/Secret:/i.test(line)) { const m = line.match(uuid); secret = m ? m[0] : line.replace(/.*Secret:\s*/i, '').trim(); } else certLines.push(line);
  }
  const certPem = certLines.join('\n').trim();
  const m = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  return { certPem: m ? `${m[0]}\n` : null, secret };
}

const certValidTo = (certPem) => {
  try { return new Date(new crypto.X509Certificate(certPem).validTo).toISOString().slice(0, 10); } catch { return null; }
};

// Pede o certificado. postImpl troca nos testes.
async function requestCertificate({ clientId, token, organization, city, state, country = 'BR', postImpl = stsPost, insecure = false }) {
  if (!token) throw new Error('Informe o token temporário.');
  const { keyPem, csrPem, fields } = buildCsr({ clientId, organization, city, state, country });
  let r;
  try {
    r = await postImpl({ token: String(token).trim(), body: csrPem, insecure });
  } catch (e) {
    throw new Error(`Não consegui falar com o Itaú (${e.code || e.message}).`);
  }
  if (r.status !== 200) {
    const hint = r.status === 401 || r.status === 403 ? ' O token temporário pode ter vencido (vale 7 dias) ou não ser deste Client ID.' : '';
    throw new Error(`O Itaú recusou o pedido do certificado (resposta ${r.status}).${hint} Resposta: ${String(r.text || '').slice(0, 200)}`);
  }
  const { certPem, secret } = parseResponse(r.text);
  if (!certPem) throw new Error('O Itaú respondeu, mas sem o certificado. Baixe o diagnóstico e mande para o suporte do sistema.');
  return { keyPem, certPem, clientSecret: secret, validTo: certValidTo(certPem), fields };
}

// ---------- guarda cifrada (AES-256-GCM com ITAU_CRYPT_KEY; sem a variável, guarda como está) ----------
function seal(value, env = process.env) {
  if (value === null || value === undefined) return null;
  const k = env.ITAU_CRYPT_KEY;
  if (!k) return `plain:${value}`;
  const key = crypto.createHash('sha256').update(k).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return `enc:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}
function unseal(stored, env = process.env) {
  if (!stored) return null;
  if (stored.startsWith('plain:')) return stored.slice(6);
  if (!stored.startsWith('enc:')) return stored;
  const k = env.ITAU_CRYPT_KEY;
  if (!k) throw new Error('A credencial do Itaú está cifrada e falta a variável ITAU_CRYPT_KEY no servidor.');
  const raw = Buffer.from(stored.slice(4), 'base64');
  const key = crypto.createHash('sha256').update(k).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { buildCsr, requestCertificate, parseResponse, certValidTo, seal, unseal, plain };

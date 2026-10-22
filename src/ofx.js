'use strict';

// Leitor de extratos OFX (versão 1.x em SGML e 2.x em XML), do jeito que os bancos brasileiros exportam:
// tags sem fechamento, datas com fuso "[-3:BRT]", valores com vírgula, acentos em Windows-1252.

const BANKS = {
  '001': 'Banco do Brasil', '033': 'Santander', '041': 'Banrisul', '077': 'Inter', '104': 'Caixa', '208': 'BTG Pactual',
  '212': 'Original', '237': 'Bradesco', '260': 'Nubank', '290': 'PagBank', '323': 'Mercado Pago', '336': 'C6 Bank',
  '341': 'Itaú', '380': 'PicPay', '422': 'Safra', '748': 'Sicredi', '756': 'Sicoob',
};

// Texto do arquivo: usa UTF-8 e cai para Windows-1252 quando o arquivo declara isso ou quando há caracteres inválidos.
function decodeOfx(buffer) {
  const head = buffer.subarray(0, 600).toString('latin1');
  const declares1252 = /CHARSET:\s*(1252|ISO-8859-1|WINDOWS-1252)/i.test(head) || /ENCODING="?(windows-1252|iso-8859-1)/i.test(head);
  const utf8 = buffer.toString('utf8');
  if (!declares1252 && !utf8.includes('�')) return utf8;
  return new TextDecoder('windows-1252').decode(buffer);
}

const tagValue = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : null;
};
const blocks = (text, tag) => {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
};

function parseAmount(raw) {
  if (raw === null || raw === undefined) return NaN;
  let s = String(raw).trim().replace(/\s/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function parseDate(raw) {
  const m = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const clean = (s) => String(s || '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();

function parseStatement(block, kind) {
  const acct = (kind === 'cartao' ? blocks(block, 'CCACCTFROM')[0] : blocks(block, 'BANKACCTFROM')[0]) || block;
  const bankCode = (tagValue(acct, 'BANKID') || '').replace(/\D/g, '').padStart(3, '0').slice(-3) || null;
  const accountNumber = (tagValue(acct, 'ACCTID') || '').trim();
  const list = blocks(block, 'BANKTRANLIST')[0] || block;
  const transactions = blocks(list, 'STMTTRN').map((t) => {
    const name = clean(tagValue(t, 'NAME'));
    const memo = clean(tagValue(t, 'MEMO'));
    // Uns bancos põem a descrição em NAME, outros em MEMO, outros repetem nos dois.
    let description;
    if (name && memo) description = name.includes(memo) ? name : memo.includes(name) ? memo : `${name} - ${memo}`;
    else description = name || memo || clean(tagValue(t, 'TRNTYPE')) || 'Sem descrição';
    return {
      fitid: tagValue(t, 'FITID'),
      date: parseDate(tagValue(t, 'DTPOSTED')),
      amount_cents: parseAmount(tagValue(t, 'TRNAMT')),
      description,
      trntype: tagValue(t, 'TRNTYPE'),
    };
  }).filter((t) => t.date && Number.isFinite(t.amount_cents) && t.amount_cents !== 0);
  const ledger = blocks(block, 'LEDGERBAL')[0];
  return {
    kind,
    bank_code: bankCode,
    bank_name: BANKS[bankCode] || (bankCode ? `Banco ${bankCode}` : 'Banco'),
    branch: tagValue(acct, 'BRANCHID'),
    account_number: accountNumber,
    period_start: parseDate(tagValue(list, 'DTSTART')),
    period_end: parseDate(tagValue(list, 'DTEND')),
    ledger_balance_cents: ledger ? parseAmount(tagValue(ledger, 'BALAMT')) : null,
    balance_date: ledger ? parseDate(tagValue(ledger, 'DTASOF')) : null,
    transactions,
  };
}

function parseOfx(input) {
  const text = Buffer.isBuffer(input) ? decodeOfx(input) : String(input);
  const start = text.search(/<OFX>/i);
  if (start < 0) throw new Error('O arquivo não parece ser um extrato OFX.');
  const body = text.slice(start);
  const statements = [
    ...blocks(body, 'STMTRS').map((b) => parseStatement(b, 'corrente')),
    ...blocks(body, 'CCSTMTRS').map((b) => parseStatement(b, 'cartao')),
  ].filter((s) => s.account_number);
  if (!statements.length) throw new Error('Nenhuma conta encontrada no extrato.');
  for (const s of statements) {
    if (Number.isNaN(s.ledger_balance_cents)) s.ledger_balance_cents = null;
  }
  return statements;
}

// Chave para não importar o mesmo lançamento duas vezes, mesmo com arquivos de períodos que se sobrepõem.
// Alguns bancos repetem o FITID ou não mandam: aí usa data + valor + descrição + ordem no dia.
function dedupeKeys(transactions) {
  const fitidCount = new Map();
  for (const t of transactions) if (t.fitid) fitidCount.set(t.fitid, (fitidCount.get(t.fitid) || 0) + 1);
  const seen = new Map();
  return transactions.map((t) => {
    if (t.fitid && fitidCount.get(t.fitid) === 1 && !/^0+$/.test(t.fitid)) return `F:${t.fitid}:${t.date}:${t.amount_cents}`;
    const base = `H:${t.date}:${t.amount_cents}:${t.description.toUpperCase()}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return `${base}:${n}`;
  });
}

module.exports = { parseOfx, decodeOfx, dedupeKeys, parseAmount, BANKS };

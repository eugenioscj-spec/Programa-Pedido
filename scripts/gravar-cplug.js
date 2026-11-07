'use strict';

// Gravador do CPlug: abre o Chrome (ou o Edge) do computador no login do CPlug. Você entra e navega
// normalmente; ele anota como as telas do CPlug buscam os dados (endereços e respostas), para depois
// montarmos a busca automática diária. NÃO guarda a sua senha, o usuário, os cookies nem os tokens:
// tudo isso é trocado por *** antes de salvar.
//
// Uso: "Gravar passos do CPlug.bat" (ou: node scripts/gravar-cplug.js)

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const START = 'https://connectplug.com.br/login';
const HOSTS = /(^|\.)(connectplug\.com\.br|cplug\.com\.br)$/i;
const SECRET_KEY = /(senha|password|passwd|pass|secret|token|jwt|auth|cookie|session|sessao|usuario|user|login|email)/i;
const MAX_BODY = 300 * 1024;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(__dirname, '..', 'gravacao-cplug', stamp);

// Troca por *** qualquer valor cujo nome pareça segredo (em JSON, formulário ou texto).
function redactValue(v, depth = 0) {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) && typeof x !== 'object' ? '***' : redactValue(x, depth + 1);
  return out;
}
function redactText(text, type = '') {
  if (!text) return text;
  try {
    return JSON.stringify(redactValue(JSON.parse(text)));
  } catch { /* não é JSON */ }
  if (/x-www-form-urlencoded/i.test(type) || /^[^\s{<]+=[^\s]*(&|$)/.test(text)) {
    const p = new URLSearchParams(text);
    for (const k of [...p.keys()]) if (SECRET_KEY.test(k)) p.set(k, '***');
    return p.toString();
  }
  // JWT solto no texto
  return text.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '***');
}
function redactUrl(u) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (SECRET_KEY.test(k)) url.searchParams.set(k, '***');
    return url.toString();
  } catch {
    return u;
  }
}
const cleanHeaders = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, SECRET_KEY.test(k) ? '***' : v]));

// Procura o Chrome/Edge do computador em todos os lugares comuns do Windows (inclusive o Chrome
// instalado só para o usuário, em AppData). Se nenhum servir, usa o navegador baixado pelo Playwright.
function browserPaths() {
  const env = process.env;
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA, 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean);
  const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe'];
  const list = [];
  for (const r of roots) for (const x of rel) list.push(path.join(r, x));
  return [...new Set(list)].filter((f) => { try { return fs.existsSync(f); } catch { return false; } });
}

async function launch(chromium) {
  const tries = [
    ...browserPaths().map((executablePath) => ({ label: executablePath, opts: { executablePath } })),
    { label: 'Chrome (canal)', opts: { channel: 'chrome' } },
    { label: 'Edge (canal)', opts: { channel: 'msedge' } },
    { label: 'navegador do Playwright', opts: {} },
  ];
  for (const t of tries) {
    try {
      const b = await chromium.launch({ ...t.opts, headless: false });
      console.log(`Navegador aberto: ${t.label}`);
      return b;
    } catch (e) {
      console.log(`Não abriu (${t.label}): ${String(e.message).split('\n')[0]}`);
    }
  }
  return null;
}

const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); resolve(a); });
});

(async () => {
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    console.log('Falta o componente do gravador. Rode pelo arquivo "Gravar passos do CPlug.bat".');
    process.exit(1);
  }
  fs.mkdirSync(path.join(OUT, 'arquivos'), { recursive: true });
  const records = [];
  const browser = await launch(chromium);
  if (!browser) {
    console.log('');
    console.log('Nenhum navegador abriu. Rode de novo o "Gravar passos do CPlug.bat": ele vai baixar um navegador só para a gravação.');
    process.exit(2);
  }
  const context = await browser.newContext({ acceptDownloads: true, locale: 'pt-BR' });
  const page = await context.newPage();

  context.on('response', async (res) => {
    const req = res.request();
    let host;
    try { host = new URL(req.url()).hostname; } catch { return; }
    if (!HOSTS.test(host)) return;
    const kind = req.resourceType();
    if (!['xhr', 'fetch', 'document', 'other'].includes(kind)) return;
    const type = res.headers()['content-type'] || '';
    let body = null;
    if (/json|csv|text\/plain|xml/i.test(type)) {
      try {
        const text = await res.text();
        body = redactText(text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text, type);
        if (text.length > MAX_BODY) body += '\n[...cortado]';
      } catch { /* resposta sem corpo */ }
    } else if (kind === 'document') {
      body = `[página HTML, ${type}]`;
    }
    records.push({
      quando: new Date().toISOString(), tipo: kind, metodo: req.method(), url: redactUrl(req.url()), status: res.status(),
      cabecalhos_pedido: cleanHeaders(req.headers()), envio: redactText(req.postData() || '', req.headers()['content-type']),
      tipo_resposta: type, resposta: body, tela: redactUrl(page.url()),
    });
  });
  context.on('page', (p) => p.on('download', saveDownload));
  page.on('download', saveDownload);
  async function saveDownload(d) {
    const name = d.suggestedFilename().replace(/[^\w.\- ]/g, '_');
    await d.saveAs(path.join(OUT, 'arquivos', name)).catch(() => {});
    console.log(`   Arquivo baixado e guardado: ${name}`);
  }

  // Avisa se aparecer captcha (o robô não vai tentar contornar).
  page.on('framenavigated', async () => {
    const html = await page.content().catch(() => '');
    if (/recaptcha|hcaptcha|turnstile|captcha/i.test(html)) console.log('   Atenção: esta tela tem verificação "não sou um robô" (captcha).');
  });

  await page.goto(START);
  console.log('');
  console.log('==============================================================');
  console.log(' GRAVADOR DO CPLUG');
  console.log('==============================================================');
  console.log(' Na janela do navegador que abriu:');
  console.log('  1) Entre com o código da empresa, usuário e senha.');
  console.log('  2) Abra o RELATÓRIO DE VENDAS POR PRODUTO de um dia (ontem, por exemplo).');
  console.log('     Se houver, exporte para Excel/CSV.');
  console.log('  3) Troque para a OUTRA LOJA e repita o passo 2.');
  console.log('  4) Se der, abra também as vendas por FORMA DE PAGAMENTO e o ESTOQUE.');
  console.log('  5) Volte para esta janela preta e aperte ENTER.');
  console.log('');
  console.log(' A sua senha, o usuário, cookies e tokens NÃO são guardados.');
  console.log('==============================================================');
  await ask('\nAperte ENTER quando terminar... ');

  fs.writeFileSync(path.join(OUT, 'requisicoes.json'), JSON.stringify(records, null, 1));
  const resumo = records.filter((r) => r.tipo !== 'document').map((r) => `${r.status} ${r.metodo} ${r.url.split('?')[0]}  (${(r.tipo_resposta || '').split(';')[0]})`);
  fs.writeFileSync(path.join(OUT, 'resumo.txt'), [...new Set(resumo)].join('\n'));
  await browser.close().catch(() => {});
  console.log('');
  console.log(` Pronto! ${records.length} chamadas gravadas na pasta:`);
  console.log(`   ${OUT}`);
  console.log(' Clique com o botão direito nessa pasta > Compactar (ZIP) e mande o arquivo para o Claude.');
  process.exit(0);
})().catch((e) => {
  console.error('Erro no gravador:', e.message);
  process.exit(1);
});

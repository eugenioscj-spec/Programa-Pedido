'use strict';

// Roda o sistema no próprio computador para testar (sem hospedagem).
// Na primeira vez carrega produtos e um cliente de EXEMPLO, abre o navegador
// e mostra o endereço para testar pelo celular na mesma rede Wi-Fi.

const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3000;
process.env.PORT = String(PORT);

spawnSync(process.execPath, [path.join(__dirname, 'seed-demo.js')], { stdio: 'inherit' });
require('../server.js');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* abre manualmente */ }
}

function whenReady(tries = 0) {
  http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
    res.resume();
    const lan = lanAddresses();
    console.log('\n==============================================================');
    console.log(' SISTEMA DE TESTE LIGADO. Não feche esta janela enquanto usa.');
    console.log('==============================================================');
    console.log(`  Painel da loja (neste computador): http://localhost:${PORT}/admin`);
    console.log(`  Portal do cliente:                 http://localhost:${PORT}/`);
    if (lan.length) {
      console.log('\n  Para testar no celular (conectado no MESMO Wi-Fi), abra:');
      for (const ip of lan) console.log(`     http://${ip}:${PORT}/`);
    }
    console.log('\n  Cliente de exemplo: CNPJ 11.222.333/0001-81 · senha cliente123');
    console.log('  Para desligar: feche esta janela.\n');
    openBrowser(`http://localhost:${PORT}/admin`);
  }).on('error', () => {
    if (tries < 50) setTimeout(() => whenReady(tries + 1), 200);
  });
}
whenReady();

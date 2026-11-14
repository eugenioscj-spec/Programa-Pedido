'use strict';

// Rotina automática do CPlug: busca as vendas das lojas e guarda o "retrato" de cada dia
// (por produto e por forma de pagamento). Não lança nada na DRE, no caixa nem no estoque: só guarda.
//   - de hora em hora, das 8h às 23h (horário de Cuiabá): o dia de hoje até agora
//   - a partir das 3h da madrugada: o fechamento de ontem (e de anteontem, se ainda faltar)
// Só uma busca por vez. Cada busca fica registrada em sync_runs.

const T = require('./time');
const cplug = require('./cplug');

// ---------- de-para dos produtos (CPlug → nosso cadastro) ----------
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set(['picole', 'picol', 'pote', 'litros', 'litro', 'l', 'g', 'ml', 'com', 'de', 'do', 'da', 'e', 'base', 'linha',
  'sabor', 'sabores', 'cone', 'top', 'agua', 'leite']);
const ALIAS = { regionais: 'regionais', selecoes: 'selecoes', classicos: 'classico', classico: 'classico', acai: 'acai', 'acai': 'acai',
  bombom: 'bombom', lingua: 'lingua', vecna: 'vecna' };
function tokens(name) {
  const n = fold(name);
  const size = [];
  if (/1[,.]5\s*l/.test(n)) size.push('#1,5l'); // pote/açaí de 1,5 litro
  if (/\b200\s*g\b/.test(n)) size.push('#200g'); // açaí de 200 g
  const words = n.replace(/\(.*?\)/g, ' ').replace(/[\d.,]+\s*(g|ml|l|litros?)\b/g, ' ').replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t)).map((t) => ALIAS[t] || t)
    .map((t) => (t.length > 5 ? t.slice(0, 5) : t)); // "trufado" ~ "trufa", "classicos" ~ "classico"
  return new Set([...words, ...size]);
}
// Tipo pelo nome do CPlug: "2 LITROS", "1,5 LITROS" = pote; "200G" de açaí; resto = picolé/outros.
function cplugKind(name) {
  const n = fold(name);
  if (/\blitros?\b/.test(n)) return /acai/.test(n) ? 'Açaí' : 'Potes';
  if (/acai .*200\s*g|200\s*g.*acai/.test(n)) return 'Açaí';
  if (/giratto/.test(n)) return 'Cones';
  if (/sundae/.test(n)) return 'Sundae';
  if (/sensa bombom|bites/.test(n)) return 'Bombons';
  return 'Picolés';
}

// Melhor produto do nosso cadastro para um nome do CPlug: [{ product, score }] do melhor para o pior.
function rank(cplugName, products) {
  const a = tokens(cplugName);
  const kind = cplugKind(cplugName);
  return products.map((p) => {
    const b = tokens(p.name);
    let inter = 0;
    for (const t of a) if (b.has(t)) inter += 1;
    const union = new Set([...a, ...b]).size || 1;
    let score = inter / union;
    if (p.product_type && p.product_type !== kind) score *= 0.5; // tipo diferente (pote × picolé) pesa contra
    if (a.has('zero') !== b.has('zero')) score *= 0.5; // linha Zero só com Zero
    for (const sz of ['#1,5l', '#200g']) if (b.has(sz) && !a.has(sz)) score *= 0.6; // tamanho diferente
    return { product: p, score };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score);
}

function createSync(db, { fetchDay = cplug.fetchDay, env = process.env, log = console.log } = {}) {
  let running = null;

  const upsertStore = db.prepare(`INSERT INTO int_stores (source, external_id, name, cnpj) VALUES ('cplug', ?, ?, ?)
    ON CONFLICT(source, external_id) DO UPDATE SET name = excluded.name, cnpj = COALESCE(excluded.cnpj, int_stores.cnpj)`);
  const storeId = db.prepare("SELECT id FROM int_stores WHERE source = 'cplug' AND external_id = ?");

  // Produto do CPlug visto pela primeira vez: entra no de-para com a melhor sugestão.
  function seeProduct(code, name, products) {
    const found = db.prepare('SELECT * FROM cplug_products WHERE code = ? AND name = ?').get(code, name);
    if (found) { db.prepare("UPDATE cplug_products SET last_seen = datetime('now') WHERE id = ?").run(found.id); return; }
    const [best, second] = rank(name, products);
    const sure = best && best.score >= 0.99 && !(second && second.score >= best.score);
    db.prepare("INSERT INTO cplug_products (code, name, product_id, status, score) VALUES (?, ?, ?, ?, ?)")
      .run(code, name, best ? best.product.id : null, best ? (sure ? 'confirmado' : 'sugerido') : 'pendente', best ? Math.round(best.score * 100) / 100 : null);
  }

  // Grava o retrato de um dia (substitui o que havia daquele dia e loja).
  const saveDay = db.transaction((result) => {
    const products = db.prepare('SELECT id, name, product_type FROM products WHERE active = 1').all();
    let stores = 0;
    for (const s of result.stores) {
      if (!s.products && !s.payments) continue;
      upsertStore.run(String(s.id ?? s.name), s.name, s.cnpj || null);
      const id = storeId.get(String(s.id ?? s.name)).id;
      const date = result.date;
      if (s.products) {
        db.prepare('DELETE FROM cplug_daily_products WHERE store_id = ? AND date = ?').run(id, date);
        const ins = db.prepare(`INSERT INTO cplug_daily_products (store_id, date, code, name, quantity, value_cents) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(store_id, date, code, name) DO UPDATE SET quantity = quantity + excluded.quantity, value_cents = value_cents + excluded.value_cents`);
        for (const it of s.products.items) {
          ins.run(id, date, it.code || '', it.name, it.quantity, it.value_cents);
          seeProduct(it.code || '', it.name, products);
        }
      }
      if (s.payments) {
        db.prepare('DELETE FROM cplug_daily_payments WHERE store_id = ? AND date = ?').run(id, date);
        const ins = db.prepare(`INSERT INTO cplug_daily_payments (store_id, date, method, value_cents, returns_cents) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(store_id, date, method) DO UPDATE SET value_cents = value_cents + excluded.value_cents`);
        for (const m of s.payments.methods) ins.run(id, date, m.method, m.value_cents, m.returns_cents || 0);
      }
      db.prepare(`INSERT INTO cplug_daily_totals (store_id, date, products_cents, other_cents, payments_cents, item_count, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(store_id, date) DO UPDATE SET products_cents = excluded.products_cents, other_cents = excluded.other_cents,
          payments_cents = excluded.payments_cents, item_count = excluded.item_count, fetched_at = excluded.fetched_at`)
        .run(id, date, s.products ? s.products.total_cents : null, s.products ? s.products.other_cents : 0,
          s.payments ? s.payments.total_cents : null, s.products ? s.products.items.length : 0);
      stores += 1;
    }
    return stores;
  });

  const configured = () => !!(env.CPLUG_EMPRESA && env.CPLUG_USUARIO && env.CPLUG_SENHA);

  // Busca e grava as datas pedidas. Devolve o registro da busca.
  async function run(dates, kind = 'manual') {
    if (running) return { busy: true, run: running };
    const runId = Number(db.prepare("INSERT INTO sync_runs (source, kind, dates) VALUES ('cplug', ?, ?)").run(kind, dates.join(',')).lastInsertRowid);
    running = { id: runId, kind, dates };
    const problems = [];
    let stores = 0;
    try {
      if (!configured()) throw new Error('Faltam as variáveis CPLUG_EMPRESA, CPLUG_USUARIO e CPLUG_SENHA no servidor.');
      for (const date of dates) {
        const result = await fetchDay({ date, empresa: env.CPLUG_EMPRESA, usuario: env.CPLUG_USUARIO, senha: env.CPLUG_SENHA, keepPages: false });
        for (const s of result.stores) for (const e of s.errors) problems.push(`${s.name} ${date}: ${e}`);
        stores = Math.max(stores, saveDay(result));
      }
      const status = problems.length ? 'parcial' : 'ok';
      db.prepare("UPDATE sync_runs SET finished_at = datetime('now'), status = ?, message = ?, stores = ? WHERE id = ?")
        .run(status, problems.join(' | ').slice(0, 1000) || null, stores, runId);
    } catch (e) {
      db.prepare("UPDATE sync_runs SET finished_at = datetime('now'), status = 'erro', message = ?, stores = ? WHERE id = ?")
        .run(String(e.message).slice(0, 1000), stores, runId);
      log(`CPlug: busca ${kind} falhou: ${e.message}`);
    } finally {
      running = null;
    }
    return db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(runId);
  }

  // ---------- agenda ----------
  const lastRun = (kind, okOnly) => db.prepare(`SELECT * FROM sync_runs WHERE source = 'cplug' AND kind = ?
    ${okOnly ? "AND status IN ('ok', 'parcial')" : ''} ORDER BY id DESC LIMIT 1`).get(kind);
  const hasDay = (date) => db.prepare("SELECT 1 FROM sync_runs WHERE source = 'cplug' AND kind = 'fechamento' AND status IN ('ok', 'parcial') AND (',' || dates || ',') LIKE ?")
    .get(`%,${date},%`);
  const minutesSince = (sqlUtc) => (sqlUtc ? (Date.now() - Date.parse(`${sqlUtc.replace(' ', 'T')}Z`)) / 60000 : Infinity);

  // O que a agenda faria agora (separado para dar para testar sem relógio de verdade).
  function due(now = new Date()) {
    if (!configured() || db.prepare("SELECT value FROM settings WHERE key = 'cplug_auto'").get()?.value === '0') return null;
    const today = T.localDate(now);
    const hour = Number(new Date(now.getTime() - 4 * 3600e3).toISOString().slice(11, 13)); // hora em Cuiabá
    const yesterday = T.addDays(today, -1);
    if (hour >= 3) {
      const missing = [T.addDays(today, -2), yesterday].filter((d) => !hasDay(d));
      // tenta de novo no máximo a cada 30 min se o fechamento falhar
      const last = lastRun('fechamento', false);
      if (missing.length && minutesSince(last && last.started_at) >= 30) return { kind: 'fechamento', dates: missing };
    }
    if (hour >= 8) {
      const last = lastRun('hoje', false);
      if (minutesSince(last && last.started_at) >= 60) return { kind: 'hoje', dates: [today] };
    }
    return null;
  }

  let timer = null;
  function start({ everyMs = 5 * 60 * 1000 } = {}) {
    if (timer) return;
    const tick = () => {
      const job = due();
      if (job && !running) run(job.dates, job.kind).catch(() => {});
    };
    timer = setInterval(tick, everyMs);
    if (timer.unref) timer.unref();
    setTimeout(tick, 60 * 1000).unref?.();
  }

  return { run, due, start, saveDay, configured, isRunning: () => running };
}

module.exports = { createSync, rank, tokens, cplugKind };

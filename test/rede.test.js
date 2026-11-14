'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchSales, findList, summarizeSale, totals } = require('../src/rede');

function fakeRede() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const ok = req.headers.authorization === `Basic ${Buffer.from('id-certo:segredo').toString('base64')}`;
      return ok ? json(200, { access_token: 'tok-123', token_type: 'Bearer', expires_in: 1440 }) : json(401, { error: 'invalid_client' });
    }
    if (url.pathname === '/merchant-statement/v1/sales') {
      if (req.headers.authorization !== 'Bearer tok-123') return json(401, { message: 'unauthorized' });
      if (url.searchParams.get('parentCompanyNumber') !== '13381369' || url.searchParams.get('startDate') !== '2026-11-13') return json(200, { content: { transactions: [] } });
      const page2 = url.searchParams.get('pageKey') === 'p2';
      return json(200, {
        content: { transactions: page2 ? [{ saleDate: '2026-11-13', amount: 10, netAmount: 9.8, mdrAmount: 0.2, brand: { name: 'VISA' }, modality: { type: 'DEBIT' }, nsu: '2', status: 'APPROVED' }]
          : [{ saleDate: '2026-11-13', amount: 47.92, netAmount: 46.36, mdrAmount: 1.56, brand: { name: 'MASTERCARD' }, modality: { type: 'CREDIT' }, installmentQuantity: 1, nsu: '1', status: 'APPROVED' }] },
        cursor: page2 ? { hasNextKey: false } : { hasNextKey: true, nextKey: 'p2' },
      });
    }
    return json(404, {});
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

test('Rede: token com Client ID/Secret, vendas do dia com paginação e campos resumidos', async (t) => {
  const server = await fakeRede();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { REDE_CLIENT_ID: 'id-certo', REDE_CLIENT_SECRET: 'segredo', REDE_BASE_URL: base, REDE_TOKEN_URL: `${base}/oauth/token` };
  const r = await fetchSales({ date: '2026-11-13', pv: '13381369', env });
  assert.equal(r.error, undefined);
  assert.equal(r.sales.length, 2, 'juntou as duas páginas');
  assert.deepEqual(r.summary[0], { date: '2026-11-13', hour: null, gross_cents: 4792, net_cents: 4636, fee_cents: 156, brand: 'MASTERCARD', modality: 'CREDIT', installments: 1, nsu: '1', status: 'APPROVED' });
  assert.equal(r.total_cents, 5792);
  assert.ok(!JSON.stringify(r.log).includes('tok-123'), 'o token não vai para o diagnóstico');

  const bad = await fetchSales({ date: '2026-11-13', pv: '13381369', env: { ...env, REDE_CLIENT_SECRET: 'errado' } });
  assert.match(bad.error, /recusou as credenciais/);
  const missing = await fetchSales({ date: '2026-11-13', pv: '1', env: {} });
  assert.match(missing.error, /REDE_CLIENT_ID/);
});

test('Rede: acha a lista de vendas em formatos diferentes', () => {
  assert.equal(findList({ content: [{ a: 1 }] }).length, 1);
  assert.equal(findList({ sales: [{ a: 1 }, { a: 2 }] }).length, 2);
  assert.equal(summarizeSale({ grossAmount: '12.5', modality: 'DEBIT' }).gross_cents, 1250);
});

test('Rede: totais só das aprovadas, canceladas à parte, por modalidade (formato real do sandbox)', () => {
  const sale = (amount, mdr, type, status = 'APPROVED') => ({ status, saleHour: '18:00:00', amount, mdrAmount: mdr, netAmount: Math.round((amount - mdr) * 100) / 100,
    installmentQuantity: 1, brandCode: 1, saleDate: '2026-11-13', modality: { type, code: type === 'CREDIT' ? 1 : 2 } });
  const t = totals([sale(118.12, 2.17, 'CREDIT'), sale(148, 2.35, 'DEBIT'), sale(188.33, 3.48, 'CREDIT', 'CANCELLED')].map(summarizeSale));
  assert.deepEqual([t.approved_count, t.total_cents, t.fee_cents, t.net_cents], [2, 26612, 452, 26160]);
  assert.deepEqual([t.cancelled_count, t.cancelled_cents], [1, 18833]);
  assert.equal(t.by_modality.DEBIT.gross_cents, 14800);
  assert.equal(summarizeSale(sale(10, 1, 'DEBIT')).brand, 'código 1');
});

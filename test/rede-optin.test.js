'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { requestAccess, checkAccess, statusLabel } = require('../src/rede-optin');

// Formato real da documentação da Rede (swagger.yaml baixado pelo servidor em 18/11/2026).
const REAL_SPEC = `
openapi: 3.0.1
paths:
  /partner/v1/organizations/requests/features/merchant-statement:
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Cadastro'
components:
  schemas:
    Cadastro:
      title: Request Body - Solicitação de Acesso ao Extrato - Cadastro
      type: object
      required: [requestCompanyNumber, requestType, permissions]
      properties:
        requestCompanyNumber:
          type: number
          example: 13818724
        companyNumbers:
          type: array
          items:
            type: number
        requestType:
          type: string
          example: P
        permissions:
          type: string
          example: R
`;

const SPEC = (extraRequired = '') => `
openapi: 3.0.1
paths:
  /partner/v1/organizations/requests/features/merchant-statement:
    post:
      summary: Criação
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Cadastro'
  /partner/v1/organizations/requests/{requestId}/features/merchant-statement:
    get:
      summary: Consulta
components:
  schemas:
    Cadastro:
      type: object
      required: [requestCompanyNumber, requestType${extraRequired ? `, ${extraRequired}` : ''}]
      properties:
        requestCompanyNumber:
          type: integer
        requestType:
          type: string
          enum: [TOTAL, PARTIAL]
        subsidiaries:
          type: array
          items:
            type: integer
        partnerDocument:
          type: string
          description: CNPJ do parceiro
`;

function fakeRede(spec) {
  const seen = { posts: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (status, b) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/docs.yaml') { res.writeHead(200); return res.end(spec); }
      if (req.url === '/oauth/token') return json(200, { access_token: 'tok' });
      if (req.headers.authorization !== 'Bearer tok') return json(401, {});
      if (req.method === 'POST' && req.url === '/partner/v1/organizations/requests/features/merchant-statement') {
        seen.posts.push({ type: req.headers['content-type'], body: JSON.parse(body) });
        return json(201, { requestId: 'abc-123', status: 'PENDING' });
      }
      if (req.method === 'GET' && req.url === '/partner/v1/organizations/requests/abc-123/features/merchant-statement') return json(200, { requestId: 'abc-123', status: 'APPROVED' });
      return json(404, { message: 'not found' });
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, seen })));
}

const envFor = (base) => ({ REDE_CLIENT_ID: 'id', REDE_CLIENT_SECRET: 's', REDE_BASE_URL: base, REDE_TOKEN_URL: `${base}/oauth/token`, REDE_DOCS_URL: `${base}/docs.yaml` });

test('Opt-in: monta o pedido pela documentação (matriz, tipo total), envia e consulta a situação', async (t) => {
  const { server, seen } = await fakeRede(SPEC());
  t.after(() => server.close());
  const env = envFor(`http://127.0.0.1:${server.address().port}`);
  const r = await requestAccess({ matriz: '107468247', env });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(seen.posts[0].body, { requestCompanyNumber: 107468247, requestType: 'TOTAL' }, 'campo opcional desconhecido não vai');
  assert.match(seen.posts[0].type, /application\/json/);
  assert.equal(r.request_id, 'abc-123');
  assert.equal(statusLabel(r.status), 'Pendente (aprovar no portal da Rede)');
  const c = await checkAccess({ requestId: 'abc-123', env });
  assert.equal(statusLabel(c.status), 'Aprovado');

  const p = await requestAccess({ matriz: '107468247', tipo: 'PARCIAL', filiais: ['107531038'], env });
  assert.deepEqual(seen.posts[1].body, { requestCompanyNumber: 107468247, requestType: 'PARTIAL', subsidiaries: [107531038] });
  assert.equal(p.error, undefined);
});

test('Opt-in: campo obrigatório desconhecido = não envia nada e explica', async (t) => {
  const { server, seen } = await fakeRede(SPEC('partnerDocument'));
  t.after(() => server.close());
  const r = await requestAccess({ matriz: '107468247', env: envFor(`http://127.0.0.1:${server.address().port}`) });
  assert.match(r.error, /partnerDocument/);
  assert.match(r.error, /Nada foi enviado/);
  assert.equal(seen.posts.length, 0);
  assert.equal(r.missing[0].descricao, 'CNPJ do parceiro');
});

test('Opt-in com o formato real da Rede: T (total) e R (só leitura); parcial manda as filiais em companyNumbers', async (t) => {
  const { server, seen } = await fakeRede(REAL_SPEC);
  t.after(() => server.close());
  const env = envFor(`http://127.0.0.1:${server.address().port}`);
  const r = await requestAccess({ matriz: '107468247', env });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(seen.posts[0].body, { requestCompanyNumber: 107468247, requestType: 'T', permissions: 'R' });
  await requestAccess({ matriz: '107468247', tipo: 'PARCIAL', filiais: ['107531038'], env });
  assert.deepEqual(seen.posts[1].body, { requestCompanyNumber: 107468247, companyNumbers: [107531038], requestType: 'P', permissions: 'R' });
});

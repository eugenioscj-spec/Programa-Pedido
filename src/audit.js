'use strict';

// Registro de alterações: toda ação do painel que grava algo (POST/PUT/PATCH/DELETE) fica anotada com
// quem fez, quando, onde e o que foi enviado (sem senhas, tokens nem arquivos). Só se acrescenta: nada é apagado.

const AREAS = {
  pedidos: 'Pedidos', estoque: 'Estoque', movimentos: 'Estoque', entrada: 'Estoque', saida: 'Estoque', inventario: 'Estoque',
  financeiro: 'Financeiro', bancos: 'Bancos', clientes: 'Clientes', produtos: 'Produtos', favoritos: 'Produtos', crm: 'CRM',
  integracoes: 'Integrações', lojas: 'Lojas', feriados: 'Feriados', config: 'Configurações', usuarios: 'Usuários',
  locais: 'Configurações', motivos: 'Configurações', 'tipos-saida': 'Configurações', loja: 'Loja', senha: 'Senha',
};
const VERB = { POST: 'Criou/executou', PUT: 'Alterou', PATCH: 'Alterou', DELETE: 'Excluiu' };
const SECRET = /(senha|password|secret|token|authorization|chave|key)/i;

function redact(v, depth = 0) {
  if (v === null || typeof v !== 'object') return typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (depth > 6) return '…';
  if (Buffer.isBuffer(v)) return `[arquivo ${v.length} bytes]`;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? '***' : (/(buffer|content|base64|file)$/i.test(k) && typeof x === 'string' && x.length > 200 ? `[arquivo ${x.length} caracteres]` : redact(x, depth + 1))]));
}

function areaOf(path) {
  const seg = String(path || '').replace(/^\/+/, '').split(/[/?]/)[0];
  return AREAS[seg] || seg || 'Outros';
}

function createAudit(db) {
  const ins = db.prepare('INSERT INTO audit_log (admin_id, user_name, method, path, area, action, status, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

  // middleware: colocar depois do login (req.admin já preenchido)
  function middleware(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const started = Date.now();
    res.on('finish', () => {
      try {
        const path = req.path || req.url;
        const area = areaOf(path);
        let details = null;
        if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) details = JSON.stringify(redact(req.body)).slice(0, 4000);
        ins.run(req.admin ? req.admin.id : null, req.admin ? req.admin.name : null, req.method, path.slice(0, 300), area,
          `${VERB[req.method] || req.method} — ${area}`, res.statusCode, details, String(req.ip || '').slice(0, 60));
      } catch { /* o registro nunca derruba a operação */ }
      void started;
    });
    return next();
  }

  function list({ from, to, area, user, q, onlyOk = true, limit = 300 } = {}) {
    const where = []; const args = [];
    if (from) { where.push("date(at, '-4 hours') >= ?"); args.push(from); }
    if (to) { where.push("date(at, '-4 hours') <= ?"); args.push(to); }
    if (area) { where.push('area = ?'); args.push(area); }
    if (user) { where.push('user_name = ?'); args.push(user); }
    if (q) { where.push('(path LIKE ? OR details LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    if (onlyOk) where.push('status < 400');
    const rows = db.prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(1000, limit));
    return {
      rows,
      areas: db.prepare('SELECT DISTINCT area FROM audit_log ORDER BY area').all().map((r) => r.area),
      users: db.prepare('SELECT DISTINCT user_name FROM audit_log WHERE user_name IS NOT NULL ORDER BY user_name').all().map((r) => r.user_name),
    };
  }

  return { middleware, list };
}

module.exports = { createAudit, redact, areaOf };

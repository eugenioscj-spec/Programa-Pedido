'use strict';

const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const COOKIE = { admin: 'oggi_admin', customer: 'oggi_cliente' };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(name, value, maxAgeSeconds, secure) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function createSessionStore(db) {
  const insert = db.prepare(
    "INSERT INTO sessions (token_hash, user_type, user_id, expires_at) VALUES (?, ?, ?, datetime('now', ?))",
  );
  const find = db.prepare(
    "SELECT user_id FROM sessions WHERE token_hash = ? AND user_type = ? AND expires_at > datetime('now')",
  );
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const removeUser = db.prepare('DELETE FROM sessions WHERE user_type = ? AND user_id = ?');
  const purge = db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')");

  return {
    login(res, req, userType, userId) {
      purge.run();
      const token = crypto.randomBytes(32).toString('base64url');
      insert.run(sha256(token), userType, userId, `+${SESSION_DAYS} days`);
      res.append('Set-Cookie', cookieString(COOKIE[userType], token, SESSION_DAYS * 86400, req.secure));
    },
    logout(res, req, userType) {
      const token = parseCookies(req.headers.cookie)[COOKIE[userType]];
      if (token) remove.run(sha256(token));
      res.append('Set-Cookie', cookieString(COOKIE[userType], '', 0, req.secure));
    },
    userId(req, userType) {
      const token = parseCookies(req.headers.cookie)[COOKIE[userType]];
      if (!token) return null;
      const row = find.get(sha256(token), userType);
      return row ? row.user_id : null;
    },
    revokeAll(userType, userId) {
      removeUser.run(userType, userId);
    },
  };
}

// Limite simples de tentativas de login por IP (memória do processo).
function createLoginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  return function limit(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
    }
    return next();
  };
}

module.exports = { hashPassword, verifyPassword, createSessionStore, createLoginLimiter };

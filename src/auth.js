'use strict';
const db = require('./db');
const config = require('./config');
const { token, parseCookies, hashPassword, verifyPassword, shortId } = require('./util');

const SESSION_DAYS = 30;
const secure = config.siteUrl.startsWith('https://');

function cookie(name, value, { maxAgeSec, httpOnly = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAgeSec !== undefined) c += `; Max-Age=${maxAgeSec}`;
  return c;
}

function appendCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, value) : value);
}

// Loads req.user from the session cookie; remembers ?ref= referral codes.
function middleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.user = null;
  const sid = req.cookies.sid;
  if (sid) {
    const row = db.get().prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?
    `).get(sid, Date.now());
    if (row) req.user = row;
  }
  const ref = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
  if (ref && /^[a-z0-9]{4,16}$/.test(ref) && !req.user) {
    appendCookie(res, cookie('ref', ref, { maxAgeSec: config.referral.cookieDays * 86400 }));
    req.cookies.ref = ref;
  }
  next();
}

function startSession(res, userId) {
  const t = token(32);
  const now = Date.now();
  db.get().prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(t, userId, now, now + SESSION_DAYS * 86400_000);
  appendCookie(res, cookie('sid', t, { maxAgeSec: SESSION_DAYS * 86400 }));
}

function endSession(req, res) {
  if (req.cookies.sid) db.get().prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  appendCookie(res, cookie('sid', '', { maxAgeSec: 0 }));
}

function createUser({ phone, name, company = '', password, refCode = '' }) {
  const conn = db.get();
  const referrer = refCode ? conn.prepare('SELECT id FROM users WHERE ref_code = ?').get(refCode) : null;
  let code;
  do { code = shortId(8); } while (conn.prepare('SELECT 1 FROM users WHERE ref_code = ?').get(code));
  const isAdmin = config.adminPhones.includes(phone) ? 1 : 0;
  const info = conn.prepare(`
    INSERT INTO users (phone, name, company, password_hash, ref_code, referred_by, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(phone, name, company, hashPassword(password), code, referrer ? referrer.id : null, isAdmin, Date.now());
  return conn.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function checkLogin(phone, password) {
  const user = db.get().prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  // Admin phones can be added to the env after signup.
  if (config.adminPhones.includes(phone) && !user.is_admin) {
    db.get().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
    user.is_admin = 1;
  }
  return user;
}

function requireUser(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!req.user.is_admin) return res.status(403).send('forbidden');
  next();
}

// CSRF defence for cookie-authenticated POSTs: SameSite=Lax already blocks
// cross-site form posts in modern browsers; also reject foreign Origin headers.
function sameOrigin(req, res, next) {
  if (req.method !== 'POST') return next();
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host = '';
    try { host = new URL(origin).host; } catch { /* fallthrough */ }
    if (host && host !== req.headers.host) return res.status(403).send('bad origin');
  }
  next();
}

module.exports = { middleware, startSession, endSession, createUser, checkLogin, requireUser, requireAdmin, sameOrigin };

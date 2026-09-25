'use strict';
// Outgoing webhooks: the owner registers URLs and picks events; each event
// becomes a delivery row (a persisted queue, so restarts lose nothing) that a
// small in-process worker POSTs as signed JSON, retrying with backoff.
//
// SSRF: targets must be public. URLs are checked when saved, and every
// resolved address is checked again at connect time (guarded DNS lookup), so
// DNS rebinding can't slip a private address in. Redirects are not followed.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');
const db = require('../db');
const { isPrivateIp } = require('../importer');
const { token } = require('../util');

const EVENTS = {
  'lead.created': 'درخواست تماس جدید (فرم نام و شماره)',
  'conversation.handoff': 'مشتری پشتیبان انسانی خواست',
  'conversation.closed': 'گفتگوی پشتیبان تمام شد',
  'message.created': 'هر پیام جدید در گفتگو',
  'question.unanswered': 'سؤال بی‌جواب ماند',
};
const TEST_EVENT = 'ping';

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 6;
// Delay before retry n (after the n-th failed attempt).
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const KEEP_PER_HOOK = 50;
const TICK_MS = 5_000;
const BATCH = 25;
const USER_AGENT = 'Pasokhyar-Webhooks/1.0';

// ---- Test-only escape hatch -----------------------------------------------------
// Tests deliver to a receiver on 127.0.0.1, which the SSRF guard (correctly)
// refuses. They register the exact loopback host here. Refused in production.
const testAllowedHosts = new Set();
function allowPrivateHostsForTests(hosts) {
  if (process.env.NODE_ENV === 'production') throw new Error('allowPrivateHostsForTests is for tests only');
  testAllowedHosts.clear();
  for (const h of hosts || []) testAllowedHosts.add(String(h).toLowerCase());
}

function blockedIp(ip) {
  return isPrivateIp(ip) && !testAllowedHosts.has(ip);
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some(a => blockedIp(a.address))) return callback(new Error('blocked_address'));
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function bareHost(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

// -> { ok: true, url } | { ok: false, error }
async function validateUrl(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 500) return { ok: false, error: 'bad_url' };
  let url;
  try { url = new URL(text); } catch { return { ok: false, error: 'bad_url' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'bad_url' };
  if (url.username || url.password) return { ok: false, error: 'bad_url' };
  const host = bareHost(url.hostname);
  if (!host) return { ok: false, error: 'bad_url' };
  if (net.isIP(host)) {
    if (blockedIp(host)) return { ok: false, error: 'blocked_address' };
  } else {
    if (testAllowedHosts.has(host)) return { ok: true, url: url.toString() };
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home|intranet)$/.test(host) || !host.includes('.')) {
      return { ok: false, error: 'blocked_address' };
    }
    try {
      const addrs = await dns.promises.lookup(host, { all: true });
      if (!addrs.length || addrs.some(a => blockedIp(a.address))) return { ok: false, error: 'blocked_address' };
    } catch {
      return { ok: false, error: 'dns_failed' };
    }
  }
  return { ok: true, url: url.toString() };
}

function cleanEvents(list) {
  const arr = Array.isArray(list) ? list : [list];
  return [...new Set(arr.map(String).filter(e => EVENTS[e]))];
}

function newSecret() {
  return 'whsec_' + token(24);
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ---- CRUD ------------------------------------------------------------------------

function list(userId) {
  return db.get().prepare(`
    SELECT w.*, b.name AS bot_name,
      (SELECT status FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.event != 'ping' ORDER BY d.id DESC LIMIT 1) AS last_status
    FROM webhooks w LEFT JOIN bots b ON b.id = w.bot_id
    WHERE w.user_id = ? ORDER BY w.id
  `).all(userId).map(parseHook);
}

function parseHook(row) {
  if (!row) return null;
  let events = [];
  try { events = JSON.parse(row.events); } catch { /* ignore */ }
  return { ...row, events: Array.isArray(events) ? events : [] };
}

function getOwned(userId, id) {
  return parseHook(db.get().prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(Number(id), userId));
}

function create(userId, { url, events, botId = null, description = '' }) {
  const now = Date.now();
  const info = db.get().prepare(`
    INSERT INTO webhooks (user_id, bot_id, url, description, events, secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, botId || null, url, String(description).trim().slice(0, 120), JSON.stringify(cleanEvents(events)), newSecret(), now, now);
  return getOwned(userId, info.lastInsertRowid);
}

function update(userId, id, patch) {
  const hook = getOwned(userId, id);
  if (!hook) return null;
  const next = {
    url: patch.url !== undefined ? patch.url : hook.url,
    events: patch.events !== undefined ? JSON.stringify(cleanEvents(patch.events)) : JSON.stringify(hook.events),
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : hook.enabled,
    bot_id: patch.botId !== undefined ? (patch.botId || null) : hook.bot_id,
    description: patch.description !== undefined ? String(patch.description).trim().slice(0, 120) : hook.description,
  };
  db.get().prepare('UPDATE webhooks SET url = ?, events = ?, enabled = ?, bot_id = ?, description = ?, updated_at = ? WHERE id = ?')
    .run(next.url, next.events, next.enabled, next.bot_id, next.description, Date.now(), hook.id);
  if (!next.enabled) {
    db.get().prepare(`UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = NULL, error = 'webhook_disabled' WHERE webhook_id = ? AND status = 'pending'`).run(hook.id);
  }
  return getOwned(userId, hook.id);
}

function rotateSecret(userId, id) {
  const hook = getOwned(userId, id);
  if (!hook) return null;
  db.get().prepare('UPDATE webhooks SET secret = ?, updated_at = ? WHERE id = ?').run(newSecret(), Date.now(), hook.id);
  return getOwned(userId, id);
}

function remove(userId, id) {
  return db.get().prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?').run(Number(id), userId).changes > 0;
}

function deliveries(webhookId, limit = KEEP_PER_HOOK) {
  return db.get().prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?').all(webhookId, limit);
}

function getDeliveryOwned(userId, deliveryId) {
  return db.get().prepare(`
    SELECT d.* FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ? AND w.user_id = ?
  `).get(Number(deliveryId), userId);
}

// Enabled webhooks of this account subscribed to `event` (and to this bot).
function subscribers(userId, botId, event) {
  return db.get().prepare('SELECT * FROM webhooks WHERE user_id = ? AND enabled = 1 AND (bot_id IS NULL OR bot_id = ?)')
    .all(userId, botId || 0).map(parseHook).filter(h => h.events.includes(event));
}

// ---- Queue -----------------------------------------------------------------------

function enqueue(hook, event, body) {
  const now = Date.now();
  const conn = db.get();
  const info = conn.prepare(`
    INSERT INTO webhook_deliveries (webhook_id, uid, event, body, status, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(hook.id, crypto.randomUUID(), event, body, now, now);
  // Keep the log short: the newest KEEP_PER_HOOK rows (pending ones always stay).
  conn.prepare(`
    DELETE FROM webhook_deliveries WHERE webhook_id = ? AND status != 'pending' AND id <= (
      SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)
  `).run(hook.id, hook.id, KEEP_PER_HOOK);
  kick();
  return conn.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(info.lastInsertRowid);
}

// POST one delivery. Resolves (never rejects) to { ok, code, body, error, duration }.
function post(url, delivery, secret) {
  return new Promise(resolve => {
    const started = Date.now();
    let settled = false;
    const done = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, body: '', error: '', ...r, duration: Date.now() - started });
    };
    let target;
    try { target = new URL(url); } catch { return done({ error: 'bad_url' }); }
    const host = bareHost(target.hostname);
    if (net.isIP(host) && blockedIp(host)) return done({ error: 'blocked_address' });
    const lib = target.protocol === 'https:' ? https : http;
    const body = Buffer.from(delivery.body, 'utf8');
    const req = lib.request(target, {
      method: 'POST',
      lookup: guardedLookup,
      agent: false,
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'User-Agent': USER_AGENT,
        'X-Pasokhyar-Event': delivery.event,
        'X-Pasokhyar-Delivery': delivery.uid,
        'X-Pasokhyar-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-Pasokhyar-Signature': sign(secret, body),
      },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        if (size < 2048) chunks.push(c);
        size += c.length;
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').slice(0, 500);
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        done({ ok, code: res.statusCode, body: text, error: ok ? '' : (res.statusCode >= 300 && res.statusCode < 400 ? 'redirect_not_followed' : `http_${res.statusCode}`) });
      });
      res.on('error', e => done({ code: res.statusCode, error: e.message }));
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), TIMEOUT_MS + 2000);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => done({ error: String(e.code || e.message).slice(0, 80) }));
    req.end(body);
  });
}

const inflight = new Set();

async function attempt(row, now) {
  if (inflight.has(row.id)) return null;
  inflight.add(row.id);
  try {
    const hook = db.get().prepare('SELECT * FROM webhooks WHERE id = ?').get(row.webhook_id);
    if (!hook || !hook.enabled) {
      db.get().prepare(`UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = NULL, error = 'webhook_disabled' WHERE id = ?`).run(row.id);
      return { id: row.id, ok: false, error: 'webhook_disabled' };
    }
    const r = await post(hook.url, row, hook.secret);
    const attempts = row.attempts + 1;
    let status = 'pending';
    let next = null;
    if (r.ok) status = 'success';
    else if (attempts >= MAX_ATTEMPTS) status = 'failed';
    else {
      const base = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
      next = now + base + Math.floor(Math.random() * base * 0.1);
    }
    db.get().prepare(`
      UPDATE webhook_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, response_code = ?, response_body = ?,
        error = ?, duration_ms = ?, last_attempt_at = ? WHERE id = ?
    `).run(status, attempts, next, r.code, r.body, r.error, r.duration, Date.now(), row.id);
    return { id: row.id, ok: r.ok, status, code: r.code, error: r.error, next };
  } finally {
    inflight.delete(row.id);
  }
}

// Sends every delivery due at `now`. Tests pass a later `now` to fast-forward
// through the backoff schedule.
async function processDue(now = Date.now()) {
  const rows = db.get().prepare(`
    SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?
  `).all(now, BATCH);
  const results = await Promise.all(rows.map(r => attempt(r, now)));
  return results.filter(Boolean);
}

async function deliverNow(deliveryId) {
  const row = db.get().prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(deliveryId);
  if (!row || row.status !== 'pending') return row;
  await attempt(row, Date.now());
  return db.get().prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(deliveryId);
}

// A fresh delivery of the same body (same event id, new delivery id).
function redeliver(userId, deliveryId) {
  const d = getDeliveryOwned(userId, deliveryId);
  if (!d) return null;
  const hook = db.get().prepare('SELECT * FROM webhooks WHERE id = ?').get(d.webhook_id);
  if (!hook || !hook.enabled) return null;
  return enqueue(hook, d.event, d.body);
}

let timer = null;
let kicking = false;
function kick() {
  if (kicking) return;
  kicking = true;
  setImmediate(() => {
    kicking = false;
    processDue().catch(e => console.error('[webhooks] worker failed:', e.message));
  });
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    processDue().catch(e => console.error('[webhooks] worker failed:', e.message));
  }, TICK_MS);
  timer.unref();
}

module.exports = {
  EVENTS, TEST_EVENT, MAX_ATTEMPTS, BACKOFF_MS, KEEP_PER_HOOK,
  validateUrl, cleanEvents, sign, list, getOwned, create, update, rotateSecret, remove,
  deliveries, getDeliveryOwned, subscribers, enqueue, processDue, deliverNow, redeliver, start, kick,
  allowPrivateHostsForTests,
};

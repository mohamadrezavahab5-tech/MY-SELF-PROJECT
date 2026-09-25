'use strict';
// Public REST API v1 for CRMs and call-center software.
//   Auth: "Authorization: Bearer pky_..." (or "X-Api-Key: pky_..."), per-account
//   keys created in /app/integrations. No cookies, no CORS (server-to-server).
//   Every query is scoped to the key owner's bots (or the key's single bot).
//   Responses: { ok: true, data, ... } | { ok: false, error, message }.
// Endpoint list and examples: /app/integrations#docs (src/routes/integrations.js).
const express = require('express');
const db = require('../db');
const bots = require('../bots');
const apiKeys = require('../integrations/apiKeys');
const contacts = require('../integrations/contacts');
const dispatch = require('../integrations/dispatch');
const phone = require('../integrations/phone');
const { effectivePlan } = require('../plans');
const { rateLimiter, clientIp } = require('../util');

const router = express.Router();
const keyLimit = rateLimiter({ windowMs: 60_000, max: 120 });
const failLimit = rateLimiter({ windowMs: 10 * 60_000, max: 30 });

const MAX_LIMIT = 200;

function iso(ms) {
  return ms ? new Date(Number(ms)).toISOString() : null;
}

function fail(res, status, error, message = '') {
  return res.status(status).json({ ok: false, error, message });
}

router.use('/api/v1', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  // Server-to-server only: no CORS headers, so browsers can't call it cross-site.
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---- Auth ---------------------------------------------------------------------------

router.use('/api/v1', (req, res, next) => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
  const raw = m ? m[1] : String(req.headers['x-api-key'] || '').trim();
  if (!raw) {
    res.set('WWW-Authenticate', 'Bearer');
    return fail(res, 401, 'missing_api_key', 'Send "Authorization: Bearer <api key>".');
  }
  const ip = clientIp(req);
  const key = apiKeys.verify(raw);
  if (!key) {
    if (!failLimit(ip)) return fail(res, 429, 'rate_limited', 'Too many invalid keys.');
    res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    return fail(res, 401, 'invalid_api_key', 'The API key is wrong or was revoked.');
  }
  if (!keyLimit(`k${key.id}`)) {
    res.set('Retry-After', '60');
    return fail(res, 429, 'rate_limited', 'Max 120 requests per minute per key.');
  }
  const user = db.get().prepare('SELECT * FROM users WHERE id = ?').get(key.user_id);
  if (!user) return fail(res, 401, 'invalid_api_key');
  const botRows = db.get().prepare('SELECT id, name, public_key, lang, created_at FROM bots WHERE user_id = ? ORDER BY id').all(user.id)
    .filter(b => !key.bot_id || b.id === key.bot_id);
  req.api = { key, user, bots: botRows, botIds: botRows.map(b => b.id) };
  next();
});

router.use('/api/v1', express.json({ limit: '64kb' }));

// ---- Helpers ------------------------------------------------------------------------

function pageOf(req) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return { limit, offset };
}

// ISO date/time, or epoch seconds / milliseconds. undefined = absent, NaN = invalid.
function timeParam(v) {
  if (v === undefined || v === '') return undefined;
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

// The bots this request may touch, optionally narrowed by ?bot_id=.
function scopeBots(req, res) {
  if (req.query.bot_id === undefined || req.query.bot_id === '') return req.api.botIds;
  const id = Number(req.query.bot_id);
  if (!req.api.botIds.includes(id)) { fail(res, 404, 'bot_not_found'); return null; }
  return [id];
}

function timeFilters(req, res, col, where, params) {
  const since = timeParam(req.query.since);
  const until = timeParam(req.query.until);
  if (Number.isNaN(since) || Number.isNaN(until)) { fail(res, 400, 'bad_date', 'Use ISO 8601 (2026-01-31T10:00:00Z) or epoch seconds/ms.'); return false; }
  if (since !== undefined) { where.push(`${col} >= ?`); params.push(since); }
  if (until !== undefined) { where.push(`${col} < ?`); params.push(until); }
  return true;
}

function inList(ids) {
  return ids.map(() => '?').join(',') || 'NULL';
}

function botName(req, id) {
  const b = req.api.bots.find(x => x.id === id);
  return b ? b.name : '';
}

function leadOut(req, l) {
  return {
    id: l.id, botId: l.bot_id, botName: botName(req, l.bot_id), name: l.name, phone: l.phone, phoneE164: phone.e164(l.phone),
    message: l.message, status: l.status, sessionId: l.session_id, createdAt: iso(l.created_at),
  };
}

function convOut(req, c) {
  const out = {
    id: c.id, botId: c.bot_id, botName: botName(req, c.bot_id), sessionId: c.session_id, channel: c.channel,
    visitorName: c.visitor_name, visitorPhone: c.visitor_phone, visitorPhoneE164: c.visitor_phone ? phone.e164(c.visitor_phone) : '',
    pageUrl: c.page_url, mode: c.mode, createdAt: iso(c.created_at), lastMessageAt: iso(c.last_message_at), closedAt: iso(c.closed_at),
  };
  if (c.message_count !== undefined) out.messageCount = c.message_count;
  if (c.qc !== undefined) out.lastQc = c.qc ? { score: c.qc.score, reviewer: c.qc.reviewer, summary: c.qc.summary, createdAt: iso(c.qc.created_at) } : null;
  if (c.messages) out.messages = c.messages.map(msgOut);
  return out;
}

function msgOut(m) {
  return { id: m.id, sender: m.sender, text: m.text, operator: m.operator || undefined, createdAt: iso(m.createdAt || m.created_at) };
}

function faqOut(f) {
  return {
    id: f.id, botId: f.bot_id, question: f.question, alternates: bots.safeJsonArray(f.alternates), answer: f.answer,
    enabled: !!f.enabled, hits: f.hits, createdAt: iso(f.created_at), updatedAt: iso(f.updated_at),
  };
}

// ---- Account ---------------------------------------------------------------------------

router.get('/api/v1/me', (req, res) => {
  const { user, key } = req.api;
  res.json({
    ok: true,
    data: {
      account: { id: user.id, name: user.name, company: user.company },
      key: { id: key.id, name: key.name, prefix: key.prefix, botId: key.bot_id },
      bots: req.api.bots.map(b => ({ id: b.id, name: b.name, lang: b.lang, createdAt: iso(b.created_at) })),
    },
  });
});

router.get('/api/v1/bots', (req, res) => {
  res.json({ ok: true, data: req.api.bots.map(b => ({ id: b.id, name: b.name, lang: b.lang, publicKey: b.public_key, createdAt: iso(b.created_at) })) });
});

// ---- Leads ------------------------------------------------------------------------------

router.get('/api/v1/leads', (req, res) => {
  const ids = scopeBots(req, res);
  if (!ids) return;
  const where = [`bot_id IN (${inList(ids)})`];
  const params = [...ids];
  const status = String(req.query.status || '');
  if (status) {
    if (!['new', 'done'].includes(status)) return fail(res, 400, 'bad_status', 'status is new or done.');
    where.push('status = ?');
    params.push(status);
  }
  if (!timeFilters(req, res, 'created_at', where, params)) return;
  if (req.query.phone) {
    const key = phone.key(req.query.phone);
    if (!key) return fail(res, 400, 'bad_phone');
    const matching = contacts.lookup(ids, req.query.phone);
    const leadIds = matching ? matching.leads.map(l => l.id) : [];
    where.push(`id IN (${inList(leadIds)})`);
    params.push(...leadIds);
  }
  const { limit, offset } = pageOf(req);
  const sqlWhere = where.join(' AND ');
  const total = db.get().prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${sqlWhere}`).get(...params).n;
  const rows = db.get().prepare(`SELECT * FROM leads WHERE ${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ ok: true, data: rows.map(l => leadOut(req, l)), total, limit, offset });
});

function ownedLead(req, res) {
  const lead = db.get().prepare(`SELECT * FROM leads WHERE id = ? AND bot_id IN (${inList(req.api.botIds)})`).get(Number(req.params.id), ...req.api.botIds);
  if (!lead) fail(res, 404, 'not_found');
  return lead;
}

router.get('/api/v1/leads/:id', (req, res) => {
  const lead = ownedLead(req, res);
  if (lead) res.json({ ok: true, data: leadOut(req, lead) });
});

function setLeadStatus(req, res, status) {
  const lead = ownedLead(req, res);
  if (!lead) return;
  if (!['new', 'done'].includes(status)) return fail(res, 400, 'bad_status', 'status is new or done.');
  db.get().prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, lead.id);
  res.json({ ok: true, data: leadOut(req, { ...lead, status }) });
}

router.patch('/api/v1/leads/:id', (req, res) => setLeadStatus(req, res, String((req.body && req.body.status) || '')));
router.post('/api/v1/leads/:id/done', (req, res) => setLeadStatus(req, res, 'done'));

// ---- Conversations ----------------------------------------------------------------------

router.get('/api/v1/conversations', (req, res) => {
  const ids = scopeBots(req, res);
  if (!ids) return;
  const where = [`c.bot_id IN (${inList(ids)})`];
  const params = [...ids];
  if (req.query.session_id) { where.push('c.session_id = ?'); params.push(String(req.query.session_id).slice(0, 100)); }
  if (req.query.channel) { where.push('c.channel = ?'); params.push(String(req.query.channel).slice(0, 20)); }
  if (req.query.mode) { where.push('c.mode = ?'); params.push(String(req.query.mode).slice(0, 10)); }
  if (!timeFilters(req, res, 'c.last_message_at', where, params)) return;
  if (req.query.phone) {
    if (!phone.key(req.query.phone)) return fail(res, 400, 'bad_phone');
    const matching = contacts.lookup(ids, req.query.phone);
    const convIds = matching ? matching.conversations.map(c => c.id) : [];
    where.push(`c.id IN (${inList(convIds)})`);
    params.push(...convIds);
  }
  const { limit, offset } = pageOf(req);
  const sqlWhere = where.join(' AND ');
  const total = db.get().prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE ${sqlWhere}`).get(...params).n;
  const rows = db.get().prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c WHERE ${sqlWhere} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const withMessages = req.query.messages === '1' || req.query.messages === 'true';
  res.json({
    ok: true,
    data: rows.map(c => convOut(req, withMessages ? { ...c, messages: contacts.messages(c.id) } : c)),
    total, limit, offset,
  });
});

function ownedConv(req, res) {
  const conv = db.get().prepare(`SELECT * FROM conversations WHERE id = ? AND bot_id IN (${inList(req.api.botIds)})`).get(Number(req.params.id), ...req.api.botIds);
  if (!conv) fail(res, 404, 'not_found');
  return conv;
}

router.get('/api/v1/conversations/:id', (req, res) => {
  const conv = ownedConv(req, res);
  if (!conv) return;
  const count = db.get().prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?').get(conv.id).n;
  res.json({ ok: true, data: convOut(req, { ...conv, message_count: count, qc: contacts.lastQc(conv.id), messages: contacts.messages(conv.id) }) });
});

router.get('/api/v1/conversations/:id/messages', (req, res) => {
  const conv = ownedConv(req, res);
  if (!conv) return;
  const after = Math.max(0, parseInt(req.query.after_id, 10) || 0);
  const { limit } = pageOf(req);
  const rows = db.get().prepare(`
    SELECT id, sender, text, meta, created_at FROM chat_messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?
  `).all(conv.id, after, limit).map(m => {
    let meta = {};
    try { meta = JSON.parse(m.meta) || {}; } catch { /* ignore */ }
    return msgOut({ ...m, operator: meta.operator || '' });
  });
  res.json({ ok: true, data: rows, next: rows.length ? rows[rows.length - 1].id : after });
});

// A CRM / call-center note on the conversation. visibility "internal" (default)
// is stored as sender "note": operators see it, the visitor never does.
// "visitor" posts a system line the web visitor sees in their chat.
router.post('/api/v1/conversations/:id/notes', (req, res) => {
  const conv = ownedConv(req, res);
  if (!conv) return;
  const b = req.body || {};
  const text = String(b.text || '').trim().slice(0, 2000);
  if (!text) return fail(res, 400, 'empty_text');
  const visibility = b.visibility === 'visitor' ? 'visitor' : 'internal';
  const author = String(b.author || '').trim().slice(0, 60);
  const meta = { source: 'api', keyId: req.api.key.id };
  if (author) meta.operator = author;
  const id = bots.addChat(conv, visibility === 'visitor' ? 'system' : 'note', text, meta);
  res.status(201).json({ ok: true, data: { id: Number(id), conversationId: conv.id, sender: visibility === 'visitor' ? 'system' : 'note', text, visibility } });
});

// ---- Contact lookup ------------------------------------------------------------------------

router.get('/api/v1/contacts', (req, res) => {
  const ids = scopeBots(req, res);
  if (!ids) return;
  const q = String(req.query.phone || '');
  if (!q) return fail(res, 400, 'missing_phone', 'GET /api/v1/contacts?phone=09121234567');
  const withTranscripts = req.query.transcripts === '1' || req.query.transcripts === 'true';
  const r = contacts.lookup(ids, q, { transcripts: withTranscripts, messageLimit: 100 });
  if (!r) return fail(res, 400, 'bad_phone');
  res.json({
    ok: true,
    data: {
      phone: r.phone, phoneE164: r.e164, name: r.name,
      found: r.leads.length + r.conversations.length > 0,
      leads: r.leads.map(l => leadOut(req, l)),
      conversations: r.conversations.map(c => convOut(req, c)),
    },
  });
});

// ---- FAQs ---------------------------------------------------------------------------------

function ownedBot(req, res) {
  const id = Number(req.params.botId);
  if (!req.api.botIds.includes(id)) { fail(res, 404, 'bot_not_found'); return null; }
  return bots.getBot(id);
}

function faqInput(body, { partial }) {
  const b = body || {};
  const out = {};
  if (b.question !== undefined || !partial) {
    const q = String(b.question || '').trim();
    if (!q || q.length > 300) return { error: 'bad_question', message: 'question: 1-300 characters.' };
    out.question = q;
  }
  if (b.answer !== undefined || !partial) {
    const a = String(b.answer || '').trim();
    if (!a || a.length > 3000) return { error: 'bad_answer', message: 'answer: 1-3000 characters.' };
    out.answer = a;
  }
  if (b.alternates !== undefined) {
    if (!Array.isArray(b.alternates)) return { error: 'bad_alternates', message: 'alternates: array of strings.' };
    out.alternates = b.alternates.map(s => String(s).slice(0, 300));
  }
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  return { data: out };
}

router.get('/api/v1/bots/:botId/faqs', (req, res) => {
  const bot = ownedBot(req, res);
  if (!bot) return;
  const { limit, offset } = pageOf(req);
  const total = db.get().prepare('SELECT COUNT(*) AS n FROM faqs WHERE bot_id = ?').get(bot.id).n;
  const rows = db.get().prepare('SELECT * FROM faqs WHERE bot_id = ? ORDER BY id LIMIT ? OFFSET ?').all(bot.id, limit, offset);
  res.json({ ok: true, data: rows.map(faqOut), total, limit, offset });
});

router.post('/api/v1/bots/:botId/faqs', (req, res) => {
  const bot = ownedBot(req, res);
  if (!bot) return;
  const input = faqInput(req.body, { partial: false });
  if (input.error) return fail(res, 400, input.error, input.message);
  const plan = effectivePlan(req.api.user);
  const count = db.get().prepare('SELECT COUNT(*) AS n FROM faqs WHERE bot_id = ?').get(bot.id).n;
  if (count >= plan.faqs) return fail(res, 403, 'plan_limit', `This plan allows ${plan.faqs} FAQs per bot.`);
  const id = bots.addFaq(bot.id, { question: input.data.question, answer: input.data.answer, alternates: input.data.alternates || [] });
  if (input.data.enabled === false) bots.updateFaq(bot.id, Number(id), { enabled: false });
  res.status(201).json({ ok: true, data: faqOut(db.get().prepare('SELECT * FROM faqs WHERE id = ?').get(id)) });
});

function ownedFaq(req, res, bot) {
  const f = db.get().prepare('SELECT * FROM faqs WHERE id = ? AND bot_id = ?').get(Number(req.params.faqId), bot.id);
  if (!f) fail(res, 404, 'not_found');
  return f;
}

router.get('/api/v1/bots/:botId/faqs/:faqId', (req, res) => {
  const bot = ownedBot(req, res);
  if (!bot) return;
  const f = ownedFaq(req, res, bot);
  if (f) res.json({ ok: true, data: faqOut(f) });
});

function updateFaq(req, res, partial) {
  const bot = ownedBot(req, res);
  if (!bot) return;
  const f = ownedFaq(req, res, bot);
  if (!f) return;
  const input = faqInput(req.body, { partial });
  if (input.error) return fail(res, 400, input.error, input.message);
  bots.updateFaq(bot.id, f.id, input.data);
  res.json({ ok: true, data: faqOut(db.get().prepare('SELECT * FROM faqs WHERE id = ?').get(f.id)) });
}

router.patch('/api/v1/bots/:botId/faqs/:faqId', (req, res) => updateFaq(req, res, true));
router.put('/api/v1/bots/:botId/faqs/:faqId', (req, res) => updateFaq(req, res, false));

router.delete('/api/v1/bots/:botId/faqs/:faqId', (req, res) => {
  const bot = ownedBot(req, res);
  if (!bot) return;
  const f = ownedFaq(req, res, bot);
  if (!f) return;
  bots.deleteFaq(bot.id, f.id);
  res.json({ ok: true, data: { id: f.id, deleted: true } });
});

// ---- Polling feed (for systems that can't receive webhooks) --------------------------------

router.get('/api/v1/events', (req, res) => {
  const ids = scopeBots(req, res);
  if (!ids) return;
  const since = Math.max(0, parseInt(req.query.since, 10) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const types = req.query.types ? String(req.query.types).split(',').map(s => s.trim()).filter(Boolean) : null;
  const r = dispatch.feed(req.api.user.id, { since, limit, botIds: ids, types });
  res.json({ ok: true, data: r.events, next: r.next });
});

// ---- Fallbacks ------------------------------------------------------------------------------

router.use('/api/v1', (req, res) => fail(res, 404, 'not_found', 'Unknown endpoint. See /app/integrations#docs.'));

// eslint-disable-next-line no-unused-vars
router.use('/api/v1', (err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'bad_json');
  if (err.type === 'entity.too.large') return fail(res, 413, 'too_large');
  console.error('[api v1]', err);
  fail(res, 500, 'server_error');
});

module.exports = router;

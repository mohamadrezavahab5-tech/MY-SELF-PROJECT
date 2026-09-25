'use strict';
// Public API the embeddable widget talks to. Called cross-origin from
// customers' websites, so it is CORS-open (optionally limited per bot to
// its allowed domains) and never uses cookies. Contract: docs/ARCHITECTURE.md.
const express = require('express');
const bots = require('../bots');
const config = require('../config');
const llm = require('../llm');
const { effectivePlan } = require('../plans');
const { t, lang } = require('../i18n');
const { rateLimiter, clientIp, normalizeMobile } = require('../util');

const router = express.Router();
const askLimit = rateLimiter({ windowMs: 60_000, max: 30 });
const leadLimit = rateLimiter({ windowMs: 60 * 60_000, max: 10 });
const chatLimit = rateLimiter({ windowMs: 60_000, max: 40 });

function originHost(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  try { return new URL(origin).hostname.toLowerCase(); } catch { return ''; }
}

// Bot owners may restrict their widget to their own domains.
function domainAllowed(bot, req) {
  const list = bot.allowed_domains.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const host = originHost(req);
  if (!host) return true; // server-to-server / privacy-stripped referrers
  const ownHost = new URL(config.siteUrl).hostname;
  if (host === ownHost) return true; // hosted chat page
  return list.some(d => host === d || host.endsWith('.' + d));
}

router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

router.use(express.json({ limit: '16kb' }));

router.param('key', (req, res, next, key) => {
  const bot = bots.getBotByKey(key);
  if (!bot) return res.status(404).json({ ok: false, error: 'bot_not_found' });
  if (!domainAllowed(bot, req)) return res.status(403).json({ ok: false, error: 'domain_not_allowed' });
  req.bot = bot;
  next();
});

function channelOf(req) {
  return req.body && req.body.channel === 'page' ? 'page' : 'web';
}

function sid(req) {
  return String((req.body && req.body.sid) || req.query.sid || '').slice(0, 64);
}

function pageUrl(req) {
  return String((req.body && req.body.page) || '').slice(0, 500);
}

function aiAvailable(bot, plan) {
  return !!(bot.ai_enabled && plan.ai && llm.isConfigured());
}

router.get('/:key/config', (req, res) => {
  const bot = req.bot;
  const owner = bots.botOwner(bot);
  const plan = effectivePlan(owner);
  res.json({
    ok: true,
    bot: {
      name: bot.name,
      lang: lang(bot),
      welcome: bot.welcome,
      color: bot.color,
      position: bot.position === 'left' ? 'left' : 'right',
      leadForm: !!bot.lead_form,
      suggestions: bots.topQuestions(bot.id, 3),
      liveChat: !!bot.live_chat,
      operatorOnline: bots.operatorOnline(bot),
      ai: aiAvailable(bot, plan),
      proactive: bot.proactive_text && bot.proactive_delay > 0
        ? { text: bot.proactive_text, delay: bot.proactive_delay, path: bot.proactive_path || '' }
        : null,
      badge: {
        show: plan.badge,
        text: `قدرت‌گرفته از ${config.siteName}`,
        url: `${config.siteUrl}/?ref=${encodeURIComponent(owner.ref_code)}&utm_source=widget`,
      },
    },
  });
});

function limited(req, res) {
  if (askLimit(`${req.bot.id}:${clientIp(req)}`)) return false;
  res.status(429).json({ ok: false, error: 'rate_limited', answer: t('rateLimited', req.bot) });
  return true;
}

router.post('/:key/ask', async (req, res, next) => {
  try {
    if (limited(req, res)) return;
    const q = String((req.body && req.body.q) || '');
    if (!q.trim()) return res.status(400).json({ ok: false, error: 'empty_question' });
    const reply = await bots.ask(req.bot, q, { sessionId: sid(req), channel: channelOf(req), pageUrl: pageUrl(req) });
    res.json({ ok: true, ...reply });
  } catch (e) {
    next(e);
  }
});

// Same as /ask, streamed as server-sent events so generated answers appear
// word by word: `delta` events carry text, `done` carries the full reply.
router.post('/:key/ask-stream', async (req, res) => {
  if (limited(req, res)) return;
  const q = String((req.body && req.body.q) || '');
  if (!q.trim()) return res.status(400).json({ ok: false, error: 'empty_question' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', // keep reverse proxies from buffering the stream
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let streamed = false;
  try {
    const reply = await bots.ask(req.bot, q, {
      sessionId: sid(req),
      channel: channelOf(req),
      pageUrl: pageUrl(req),
      onDelta: text => { streamed = true; send('delta', { text }); },
    });
    if (!streamed && reply.answer) send('delta', { text: reply.answer });
    send('done', { ok: true, ...reply });
  } catch (e) {
    console.error('ask-stream failed:', e);
    send('error', { message: 'server_error' });
  }
  res.end();
});

router.post('/:key/pick', (req, res) => {
  if (limited(req, res)) return;
  const reply = bots.pick(req.bot, req.body && req.body.faqId, {
    sessionId: sid(req),
    channel: channelOf(req),
    fromMessageId: Number(req.body && req.body.messageId) || null,
  });
  if (!reply) return res.status(404).json({ ok: false, error: 'faq_not_found' });
  res.json({ ok: true, ...reply });
});

router.post('/:key/feedback', (req, res) => {
  const messageId = Number(req.body && req.body.messageId);
  if (!messageId) return res.status(400).json({ ok: false, error: 'bad_message_id' });
  bots.feedback(req.bot, messageId, !!(req.body && req.body.helpful));
  res.json({ ok: true });
});

router.post('/:key/lead', (req, res) => {
  if (!leadLimit(`${req.bot.id}:${clientIp(req)}`)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const body = req.body || {};
  const phone = normalizeMobile(body.phone) || String(body.phone || '').trim();
  if (!/^[0-9+\-\s۰-۹]{7,20}$/.test(phone)) return res.status(400).json({ ok: false, error: 'bad_phone' });
  bots.addLead(req.bot, {
    sessionId: sid(req),
    name: String(body.name || '').trim(),
    phone,
    message: String(body.message || '').trim(),
  });
  res.json({ ok: true, message: t('leadThanks', req.bot) });
});

// ---- Live chat with a human operator ----------------------------------------------

router.post('/:key/handoff', (req, res) => {
  if (!req.bot.live_chat) return res.status(403).json({ ok: false, error: 'live_chat_off' });
  if (!sid(req)) return res.status(400).json({ ok: false, error: 'no_session' });
  if (!chatLimit(`h:${req.bot.id}:${clientIp(req)}`)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const body = req.body || {};
  const r = bots.requestHuman(req.bot, sid(req), {
    channel: channelOf(req),
    name: String(body.name || '').trim(),
    phone: normalizeMobile(body.phone) || String(body.phone || '').trim(),
  });
  res.json({ ok: true, online: r.online, message: r.message, offerLead: !r.online && !!req.bot.lead_form });
});

router.post('/:key/send', (req, res) => {
  if (!chatLimit(`s:${req.bot.id}:${clientIp(req)}`)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text || !sid(req)) return res.status(400).json({ ok: false, error: 'empty' });
  const conv = bots.conversationFor(req.bot, sid(req), channelOf(req), { create: false });
  if (!conv || conv.mode !== 'human') return res.status(409).json({ ok: false, error: 'not_in_live_chat' });
  const id = bots.addChat(conv, 'visitor', text);
  res.json({ ok: true, id });
});

router.get('/:key/poll', (req, res) => {
  const s = sid(req);
  if (!s) return res.status(400).json({ ok: false, error: 'no_session' });
  const u = bots.visitorUpdates(req.bot, s, Number(req.query.after) || 0);
  res.json({ ok: true, mode: u.mode, operatorOnline: bots.operatorOnline(req.bot), messages: u.messages });
});

router.post('/:key/end', (req, res) => {
  if (sid(req)) bots.endHuman(req.bot, sid(req));
  res.json({ ok: true });
});

module.exports = router;

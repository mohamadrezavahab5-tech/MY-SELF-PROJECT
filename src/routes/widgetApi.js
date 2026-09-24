'use strict';
// Public API the embeddable widget talks to. Called cross-origin from
// customers' websites, so it is CORS-open (optionally limited per bot to
// its allowed domains) and never uses cookies.
const express = require('express');
const bots = require('../bots');
const config = require('../config');
const { effectivePlan } = require('../plans');
const { rateLimiter, clientIp, normalizeMobile } = require('../util');

const router = express.Router();
const askLimit = rateLimiter({ windowMs: 60_000, max: 30 });
const leadLimit = rateLimiter({ windowMs: 60 * 60_000, max: 10 });

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
  return String((req.body && req.body.sid) || '').slice(0, 64);
}

router.get('/:key/config', (req, res) => {
  const bot = req.bot;
  const owner = bots.botOwner(bot);
  const plan = effectivePlan(owner);
  res.json({
    ok: true,
    bot: {
      name: bot.name,
      welcome: bot.welcome,
      color: bot.color,
      position: bot.position === 'left' ? 'left' : 'right',
      leadForm: !!bot.lead_form,
      placeholder: 'سؤالتان را بنویسید…',
      suggestions: bots.topQuestions(bot.id, 3),
      badge: {
        show: plan.badge,
        text: `قدرت‌گرفته از ${config.siteName}`,
        url: `${config.siteUrl}/?ref=${encodeURIComponent(owner.ref_code)}&utm_source=widget`,
      },
    },
  });
});

router.post('/:key/ask', (req, res) => {
  if (!askLimit(`${req.bot.id}:${clientIp(req)}`)) {
    return res.status(429).json({ ok: false, error: 'rate_limited', answer: 'کمی آهسته‌تر 🙂 چند ثانیه دیگر دوباره بپرسید.' });
  }
  const q = String((req.body && req.body.q) || '');
  if (!q.trim()) return res.status(400).json({ ok: false, error: 'empty_question' });
  const reply = bots.ask(req.bot, q, { sessionId: sid(req), channel: channelOf(req) });
  res.json({ ok: true, ...reply });
});

router.post('/:key/pick', (req, res) => {
  if (!askLimit(`${req.bot.id}:${clientIp(req)}`)) return res.status(429).json({ ok: false, error: 'rate_limited' });
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
  res.json({ ok: true, message: 'ممنون! همکاران ما به‌زودی با شما تماس می‌گیرند.' });
});

module.exports = router;

'use strict';
// Turns core business events (src/events.js) into integration events: one
// JSON envelope per event, delivered to matching webhooks and, for accounts
// with an API key, stored in the polling feed (GET /api/v1/events).
const db = require('../db');
const config = require('../config');
const events = require('../events');
const webhooks = require('./webhooks');
const apiKeys = require('./apiKeys');
const phone = require('./phone');
const { shortId } = require('../util');

const FEED_DAYS = 30;

function iso(ms) {
  return ms ? new Date(Number(ms)).toISOString() : null;
}

function conversationOut(c) {
  if (!c) return null;
  const out = { id: c.id, sessionId: c.sessionId, channel: c.channel };
  if ('visitorName' in c) out.visitorName = c.visitorName || '';
  if ('visitorPhone' in c) {
    out.visitorPhone = c.visitorPhone || '';
    out.visitorPhoneE164 = c.visitorPhone ? phone.e164(c.visitorPhone) : '';
  }
  if ('pageUrl' in c) out.pageUrl = c.pageUrl || '';
  return out;
}

// Event-specific `data` (documented on /app/integrations).
function shape(name, p, botId) {
  const base = `${config.siteUrl}/app/bots/${botId}`;
  switch (name) {
    case 'lead.created':
      return {
        lead: {
          id: p.lead.id, botId, name: p.lead.name, phone: p.lead.phone, phoneE164: phone.e164(p.lead.phone),
          message: p.lead.message, sessionId: p.lead.sessionId, status: 'new', createdAt: iso(p.lead.createdAt),
        },
        url: `${base}/leads`,
      };
    case 'conversation.handoff':
      return { conversation: conversationOut(p.conversation), operatorOnline: !!p.online, url: `${base}/live?c=${p.conversation.id}` };
    case 'conversation.closed':
      return { conversation: conversationOut(p.conversation), url: `${base}/live?c=${p.conversation.id}` };
    case 'message.created':
      return {
        conversation: conversationOut(p.conversation),
        message: { id: p.message.id, sender: p.message.sender, text: p.message.text, createdAt: iso(p.message.createdAt) },
      };
    case 'question.unanswered':
      return { question: p.question, sessionId: p.sessionId || '', channel: p.channel, type: p.type };
    default:
      return p;
  }
}

function envelope(name, { userId, bot, data, id }) {
  return {
    id: id || `evt_${shortId(16)}`,
    event: name,
    createdAt: new Date().toISOString(),
    accountId: userId,
    bot: bot ? { id: bot.id, name: bot.name } : null,
    data,
  };
}

function botRow(botId) {
  return botId ? db.get().prepare('SELECT id, user_id, name FROM bots WHERE id = ?').get(Number(botId)) : null;
}

// Handles one core event. Exported for tests.
function handle(name, payload) {
  const bot = botRow(payload && payload.botId);
  if (!bot) return null;
  const userId = bot.user_id; // authoritative: never trust a payload's userId
  const hooks = webhooks.subscribers(userId, bot.id, name);
  const polling = apiKeys.hasActive(userId);
  if (!hooks.length && !polling) return null;
  const env = envelope(name, { userId, bot, data: shape(name, payload, bot.id) });
  if (polling) {
    const info = db.get().prepare('INSERT INTO integration_events (user_id, bot_id, event, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, bot.id, name, JSON.stringify(env), Date.now());
    env.seq = Number(info.lastInsertRowid);
  }
  const body = JSON.stringify({ ...env, seq: undefined });
  for (const h of hooks) webhooks.enqueue(h, name, body);
  return env;
}

// A "ping" to one webhook, from the dashboard's "send test event" button.
function testEvent(userId, hook) {
  const bot = hook.bot_id ? botRow(hook.bot_id) : null;
  const env = envelope(webhooks.TEST_EVENT, {
    userId, bot,
    data: { message: 'این یک رویداد آزمایشی است. This is a test event.', webhookId: hook.id, events: hook.events },
  });
  return webhooks.enqueue(hook, webhooks.TEST_EVENT, JSON.stringify(env));
}

// Polling feed for /api/v1/events.
function feed(userId, { since = 0, limit = 100, botIds = null, types = null } = {}) {
  const rows = db.get().prepare(`
    SELECT * FROM integration_events WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?
  `).all(userId, Number(since) || 0, 1000);
  const out = [];
  let cursor = Number(since) || 0;
  for (const r of rows) {
    cursor = r.id;
    if (botIds && !botIds.includes(r.bot_id)) continue;
    if (types && types.length && !types.includes(r.event)) continue;
    let env;
    try { env = JSON.parse(r.body); } catch { continue; }
    out.push({ seq: r.id, ...env });
    if (out.length >= limit) break;
  }
  return { events: out, next: out.length >= limit ? out[out.length - 1].seq : cursor };
}

let lastPrune = 0;
function prune(now = Date.now()) {
  if (now - lastPrune < 3600_000) return;
  lastPrune = now;
  db.get().prepare('DELETE FROM integration_events WHERE created_at < ?').run(now - FEED_DAYS * 86400_000);
}

const CORE_EVENTS = Object.keys(webhooks.EVENTS);
let started = false;
function init() {
  if (started) return;
  started = true;
  for (const name of CORE_EVENTS) {
    events.on(name, payload => { handle(name, payload); });
  }
  webhooks.start();
  const t = setInterval(() => { try { prune(); } catch (e) { console.error('[integrations] prune failed:', e.message); } }, 600_000);
  t.unref();
}

module.exports = { init, handle, testEvent, feed, shape, envelope, CORE_EVENTS, FEED_DAYS };

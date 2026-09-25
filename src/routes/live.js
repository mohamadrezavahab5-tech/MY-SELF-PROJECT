'use strict';
// Live chat inbox: visitors who asked for a human, and every recent bot
// conversation an operator may want to join. The page polls live.json.
const express = require('express');
const db = require('../db');
const bots = require('../bots');
const channels = require('../channels');
const events = require('../events');
const { dashPage } = require('../views/layout');
const { ago, faDateTime } = require('../views/helpers');
const { faDigits } = require('../util');

const router = express.Router();
const form = express.urlencoded({ extended: false, limit: '8kb' });
const json = express.json({ limit: '8kb' });

router.param('botId', (req, res, next, id) => {
  const bot = db.get().prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!bot) return res.redirect('/app');
  req.bot = bot;
  next();
});

router.param('convId', (req, res, next, id) => {
  const conv = db.get().prepare('SELECT * FROM conversations WHERE id = ? AND bot_id = ?').get(Number(id), req.bot.id);
  if (!conv) return res.status(404).json({ ok: false, error: 'not_found' });
  req.conv = conv;
  next();
});

const WEEK = 7 * 86400_000;
const CHANNEL = { web: 'سایت', page: 'لینک اختصاصی', bale: 'بله', telegram: 'تلگرام' };

function conversationList(botId) {
  return db.get().prepare(`
    SELECT c.*,
      (SELECT text FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_text,
      (SELECT sender FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender
    FROM conversations c
    WHERE c.bot_id = ? AND (c.mode = 'human' OR c.last_message_at > ?)
    ORDER BY (c.mode = 'human' AND c.operator_unread > 0) DESC, c.mode = 'human' DESC, c.last_message_at DESC
    LIMIT 60
  `).all(botId, Date.now() - WEEK);
}

function summary(c) {
  return {
    id: c.id,
    name: c.visitor_name || `مهمان ${faDigits(c.id)}`,
    phone: c.visitor_phone,
    channel: CHANNEL[c.channel] || c.channel,
    page: c.page_url,
    mode: c.mode,
    unread: c.operator_unread,
    last: (c.last_text || '').slice(0, 80),
    lastSender: c.last_sender,
    ago: ago(c.last_message_at),
    at: c.last_message_at,
  };
}

function messagesOf(convId, after = 0) {
  return db.get().prepare(`
    SELECT id, sender, text, meta, created_at FROM chat_messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT 300
  `).all(convId, after).map(m => {
    let meta = {};
    try { meta = JSON.parse(m.meta); } catch { /* ignore */ }
    return { id: m.id, sender: m.sender, text: m.text, operator: meta.operator || '', sources: meta.sources || [], at: faDateTime(m.created_at) };
  });
}

function markRead(conv) {
  if (conv.operator_unread) db.get().prepare('UPDATE conversations SET operator_unread = 0 WHERE id = ?').run(conv.id);
}

function getConv(bot, id) {
  return id ? db.get().prepare('SELECT * FROM conversations WHERE id = ? AND bot_id = ?').get(id, bot.id) : null;
}

router.get('/app/bots/:botId/live', (req, res) => {
  const bot = req.bot;
  bots.markOperatorSeen(bot.id);
  const list = conversationList(bot.id).map(summary);
  const conv = getConv(bot, Number(req.query.c) || (list.find(c => c.mode === 'human') || list[0] || {}).id);
  if (conv) markRead(conv);
  const allBots = db.get().prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(req.user.id);
  const boot = {
    endpoint: `/app/bots/${bot.id}/live`,
    operator: req.user.name,
    conversations: list,
    messages: conv ? messagesOf(conv.id) : [],
    conv: conv ? summary({ ...conv, last_text: '', last_sender: '' }) : null,
  };
  res.send(dashPage({
    title: 'گفتگوی زنده',
    user: req.user,
    bot,
    bots: allBots,
    active: 'live',
    body: `<div class="page-title"><h1>گفتگوی زنده</h1>
  <div class="row">
    ${bot.live_chat ? '<span class="badge ok live-status">● شما آنلاین هستید</span>' : `<span class="badge warn">گفتگوی زنده خاموش است. <a href="/app/bots/${bot.id}/settings">روشن کردن</a></span>`}
    <button type="button" class="btn btn-ghost btn-sm" id="live-notify">🔔 اعلان مرورگر</button>
  </div></div>
<p class="muted">تا وقتی این صفحه باز است، مشتری‌ها شما را «آنلاین» می‌بینند. هر مشتری که بخواهد با پشتیبان صحبت کند، بالای فهرست می‌آید.</p>
<div class="live" id="live-app">
  <aside class="live-list" id="live-list" aria-label="گفتگوها"></aside>
  <section class="live-chat" id="live-chat"></section>
</div>
<script type="application/json" id="live-boot">${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>
<script src="/js/live.js" defer></script>`,
  }));
});

// Polled every few seconds by the inbox page; also keeps the operator "online".
router.get('/app/bots/:botId/live.json', (req, res) => {
  bots.markOperatorSeen(req.bot.id);
  const list = conversationList(req.bot.id).map(summary);
  let messages = [];
  let conv = null;
  const row = getConv(req.bot, Number(req.query.c));
  if (row) {
    markRead(row);
    messages = messagesOf(row.id, Number(req.query.after) || 0);
    conv = summary({ ...row, last_text: '', last_sender: '' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, conversations: list, messages, conv, waiting: list.filter(x => x.mode === 'human' && x.unread > 0).length });
});

router.post('/app/bots/:botId/live/:convId/reply', json, form, async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ ok: false, error: 'empty' });
  const operator = String((req.body && req.body.operator) || req.user.name).trim().slice(0, 60);
  const r = bots.operatorReply(req.bot, req.conv.id, text, { operator });
  bots.markOperatorSeen(req.bot.id);
  let delivered = true;
  if (channels.CHANNELS[req.conv.channel]) {
    try {
      delivered = await channels.sendToChat(req.bot, req.conv.channel, req.conv.session_id, text);
    } catch (e) {
      console.error(`[live] send to ${req.conv.channel} failed:`, e.message);
      delivered = false;
    }
  }
  res.json({ ok: true, id: r.id, delivered });
});

// Operator joins a conversation the bot was handling.
router.post('/app/bots/:botId/live/:convId/take', json, form, (req, res) => {
  db.get().prepare(`UPDATE conversations SET mode = 'human', closed_at = NULL WHERE id = ?`).run(req.conv.id);
  bots.addChat({ ...req.conv, mode: 'human' }, 'system', 'یکی از همکاران ما به گفتگو پیوست.');
  res.json({ ok: true });
});

// Hand the conversation back to the bot.
router.post('/app/bots/:botId/live/:convId/close', json, form, (req, res) => {
  db.get().prepare(`UPDATE conversations SET mode = 'bot', operator_unread = 0, closed_at = ? WHERE id = ?`).run(Date.now(), req.conv.id);
  bots.addChat({ ...req.conv, mode: 'bot' }, 'system', 'گفتگو با پشتیبان تمام شد. اگر سؤال دیگری دارید، بپرسید.');
  events.emit('conversation.closed', {
    botId: req.bot.id,
    userId: req.bot.user_id,
    conversation: { id: req.conv.id, sessionId: req.conv.session_id, channel: req.conv.channel },
  });
  res.json({ ok: true });
});

module.exports = router;

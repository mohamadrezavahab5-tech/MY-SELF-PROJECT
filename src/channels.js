'use strict';
// Messenger channels. Bale's bot API is Telegram-compatible, so one
// implementation serves both; only the API base differs. Note: Telegram's API
// is filtered inside Iran, so the Telegram channel only works when this
// server is hosted abroad. Bale works from Iranian servers.
const express = require('express');
const db = require('./db');
const bots = require('./bots');
const config = require('./config');
const { effectivePlan } = require('./plans');
const { token, normalizeMobile } = require('./util');

const CHANNELS = {
  bale: { name: 'بله', api: 'https://tapi.bale.ai', tokenCol: 'bale_token', secretCol: 'bale_secret' },
  telegram: { name: 'تلگرام', api: 'https://api.telegram.org', tokenCol: 'telegram_token', secretCol: 'telegram_secret' },
};

async function callApi(channel, botToken, method, payload) {
  const res = await fetch(`${CHANNELS[channel].api}/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
  return data.result;
}

function webhookUrl(channel, bot, secret) {
  return `${config.siteUrl}/hooks/${channel}/${bot.id}/${secret}`;
}

// Validates the token with getMe, then registers our webhook.
async function connect(bot, channel, botToken) {
  const ch = CHANNELS[channel];
  if (!ch) throw new Error('unknown channel');
  const cleaned = String(botToken || '').trim();
  if (!/^\d{3,}:[A-Za-z0-9_-]{20,}$/.test(cleaned)) throw new Error('توکن معتبر نیست. توکن را کامل و بدون فاصله کپی کنید.');
  const me = await callApi(channel, cleaned, 'getMe');
  const secret = token(18);
  await callApi(channel, cleaned, 'setWebhook', { url: webhookUrl(channel, bot, secret) });
  db.get().prepare(`UPDATE bots SET ${ch.tokenCol} = ?, ${ch.secretCol} = ?, updated_at = ? WHERE id = ?`)
    .run(cleaned, secret, Date.now(), bot.id);
  return me;
}

async function disconnect(bot, channel) {
  const ch = CHANNELS[channel];
  const botToken = bot[ch.tokenCol];
  if (botToken) {
    try { await callApi(channel, botToken, 'deleteWebhook'); } catch { /* token may be revoked already */ }
  }
  db.get().prepare(`UPDATE bots SET ${ch.tokenCol} = '', ${ch.secretCol} = '', updated_at = ? WHERE id = ?`).run(Date.now(), bot.id);
}

const SUGGEST_PREFIX = 'faq:';

function replyMarkup(reply) {
  if (reply.suggestions && reply.suggestions.length) {
    return {
      inline_keyboard: reply.suggestions.slice(0, 4).map(s => [{
        text: s.question.slice(0, 60),
        callback_data: `${SUGGEST_PREFIX}${s.id}:${reply.messageId || 0}`,
      }]),
    };
  }
  if (reply.offerLead) {
    return {
      keyboard: [[{ text: '📞 ارسال شماره تماس', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    };
  }
  return undefined;
}

function replyText(reply) {
  if (reply.offerLead && !(reply.suggestions && reply.suggestions.length)) {
    return `${reply.answer}\n\nبرای تماس همکاران ما، دکمه‌ی «ارسال شماره تماس» را بزنید.`;
  }
  return reply.answer;
}

async function handleUpdate(channel, bot, update) {
  const ch = CHANNELS[channel];
  const botToken = bot[ch.tokenCol];
  const owner = bots.botOwner(bot);
  if (!botToken || !effectivePlan(owner).channels) return;

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const data = String(cq.data || '');
    try { await callApi(channel, botToken, 'answerCallbackQuery', { callback_query_id: cq.id }); } catch { /* non-fatal */ }
    if (!chatId || !data.startsWith(SUGGEST_PREFIX)) return;
    const [faqId, fromMessageId] = data.slice(SUGGEST_PREFIX.length).split(':').map(Number);
    const reply = bots.pick(bot, faqId, { sessionId: `${channel}:${chatId}`, channel, fromMessageId: fromMessageId || null });
    if (reply) await callApi(channel, botToken, 'sendMessage', { chat_id: chatId, text: reply.answer });
    return;
  }

  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const sessionId = `${channel}:${chatId}`;

  if (msg.contact) {
    const phone = normalizeMobile(msg.contact.phone_number) || String(msg.contact.phone_number || '');
    const name = [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ');
    bots.addLead(bot, { sessionId, name, phone, message: `از طریق ${ch.name}` });
    await callApi(channel, botToken, 'sendMessage', {
      chat_id: chatId,
      text: 'ممنون! شماره‌تان ثبت شد و همکاران ما به‌زودی با شما تماس می‌گیرند. 🙏',
      reply_markup: { remove_keyboard: true },
    });
    return;
  }

  const text = String(msg.text || '').trim();
  if (!text) return;
  if (text === '/start') {
    await callApi(channel, botToken, 'sendMessage', { chat_id: chatId, text: bot.welcome });
    return;
  }
  const reply = bots.ask(bot, text, { sessionId, channel });
  const payload = { chat_id: chatId, text: replyText(reply) };
  const markup = replyMarkup(reply);
  if (markup) payload.reply_markup = markup;
  await callApi(channel, botToken, 'sendMessage', payload);
}

const router = express.Router();
router.post('/hooks/:channel/:botId/:secret', express.json({ limit: '256kb' }), (req, res) => {
  const ch = CHANNELS[req.params.channel];
  const bot = ch && bots.getBot(Number(req.params.botId));
  // Always 200 quickly so the platform doesn't retry; ignore bad secrets silently.
  res.sendStatus(200);
  if (!bot || !bot[ch.secretCol] || bot[ch.secretCol] !== req.params.secret) return;
  handleUpdate(req.params.channel, bot, req.body || {}).catch(e => console.error(`[${req.params.channel}] bot ${bot.id}:`, e.message));
});

module.exports = { CHANNELS, connect, disconnect, handleUpdate, router };

'use strict';
// Bot service: the one place that turns a visitor question into a reply.
// Used by the web widget API, the hosted chat page, Bale/Telegram webhooks,
// and the dashboard's test console, so every channel behaves the same.
const db = require('./db');
const engine = require('./nlp/engine');
const { effectivePlan } = require('./plans');
const { shortId } = require('./util');

// botId -> { version, index, faqsById }
const indexCache = new Map();
// Bumped on every FAQ write for a bot, so a stale cached index is rebuilt lazily.
const versions = new Map();

function invalidate(botId) {
  versions.set(botId, (versions.get(botId) || 0) + 1);
}

function loadIndex(botId) {
  const version = versions.get(botId) || 0;
  const cached = indexCache.get(botId);
  if (cached && cached.version === version) return cached;
  const rows = db.get().prepare('SELECT id, question, alternates, answer FROM faqs WHERE bot_id = ? AND enabled = 1').all(botId);
  const faqs = rows.map(r => ({ id: r.id, question: r.question, alternates: safeJsonArray(r.alternates), answer: r.answer }));
  const entry = { version, index: engine.buildIndex(faqs), faqsById: new Map(faqs.map(f => [f.id, f])) };
  indexCache.set(botId, entry);
  return entry;
}

function safeJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function monthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

function answersThisMonth(userId) {
  return db.get().prepare(`
    SELECT COUNT(*) AS n FROM messages m JOIN bots b ON b.id = m.bot_id
    WHERE b.user_id = ? AND m.created_at >= ? AND m.type = 'answer' AND m.channel != 'test'
  `).get(userId, monthStart()).n;
}

function botOwner(bot) {
  return db.get().prepare('SELECT * FROM users WHERE id = ?').get(bot.user_id);
}

function createBot(userId, { name, industry = '', welcome = '', fallback = '' }) {
  const now = Date.now();
  const info = db.get().prepare(`
    INSERT INTO bots (user_id, public_key, name, industry, welcome, fallback, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, shortId(14), name, industry,
    welcome || `سلام! 👋 من دستیار ${name} هستم. سؤالتان را بپرسید.`,
    fallback || 'متأسفانه جواب این سؤال را پیدا نکردم. اگر شماره‌تان را بگذارید، همکاران ما با شما تماس می‌گیرند.',
    now, now);
  return getBot(info.lastInsertRowid);
}

function getBot(id) {
  return db.get().prepare('SELECT * FROM bots WHERE id = ?').get(id);
}

function getBotByKey(key) {
  return db.get().prepare('SELECT * FROM bots WHERE public_key = ?').get(String(key || ''));
}

function addFaq(botId, { question, alternates = [], answer }) {
  const now = Date.now();
  const info = db.get().prepare(`
    INSERT INTO faqs (bot_id, question, alternates, answer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(botId, question.trim(), JSON.stringify(cleanAlternates(alternates)), answer.trim(), now, now);
  invalidate(botId);
  return info.lastInsertRowid;
}

function updateFaq(botId, faqId, { question, alternates, answer, enabled }) {
  const row = db.get().prepare('SELECT * FROM faqs WHERE id = ? AND bot_id = ?').get(faqId, botId);
  if (!row) return false;
  db.get().prepare(`
    UPDATE faqs SET question = ?, alternates = ?, answer = ?, enabled = ?, updated_at = ? WHERE id = ?
  `).run(
    question !== undefined ? question.trim() : row.question,
    alternates !== undefined ? JSON.stringify(cleanAlternates(alternates)) : row.alternates,
    answer !== undefined ? answer.trim() : row.answer,
    enabled !== undefined ? (enabled ? 1 : 0) : row.enabled,
    Date.now(), faqId,
  );
  invalidate(botId);
  return true;
}

function deleteFaq(botId, faqId) {
  const info = db.get().prepare('DELETE FROM faqs WHERE id = ? AND bot_id = ?').run(faqId, botId);
  invalidate(botId);
  return info.changes > 0;
}

// Teach the bot: a question it could not answer becomes another phrasing of an FAQ.
function addAlternate(botId, faqId, phrasing) {
  const row = db.get().prepare('SELECT alternates FROM faqs WHERE id = ? AND bot_id = ?').get(faqId, botId);
  if (!row) return false;
  const alts = safeJsonArray(row.alternates);
  if (!alts.includes(phrasing)) alts.push(phrasing);
  return updateFaq(botId, faqId, { alternates: alts });
}

function cleanAlternates(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const s = String(a || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 50);
}

function logMessage(bot, { sessionId, channel, question, type, faqId = null, score = 0 }) {
  return db.get().prepare(`
    INSERT INTO messages (bot_id, session_id, channel, question, type, faq_id, score, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bot.id, sessionId || '', channel, question.slice(0, 1000), type, faqId, score, Date.now()).lastInsertRowid;
}

function suggestionList(entry, results) {
  return results
    .map(r => entry.faqsById.get(r.id))
    .filter(Boolean)
    .map(f => ({ id: f.id, question: f.question }));
}

// Core Q&A. Returns a channel-neutral reply object.
function ask(bot, question, { sessionId = '', channel = 'web' } = {}) {
  const q = String(question || '').trim().slice(0, 500);
  if (!q) return { type: 'fallback', answer: bot.fallback, suggestions: [], offerLead: !!bot.lead_form };

  const owner = botOwner(bot);
  const plan = effectivePlan(owner);
  if (channel !== 'test' && answersThisMonth(owner.id) >= plan.answersPerMonth) {
    const messageId = logMessage(bot, { sessionId, channel, question: q, type: 'limit' });
    return {
      type: 'limit',
      messageId,
      answer: 'در حال حاضر پاسخگوی خودکار در دسترس نیست. لطفاً شماره‌تان را بگذارید تا با شما تماس بگیریم.',
      suggestions: [],
      offerLead: true,
    };
  }

  const entry = loadIndex(bot.id);
  const results = engine.search(entry.index, q, { limit: 5 });
  const decision = engine.decide(results, { faqCount: entry.faqsById.size });

  if (decision.type === 'answer') {
    const faq = entry.faqsById.get(decision.best.id);
    const messageId = logMessage(bot, { sessionId, channel, question: q, type: 'answer', faqId: faq.id, score: decision.best.score });
    db.get().prepare('UPDATE faqs SET hits = hits + 1 WHERE id = ?').run(faq.id);
    return {
      type: 'answer',
      messageId,
      faqId: faq.id,
      answer: faq.answer,
      suggestions: suggestionList(entry, decision.suggestions),
      offerLead: false,
    };
  }

  const top = results[0];
  const messageId = logMessage(bot, { sessionId, channel, question: q, type: decision.type, score: top ? top.score : 0 });
  if (decision.type === 'suggest') {
    return {
      type: 'suggest',
      messageId,
      answer: 'منظورتان یکی از این‌هاست؟',
      suggestions: suggestionList(entry, decision.suggestions),
      offerLead: !!bot.lead_form,
    };
  }
  return { type: 'fallback', messageId, answer: bot.fallback, suggestions: [], offerLead: !!bot.lead_form };
}

// Visitor tapped a suggested question: answer it directly and remember that
// their original wording meant this FAQ (a strong learning signal).
function pick(bot, faqId, { sessionId = '', channel = 'web', fromMessageId = null } = {}) {
  const entry = loadIndex(bot.id);
  const faq = entry.faqsById.get(Number(faqId));
  if (!faq) return null;
  if (fromMessageId) {
    db.get().prepare(`
      UPDATE messages SET faq_id = ? WHERE id = ? AND bot_id = ? AND type = 'suggest' AND faq_id IS NULL
    `).run(faq.id, fromMessageId, bot.id);
  }
  const messageId = logMessage(bot, { sessionId, channel, question: faq.question, type: 'answer', faqId: faq.id, score: 1 });
  db.get().prepare('UPDATE faqs SET hits = hits + 1 WHERE id = ?').run(faq.id);
  return { type: 'answer', messageId, faqId: faq.id, answer: faq.answer, suggestions: [], offerLead: false };
}

function feedback(bot, messageId, helpful) {
  db.get().prepare('UPDATE messages SET helpful = ? WHERE id = ? AND bot_id = ?').run(helpful ? 1 : 0, messageId, bot.id);
}

function addLead(bot, { sessionId = '', name = '', phone = '', message = '' }) {
  db.get().prepare(`
    INSERT INTO leads (bot_id, session_id, name, phone, message, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(bot.id, sessionId, name.slice(0, 100), phone.slice(0, 30), message.slice(0, 1000), Date.now());
}

// Top candidates with scores, for the dashboard's test console.
function debugSearch(bot, question, limit = 3) {
  const entry = loadIndex(bot.id);
  return engine.search(entry.index, String(question || ''), { limit })
    .map(r => ({ question: entry.faqsById.get(r.id).question, score: Math.round(r.score * 100) }));
}

// Most-asked questions, used as the widget's starter chips.
function topQuestions(botId, n = 3) {
  return db.get().prepare(`
    SELECT question FROM faqs WHERE bot_id = ? AND enabled = 1 ORDER BY hits DESC, id ASC LIMIT ?
  `).all(botId, n).map(r => r.question);
}

module.exports = {
  createBot, getBot, getBotByKey, addFaq, updateFaq, deleteFaq, addAlternate,
  ask, pick, feedback, addLead, topQuestions, debugSearch, answersThisMonth, botOwner, invalidate, safeJsonArray,
};

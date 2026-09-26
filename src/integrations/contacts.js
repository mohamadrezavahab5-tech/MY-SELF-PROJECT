'use strict';
// "Who is calling?" — everything an account knows about one phone number:
// leads with that number, conversations where the visitor left it (or that
// belong to one of those leads' chat sessions), transcripts and the last QC
// score. Used by GET /api/v1/contacts, /app/lookup and the screen-pop page.
const db = require('../db');
const phone = require('./phone');

const MAX_LEADS = 100;
const MAX_CONVERSATIONS = 30;
const MAX_MESSAGES = 300;

// Separators people type inside numbers, stripped in SQL before matching.
const STRIPPED = "replace(replace(replace(replace(replace(COL, ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')";
const HAS_FA_DIGITS = "COL GLOB '*[۰-۹٠-٩]*'";

function phoneWhere(col) {
  return `(${STRIPPED.replace('COL', col)} LIKE ? OR ${HAS_FA_DIGITS.replace('COL', col)})`;
}

function placeholders(list) {
  return list.map(() => '?').join(',');
}

function lastQc(conversationId) {
  try {
    return db.get().prepare(`
      SELECT score, reviewer, summary, created_at FROM qc_reviews WHERE conversation_id = ? AND score IS NOT NULL ORDER BY id DESC LIMIT 1
    `).get(conversationId) || null;
  } catch {
    return null; // QC tables absent
  }
}

function messages(conversationId, limit = MAX_MESSAGES) {
  return db.get().prepare(`
    SELECT id, sender, text, meta, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
  `).all(conversationId, limit).reverse().map(m => {
    let meta = {};
    try { meta = JSON.parse(m.meta) || {}; } catch { /* ignore */ }
    return { id: m.id, sender: m.sender, text: m.text, operator: meta.operator || '', createdAt: m.created_at };
  });
}

// botIds: the bots the caller may see (all of the account's, or one).
// -> { phone, e164, key, name, leads: [...], conversations: [...] } or null for an unusable number.
function lookup(botIds, input, { transcripts = false, messageLimit = MAX_MESSAGES } = {}) {
  const key = phone.key(input);
  if (!key || key.length < 4 || !botIds.length) return null;
  const conn = db.get();
  const like = `%${key.slice(-7)}`;
  const inBots = placeholders(botIds);

  const leads = conn.prepare(`
    SELECT l.*, b.name AS bot_name FROM leads l JOIN bots b ON b.id = l.bot_id
    WHERE l.bot_id IN (${inBots}) AND l.phone != '' AND ${phoneWhere('l.phone')}
    ORDER BY l.id DESC LIMIT 1000
  `).all(...botIds, like).filter(l => phone.key(l.phone) === key).slice(0, MAX_LEADS);

  const byPhone = conn.prepare(`
    SELECT c.*, b.name AS bot_name FROM conversations c JOIN bots b ON b.id = c.bot_id
    WHERE c.bot_id IN (${inBots}) AND c.visitor_phone != '' AND ${phoneWhere('c.visitor_phone')}
    ORDER BY c.last_message_at DESC LIMIT 1000
  `).all(...botIds, like).filter(c => phone.key(c.visitor_phone) === key);

  // Conversations of the leads' chat sessions (the lead form doesn't set visitor_phone).
  const seen = new Set(byPhone.map(c => c.id));
  const conversations = [...byPhone];
  const sessionConv = conn.prepare(`
    SELECT c.*, b.name AS bot_name FROM conversations c JOIN bots b ON b.id = c.bot_id WHERE c.bot_id = ? AND c.session_id = ?
  `);
  for (const l of leads) {
    if (!l.session_id) continue;
    const c = sessionConv.get(l.bot_id, l.session_id);
    if (c && !seen.has(c.id)) { seen.add(c.id); conversations.push(c); }
  }
  conversations.sort((a, b) => b.last_message_at - a.last_message_at);
  const convs = conversations.slice(0, MAX_CONVERSATIONS).map(c => {
    const n = conn.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?').get(c.id).n;
    const out = { ...c, message_count: n, qc: lastQc(c.id) };
    if (transcripts) out.messages = messages(c.id, messageLimit);
    return out;
  });

  const name = (leads.find(l => l.name) || {}).name || (convs.find(c => c.visitor_name) || {}).visitor_name || '';
  return { phone: phone.local(input), e164: phone.e164(input), key, name, leads, conversations: convs };
}

module.exports = { lookup, messages, lastQc };

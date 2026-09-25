'use strict';
// Live operator chat, conversation transcript and the generative-answer path
// (against a fake OpenAI-compatible server started in this process).
const http = require('http');

process.env.DB_FILE = ':memory:';
process.env.PAYMENT_MODE = 'mock';

const test = require('node:test');
const assert = require('node:assert');

// ---- Fake LLM: streams a fixed answer, or NO_ANSWER for questions containing «دلار».
const llmCalls = [];
const fakeLlm = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body);
    llmCalls.push(payload);
    const question = payload.messages[payload.messages.length - 1].content;
    const text = /دلار|خارج از کشور/.test(question) ? 'NO_ANSWER' : 'در روزهای تعطیل رسمی مجموعه بسته است؛ ساعت کاری شنبه تا پنجشنبه ۹ تا ۱۸ است.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = text.match(/.{1,6}/gsu);
    for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});

let server;
let base;
let db;

test.before(async () => {
  await new Promise(r => fakeLlm.listen(0, '127.0.0.1', r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${fakeLlm.address().port}/v1`;
  process.env.LLM_MODEL = 'fake';
  const app = require('../src/app');
  db = require('../src/db');
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fakeLlm.close(); });

function client() {
  const jar = {};
  return async (path, { method = 'GET', form, json, headers = {} } = {}) => {
    const h = { ...headers };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    if (json) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return res;
  };
}

async function ownerWithBot(phone) {
  const c = client();
  await c('/signup', { method: 'POST', form: { name: 'اپراتور تست', company: 'فروشگاه', phone, password: 'password123' } });
  const res = await c('/app/bots/new', { method: 'POST', form: { name: 'فروشگاه تست', industry: '' } });
  const botId = Number(res.headers.get('location').match(/\/app\/bots\/(\d+)/)[1]);
  const faqs = [
    ['ساعت کاری شما چیست؟', 'کی بازید', 'شنبه تا پنجشنبه ۹ تا ۱۸'],
    ['هزینه ارسال چقدر است؟', 'هزینه پست چنده', 'ارسال بالای ۵۰۰ هزار تومان رایگان است.'],
    ['امکان مرجوع کردن کالا هست؟', 'مرجوعی دارید', 'تا ۷ روز'],
  ];
  for (const [question, alternates, answer] of faqs) await c(`/app/bots/${botId}/faqs`, { method: 'POST', form: { question, alternates, answer } });
  const bot = db.get().prepare('SELECT * FROM bots WHERE id = ?').get(botId);
  return { c, bot };
}

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map(block => {
    const ev = (block.match(/^event: (.*)$/m) || [])[1];
    const data = (block.match(/^data: (.*)$/m) || [])[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}

test('every exchange is written to the conversation transcript', async () => {
  const { bot } = await ownerWithBot('09131000001');
  const w = client();
  await w(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q: 'ساعت کاری', sid: 'tx1', page: 'https://shop.example/contact' } });
  const conv = db.get().prepare('SELECT * FROM conversations WHERE bot_id = ? AND session_id = ?').get(bot.id, 'tx1');
  assert.ok(conv);
  assert.strictEqual(conv.page_url, 'https://shop.example/contact');
  const msgs = db.get().prepare('SELECT sender, text FROM chat_messages WHERE conversation_id = ? ORDER BY id').all(conv.id);
  assert.deepStrictEqual(msgs.map(m => m.sender), ['visitor', 'bot']);
  assert.match(msgs[1].text, /شنبه/);
});

test('generative answers stream only for paid plans with AI on, and only with context', async () => {
  const { bot } = await ownerWithBot('09131000002');
  const w = client();
  const q = 'ساعت کاری روزهای تعطیل رسمی چطوره';

  // AI off -> no LLM call, suggestions instead.
  let r = await (await w(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q, sid: 'ai1' } })).json();
  assert.strictEqual(r.type, 'suggest');
  assert.strictEqual(llmCalls.length, 0);

  db.get().prepare('UPDATE bots SET ai_enabled = 1 WHERE id = ?').run(bot.id);
  // Free plan -> still no AI.
  r = await (await w(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q, sid: 'ai1' } })).json();
  assert.strictEqual(r.type, 'suggest');
  assert.strictEqual(llmCalls.length, 0);

  db.get().prepare(`UPDATE users SET plan = 'pro', plan_expires_at = ? WHERE id = ?`).run(Date.now() + 86400_000, bot.user_id);
  const cfg = await (await w(`/api/w/${bot.public_key}/config`)).json();
  assert.strictEqual(cfg.bot.ai, true);

  const res = await w(`/api/w/${bot.public_key}/ask-stream`, { method: 'POST', json: { q, sid: 'ai1' } });
  assert.match(res.headers.get('content-type'), /event-stream/);
  const events = parseSse(await res.text());
  const deltas = events.filter(e => e.event === 'delta').map(e => e.data.text);
  assert.ok(deltas.length > 1, 'streamed in several chunks');
  const done = events.find(e => e.event === 'done').data;
  assert.strictEqual(done.kind, 'ai');
  assert.strictEqual(deltas.join(''), done.answer);
  assert.match(done.answer, /تعطیل/);
  assert.strictEqual(llmCalls.length, 1);
  // The model saw the FAQ as grounding and the conversation so far.
  const sys = llmCalls[0].messages[0].content;
  assert.match(sys, /ساعت کاری شما چیست/);
  assert.match(sys, /NO_ANSWER/);
  assert.ok(llmCalls[0].messages.length >= 3, 'history included');
  const row = db.get().prepare(`SELECT type FROM messages WHERE bot_id = ? ORDER BY id DESC`).get(bot.id);
  assert.strictEqual(row.type, 'ai');

  // Off-topic -> never sent to the model.
  const before = llmCalls.length;
  r = await (await w(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q: 'قیمت دلار امروز', sid: 'ai1' } })).json();
  assert.notStrictEqual(r.kind, 'ai');
  assert.strictEqual(llmCalls.length, before);

  // Model says NO_ANSWER -> nothing leaks to the visitor; normal suggestions instead.
  const res2 = await w(`/api/w/${bot.public_key}/ask-stream`, { method: 'POST', json: { q: 'ارسال به خارج از کشور هم دارید', sid: 'ai1' } });
  const ev2 = parseSse(await res2.text());
  assert.ok(llmCalls.length > before, 'model was asked');
  assert.ok(!ev2.some(e => e.event === 'delta' && /NO_ANSWER/.test(e.data.text)));
  assert.notStrictEqual(ev2.find(e => e.event === 'done').data.kind, 'ai');
});

test('visitor asks for a human, operator replies from the dashboard, then hands back to the bot', async () => {
  const { c, bot } = await ownerWithBot('09131000003');
  const w = client();
  const key = bot.public_key;

  // Nobody has the inbox open yet -> offline.
  let r = await (await w(`/api/w/${key}/handoff`, { method: 'POST', json: { sid: 'h1', name: 'مینا' } })).json();
  assert.strictEqual(r.online, false);
  assert.strictEqual(r.offerLead, true);

  // Operator opens the inbox -> online.
  let page = await c(`/app/bots/${bot.id}/live`);
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /مینا/);
  r = await (await w(`/api/w/${key}/handoff`, { method: 'POST', json: { sid: 'h1' } })).json();
  assert.strictEqual(r.online, true);

  // In human mode, questions are held for the operator, not answered by the bot.
  r = await (await w(`/api/w/${key}/ask`, { method: 'POST', json: { q: 'ساعت کاری', sid: 'h1' } })).json();
  assert.strictEqual(r.type, 'human');
  r = await (await w(`/api/w/${key}/send`, { method: 'POST', json: { sid: 'h1', text: 'سفارشم خراب رسیده' } })).json();
  assert.strictEqual(r.ok, true);

  const conv = db.get().prepare('SELECT * FROM conversations WHERE bot_id = ? AND session_id = ?').get(bot.id, 'h1');
  let live = await (await c(`/app/bots/${bot.id}/live.json`)).json();
  assert.strictEqual(live.waiting, 1);
  live = await (await c(`/app/bots/${bot.id}/live.json?c=${conv.id}`)).json();
  assert.ok(live.messages.some(m => m.text === 'سفارشم خراب رسیده'));

  r = await (await c(`/app/bots/${bot.id}/live/${conv.id}/reply`, { method: 'POST', json: { text: 'سلام، عکس کالا را بفرستید.', operator: 'علی' } })).json();
  assert.strictEqual(r.ok, true);
  const poll = await (await w(`/api/w/${key}/poll?sid=h1&after=0`)).json();
  assert.strictEqual(poll.mode, 'human');
  const op = poll.messages.find(m => m.sender === 'operator');
  assert.strictEqual(op.text, 'سلام، عکس کالا را بفرستید.');
  const meta = JSON.parse(db.get().prepare('SELECT meta FROM chat_messages WHERE id = ?').get(op.id).meta);
  assert.strictEqual(meta.operator, 'علی');
  // Visitors never see visitor/bot rows through poll.
  assert.ok(poll.messages.every(m => m.sender === 'operator' || m.sender === 'system'));

  await c(`/app/bots/${bot.id}/live/${conv.id}/close`, { method: 'POST', json: {} });
  r = await (await w(`/api/w/${key}/ask`, { method: 'POST', json: { q: 'ساعت کاری', sid: 'h1' } })).json();
  assert.strictEqual(r.type, 'answer');
  r = await (await w(`/api/w/${key}/send`, { method: 'POST', json: { sid: 'h1', text: 'x' } })).json();
  assert.strictEqual(r.ok, false);
});

test('operators cannot read or reply to another account\'s conversations', async () => {
  const a = await ownerWithBot('09131000004');
  const w = client();
  await w(`/api/w/${a.bot.public_key}/handoff`, { method: 'POST', json: { sid: 'x1' } });
  const conv = db.get().prepare('SELECT * FROM conversations WHERE bot_id = ?').get(a.bot.id);
  const b = await ownerWithBot('09131000005');
  let res = await b.c(`/app/bots/${a.bot.id}/live`);
  assert.strictEqual(res.status, 302);
  res = await b.c(`/app/bots/${b.bot.id}/live/${conv.id}/reply`, { method: 'POST', json: { text: 'hack' } });
  assert.strictEqual(res.status, 404);
  res = await b.c(`/app/bots/${b.bot.id}/live.json?c=${conv.id}`);
  const data = await res.json();
  assert.strictEqual(data.conv, null);
});

test('bot settings: language, live chat, proactive greeting; AI needs a paid plan', async () => {
  const { c, bot } = await ownerWithBot('09131000006');
  const form = {
    name: 'Shop Assistant', lang: 'en', welcome: 'Hi!', fallback: 'Sorry.', color: '#0ea5e9', position: 'left',
    lead_form: '1', live_chat: '1', ai_enabled: '1', proactive_text: 'Questions about shipping?', proactive_delay: '15', proactive_path: '/pricing',
  };
  let res = await c(`/app/bots/${bot.id}/settings`, { method: 'POST', form });
  assert.strictEqual(res.status, 302);
  let row = db.get().prepare('SELECT * FROM bots WHERE id = ?').get(bot.id);
  assert.strictEqual(row.lang, 'en');
  assert.strictEqual(row.ai_enabled, 0, 'free plan cannot turn AI on');
  assert.strictEqual(row.proactive_delay, 15);

  const cfg = (await (await client()(`/api/w/${bot.public_key}/config`)).json()).bot;
  assert.strictEqual(cfg.lang, 'en');
  assert.strictEqual(cfg.position, 'left');
  assert.deepStrictEqual(cfg.proactive, { text: 'Questions about shipping?', delay: 15, path: '/pricing' });

  // English bot -> English system strings.
  const r = await (await client()(`/api/w/${bot.public_key}/handoff`, { method: 'POST', json: { sid: 'en1' } })).json();
  assert.match(r.message, /team/i);

  db.get().prepare(`UPDATE users SET plan = 'pro', plan_expires_at = ? WHERE id = ?`).run(Date.now() + 86400_000, bot.user_id);
  await c(`/app/bots/${bot.id}/settings`, { method: 'POST', form: { ...form, proactive_text: '' } });
  row = db.get().prepare('SELECT * FROM bots WHERE id = ?').get(bot.id);
  assert.strictEqual(row.ai_enabled, 1);
  assert.strictEqual(row.proactive_delay, 0, 'empty text turns the greeting off');
  const page = await (await c(`/app/bots/${bot.id}/settings`)).text();
  assert.match(page, /English/);
});

test('new bots can be created in another language without the Persian starter pack', async () => {
  const c = client();
  await c('/signup', { method: 'POST', form: { name: 'Owner', company: 'Acme', phone: '09131000007', password: 'password123' } });
  const res = await c('/app/bots/new', { method: 'POST', form: { name: 'Acme', industry: 'shop', starter: '1', lang: 'en' } });
  const botId = Number(res.headers.get('location').match(/\/app\/bots\/(\d+)/)[1]);
  const bot = db.get().prepare('SELECT * FROM bots WHERE id = ?').get(botId);
  assert.strictEqual(bot.lang, 'en');
  assert.match(bot.welcome, /Hi there/);
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM faqs WHERE bot_id = ?').get(botId).n, 0);
});

test('English landing page with an English demo bot and an international sales form', async () => {
  const w = client();
  let res = await w('/en');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html lang="en" dir="ltr">/);
  assert.match(html, /hreflang="fa"/);
  assert.match(html, /data-bot="sitedemo-en"/);
  const cfg = (await (await w('/api/w/sitedemo-en/config')).json()).bot;
  assert.strictEqual(cfg.lang, 'en');
  const r = await (await w('/api/w/sitedemo-en/ask', { method: 'POST', json: { q: 'does it make up answers?', sid: 'en-demo' } })).json();
  assert.strictEqual(r.type, 'answer');
  assert.match(r.answer, /only answers from your own FAQ/);

  res = await w('/en', { method: 'POST', form: { name: 'Sam', org: 'Acme LLC', contact: 'nope', message: '' } });
  assert.strictEqual(res.status, 400);
  res = await w('/en', { method: 'POST', form: { name: 'Sam', org: 'Acme LLC', contact: 'sam@acme.example', country: 'UAE', message: '<b>hi</b>' } });
  assert.match(await res.text(), /We received your message/);
  const row = db.get().prepare(`SELECT * FROM contact_requests WHERE kind = 'international'`).get();
  assert.strictEqual(row.phone, 'sam@acme.example');
  assert.match(row.message, /Country: UAE/);
});

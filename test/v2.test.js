'use strict';
// QC and CRM/call-center integrations: the main flows, over HTTP.
process.env.DB_FILE = ':memory:';

const test = require('node:test');
const assert = require('node:assert');

let app, db, apiKeys, qc, server, base;

test.before(async () => {
  app = require('../src/app');
  db = require('../src/db');
  apiKeys = require('../src/integrations/apiKeys');
  qc = require('../src/qc');
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

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
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i)] = pair.slice(i + 1); }
    return res;
  };
}

async function ownerWithBot(phone) {
  const c = client();
  await c('/signup', { method: 'POST', form: { name: 'مدیر پشتیبانی', company: 'شرکت نمونه', phone, password: 'password123' } });
  const res = await c('/app/bots/new', { method: 'POST', form: { name: 'پشتیبانی', industry: '' } });
  const botId = Number(res.headers.get('location').match(/\/app\/bots\/(\d+)/)[1]);
  await c(`/app/bots/${botId}/faqs`, { method: 'POST', form: { question: 'ساعت کاری شما چیست؟', alternates: 'کی بازید', answer: 'شنبه تا پنجشنبه ۹ تا ۱۸' } });
  return { c, bot: db.get().prepare('SELECT * FROM bots WHERE id = ?').get(botId) };
}

test('QC: an operator conversation gets an automatic review with metrics and flags', async () => {
  const { c, bot } = await ownerWithBot('09151000001');
  const w = client();
  await w(`/api/w/${bot.public_key}/handoff`, { method: 'POST', json: { sid: 'qc1', name: 'نرگس' } });
  await w(`/api/w/${bot.public_key}/send`, { method: 'POST', json: { sid: 'qc1', text: 'سفارشم دیر رسیده' } });
  const conv = db.get().prepare('SELECT * FROM conversations WHERE bot_id = ? AND session_id = ?').get(bot.id, 'qc1');
  await c(`/app/bots/${bot.id}/live/${conv.id}/reply`, { method: 'POST', json: { text: 'سلام، وقت بخیر. پیگیری می‌کنم و خبر می‌دهم. ممنون از صبرتان', operator: 'سارا' } });

  const r = qc.autoReview(db.get().prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id));
  assert.ok(r.score === null || (r.score >= 0 && r.score <= 100), `score ${r.score}`);
  assert.ok(r.metrics, 'metrics computed');

  let res = await c(`/app/bots/${bot.id}/qc`);
  assert.strictEqual(res.status, 200);
  res = await c(`/app/bots/${bot.id}/qc/c/${conv.id}`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /سفارشم دیر رسیده/);
  assert.match(html, /سارا/);

  const other = await ownerWithBot('09151000002');
  res = await other.c(`/app/bots/${bot.id}/qc/c/${conv.id}`);
  assert.strictEqual(res.status, 302);
});

test('Integrations: API keys are scoped to their owner; contacts lookup normalizes phones', async () => {
  const a = await ownerWithBot('09151000003');
  const w = client();
  await w(`/api/w/${a.bot.public_key}/lead`, { method: 'POST', json: { sid: 'l1', name: 'مشتری', phone: '+98 912 000 0033', message: 'تماس بگیرید' } });

  let res = await a.c('/app/integrations');
  assert.strictEqual(res.status, 200);
  res = await a.c('/app/integrations/keys', { method: 'POST', form: { name: 'CRM' } });
  assert.strictEqual(res.status, 302);

  const { key } = apiKeys.create(a.bot.user_id, { name: 'test' });
  const auth = { authorization: `Bearer ${key}` };
  res = await w('/api/v1/leads', { headers: auth });
  assert.strictEqual(res.status, 200);
  const leads = await res.json();
  assert.ok(JSON.stringify(leads).includes('09120000033'));

  res = await w(`/api/v1/contacts?phone=${encodeURIComponent('۰۹۱۲۰۰۰۰۰۳۳')}`, { headers: auth });
  assert.strictEqual(res.status, 200);
  assert.ok(JSON.stringify(await res.json()).includes('تماس بگیرید'));

  res = await w('/api/v1/leads');
  assert.strictEqual(res.status, 401);

  const b = await ownerWithBot('09151000004');
  const other = apiKeys.create(b.bot.user_id, { name: 'other' }).key;
  res = await w('/api/v1/leads', { headers: { authorization: `Bearer ${other}` } });
  assert.ok(!JSON.stringify(await res.json()).includes('09120000033'), 'another account sees nothing');
  res = await w(`/api/v1/bots/${a.bot.id}/faqs`, { headers: { authorization: `Bearer ${other}` } });
  assert.ok(res.status === 403 || res.status === 404);

  res = await a.c('/app/lookup?phone=09120000033');
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /تماس بگیرید/);
});

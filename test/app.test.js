'use strict';
// End-to-end tests over HTTP against an in-memory database.
process.env.DB_FILE = ':memory:';
process.env.PAYMENT_MODE = 'mock';
process.env.ADMIN_PHONES = '09350000000';

const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const db = require('../src/db');

let server;
let base;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

// Tiny cookie-keeping client.
function client() {
  const jar = {};
  async function req(path, { method = 'GET', form, json, raw, headers = {} } = {}) {
    const h = { ...headers };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    if (json) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
    if (raw) { body = raw; h['content-type'] = 'application/octet-stream'; }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return res;
  }
  return { req, jar };
}

async function signup(c, phone, extra = {}) {
  const res = await c.req('/signup', { method: 'POST', form: { name: 'کاربر تست', company: 'شرکت تست', phone, password: 'password123', ...extra } });
  assert.strictEqual(res.status, 302);
  return res;
}

async function makeBot(c) {
  const res = await c.req('/app/bots/new', { method: 'POST', form: { name: 'بات تست', industry: '' } });
  assert.strictEqual(res.status, 302);
  const id = Number(res.headers.get('location').match(/\/app\/bots\/(\d+)/)[1]);
  return db.get().prepare('SELECT * FROM bots WHERE id = ?').get(id);
}

test('public pages render with SEO essentials', async () => {
  const c = client();
  for (const p of ['/', '/pricing', '/industries', '/blog', '/affiliate', '/signup', '/login']) {
    const res = await c.req(p);
    assert.strictEqual(res.status, 200, p);
    const html = await res.text();
    assert.match(html, /<html lang="fa" dir="rtl">/, p);
    assert.match(html, /<title>[^<]+<\/title>/, p);
  }
  const sm = await (await c.req('/sitemap.xml')).text();
  assert.match(sm, /<urlset/);
  const robots = await (await c.req('/robots.txt')).text();
  assert.match(robots, /Disallow: \/app/);
});

test('signup -> bot -> FAQ -> widget answers, suggests, falls back, captures lead', async () => {
  const c = client();
  await signup(c, '09121000001');
  const bot = await makeBot(c);

  let res = await c.req(`/app/bots/${bot.id}/faqs`, { method: 'POST', form: { question: 'ساعت کاری شما چیست؟', alternates: 'کی بازید\nتایم کاری', answer: 'شنبه تا پنجشنبه ۹ تا ۱۸' } });
  assert.strictEqual(res.status, 302);

  const w = client();
  res = await w.req(`/api/w/${bot.public_key}/config`);
  const cfg = await res.json();
  assert.strictEqual(cfg.ok, true);
  assert.strictEqual(cfg.bot.badge.show, true, 'free plan shows badge');
  assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');

  res = await w.req(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q: 'ساعت کاری شما چیست', sid: 's1' } });
  const ans = await res.json();
  assert.strictEqual(ans.type, 'answer');
  assert.match(ans.answer, /شنبه/);

  res = await w.req(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q: 'قیمت بلیت هواپیما به استانبول', sid: 's1' } });
  const fb = await res.json();
  assert.notStrictEqual(fb.type, 'answer');

  res = await w.req(`/api/w/${bot.public_key}/lead`, { method: 'POST', json: { sid: 's1', name: 'مریم', phone: '۰۹۱۲۳۴۵۶۷۸۹', message: 'تماس بگیرید' } });
  assert.strictEqual((await res.json()).ok, true);
  const lead = db.get().prepare('SELECT * FROM leads WHERE bot_id = ?').get(bot.id);
  assert.strictEqual(lead.phone, '09123456789');

  res = await w.req(`/api/w/${bot.public_key}/lead`, { method: 'POST', json: { sid: 's1', phone: 'abc' } });
  assert.strictEqual(res.status, 400);

  res = await w.req(`/api/w/${bot.public_key}/feedback`, { method: 'POST', json: { messageId: ans.messageId, helpful: true } });
  assert.strictEqual((await res.json()).ok, true);

  res = await c.req(`/app/bots/${bot.id}/leads`);
  assert.match(await res.text(), /09123456789/);
});

test('inbox: answering an unanswered question teaches the bot', async () => {
  const c = client();
  await signup(c, '09121000002');
  const bot = await makeBot(c);
  const w = client();
  const q = 'پارکینگ دارید؟';
  let res = await w.req(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q, sid: 'x' } });
  assert.strictEqual((await res.json()).type, 'fallback');

  const msg = db.get().prepare(`SELECT * FROM messages WHERE bot_id = ? AND type = 'fallback'`).get(bot.id);
  res = await c.req(`/app/bots/${bot.id}/inbox`);
  assert.match(await res.text(), /پارکینگ دارید/);

  res = await c.req(`/app/bots/${bot.id}/inbox/${msg.id}/answer`, { method: 'POST', form: { question: 'آیا پارکینگ دارید؟', answer: 'بله، پارکینگ رایگان داریم.' } });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(db.get().prepare('SELECT resolved FROM messages WHERE id = ?').get(msg.id).resolved, 1);

  res = await w.req(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q, sid: 'x' } });
  const again = await res.json();
  assert.strictEqual(again.type, 'answer');
  assert.match(again.answer, /پارکینگ رایگان/);
});

test('bulk text and CSV import', async () => {
  const c = client();
  await signup(c, '09121000003');
  const bot = await makeBot(c);
  let res = await c.req(`/app/bots/${bot.id}/faqs/import-text`, { method: 'POST', form: { text: 'سؤال: آدرس کجاست؟\nجواب: تهران، خیابان آزادی\n\nسوال: شماره تماس؟\nپاسخ: ۰۲۱۱۲۳۴' } });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM faqs WHERE bot_id = ?').get(bot.id).n, 2);

  res = await c.req(`/app/bots/${bot.id}/faqs/import-file?name=f.csv`, { method: 'POST', raw: Buffer.from('سؤال,جواب,شکل‌های دیگر\n"ارسال رایگان؟","بله، بالای ۵۰۰ هزار",ارسال مجانی|پست رایگان\n') });
  const out = await res.json();
  assert.strictEqual(out.imported, 1);
  const row = db.get().prepare(`SELECT * FROM faqs WHERE bot_id = ? AND question LIKE 'ارسال%'`).get(bot.id);
  assert.deepStrictEqual(JSON.parse(row.alternates), ['ارسال مجانی', 'پست رایگان']);
});

test('free plan limits FAQ count', async () => {
  const c = client();
  await signup(c, '09121000004');
  const bot = await makeBot(c);
  const text = Array.from({ length: 40 }, (_, i) => `سؤال: سؤال شماره ${i}\nجواب: جواب ${i}`).join('\n');
  await c.req(`/app/bots/${bot.id}/faqs/import-text`, { method: 'POST', form: { text } });
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM faqs WHERE bot_id = ?').get(bot.id).n, 30);
});

test('user output is HTML-escaped everywhere (no stored XSS)', async () => {
  const c = client();
  await signup(c, '09121000005');
  const bot = await makeBot(c);
  const evil = '<img src=x onerror=alert(1)>';
  await c.req(`/app/bots/${bot.id}/faqs`, { method: 'POST', form: { question: evil, answer: evil } });
  const w = client();
  await w.req(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q: `${evil} zzz`, sid: 'e' } });
  await w.req(`/api/w/${bot.public_key}/lead`, { method: 'POST', json: { phone: '09120000001', name: evil, message: evil } });
  for (const p of ['/faqs', '/inbox', '/leads', '', '/settings']) {
    const html = await (await c.req(`/app/bots/${bot.id}${p}`)).text();
    assert.ok(!html.includes('<img src=x'), `unescaped on ${p || 'overview'}`);
  }
});

test('users cannot access other users\' bots', async () => {
  const a = client();
  await signup(a, '09121000006');
  const bot = await makeBot(a);
  const b = client();
  await signup(b, '09121000007');
  let res = await b.req(`/app/bots/${bot.id}/faqs`);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/app');
  res = await b.req(`/app/bots/${bot.id}/faqs`, { method: 'POST', form: { question: 'hack', answer: 'hack' } });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(db.get().prepare(`SELECT COUNT(*) n FROM faqs WHERE bot_id = ? AND question = 'hack'`).get(bot.id).n, 0);
});

test('cross-origin POSTs to the dashboard are rejected', async () => {
  const c = client();
  await signup(c, '09121000008');
  const bot = await makeBot(c);
  const res = await c.req(`/app/bots/${bot.id}/faqs`, { method: 'POST', form: { question: 'q', answer: 'a' }, headers: { origin: 'https://evil.example' } });
  assert.strictEqual(res.status, 403);
});

test('login rejects open redirects', async () => {
  const c = client();
  await signup(c, '09121000009');
  const d = client();
  const res = await d.req('/login', { method: 'POST', form: { phone: '09121000009', password: 'password123', next: '//evil.example/x' } });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/app');
  const bad = await client().req('/login', { method: 'POST', form: { phone: '09121000009', password: 'wrong-password' } });
  assert.strictEqual(bad.status, 400);
});

test('referral: discounted first purchase, plan activation, commission, payout', async () => {
  const aff = client();
  await signup(aff, '09121000010');
  const affUser = db.get().prepare('SELECT * FROM users WHERE phone = ?').get('09121000010');

  const buyer = client();
  await buyer.req(`/?ref=${affUser.ref_code}`);
  assert.ok(buyer.jar.ref, 'ref cookie set');
  await signup(buyer, '09121000011');
  const buyerUser = db.get().prepare('SELECT * FROM users WHERE phone = ?').get('09121000011');
  assert.strictEqual(buyerUser.referred_by, affUser.id);
  const bot = await makeBot(buyer);

  let res = await buyer.req('/app/billing/checkout', { method: 'POST', form: { plan: 'pro', months: '1' } });
  assert.strictEqual(res.status, 302);
  const mockUrl = res.headers.get('location');
  assert.match(mockUrl, /^\/pay\/mock\//);
  const order = db.get().prepare('SELECT * FROM orders WHERE user_id = ?').get(buyerUser.id);
  assert.strictEqual(order.discount, 29000);
  assert.strictEqual(order.amount, 261000);

  res = await buyer.req(`/pay/callback?Authority=${encodeURIComponent(order.authority)}&Status=OK`);
  assert.strictEqual(res.headers.get('location'), '/app/billing?paid=1');
  // Replaying the callback must not double-credit.
  await buyer.req(`/pay/callback?Authority=${encodeURIComponent(order.authority)}&Status=OK`);

  const paid = db.get().prepare('SELECT * FROM users WHERE id = ?').get(buyerUser.id);
  assert.strictEqual(paid.plan, 'pro');
  assert.ok(paid.plan_expires_at > Date.now() + 29 * 86400_000);
  const cfg = await (await client().req(`/api/w/${bot.public_key}/config`)).json();
  assert.strictEqual(cfg.bot.badge.show, false, 'paid plan hides badge');

  let a = db.get().prepare('SELECT * FROM users WHERE id = ?').get(affUser.id);
  assert.strictEqual(a.balance, Math.floor(261000 * 0.25));
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM commissions WHERE referrer_id = ?').get(affUser.id).n, 1);

  // Second purchase: no discount, commission again (recurring).
  res = await buyer.req('/app/billing/checkout', { method: 'POST', form: { plan: 'pro', months: '3' } });
  const order2 = db.get().prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').get(buyerUser.id);
  assert.strictEqual(order2.discount, 0);
  await buyer.req(`/pay/callback?Authority=${encodeURIComponent(order2.authority)}&Status=OK`);
  a = db.get().prepare('SELECT * FROM users WHERE id = ?').get(affUser.id);
  assert.strictEqual(a.balance, Math.floor(261000 * 0.25) + Math.floor(order2.amount * 0.25));

  // Payout needs a valid Sheba.
  res = await aff.req('/app/referral/sheba', { method: 'POST', form: { sheba: 'IR123' } });
  assert.match(res.headers.get('location'), /err=sheba/);
  res = await aff.req('/app/referral/sheba', { method: 'POST', form: { sheba: 'IR062960000000100324200001' } });
  assert.match(res.headers.get('location'), /ok=sheba/);
  res = await aff.req('/app/referral/payout', { method: 'POST', form: {} });
  assert.match(res.headers.get('location'), /ok=payout/);
  a = db.get().prepare('SELECT * FROM users WHERE id = ?').get(affUser.id);
  assert.strictEqual(a.balance, 0);
  assert.strictEqual(db.get().prepare(`SELECT COUNT(*) n FROM payouts WHERE user_id = ? AND status = 'requested'`).get(affUser.id).n, 1);

  // Admin rejects -> balance restored.
  const admin = client();
  await signup(admin, '09350000000');
  const p = db.get().prepare('SELECT * FROM payouts WHERE user_id = ?').get(affUser.id);
  res = await admin.req(`/admin/payouts/${p.id}`, { method: 'POST', form: { status: 'rejected' } });
  assert.strictEqual(res.status, 302);
  a = db.get().prepare('SELECT * FROM users WHERE id = ?').get(affUser.id);
  assert.strictEqual(a.balance, p.amount);
});

test('failed/cancelled payment does not activate plan', async () => {
  const c = client();
  await signup(c, '09121000012');
  await makeBot(c);
  const user = db.get().prepare('SELECT * FROM users WHERE phone = ?').get('09121000012');
  await c.req('/app/billing/checkout', { method: 'POST', form: { plan: 'business', months: '12' } });
  const order = db.get().prepare('SELECT * FROM orders WHERE user_id = ?').get(user.id);
  const res = await c.req(`/pay/callback?Authority=${encodeURIComponent(order.authority)}&Status=NOK`);
  assert.match(res.headers.get('location'), /failed=1/);
  assert.strictEqual(db.get().prepare('SELECT plan FROM users WHERE id = ?').get(user.id).plan, 'free');
});

test('non-admins cannot open the admin panel', async () => {
  const c = client();
  await signup(c, '09121000013');
  const res = await c.req('/admin');
  assert.strictEqual(res.status, 403);
});

test('monthly answer limit switches the bot to lead capture', async () => {
  const c = client();
  await signup(c, '09121000014');
  const bot = await makeBot(c);
  await c.req(`/app/bots/${bot.id}/faqs`, { method: 'POST', form: { question: 'ساعت کاری؟', answer: '۹ تا ۵' } });
  const ins = db.get().prepare(`INSERT INTO messages (bot_id, question, type, channel, created_at) VALUES (?, 'x', 'answer', 'web', ?)`);
  db.get().transaction(() => { for (let i = 0; i < 150; i++) ins.run(bot.id, Date.now()); })();
  const res = await client().req(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q: 'ساعت کاری؟', sid: 'l' } });
  const r = await res.json();
  assert.strictEqual(r.type, 'limit');
  assert.strictEqual(r.offerLead, true);
});

test('allowed domains restrict the widget', async () => {
  const c = client();
  await signup(c, '09121000015');
  const bot = await makeBot(c);
  await c.req(`/app/bots/${bot.id}/install/domains`, { method: 'POST', form: { domains: 'https://www.shop.ir/\nfoo' } });
  assert.strictEqual(db.get().prepare('SELECT allowed_domains FROM bots WHERE id = ?').get(bot.id).allowed_domains, 'shop.ir');
  const w = client();
  let res = await w.req(`/api/w/${bot.public_key}/config`, { headers: { origin: 'https://evil.com' } });
  assert.strictEqual(res.status, 403);
  res = await w.req(`/api/w/${bot.public_key}/config`, { headers: { origin: 'https://blog.shop.ir' } });
  assert.strictEqual(res.status, 200);
});

test('admin can issue a temporary password', async () => {
  const u = client();
  await signup(u, '09121000016');
  const admin = client();
  await admin.req('/login', { method: 'POST', form: { phone: '09350000000', password: 'password123' } });
  const user = db.get().prepare('SELECT * FROM users WHERE phone = ?').get('09121000016');
  const res = await admin.req(`/admin/users/${user.id}/reset`, { method: 'POST', form: {} });
  const html = await res.text();
  const temp = html.match(/<p class="code-box"[^>]*>([^<]+)<\/p>/)[1];
  assert.ok(temp.length >= 8);
  // Old session is revoked, old password fails, temp password works.
  assert.strictEqual((await u.req('/app')).headers.get('location').startsWith('/login'), true);
  assert.strictEqual((await client().req('/login', { method: 'POST', form: { phone: '09121000016', password: 'password123' } })).status, 400);
  assert.strictEqual((await client().req('/login', { method: 'POST', form: { phone: '09121000016', password: temp } })).status, 302);
});

test('FAQ template and enterprise pages; enquiries reach the admin', async () => {
  const c = client();
  let res = await c.req('/faq-templates');
  assert.strictEqual(res.status, 200);
  res = await c.req('/faq-templates/online-shop');
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /نمونه سؤالات متداول/);
  const sm = await (await c.req('/sitemap.xml')).text();
  assert.match(sm, /\/faq-templates\/online-shop/);
  assert.match(sm, /\/enterprise/);

  res = await c.req('/enterprise', { method: 'POST', form: { name: 'رضا', org: 'اداره نمونه', phone: '۰۲۱۸۸۸۸۸۸۸۸', message: '<b>x</b>' } });
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /درخواست شما ثبت شد/);
  const row = db.get().prepare('SELECT * FROM contact_requests ORDER BY id DESC').get();
  assert.strictEqual(row.phone, '02188888888');

  const admin = client();
  await admin.req('/login', { method: 'POST', form: { phone: '09350000000', password: 'password123' } });
  const html = await (await admin.req('/admin')).text();
  assert.match(html, /اداره نمونه/);
  assert.ok(!html.includes('<b>x</b>'));
});

test('importing from an internal URL is refused with a friendly error', async () => {
  const c = client();
  await signup(c, '09121000017');
  const bot = await makeBot(c);
  const res = await c.req(`/app/bots/${bot.id}/faqs/import-url`, { method: 'POST', form: { url: 'http://127.0.0.1:9/faq' } });
  assert.strictEqual(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location')), /err=این آدرس قابل دسترسی نیست/);
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM faqs WHERE bot_id = ?').get(bot.id).n, 0);
});

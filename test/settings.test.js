'use strict';
// Site-owner settings (/admin/settings): values edited at runtime must show up
// at once on public pages, prices, checkout, referral, blog, FAQ and demo bot.
process.env.DB_FILE = ':memory:';
process.env.PAYMENT_MODE = 'mock';
process.env.ADMIN_PHONES = '09350000009';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const app = require('../src/app');
const db = require('../src/db');
const config = require('../src/config');
const settings = require('../src/settings');
const { PLANS, DURATIONS, priceToman } = require('../src/plans');
const builtinBlog = require('../src/content/blog');

let server;
let base;
let admin;

// Tiny cookie-keeping client (same as app.test.js).
function client() {
  const jar = {};
  async function req(p, { method = 'GET', form, headers = {} } = {}) {
    const h = { ...headers };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return res;
  }
  const text = async (p, opts) => (await req(p, opts)).text();
  return { req, text, jar };
}

let phoneSeq = 0;
async function signup(c, phone = `0912200${String(++phoneSeq).padStart(4, '0')}`) {
  const res = await c.req('/signup', { method: 'POST', form: { name: 'کاربر تست', company: 'شرکت تست', phone, password: 'password123' } });
  assert.strictEqual(res.status, 302);
  return db.get().prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

async function save(tab, form, expect = 302) {
  const res = await admin.req(`/admin/settings/${tab}`, { method: 'POST', form });
  assert.strictEqual(res.status, expect, `${tab}: ${JSON.stringify(form)}`);
  return res;
}

test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = client();
  await signup(admin, '09350000009');
});
test.after(() => server.close());

test('apply() keeps every code/env default when nothing is saved', async () => {
  // A pristine copy of src/plans.js, as shipped.
  const plansPath = require.resolve('../src/plans');
  const current = require.cache[plansPath];
  delete require.cache[plansPath];
  const pristine = require('../src/plans');
  require.cache[plansPath] = current;

  settings.apply();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(PLANS)), JSON.parse(JSON.stringify(pristine.PLANS)));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(DURATIONS)), JSON.parse(JSON.stringify(pristine.DURATIONS)));
  for (const p of Object.values(PLANS)) {
    for (const k of ['name', 'priceMonthly', 'bots', 'faqs', 'answersPerMonth', 'pages', 'ai', 'badge', 'channels', 'export']) {
      assert.notStrictEqual(p[k], undefined, `${p.id}.${k}`);
    }
  }
  assert.strictEqual(config.siteName, 'پاسخ‌یار');
  assert.strictEqual(config.payment.mode, 'mock');
  assert.strictEqual(config.referral.commissionPercent, 25);

  // Saving a value then saving it empty goes back to the default.
  await save('plans', { 'plan.pro.faqs': '777' });
  assert.strictEqual(PLANS.pro.faqs, 777);
  await save('plans', { 'plan.pro.faqs': '' });
  assert.strictEqual(PLANS.pro.faqs, pristine.PLANS.pro.faqs);
  assert.strictEqual(settings.has('plan.pro.faqs'), false);
});

test('site name change shows on the home page immediately', async () => {
  await save('general', { siteName: 'بات‌یار تست' });
  const html = await client().text('/');
  assert.match(html, /<title>بات‌یار تست \|/);
  assert.match(html, /<span>بات‌یار تست<\/span>/);
  // {{site}} in content resolves lazily.
  assert.match(html, /بات‌یار تست چطور کار می‌کند؟/);
  assert.ok(!html.includes('{{site}}'));
  const demo = db.get().prepare(`SELECT name FROM bots WHERE public_key = 'sitedemo'`).get();
  assert.strictEqual(demo.name, 'دستیار بات‌یار تست');

  await save('general', { siteName: '' });
  assert.strictEqual(config.siteName, 'پاسخ‌یار');
  assert.match(await client().text('/'), /<title>پاسخ‌یار \|/);
});

test('hero texts are editable, *highlight* works and text is escaped', async () => {
  await save('home', { 'home.heroTitle': 'تست *برجسته* <b>x</b>', 'home.heroText': 'متن {{site}} <script>alert(1)</script>', 'home.heroButton': 'همین حالا شروع کن' });
  const html = await client().text('/');
  assert.match(html, /<h1>تست <span class="grad">برجسته<\/span> &lt;b&gt;x&lt;\/b&gt;<\/h1>/);
  assert.match(html, /متن پاسخ‌یار &lt;script&gt;/);
  assert.ok(!html.includes('<script>alert(1)'));
  assert.match(html, />همین حالا شروع کن<\/a>/);
  await admin.req('/admin/settings/home/reset', { method: 'POST', form: {} });
  assert.match(await client().text('/'), /<span class="grad">۲۴ ساعته<\/span>/);
});

test('announcement bar: on/off, escaped text, validated link', async () => {
  await save('general', { 'announce.enabled': '1', 'announce.text': 'تخفیف <i>ویژه</i>', 'announce.link': 'javascript:alert(1)' }, 400);
  assert.ok(!(await client().text('/pricing')).includes('announce-bar'));
  // Hidden "0" + ticked checkbox "1", exactly as the browser sends it.
  await save('general', [['announce.enabled', '0'], ['announce.enabled', '1'], ['announce.text', 'تخفیف <i>ویژه</i>'], ['announce.link', '/pricing']]);
  let html = await client().text('/pricing');
  assert.match(html, /class="announce-bar"[^]*href="\/pricing">تخفیف &lt;i&gt;ویژه&lt;\/i&gt;/);
  await save('general', { 'announce.enabled': '0' });
  html = await client().text('/pricing');
  assert.ok(!html.includes('announce-bar'));
});

test('plan price change updates /pricing and the checkout quote / order amount', async () => {
  await save('plans', { 'plan.pro.priceMonthly': '390000', 'duration.3.discountPercent': '25' });
  assert.strictEqual(PLANS.pro.priceMonthly, 390000);
  assert.strictEqual(DURATIONS.find(d => d.months === 3).discountPercent, 25);
  const pricing = await client().text('/pricing');
  assert.match(pricing, /۳۹۰٬۰۰۰ <small>تومان \/ ماه<\/small>/);
  assert.match(pricing, /۲۵٪ تخفیف/);

  const c = client();
  const user = await signup(c);
  assert.match(await c.text('/app/billing'), /۳۹۰٬۰۰۰ تومان/);
  let res = await c.req('/app/billing/checkout', { method: 'POST', form: { plan: 'pro', months: '1' } });
  assert.match(res.headers.get('location'), /^\/pay\/mock\//);
  let order = db.get().prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').get(user.id);
  assert.strictEqual(order.amount, 390000);
  res = await c.req('/app/billing/checkout', { method: 'POST', form: { plan: 'pro', months: '3' } });
  order = db.get().prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').get(user.id);
  assert.strictEqual(order.amount, 878000); // 390,000 × 3 − 25%, rounded to 1,000

  // Invalid input is rejected and nothing is saved.
  await save('plans', { 'plan.pro.priceMonthly': 'abc', 'plan.pro.faqs': '5' }, 400);
  await save('plans', { 'plan.pro.priceMonthly': '500' }, 400);
  await save('plans', { 'duration.12.discountPercent': '150' }, 400);
  assert.strictEqual(PLANS.pro.priceMonthly, 390000);
  assert.notStrictEqual(PLANS.pro.faqs, 5);
  assert.strictEqual(PLANS.free.priceMonthly, 0, 'the free plan price is not editable');
  await admin.req('/admin/settings/plans/reset', { method: 'POST', form: {} });
  assert.strictEqual(PLANS.pro.priceMonthly, 290000);
});

test('plan limits and switches apply live to existing users', async () => {
  const c = client();
  await signup(c);
  let res = await c.req('/app/bots/new', { method: 'POST', form: { name: 'بات', industry: '' } });
  const botId = Number(res.headers.get('location').match(/\/app\/bots\/(\d+)/)[1]);
  const bot = db.get().prepare('SELECT * FROM bots WHERE id = ?').get(botId);

  await save('plans', { 'plan.free.faqs': '5', 'plan.free.badge': '0' });
  const text = Array.from({ length: 8 }, (_, i) => `سؤال: سؤال شماره ${i}\nجواب: جواب ${i}`).join('\n');
  await c.req(`/app/bots/${botId}/faqs/import-text`, { method: 'POST', form: { text } });
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM faqs WHERE bot_id = ?').get(botId).n, 5);
  const cfg = await (await client().req(`/api/w/${bot.public_key}/config`)).json();
  assert.strictEqual(cfg.bot.badge.show, false);
  await admin.req('/admin/settings/plans/reset', { method: 'POST', form: {} });
  assert.strictEqual(PLANS.free.faqs, 30);
  assert.strictEqual(PLANS.free.badge, true);
});

test('referral percentages change the discount and the commission', async () => {
  await save('referral', { 'referral.commissionPercent': '40', 'referral.buyerDiscountPercent': '20', 'referral.minPayoutToman': '50٬000' });
  assert.strictEqual(config.referral.minPayoutToman, 50000);
  assert.match(await client().text('/affiliate'), /۴۰٪/);

  const aff = client();
  const affUser = await signup(aff);
  const buyer = client();
  await buyer.req(`/?ref=${affUser.ref_code}`);
  const buyerUser = await signup(buyer);
  assert.strictEqual(buyerUser.referred_by, affUser.id);
  await buyer.req('/app/billing/checkout', { method: 'POST', form: { plan: 'pro', months: '1' } });
  const order = db.get().prepare('SELECT * FROM orders WHERE user_id = ?').get(buyerUser.id);
  const baseAmount = priceToman('pro', 1);
  const discount = Math.round((baseAmount * 0.2) / 1000) * 1000;
  assert.strictEqual(order.discount, discount);
  assert.strictEqual(order.amount, baseAmount - discount);
  await buyer.req(`/pay/callback?Authority=${encodeURIComponent(order.authority)}&Status=OK`);
  const a = db.get().prepare('SELECT * FROM users WHERE id = ?').get(affUser.id);
  assert.strictEqual(a.balance, Math.floor(order.amount * 0.4));

  await save('referral', { 'referral.commissionPercent': '101' }, 400);
  await admin.req('/admin/settings/referral/reset', { method: 'POST', form: {} });
  assert.strictEqual(config.referral.commissionPercent, 25);
});

test('blog: create, rename, unpublish, delete — /blog, /blog/:slug and sitemap follow', async () => {
  const anon = client();
  const post = { orig: '', title: 'راهنمای تست مجله', slug: '', meta: 'یک توضیح کوتاه', date: '2026-09-20', minutes: '', body: '<p>سلام از {{site}}</p>', published: '1' };
  let res = await admin.req('/admin/settings/blog/save', { method: 'POST', form: post });
  assert.strictEqual(res.status, 302);
  const slug = 'راهنمای-تست-مجله';
  const url = `/blog/${encodeURIComponent(slug)}`;
  assert.match(await anon.text('/blog'), /راهنمای تست مجله/);
  res = await anon.req(url);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /<p>سلام از پاسخ‌یار<\/p>/);
  assert.ok((await anon.text('/sitemap.xml')).includes(encodeURIComponent(slug)));

  // Same slug again, or a built-in slug: refused.
  res = await admin.req('/admin/settings/blog/save', { method: 'POST', form: post });
  assert.strictEqual(res.status, 400);
  res = await admin.req('/admin/settings/blog/save', { method: 'POST', form: { ...post, slug: 'what-is-a-chatbot' } });
  assert.strictEqual(res.status, 400);

  // Edit: new title and a latin slug.
  res = await admin.req('/admin/settings/blog/save', { method: 'POST', form: { ...post, orig: slug, title: 'عنوان ویرایش‌شده', slug: 'Test Post' } });
  assert.strictEqual(res.status, 302);
  assert.strictEqual((await anon.req(url)).status, 404);
  res = await anon.req('/blog/test-post');
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /<h1>عنوان ویرایش‌شده<\/h1>/);
  assert.match(await anon.text('/sitemap.xml'), /\/blog\/test-post</);

  // Unpublish: hidden from visitors, previewable by the admin.
  await admin.req('/admin/settings/blog/publish', { method: 'POST', form: { slug: 'test-post', published: '0' } });
  assert.strictEqual((await anon.req('/blog/test-post')).status, 404);
  assert.ok(!(await anon.text('/blog')).includes('عنوان ویرایش‌شده'));
  assert.ok(!(await anon.text('/sitemap.xml')).includes('test-post'));
  const preview = await admin.req('/blog/test-post');
  assert.strictEqual(preview.status, 200);
  assert.match(await preview.text(), /noindex[^]*پیش‌نمایش/);

  await admin.req('/admin/settings/blog/delete', { method: 'POST', form: { slug: 'test-post' } });
  assert.strictEqual((await admin.req('/blog/test-post')).status, 404);
  assert.strictEqual(settings.posts.get('test-post'), undefined);
});

test('built-in posts can be edited, deleted and restored', async () => {
  const anon = client();
  const slug = 'what-is-a-chatbot';
  const original = builtinBlog.find(p => p.slug === slug);
  const list = await admin.text('/admin/settings/blog');
  assert.ok(list.includes(original.title), 'built-in posts are listed');

  let res = await admin.req('/admin/settings/blog/save', { method: 'POST', form: { orig: slug, title: 'چت‌بات چیست؟ نسخه‌ی تازه', slug: 'ignored-slug', meta: 'توضیح تازه', date: '2026-01-02', minutes: '3', body: '<p>متن تازه</p>', published: '1' } });
  assert.strictEqual(res.status, 302);
  res = await anon.req(`/blog/${slug}`);
  const html = await res.text();
  assert.match(html, /<h1>چت‌بات چیست؟ نسخه‌ی تازه<\/h1>/);
  assert.match(html, /<p>متن تازه<\/p>/);
  assert.strictEqual((await anon.req('/blog/ignored-slug')).status, 404, 'built-in slugs are fixed');

  await admin.req('/admin/settings/blog/delete', { method: 'POST', form: { slug } });
  assert.strictEqual((await anon.req(`/blog/${slug}`)).status, 404);
  assert.ok(!(await anon.text('/sitemap.xml')).includes(`/blog/${slug}<`));
  assert.ok(!(await anon.text('/blog')).includes('نسخه‌ی تازه'));

  await admin.req('/admin/settings/blog/restore', { method: 'POST', form: { slug } });
  res = await anon.req(`/blog/${slug}`);
  assert.strictEqual(res.status, 200);
  assert.ok((await res.text()).includes(original.title.replace(/\{\{site\}\}/g, 'پاسخ‌یار')));
});

test('site FAQ edit changes the home FAQ and the demo bot answer', async () => {
  const form = {
    count: '3',
    q_0: 'اپلیکیشن اندروید دارید؟', a_0: 'بله، اپ اندروید به‌زودی منتشر می‌شود. <b>قول</b>', pos_0: '2',
    q_1: 'چطور با {{site}} تماس بگیرم؟', a_1: 'از فرم تماس سایت.', pos_1: '1',
    q_2: 'این حذف می‌شود؟', a_2: 'بله', pos_2: '3', del_2: '1',
  };
  await save('faq', form);
  const html = await client().text('/');
  assert.ok(html.includes('<summary>اپلیکیشن اندروید دارید؟</summary>'));
  assert.ok(html.includes('&lt;b&gt;قول&lt;/b&gt;'));
  assert.ok(html.indexOf('چطور با پاسخ‌یار تماس بگیرم؟') < html.indexOf('اپلیکیشن اندروید دارید؟'), 'reordered');
  assert.ok(!html.includes('این حذف می‌شود؟'));
  assert.ok(!html.includes('پلن رایگان دارید؟'), 'old FAQ replaced');

  const res = await fetch(`${base}/api/w/sitedemo/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'اپلیکیشن اندروید دارید', sid: 'faq-test' }) });
  const ans = await res.json();
  assert.strictEqual(ans.type, 'answer');
  assert.match(ans.answer, /اپ اندروید/);

  // Incomplete rows are refused.
  await save('faq', { count: '1', q_0: 'بدون جواب', a_0: '' }, 400);
  await admin.req('/admin/settings/faq/reset', { method: 'POST', form: {} });
  assert.match(await client().text('/'), /پلن رایگان دارید؟/);
});

test('legal/about pages are editable and resettable', async () => {
  await admin.req('/admin/settings/pages', { method: 'POST', form: { key: 'terms', title: 'قوانین تازه', body: '<h2>بند ۱</h2><p>{{site}}</p>' } });
  const html = await client().text('/terms');
  assert.match(html, /<h1>قوانین تازه<\/h1>/);
  assert.match(html, /<h2>بند ۱<\/h2><p>پاسخ‌یار<\/p>/);
  await admin.req('/admin/settings/pages/reset', { method: 'POST', form: { key: 'terms' } });
  assert.match(await client().text('/terms'), /<h1>قوانین و مقررات استفاده<\/h1>/);
});

test('payment: mode switches live, merchant id is validated and masked', async () => {
  const c = client();
  const user = await signup(c);
  await c.req('/app/billing/checkout', { method: 'POST', form: { plan: 'pro', months: '1' } });
  const order = db.get().prepare('SELECT * FROM orders WHERE user_id = ?').get(user.id);
  assert.strictEqual((await c.req(`/pay/mock/${order.authority}`)).status, 200);

  await save('payment', { 'payment.mode': 'disabled' });
  assert.strictEqual(config.payment.mode, 'disabled');
  assert.strictEqual((await c.req(`/pay/mock/${order.authority}`)).status, 404, 'mock gateway gone at once');
  const res = await c.req('/app/billing/checkout', { method: 'POST', form: { plan: 'pro', months: '3' } });
  assert.strictEqual(res.headers.get('location'), '/app/billing');
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM orders WHERE user_id = ?').get(user.id).n, 1);

  await save('payment', { 'payment.merchant': 'not-a-merchant' }, 400);
  const merchant = '12345678-abcd-4bcd-8bcd-1234567890ab';
  await save('payment', { 'payment.mode': 'zarinpal', 'payment.merchant': merchant });
  assert.strictEqual(config.payment.merchant, merchant);
  assert.strictEqual(config.payment.mode, 'zarinpal');
  const page = await admin.text('/admin/settings/payment');
  assert.ok(!page.includes(merchant), 'merchant id is masked');
  assert.ok(page.includes('90ab'));
  // Empty merchant field keeps the saved one.
  await save('payment', { 'payment.merchant': '' });
  assert.strictEqual(config.payment.merchant, merchant);

  await admin.req('/admin/settings/payment/reset', { method: 'POST', form: {} });
  assert.strictEqual(config.payment.mode, 'mock');
  assert.strictEqual(config.payment.merchant, '');
  assert.strictEqual((await c.req(`/pay/mock/${order.authority}`)).status, 200);
});

test('mock payment is impossible with NODE_ENV=production', () => {
  const { resolvePaymentMode: r } = settings;
  const m = '12345678-abcd-4bcd-8bcd-1234567890ab';
  assert.strictEqual(r({ wanted: 'mock', merchant: '', isProd: true }), 'disabled');
  assert.strictEqual(r({ wanted: 'mock', merchant: m, isProd: true }), 'zarinpal');
  assert.strictEqual(r({ wanted: 'zarinpal', merchant: '', isProd: true }), 'disabled');
  assert.strictEqual(r({ wanted: 'sandbox', merchant: '', isProd: true }), 'disabled');
  assert.strictEqual(r({ wanted: 'sandbox', merchant: m, isProd: true }), 'sandbox');
  assert.strictEqual(r({ wanted: 'live', merchant: m, isProd: true }), 'zarinpal');
  assert.strictEqual(r({ wanted: '', merchant: '', isProd: true }), 'disabled');
  assert.strictEqual(r({ wanted: 'disabled', merchant: m, isProd: true }), 'disabled');
  assert.strictEqual(r({ wanted: '', merchant: '', isProd: false }), 'mock');
  assert.strictEqual(r({ wanted: '', merchant: m, isProd: false }), 'zarinpal');
  assert.strictEqual(r({ wanted: 'mock', merchant: m, isProd: false }), 'mock');

  // End to end in a production process: env AND saved setting both ask for mock.
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
    const settings = require('./src/settings');
    const config = require('./src/config');
    settings.apply();
    const before = config.payment.mode;
    const parsed = settings.parse('payment.mode', 'mock');
    require('./src/db').get().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('payment.mode', '\\"mock\\"', 0)").run();
    settings.invalidate(); settings.apply();
    process.stdout.write(JSON.stringify({ before, after: config.payment.mode, parseError: !!parsed.error }));
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', PAYMENT_MODE: 'mock', DB_FILE: ':memory:', ZARINPAL_MERCHANT: '' } }).toString();
  assert.deepStrictEqual(JSON.parse(out), { before: 'disabled', after: 'disabled', parseError: true });
});

test('AI settings: saved live, key masked, test-connection button', async () => {
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'qwen-test' }] }));
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const { model } = JSON.parse(body || '{}');
        if (model !== 'qwen-test') { res.statusCode = 404; return res.end('{}'); }
        return res.end(JSON.stringify({ choices: [{ message: { content: 'سلام' } }] }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const llmBase = `http://127.0.0.1:${fake.address().port}/v1`;
  try {
    const test = async form => (await admin.req('/admin/settings/ai/test', { method: 'POST', form, headers: { accept: 'application/json' } })).json();
    let t = await test({ 'llm.baseUrl': llmBase, 'llm.model': 'qwen-test' });
    assert.strictEqual(t.ok, true, t.message);
    assert.deepStrictEqual(t.models, ['qwen-test']);
    assert.strictEqual(t.reply, 'سلام');
    t = await test({ 'llm.baseUrl': llmBase, 'llm.model': 'nope' });
    assert.strictEqual(t.ok, false);
    assert.match(t.message, /nope/);
    t = await test({ 'llm.baseUrl': 'http://127.0.0.1:1/v1', 'llm.model': 'x' });
    assert.strictEqual(t.ok, false);
    t = await test({ 'llm.baseUrl': 'ftp://example.com' });
    assert.strictEqual(t.ok, false);

    await save('ai', { 'llm.baseUrl': 'not a url' }, 400);
    await save('ai', { 'llm.baseUrl': `${llmBase}/`, 'llm.model': 'qwen-test', 'llm.apiKey': 'sk-secret-123456789', 'llm.timeoutMs': '۲۰', 'llm.maxTokens': '400' });
    assert.strictEqual(config.llm.baseUrl, llmBase);
    assert.strictEqual(config.llm.model, 'qwen-test');
    assert.strictEqual(config.llm.apiKey, 'sk-secret-123456789');
    assert.strictEqual(config.llm.timeoutMs, 20000);
    assert.strictEqual(config.llm.maxTokens, 400);
    const page = await admin.text('/admin/settings/ai');
    assert.ok(!page.includes('sk-secret-123456789'), 'API key is masked');
    assert.match(page, /value="20"/, 'timeout shown in seconds');
    assert.match(await client().text('/pricing'), /پاسخ هوشمند با هوش مصنوعی/);

    await admin.req('/admin/settings/ai/reset', { method: 'POST', form: {} });
    assert.strictEqual(config.llm.baseUrl, '');
    assert.strictEqual(config.llm.apiKey, '');
    assert.ok(!(await client().text('/pricing')).includes('پاسخ هوشمند با هوش مصنوعی'));
  } finally {
    await new Promise(resolve => fake.close(resolve));
  }
});

test('every settings page renders for the admin', async () => {
  for (const p of ['general', 'home', 'plans', 'referral', 'payment', 'ai', 'faq', 'blog', 'blog/new', 'blog/edit?slug=what-is-a-chatbot', 'pages', 'pages?key=about']) {
    const res = await admin.req(`/admin/settings/${p}`);
    assert.strictEqual(res.status, 200, p);
    const html = await res.text();
    assert.match(html, /class="settings-tabs"/, p);
  }
  assert.strictEqual((await admin.req('/admin/settings')).headers.get('location'), '/admin/settings/general');
  assert.match(await admin.text('/admin'), /href="\/admin\/settings"/);
});

test('non-admins get 403 on every settings route', async () => {
  const c = client();
  await signup(c);
  const gets = ['', '/general', '/home', '/plans', '/referral', '/payment', '/ai', '/faq', '/blog', '/blog/new', '/blog/edit?slug=what-is-a-chatbot', '/pages'];
  const posts = ['/general', '/home', '/plans', '/referral', '/payment', '/ai', '/ai/test', '/faq', '/faq/reset', '/blog/save', '/blog/publish', '/blog/delete', '/blog/restore', '/pages', '/pages/reset',
    '/general/reset', '/home/reset', '/plans/reset', '/referral/reset', '/payment/reset', '/ai/reset'];
  for (const p of gets) assert.strictEqual((await c.req(`/admin/settings${p}`)).status, 403, `GET ${p}`);
  for (const p of posts) {
    const res = await c.req(`/admin/settings${p}`, { method: 'POST', form: { siteName: 'hacked', 'plan.pro.priceMonthly': '1000', slug: 'what-is-a-chatbot', key: 'terms', title: 'x', body: 'x' } });
    assert.strictEqual(res.status, 403, `POST ${p}`);
  }
  assert.strictEqual(config.siteName, 'پاسخ‌یار');
  assert.strictEqual(PLANS.pro.priceMonthly, 290000);
  // Anonymous visitors are sent to the login page.
  const anon = await client().req('/admin/settings/plans');
  assert.strictEqual(anon.status, 302);
  assert.match(anon.headers.get('location'), /^\/login/);
  // Cross-origin POSTs from the admin are refused too.
  const x = await admin.req('/admin/settings/general', { method: 'POST', form: { siteName: 'x' }, headers: { origin: 'https://evil.example' } });
  assert.strictEqual(x.status, 403);
});

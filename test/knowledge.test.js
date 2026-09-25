'use strict';
// Website knowledge: crawl a small in-memory site, answer from its text with
// a source link, and the dashboard page (owner-only).
process.env.DB_FILE = ':memory:';

const test = require('node:test');
const assert = require('node:assert');

let app, db, knowledge, bots, server, base;

const SITE = 'https://shop.example';
const layout = (title, main) => `<!doctype html><html lang="fa"><head><title>${title} | فروشگاه نمونه</title></head>
<body><header><nav><a href="/">خانه</a> <a href="/shipping/">ارسال</a> <a href="/returns/">مرجوعی</a> <a href="/cart/">سبد خرید</a></nav></header>
<main><article class="entry-content">${main}</article></main>
<aside class="sidebar widget">مطالب مرتبط: تخفیف ویژه‌ی تابستان</aside>
<footer>تمام حقوق محفوظ است. نماد اعتماد الکترونیکی</footer></body></html>`;
const PAGES = {
  '/robots.txt': 'User-agent: *\nDisallow: /cart/\nSitemap: https://shop.example/sitemap.xml',
  '/sitemap.xml': `<?xml version="1.0"?><urlset><url><loc>${SITE}/</loc></url><url><loc>${SITE}/shipping/</loc></url><url><loc>${SITE}/returns/</loc></url></urlset>`,
  '/': layout('خانه', '<h1>فروشگاه نمونه</h1><p>فروش آنلاین قهوه و دمنوش با بسته‌بندی بهداشتی. سفارش‌ها از طریق سایت ثبت می‌شوند.</p>'),
  '/shipping/': layout('شرایط ارسال', '<h1>شرایط ارسال</h1><h2>هزینه ارسال</h2><p>ارسال سفارش‌های بالای ۵۰۰ هزار تومان رایگان است. برای سفارش‌های کمتر، هزینه‌ی ارسال پستی ۴۵ هزار تومان است.</p><h2>زمان تحویل</h2><p>سفارش‌های تهران یک تا دو روز کاری و شهرستان‌ها دو تا چهار روز کاری بعد از ثبت تحویل داده می‌شوند.</p>'),
  '/returns/': layout('مرجوعی کالا', '<h1>مرجوعی کالا</h1><p>تا هفت روز بعد از دریافت، اگر بسته باز نشده باشد، می‌توانید کالا را مرجوع کنید. هزینه‌ی ارسال مرجوعی با مشتری است، مگر کالا معیوب باشد.</p>'),
  '/cart/': layout('سبد خرید', '<p>سبد خرید شما خالی است.</p>'),
};
const fakeFetch = async u => {
  const url = new URL(u);
  const body = PAGES[url.pathname];
  if (body === undefined) { const e = new Error('http_404'); e.code = 'http_404'; throw e; }
  return body;
};

test.before(async () => {
  app = require('../src/app');
  db = require('../src/db');
  knowledge = require('../src/knowledge');
  bots = require('../src/bots');
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function client() {
  const jar = {};
  return async (path, { method = 'GET', form, json } = {}) => {
    const h = {};
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
  await c('/signup', { method: 'POST', form: { name: 'صاحب فروشگاه', company: 'فروشگاه نمونه', phone, password: 'password123' } });
  const res = await c('/app/bots/new', { method: 'POST', form: { name: 'فروشگاه نمونه', industry: '' } });
  const botId = Number(res.headers.get('location').match(/\/app\/bots\/(\d+)/)[1]);
  return { c, bot: db.get().prepare('SELECT * FROM bots WHERE id = ?').get(botId) };
}

test('extraction keeps the main content and drops navigation, sidebar and footer', () => {
  const page = knowledge._internal.extractPage(PAGES['/shipping/'], `${SITE}/shipping/`);
  const text = JSON.stringify(page);
  assert.match(text, /۵۰۰ هزار تومان/);
  assert.doesNotMatch(text, /تمام حقوق محفوظ/);
  assert.doesNotMatch(text, /تخفیف ویژه/);
});

test('crawls a site, answers from its text with a source link, and rejects off-topic questions', async () => {
  const { c, bot } = await ownerWithBot('09141000001');
  const source = knowledge.startCrawl(bot, 'shop.example', { fetchForTestsOnly: fakeFetch });
  assert.strictEqual(source.status, 'crawling');
  await knowledge._internal.idle();
  const row = db.get().prepare('SELECT * FROM sources WHERE id = ?').get(source.id);
  assert.strictEqual(row.status, 'ready', row.error);
  assert.ok(row.pages >= 3);
  const urls = db.get().prepare('SELECT DISTINCT url FROM passages WHERE source_id = ?').all(source.id).map(r => r.url);
  assert.ok(!urls.some(u => u.includes('/cart/')), 'robots.txt disallowed page skipped');

  const top = knowledge.search(bot.id, 'هزینه ارسال چقدره؟', { limit: 3 })[0];
  assert.match(top.url, /\/shipping\/$/);
  assert.ok(top.score >= knowledge.THRESHOLDS.answer, `score ${top.score}`);
  assert.match(knowledge.snippet(top, 'هزینه ارسال چقدره؟', 400), /۵۰۰ هزار تومان/);

  const w = client();
  const r = await (await w(`/api/w/${bot.public_key}/ask`, { method: 'POST', json: { q: 'هزینه ارسال چقدره؟', sid: 'k1' } })).json();
  assert.strictEqual(r.type, 'answer');
  assert.strictEqual(r.kind, 'passage');
  assert.match(r.sources[0].url, /\/shipping\/$/);
  assert.strictEqual(db.get().prepare(`SELECT type FROM messages WHERE bot_id = ? ORDER BY id DESC`).get(bot.id).type, 'passage');

  const off = knowledge.search(bot.id, 'قیمت دلار امروز چنده', { limit: 1 })[0];
  assert.ok(!off || off.score < knowledge.THRESHOLDS.context, `off-topic scored ${off && off.score}`);

  // Dashboard: list + test box.
  const page = await (await c(`/app/bots/${bot.id}/knowledge?q=${encodeURIComponent('مرجوعی کالا')}`)).text();
  assert.match(page, /shop\.example/);
  assert.match(page, /هفت روز/);

  // Delete removes the passages.
  await c(`/app/bots/${bot.id}/knowledge/${source.id}/delete`, { method: 'POST', form: {} });
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM passages WHERE bot_id = ?').get(bot.id).n, 0);
});

test('bad URLs and other owners are refused', async () => {
  const { c, bot } = await ownerWithBot('09141000002');
  let res = await c(`/app/bots/${bot.id}/knowledge`, { method: 'POST', form: { url: 'javascript:alert(1)' } });
  assert.match(decodeURIComponent(res.headers.get('location')), /err=/);
  const other = await ownerWithBot('09141000003');
  res = await other.c(`/app/bots/${bot.id}/knowledge`);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/app');
});

'use strict';
// Reports page: SQL aggregation over seeded messages, HTTP access control,
// and the SVG chart helpers.
process.env.DB_FILE = ':memory:';
process.env.PAYMENT_MODE = 'mock';

const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const db = require('../src/db');
const bots = require('../src/bots');
const reports = require('../src/routes/reports');
const charts = require('../src/views/charts');
const { formatNumber, faDigits } = require('../src/util');

let server;
let base;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function client() {
  const jar = {};
  async function req(path, { method = 'GET', form } = {}) {
    const h = {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return res;
  }
  return { req };
}

async function signup(c, phone) {
  const res = await c.req('/signup', { method: 'POST', form: { name: 'کاربر تست', company: 'شرکت تست', phone, password: 'password123' } });
  assert.strictEqual(res.status, 302);
}

async function makeBot(c) {
  const res = await c.req('/app/bots/new', { method: 'POST', form: { name: 'بات گزارش', industry: '' } });
  assert.strictEqual(res.status, 302);
  const id = Number(res.headers.get('location').match(/\/app\/bots\/(\d+)/)[1]);
  return db.get().prepare('SELECT * FROM bots WHERE id = ?').get(id);
}

// Seeding helpers: timestamps in Tehran local time, `ago` whole days back.
const DAY = 86400000;
const HOUR = 3600000;
const OFF = reports.TEHRAN_OFFSET;
const today = Math.floor((Date.now() + OFF) / DAY);
const at = (ago, hour, minute = 15) => (today - ago) * DAY - OFF + hour * HOUR + minute * 60000;
const weekdayIndex = ago => (today - ago + 5) % 7; // Saturday = 0

function insert(botId, { ago, hour = 10, type, channel = 'web', question = 'سؤال', faqId = null, helpful = null, resolved = 0 }) {
  return db.get().prepare(`
    INSERT INTO messages (bot_id, session_id, channel, question, type, faq_id, score, helpful, resolved, created_at)
    VALUES (?, 's', ?, ?, ?, ?, 0.9, ?, ?, ?)
  `).run(botId, channel, question, type, faqId, helpful, resolved, at(ago, hour)).lastInsertRowid;
}

function kpi(html, label) {
  const re = new RegExp(`<div class="rp-kpi-label">${label}</div>\\s*<div class="rp-kpi-row"><span class="rp-kpi-value">([^<]*)</span>`);
  const m = html.match(re);
  assert.ok(m, `tile ${label}`);
  return m[1];
}

test('reports: aggregates the period, excludes test traffic, renders links', async () => {
  const c = client();
  await signup(c, '09127000001');
  const bot = await makeBot(c);
  bots.addFaq(bot.id, { question: 'هزینه ارسال چقدر است؟', answer: 'رایگان', alternates: [] });
  bots.addFaq(bot.id, { question: 'ساعت کاری؟', answer: '۹ تا ۵', alternates: [] });
  const [faq1, faq2] = db.get().prepare('SELECT id FROM faqs WHERE bot_id = ? ORDER BY id').all(bot.id).map(r => r.id);

  // Current 30-day period: 11 questions.
  insert(bot.id, { ago: 0, hour: 10, type: 'answer', faqId: faq1, helpful: 1 });
  insert(bot.id, { ago: 0, hour: 10, type: 'answer', faqId: faq1, helpful: 1 });
  insert(bot.id, { ago: 0, hour: 10, type: 'answer', faqId: faq1, helpful: 0, channel: 'page' });
  insert(bot.id, { ago: 0, hour: 10, type: 'passage', channel: 'bale' });
  insert(bot.id, { ago: 0, hour: 10, type: 'ai', helpful: 1, channel: 'telegram' });
  insert(bot.id, { ago: 2, hour: 21, type: 'answer', faqId: faq2 });
  insert(bot.id, { ago: 2, hour: 21, type: 'suggest', question: 'ارسال به کیش دارید؟' });
  const kishId = insert(bot.id, { ago: 2, hour: 22, type: 'fallback', question: 'ارسال به كيش داريد' }); // Arabic letters: same after normalize
  insert(bot.id, { ago: 5, hour: 9, type: 'fallback', question: 'ارسال به کیش دارید؟', resolved: 1 });
  insert(bot.id, { ago: 5, hour: 9, type: 'limit', question: '<script>alert(1)</script>' });
  insert(bot.id, { ago: 6, hour: 9, type: 'fallback', question: '<b>پارکینگ</b> دارید؟' });
  // Test console: never counted.
  for (let i = 0; i < 4; i++) insert(bot.id, { ago: 0, hour: 11, type: 'fallback', channel: 'test' });
  // Previous 30-day period: 4 questions (2 answered).
  insert(bot.id, { ago: 31, type: 'answer', faqId: faq2, helpful: 1 });
  insert(bot.id, { ago: 40, type: 'answer', faqId: faq2, helpful: 1 });
  insert(bot.id, { ago: 45, type: 'fallback' });
  insert(bot.id, { ago: 59, type: 'suggest' });
  // Older than both periods, visible only in the 90-day view.
  insert(bot.id, { ago: 75, type: 'answer', faqId: faq1 });

  const lead = db.get().prepare('INSERT INTO leads (bot_id, name, phone, status, created_at) VALUES (?, ?, ?, ?, ?)');
  lead.run(bot.id, 'الف', '09120000001', 'new', at(1, 12));
  lead.run(bot.id, 'ب', '09120000002', 'done', at(3, 12));
  lead.run(bot.id, 'پ', '09120000003', 'done', at(35, 12));
  const conv = db.get().prepare('INSERT INTO conversations (bot_id, session_id, channel, mode, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)');
  conv.run(bot.id, 'h1', 'web', 'human', at(1, 12), at(1, 12));
  const c2 = conv.run(bot.id, 'h2', 'web', 'bot', at(2, 12), at(2, 13)).lastInsertRowid;
  db.get().prepare('INSERT INTO chat_messages (conversation_id, sender, text, created_at) VALUES (?, ?, ?, ?)').run(c2, 'operator', 'سلام', at(2, 13));
  conv.run(bot.id, 'h3', 'test', 'human', at(1, 12), at(1, 12));
  conv.run(bot.id, 'h4', 'web', 'human', at(50, 12), at(50, 12));

  // Aggregation.
  const d = reports.collect(bot.id, 30);
  assert.strictEqual(d.daily.length, 30);
  assert.strictEqual(d.daily[29].d, today);
  assert.deepStrictEqual(
    { total: d.current.total, auto: d.current.auto, faq: d.current.faq, passage: d.current.passage, ai: d.current.ai, suggested: d.current.suggested, missed: d.current.missed, up: d.current.up, rated: d.current.rated },
    { total: 11, auto: 6, faq: 4, passage: 1, ai: 1, suggested: 1, missed: 4, up: 3, rated: 4 },
  );
  assert.deepStrictEqual({ total: d.previous.total, auto: d.previous.auto, missed: d.previous.missed }, { total: 4, auto: 2, missed: 1 });
  assert.strictEqual(d.daily[29].auto, 5);
  assert.strictEqual(d.daily[27].total, 3);
  assert.strictEqual(d.daily.reduce((a, x) => a + x.total, 0), 11);
  assert.strictEqual(d.heat[weekdayIndex(0)][10], 5);
  assert.strictEqual(d.heat[weekdayIndex(2)][21], 2);
  assert.strictEqual(d.heat.flat().reduce((a, v) => a + v, 0), 11);
  assert.deepStrictEqual({ current: d.leads.current, previous: d.leads.previous, open: d.leads.open }, { current: 2, previous: 1, open: 1 });
  assert.strictEqual(d.handoffs, 2);
  assert.deepStrictEqual(d.channels.map(ch => [ch.id, ch.total]), [['web', 8], ['page', 1], ['bale', 1], ['telegram', 1]]);
  assert.deepStrictEqual(d.topAnswered.map(f => [f.id, f.n, f.up, f.down]), [[faq1, 3, 2, 1], [faq2, 1, 0, 0]]);
  // Suggest + fallback grouped by normalized text; resolved rows count but the
  // link points at the newest still-open message.
  assert.strictEqual(d.topMissed[0].n, 3);
  assert.strictEqual(d.topMissed[0].openId, Number(kishId));
  assert.ok(!d.topMissed.some(g => g.question.includes('script')), 'limit rows are not "unanswered" questions');

  // Page over HTTP.
  let res = await c.req(`/app/bots/${bot.id}/reports`);
  assert.strictEqual(res.status, 200);
  let html = await res.text();
  assert.strictEqual(kpi(html, 'سؤال دریافتی'), formatNumber(11));
  assert.strictEqual(kpi(html, 'پاسخ خودکار'), `${faDigits(55)}٪`); // 6 / 11
  assert.strictEqual(kpi(html, 'بی‌جواب ماند'), formatNumber(4));
  assert.strictEqual(kpi(html, 'درخواست تماس'), formatNumber(2));
  assert.strictEqual(kpi(html, 'رضایت از پاسخ‌ها'), `${faDigits(75)}٪`); // 3 / 4
  assert.match(html, /۱۷۵٪/, 'questions vs previous period: 11 vs 4');
  assert.match(html, /aria-current="page">۳۰ روز/);
  assert.match(html, new RegExp(`/app/bots/${bot.id}/faqs#faq-${faq1}`));
  assert.match(html, new RegExp(`/app/bots/${bot.id}/inbox#m-${kishId}`));
  assert.match(html, /&lt;b&gt;پارکینگ&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>پارکینگ/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  assert.match(html, /\/js\/reports\.js/);
  assert.match(html, /class="viz viz-cols"/);
  assert.strictEqual((html.match(/class="viz-cell"/g) || []).length, 7 * 24);

  // Period switch.
  res = await c.req(`/app/bots/${bot.id}/reports?days=7`);
  html = await res.text();
  assert.strictEqual(kpi(html, 'سؤال دریافتی'), formatNumber(11));
  assert.strictEqual(reports.collect(bot.id, 7).previous.total, 0);
  res = await c.req(`/app/bots/${bot.id}/reports?days=90`);
  html = await res.text();
  assert.strictEqual(kpi(html, 'سؤال دریافتی'), formatNumber(16));
  res = await c.req(`/app/bots/${bot.id}/reports?days=12345`);
  html = await res.text();
  assert.match(html, /aria-current="page">۳۰ روز/, 'unknown period falls back to 30 days');

  // Another user can't see it; a visitor must log in.
  const other = client();
  await signup(other, '09127000002');
  res = await other.req(`/app/bots/${bot.id}/reports`);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/app');
  assert.doesNotMatch(await res.text(), /کیش/);
  res = await client().req(`/app/bots/${bot.id}/reports`);
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login/);
});

test('reports: empty states', async () => {
  const c = client();
  await signup(c, '09127000003');
  const bot = await makeBot(c);
  insert(bot.id, { ago: 0, type: 'fallback', channel: 'test' }); // test console only
  let res = await c.req(`/app/bots/${bot.id}/reports`);
  assert.strictEqual(res.status, 200);
  let html = await res.text();
  assert.match(html, /هنوز گزارشی برای نمایش نیست/);
  assert.doesNotMatch(html, /class="rp-kpis"/);

  // Used before, quiet in this period: full layout with zeros and a hint.
  insert(bot.id, { ago: 50, type: 'answer' });
  res = await c.req(`/app/bots/${bot.id}/reports?days=7`);
  html = await res.text();
  assert.match(html, /در ۷ روز اخیر سؤالی ثبت نشده/);
  assert.strictEqual(kpi(html, 'سؤال دریافتی'), formatNumber(0));
  assert.strictEqual(kpi(html, 'پاسخ خودکار'), '—');
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

// ---- Chart helpers ------------------------------------------------------------

// Tag balance check (enough to catch broken markup from the template strings).
function assertWellFormed(markup) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const voids = new Set(['br', 'img', 'input', 'meta', 'link', 'hr']);
  let m;
  while ((m = re.exec(markup))) {
    const [, close, name, , self] = m;
    if (self || voids.has(name)) continue;
    if (close) assert.strictEqual(stack.pop(), name, `unexpected </${name}>`);
    else stack.push(name);
  }
  assert.deepStrictEqual(stack, [], 'unclosed tags');
}

// Every numeric geometry attribute: finite, percentages within [0, 100],
// pixel values within [0, maxY] for vertical attributes.
function assertBounds(markup, maxY) {
  assert.doesNotMatch(markup, /NaN|Infinity|undefined|null/);
  for (const m of markup.matchAll(/\s(x|x1|x2|cx|width)="([^"]*)"/g)) {
    const v = m[2];
    if (v.endsWith('%')) {
      const n = Number(v.slice(0, -1));
      assert.ok(Number.isFinite(n) && n >= 0 && n <= 100, `${m[1]}=${v}`);
    } else {
      assert.ok(Number.isFinite(Number(v)) && Number(v) >= 0, `${m[1]}=${v}`);
    }
  }
  for (const m of markup.matchAll(/\s(y|y1|y2|cy|height)="([^"]*)"/g)) {
    const n = Number(m[2]);
    assert.ok(Number.isFinite(n) && n >= 0 && n <= maxY, `${m[1]}=${m[2]}`);
  }
}

const SERIES = [{ label: 'a', color: 'var(--a)' }, { label: 'b', color: '#f59e0b' }];

test('charts: niceScale picks clean integer ticks', () => {
  assert.deepStrictEqual(charts.niceScale(0).ticks, [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(charts.niceScale(41), { max: 50, step: 10, ticks: [0, 10, 20, 30, 40, 50] });
  assert.deepStrictEqual(charts.niceScale(1).ticks, [0, 1]);
  for (const v of [1, 2, 3, 7, 13, 99, 101, 1234, 98765]) {
    const s = charts.niceScale(v);
    assert.ok(s.max >= v && Number.isInteger(s.step) && s.step >= 1, `max for ${v}`);
    assert.ok(s.ticks.length >= 2 && s.ticks.length <= 7);
    assert.strictEqual(s.ticks[s.ticks.length - 1], s.max);
  }
});

test('charts: column chart is valid SVG within bounds', () => {
  for (const n of [1, 7, 30, 90]) {
    const slots = Array.from({ length: n }, (_, i) => ({ values: [i % 7, (i * 3) % 5], tick: i % 5 === 0, label: String(i), sub: 'مهر', tip: { t: `روز ${i}`, r: [['a', String(i)]] } }));
    const html = charts.columnChart({ slots, series: SERIES, height: 180, ariaLabel: 'test' });
    assertWellFormed(html);
    const h = Number(html.match(/<svg class="viz-svg" width="100%" height="(\d+)"/)[1]);
    assertBounds(html, h);
    assert.strictEqual((html.match(/class="viz-col"/g) || []).length, n);
  }
  // RTL: the first (oldest) slot sits at the right edge.
  const two = charts.columnChart({ slots: [{ values: [1, 0] }, { values: [2, 0] }], series: SERIES });
  const hits = [...two.matchAll(/class="viz-hit" x="([\d.]+)%"/g)].map(m => Number(m[1]));
  assert.deepStrictEqual(hits, [50, 0]);
});

test('charts: all-zero and empty data render without marks or NaN', () => {
  const zero = charts.columnChart({ slots: Array.from({ length: 30 }, () => ({ values: [0, 0] })), series: SERIES });
  assertWellFormed(zero);
  assertBounds(zero, 300);
  assert.doesNotMatch(zero, /class="viz-bar"/);
  assert.doesNotMatch(zero, /class="viz-peak"/);

  const none = charts.columnChart({ slots: [], series: SERIES });
  assertWellFormed(none);
  assertBounds(none, 300);

  const heat = charts.heatmap({
    rows: [{ label: 'شنبه' }, { label: 'یکشنبه' }],
    cols: Array.from({ length: 24 }, (_, h) => ({ tick: h % 3 ? '' : String(h) })),
    values: [new Array(24).fill(0), new Array(24).fill(0)],
    ramp: ['#1', '#2', '#3'], empty: '#e',
  });
  assertWellFormed(heat);
  assertBounds(heat, 200);
  assert.strictEqual((heat.match(/fill:#e"/g) || []).length, 48);

  for (const spark of [charts.sparkline([0, 0, 0, 0]), charts.sparkline([NaN, 'x', -3, 5])]) {
    assertWellFormed(spark);
    assert.doesNotMatch(spark, /NaN|Infinity/);
  }
  assert.strictEqual(charts.sparkline([5]), '');

  const share = charts.shareBar([{ value: 0, color: '#a' }, { value: 0, color: '#b' }]);
  assertWellFormed(share);
  assertBounds(share, 50);
  assert.doesNotMatch(share, /class="viz-seg"/);

  for (const f of [0, 0.5, 1, 7, -2, NaN]) {
    const m = charts.meter(f);
    assertWellFormed(m);
    assertBounds(m, 10);
  }
  assertBounds(charts.hbar(0, 0), 10);
});

test('charts: heatmap bins, share bar widths, escaping', () => {
  const values = [[0, 1, 5, 10], [2, 0, 0, 10]];
  const heat = charts.heatmap({
    rows: [{ label: 'a' }, { label: 'b' }], cols: [{}, {}, {}, {}], values,
    ramp: ['#r1', '#r2', '#r3', '#r4', '#r5'], empty: '#e',
    tip: (r, c, v) => ({ t: `<${r},${c}>`, r: [['n', String(v)]] }),
  });
  assertWellFormed(heat);
  const fills = [...heat.matchAll(/data-kx="(\d)" data-ky="(\d)"[^>]*style="fill:([^"]+)"/g)].map(m => [Number(m[2]), Number(m[1]), m[3]]);
  const fillAt = (r, c) => fills.find(f => f[0] === r && f[1] === c)[2];
  assert.strictEqual(fillAt(0, 0), '#e');
  assert.strictEqual(fillAt(0, 1), '#r1');
  assert.strictEqual(fillAt(0, 2), '#r3');
  assert.strictEqual(fillAt(0, 3), '#r5');
  assert.strictEqual(fillAt(1, 3), '#r5');
  assert.doesNotMatch(heat, /<0,0>/, 'tooltip text is escaped');
  assert.match(heat, /&lt;0,0&gt;/);

  const share = charts.shareBar([{ value: 3, color: '#a' }, { value: 0, color: '#b' }, { value: 1, color: '#c' }]);
  const widths = [...share.matchAll(/class="viz-seg"[^>]*width="([\d.]+)%"/g)].map(m => Number(m[1]));
  assert.deepStrictEqual(widths, [75, 25]);
  const xs = [...share.matchAll(/class="viz-seg"[^>]*x="([\d.]+)%"/g)].map(m => Number(m[1]));
  assert.deepStrictEqual(xs, [25, 0], 'first part starts at the right edge');

  const legend = charts.legend([{ label: '<i>x</i>', color: 'red', value: '۳' }]);
  assert.match(legend, /&lt;i&gt;x&lt;\/i&gt;/);
  const table = charts.tableView({ head: ['a', 'b'], rows: [['<x>', '1']] });
  assertWellFormed(table);
  assert.match(table, /&lt;x&gt;/);
});

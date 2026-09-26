'use strict';
// Site-owner settings ("CMS-lite"), edited at /admin/settings.
//
// Values live in the `settings` table as key -> JSON and overlay the env/code
// defaults (src/config.js, src/plans.js) IN PLACE: apply() writes into the
// very `config`, `PLANS` and `DURATIONS` objects every module already holds,
// so a change shows up on the next request without a restart.
//
// An absent key means "use the default". Saving a field empty, or equal to
// its default, deletes the key, so env vars and code keep working as before.
const db = require('./db');
const config = require('./config');
const { PLANS, DURATIONS } = require('./plans');
const { enDigits, faDigits } = require('./util');

const clone = v => JSON.parse(JSON.stringify(v));

if (!config.llm) config.llm = { baseUrl: '', model: '', apiKey: '', timeoutMs: 30000, maxTokens: 350 };

// ---- Defaults: whatever env / code said when the process started -------------------

const D = {
  siteName: config.siteName,
  siteNameEn: config.siteNameEn,
  supportPhone: config.supportPhone,
  supportEmail: config.supportEmail,
  supportTelegram: config.supportTelegram,
  trustBadgesHtml: config.trustBadgesHtml,
  paymentWanted: process.env.PAYMENT_MODE || '',
  merchant: config.payment.merchant,
  referral: clone(config.referral),
  llm: clone(config.llm),
  plans: clone(PLANS),
  durations: clone(DURATIONS),
};

const HOME_DEFAULTS = {
  heroTitle: 'به سؤال‌های تکراری مشتری‌ها *۲۴ ساعته* جواب بدهید، بدون استخدام اپراتور',
  heroText: 'سؤال و جواب‌هایتان را وارد کنید، یک خط کد در سایتتان بگذارید و تمام. {{site}} هر روز و هر ساعت، فقط با پاسخ‌های تأییدشده‌ی خودتان جواب مشتری‌ها را می‌دهد و هر سؤالی را که بلد نیست برایتان جمع می‌کند.',
  heroButton: 'ساخت چت‌بات رایگان',
  seoTitle: '{{site}} | چت بات پاسخگوی خودکار فارسی برای سایت و بله',
  seoDescription: 'چت بات فارسی که ۲۴ ساعته و بدون اپراتور به سؤال‌های تکراری مشتری‌های سایت شما جواب می‌دهد. نصب در ۵ دقیقه، پلن رایگان، مخصوص کسب‌وکارهای ایرانی.',
};

// ---- Field registry: type, limits, default and (optionally) where apply() writes ----
// Types: text | html | int | bool | enum | url | link | email | secret.
// int fields may have `scale` (stored = shown × scale, e.g. seconds -> ms).

const FIELDS = new Map();
function field(key, spec) {
  FIELDS.set(key, { ...spec, key });
}

field('siteName', { type: 'text', max: 60, default: D.siteName, target: [config, 'siteName'] });
field('siteNameEn', { type: 'text', max: 60, default: D.siteNameEn, target: [config, 'siteNameEn'] });
field('supportPhone', { type: 'text', max: 40, default: D.supportPhone, target: [config, 'supportPhone'] });
field('supportEmail', { type: 'email', max: 120, default: D.supportEmail, target: [config, 'supportEmail'] });
field('supportTelegram', { type: 'text', max: 80, default: D.supportTelegram, target: [config, 'supportTelegram'] });
field('trustBadgesHtml', { type: 'html', max: 20000, default: D.trustBadgesHtml, target: [config, 'trustBadgesHtml'] });

field('announce.enabled', { type: 'bool', default: false });
field('announce.text', { type: 'text', max: 200, default: '' });
field('announce.link', { type: 'link', max: 500, default: '' });

field('home.heroTitle', { type: 'text', max: 200, default: HOME_DEFAULTS.heroTitle });
field('home.heroText', { type: 'text', max: 700, default: HOME_DEFAULTS.heroText });
field('home.heroButton', { type: 'text', max: 40, default: HOME_DEFAULTS.heroButton });
field('home.seoTitle', { type: 'text', max: 120, default: HOME_DEFAULTS.seoTitle });
field('home.seoDescription', { type: 'text', max: 320, default: HOME_DEFAULTS.seoDescription });

// `prop` = the property on the PLANS entry.
const PLAN_FIELDS = [
  { prop: 'name', type: 'text', max: 40, label: 'نام پلن' },
  { prop: 'priceMonthly', type: 'int', min: 1000, max: 10_000_000_000, label: 'قیمت ماهانه (تومان)', paidOnly: true },
  { prop: 'bots', type: 'int', min: 1, max: 1000, label: 'تعداد بات' },
  { prop: 'faqs', type: 'int', min: 0, max: 1_000_000, label: 'تعداد سؤال و جواب' },
  { prop: 'answersPerMonth', type: 'int', min: 0, max: 100_000_000, label: 'پاسخ در ماه' },
  { prop: 'pages', type: 'int', min: 0, max: 1_000_000, label: 'صفحه‌های سایت (یادگیری از سایت)' },
  { prop: 'ai', type: 'bool', label: 'پاسخ با هوش مصنوعی' },
  { prop: 'channels', type: 'bool', label: 'اتصال به بله و تلگرام' },
  { prop: 'export', type: 'bool', label: 'خروجی اکسل' },
  { prop: 'badge', type: 'bool', label: 'نمایش نشان «قدرت‌گرفته از» در ویجت' },
];
for (const [id, plan] of Object.entries(PLANS)) {
  for (const f of PLAN_FIELDS) {
    // The free plan must stay free: billing treats price 0 as "not purchasable".
    if (f.paidOnly && id === 'free') continue;
    if (!(f.prop in D.plans[id])) continue;
    field(`plan.${id}.${f.prop}`, { ...f, default: D.plans[id][f.prop], target: [plan, f.prop] });
  }
}
for (const d of DURATIONS) {
  const def = D.durations.find(x => x.months === d.months);
  // Capped below 100 so a price can never round down to zero.
  field(`duration.${d.months}.discountPercent`, { type: 'int', min: 0, max: 90, default: def.discountPercent, target: [d, 'discountPercent'] });
}

field('referral.commissionPercent', { type: 'int', min: 0, max: 100, default: D.referral.commissionPercent, target: [config.referral, 'commissionPercent'] });
field('referral.buyerDiscountPercent', { type: 'int', min: 0, max: 90, default: D.referral.buyerDiscountPercent, target: [config.referral, 'buyerDiscountPercent'] });
field('referral.minPayoutToman', { type: 'int', min: 0, max: 1_000_000_000, default: D.referral.minPayoutToman, target: [config.referral, 'minPayoutToman'] });

const PAYMENT_MODES = ['zarinpal', 'sandbox', 'disabled', 'mock'];
field('payment.mode', { type: 'enum', values: PAYMENT_MODES, default: '' });
field('payment.merchant', { type: 'secret', max: 64, pattern: /^[A-Za-z0-9-]{36}$/, patternError: 'مرچنت کد زرین‌پال ۳۶ نویسه است (مثل xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).', default: D.merchant, target: [config.payment, 'merchant'] });

field('llm.baseUrl', { type: 'url', max: 300, default: D.llm.baseUrl, target: [config.llm, 'baseUrl'] });
field('llm.model', { type: 'text', max: 150, default: D.llm.model, target: [config.llm, 'model'] });
field('llm.apiKey', { type: 'secret', max: 400, default: D.llm.apiKey, target: [config.llm, 'apiKey'] });
field('llm.timeoutMs', { type: 'int', scale: 1000, min: 1000, max: 600_000, default: D.llm.timeoutMs, target: [config.llm, 'timeoutMs'] });
field('llm.maxTokens', { type: 'int', min: 16, max: 16_384, default: D.llm.maxTokens, target: [config.llm, 'maxTokens'] });

// ---- Storage with an in-memory cache ------------------------------------------------

let cache = null;
let cacheConn = null;
let ver = 0;

function load() {
  const conn = db.get();
  if (cache && cacheConn === conn) return cache;
  const map = new Map();
  for (const row of conn.prepare('SELECT key, value FROM settings').all()) {
    try { map.set(row.key, JSON.parse(row.value)); } catch { /* skip a corrupt row */ }
  }
  cache = map;
  cacheConn = conn;
  ver++;
  return cache;
}

function invalidate() {
  cache = null;
  ver++;
}

// Bumped on every write; content caches key on it.
function version() {
  load();
  return ver;
}

function get(key, fallback) {
  const c = load();
  return c.has(key) ? c.get(key) : fallback;
}

function has(key) {
  return load().has(key);
}

function validStored(f, v) {
  switch (f.type) {
    case 'bool': return typeof v === 'boolean';
    case 'int': return Number.isInteger(v) && v >= (f.min ?? 0) && v <= (f.max ?? Number.MAX_SAFE_INTEGER);
    case 'enum': return f.values.includes(v);
    default: return typeof v === 'string';
  }
}

// Effective value of a registry field: the saved one if valid, else the default.
function value(key, map) {
  const f = FIELDS.get(key);
  const c = map || load();
  if (!f) return c.get(key);
  if (c.has(key) && validStored(f, c.get(key))) return c.get(key);
  return f.default;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// changes: { key: value } — null (or '') deletes the key (= use default),
// undefined leaves it untouched. Registry values equal to their default are
// deleted too, so a later env/code change still flows through.
function save(changes) {
  const conn = db.get();
  const del = conn.prepare('DELETE FROM settings WHERE key = ?');
  const put = conn.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  conn.transaction(() => {
    for (const [key, v] of Object.entries(changes)) {
      if (v === undefined) continue;
      const f = FIELDS.get(key);
      if (v === null || v === '' || (f && sameValue(v, f.default))) del.run(key);
      else put.run(key, JSON.stringify(v), Date.now());
    }
  })();
  invalidate();
  apply();
}

function set(key, v) {
  save({ [key]: v === undefined ? null : v });
}

// ---- Form parsing / validation (used by the admin routes) ---------------------------
// -> { value } (null = use default, undefined = leave unchanged) | { error }

function parse(key, raw) {
  const f = FIELDS.get(key);
  if (!f) return { error: 'فیلد ناشناخته' };
  if (Array.isArray(raw)) raw = raw[raw.length - 1]; // hidden "0" + checkbox "1" pairs
  const s = raw === undefined || raw === null ? '' : String(raw);
  const t = s.trim();
  if (f.type !== 'bool' && f.type !== 'int' && f.max && t.length > f.max) {
    return { error: `حداکثر ${faDigits(f.max)} نویسه.` };
  }
  switch (f.type) {
    case 'bool':
      return { value: t === '1' || t === 'on' || t === 'true' };
    case 'int': {
      const n0 = enDigits(t).replace(/[\s,٬،_]/g, '');
      if (!n0) return { value: null };
      if (!/^\d+$/.test(n0)) return { error: 'یک عدد صحیح و مثبت وارد کنید.' };
      const scale = f.scale || 1;
      const n = Number(n0) * scale;
      if (n < (f.min ?? 0)) return { error: `حداقل ${faDigits(Math.ceil((f.min ?? 0) / scale))} است.` };
      if (n > (f.max ?? Number.MAX_SAFE_INTEGER)) return { error: `حداکثر ${faDigits(Math.floor(f.max / scale))} است.` };
      return { value: n };
    }
    case 'enum':
      if (!t) return { value: null };
      if (!f.values.includes(t)) return { error: 'گزینه‌ی نامعتبر.' };
      if (key === 'payment.mode' && t === 'mock' && config.isProd) return { error: 'درگاه ساختگی روی سرور اصلی مجاز نیست.' };
      return { value: t };
    case 'url': {
      if (!t) return { value: null };
      let u;
      try { u = new URL(t); } catch { return { error: 'آدرس کامل وارد کنید؛ مثلاً http://127.0.0.1:11434/v1' }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'آدرس باید با http:// یا https:// شروع شود.' };
      if (u.username || u.password) return { error: 'نام کاربری و رمز را داخل آدرس نگذارید؛ از «کلید دسترسی» استفاده کنید.' };
      return { value: t.replace(/\/+$/, '') };
    }
    case 'link':
      if (!t) return { value: null };
      if (/^\/(?!\/)/.test(t)) return { value: t };
      try {
        const u = new URL(t);
        if (u.protocol === 'http:' || u.protocol === 'https:') return { value: t };
      } catch { /* fallthrough */ }
      return { error: 'لینک باید با / (صفحه‌ای از همین سایت) یا https:// شروع شود.' };
    case 'email':
      if (!t) return { value: null };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { error: 'ایمیل معتبر نیست.' };
      return { value: t };
    case 'secret':
      if (!t) return { value: undefined }; // empty = keep the current secret
      if (f.pattern && !f.pattern.test(t)) return { error: f.patternError || 'مقدار معتبر نیست.' };
      return { value: t };
    case 'html':
      return { value: t || null };
    default:
      return { value: t || null };
  }
}

// ---- Payment mode resolution ---------------------------------------------------------
//   zarinpal - live gateway          sandbox - Zarinpal sandbox
//   mock     - fake local gateway (development only, NEVER in production)
//   disabled - checkout shows "coming soon"
// In production a missing merchant id always means 'disabled'.
function resolvePaymentMode({ wanted, merchant, isProd }) {
  let m = String(wanted || '').trim().toLowerCase();
  if (m === 'live') m = 'zarinpal';
  if (m === 'mock' && isProd) m = '';
  if (!PAYMENT_MODES.includes(m)) m = merchant ? 'zarinpal' : (isProd ? 'disabled' : 'mock');
  if (isProd && !merchant) m = 'disabled';
  return m;
}

function paymentStatus() {
  const wanted = value('payment.mode') || '';
  return {
    wanted,
    envWanted: D.paymentWanted,
    effective: config.payment.mode,
    hasMerchant: !!config.payment.merchant,
    isProd: config.isProd,
  };
}

// ---- apply(): overlay saved values onto the shared objects, in place ----------------

function apply() {
  let map;
  try {
    map = load();
  } catch (e) {
    console.error('settings: could not read saved settings, using defaults:', e.message);
    map = new Map();
  }
  for (const f of FIELDS.values()) {
    if (!f.target) continue;
    const [obj, prop] = f.target;
    const v = value(f.key, map);
    obj[prop] = v === undefined ? f.default : v;
  }
  config.payment.mode = resolvePaymentMode({
    wanted: value('payment.mode', map) || D.paymentWanted,
    merchant: config.payment.merchant,
    isProd: config.isProd,
  });
}

function announcement() {
  const enabled = value('announce.enabled');
  const text = value('announce.text');
  return { enabled: !!(enabled && text), text, link: value('announce.link') };
}

// ---- Blog posts written / edited in the admin panel ---------------------------------
// A row whose slug matches a built-in post (src/content/blog.js) replaces it;
// deleted = 1 on such a row is a tombstone that hides the built-in post.

const posts = {
  all() {
    return db.get().prepare('SELECT * FROM posts ORDER BY date DESC, id DESC').all();
  },
  get(slug) {
    return db.get().prepare('SELECT * FROM posts WHERE slug = ?').get(String(slug || ''));
  },
  // data: { slug, title, metaDescription, bodyHtml, date, readingMinutes, published }
  save(data, origSlug = null) {
    const conn = db.get();
    const now = Date.now();
    conn.transaction(() => {
      const existing = conn.prepare('SELECT * FROM posts WHERE slug = ?').get(origSlug || data.slug);
      if (existing) {
        conn.prepare(`UPDATE posts SET slug = ?, title = ?, meta_description = ?, body_html = ?, date = ?, reading_minutes = ?,
          published = ?, deleted = 0, updated_at = ? WHERE id = ?`).run(
          data.slug, data.title, data.metaDescription, data.bodyHtml, data.date, data.readingMinutes, data.published ? 1 : 0, now, existing.id);
      } else {
        conn.prepare(`INSERT INTO posts (slug, title, meta_description, body_html, date, reading_minutes, published, deleted, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
          data.slug, data.title, data.metaDescription, data.bodyHtml, data.date, data.readingMinutes, data.published ? 1 : 0, now, now);
      }
    })();
    invalidate();
  },
  setPublished(slug, published) {
    db.get().prepare('UPDATE posts SET published = ?, updated_at = ? WHERE slug = ?').run(published ? 1 : 0, Date.now(), slug);
    invalidate();
  },
  // Built-in posts get a tombstone; admin-only posts are removed for good.
  remove(slug, { tombstone }) {
    const conn = db.get();
    if (tombstone) {
      const now = Date.now();
      conn.prepare(`INSERT INTO posts (slug, title, date, deleted, created_at, updated_at) VALUES (?, '', '', 1, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET deleted = 1, updated_at = excluded.updated_at`).run(slug, now, now);
    } else {
      conn.prepare('DELETE FROM posts WHERE slug = ?').run(slug);
    }
    invalidate();
  },
  // Drop the admin's row: a built-in post comes back as shipped.
  reset(slug) {
    db.get().prepare('DELETE FROM posts WHERE slug = ?').run(slug);
    invalidate();
  },
};

module.exports = {
  get, set, has, save, value, parse, apply, version, invalidate,
  resolvePaymentMode, paymentStatus, announcement,
  FIELDS, PLAN_FIELDS, HOME_DEFAULTS, DEFAULTS: D, posts,
};

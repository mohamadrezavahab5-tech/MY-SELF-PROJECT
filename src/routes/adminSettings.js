'use strict';
// Site-owner settings ("CMS-lite") under /admin/settings: brand & contact,
// home page texts, plans & prices, referral, payment gateway, AI server, the
// site FAQ, the blog and the legal pages. Saving applies at once, without a
// restart (src/settings.js overlays the saved values onto config / plans).
// Access: admins only (ADMIN_PHONES); POSTs are same-origin checked.
//
// Escaping: everything the admin types is escaped when rendered, EXCEPT the
// fields that are explicitly HTML (trust badges, blog body, legal pages):
// those are trusted admin HTML and the UI says so.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const settings = require('../settings');
const content = require('../content');
const demo = require('../demoBot');
const { PLANS, DURATIONS, priceToman } = require('../plans');
const { dashPage, brand } = require('../views/layout');
const { esc, faDigits, formatNumber, formatToman, enDigits } = require('../util');

const router = express.Router();
router.use('/admin/settings', auth.requireAdmin, auth.sameOrigin);
// Blog bodies and legal pages can be long (Persian is ~6 bytes per letter URL-encoded).
const form = express.urlencoded({ extended: false, limit: '3mb', parameterLimit: 5000 });

const TABS = [
  { id: 'general', label: 'عمومی', icon: '🏷️' },
  { id: 'home', label: 'صفحه‌ی اول', icon: '🏠' },
  { id: 'plans', label: 'قیمت‌ها و پلن‌ها', icon: '💰' },
  { id: 'referral', label: 'همکاری در فروش', icon: '🤝' },
  { id: 'payment', label: 'پرداخت', icon: '💳' },
  { id: 'ai', label: 'هوش مصنوعی', icon: '🧠' },
  { id: 'faq', label: 'سؤالات متداول سایت', icon: '❓' },
  { id: 'blog', label: 'مجله', icon: '📰' },
  { id: 'pages', label: 'صفحه‌ها', icon: '📄' },
];

const FLASH = {
  1: 'ذخیره شد. تغییرات همین حالا روی سایت اعمال شد.',
  reset: 'این بخش به مقادیر پیش‌فرض برگشت.',
  deleted: 'مطلب حذف شد.',
  restored: 'مطلب اصلی بازگردانده شد.',
  published: 'وضعیت انتشار تغییر کرد.',
};

const str = v => (Array.isArray(v) ? String(v[v.length - 1] ?? '') : String(v ?? ''));
const has = (obj, k) => obj != null && Object.prototype.hasOwnProperty.call(obj, k);

function render(req, res, tab, body, { status = 200, error = '' } = {}) {
  const bots = db.get().prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(req.user.id);
  const t = TABS.find(x => x.id === tab) || TABS[0];
  const flash = FLASH[req.query.ok] || '';
  res.status(status).set('Cache-Control', 'no-store').send(dashPage({
    title: `${t.label} | تنظیمات سایت`,
    user: req.user,
    bot: bots[0] || null,
    bots,
    active: 'site-settings',
    flash: status === 200 ? esc(flash) : '',
    body: `<div class="page-title"><h1>تنظیمات سایت</h1><a class="btn btn-ghost btn-sm" href="/" target="_blank" rel="noopener">مشاهده‌ی سایت ↗</a></div>
<nav class="settings-tabs" aria-label="بخش‌های تنظیمات">${TABS.map(x => `<a href="/admin/settings/${x.id}"${x.id === t.id ? ' class="active" aria-current="page"' : ''}><span aria-hidden="true">${x.icon}</span>${x.label}</a>`).join('')}</nav>
<div class="settings-page">
${error ? `<div class="error" role="alert" style="margin-bottom:16px">${esc(error)}</div>` : ''}
${body}
</div>
<script src="/js/admin.js" defer></script>`,
  }));
}

// ---- Form building blocks ---------------------------------------------------------

const idOf = key => `f-${key.replace(/[^a-zA-Z0-9]+/g, '-')}`;

function truncate(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// The value shown in an input: what was just submitted (on a validation error)
// or the effective saved/default value.
function shown(ctx, key) {
  if (ctx.values && has(ctx.values, key)) return ctx.values[key];
  const f = settings.FIELDS.get(key);
  const v = settings.value(key);
  if (f && f.type === 'int' && f.scale) return v / f.scale;
  return v;
}

function errorFor(ctx, key) {
  return ctx.errors && ctx.errors[key] ? `<span class="field-error">${esc(ctx.errors[key])}</span>` : '';
}

function defaultNote(key) {
  const f = settings.FIELDS.get(key);
  if (!f || !settings.has(key) || f.type === 'secret') return '';
  let d = f.default;
  if (f.type === 'bool') d = d ? 'روشن' : 'خاموش';
  else if (f.type === 'int') d = formatNumber(f.scale ? d / f.scale : d);
  else if (d === '' || d == null) d = 'خالی';
  return ` <span class="def" title="${esc(String(d))}">تغییر یافته · پیش‌فرض: ${esc(truncate(brand(d), 40))}</span>`;
}

function input(ctx, key, label, { hint = '', ltr = false, type = 'text', placeholder = null, money = false, count = 0, suffix = '', required = false } = {}) {
  const f = settings.FIELDS.get(key);
  const id = idOf(key);
  const isInt = f.type === 'int';
  const v = shown(ctx, key);
  const ph = placeholder !== null ? placeholder : (!isInt && f.default ? String(f.default) : '');
  const attrs = [
    `id="${id}"`, `name="${esc(key)}"`, `type="${isInt ? 'text' : type}"`,
    isInt ? 'inputmode="numeric" autocomplete="off"' : '',
    ltr || isInt ? 'class="ltr"' : '',
    `value="${esc(v ?? '')}"`,
    ph ? `placeholder="${esc(ph)}"` : '',
    f.max && !isInt ? `maxlength="${f.max}"` : '',
    money ? `data-money="${id}-money"` : '',
    count ? `data-count="${count}"` : '',
    required ? 'required' : '',
    ctx.errors && ctx.errors[key] ? 'aria-invalid="true"' : '',
  ].filter(Boolean).join(' ');
  const moneyText = money && /^\d+$/.test(enDigits(String(v ?? '')).replace(/[,٬\s]/g, '')) ? `= ${formatToman(Number(enDigits(String(v)).replace(/[,٬\s]/g, '')))}` : '';
  return `<div class="field${ctx.errors && ctx.errors[key] ? ' has-error' : ''}">
  <label for="${id}">${label}${defaultNote(key)}</label>
  ${suffix ? `<div class="input-suffix"><input ${attrs}><span>${suffix}</span></div>` : `<input ${attrs}>`}
  ${money ? `<span class="hint money-preview" id="${id}-money" aria-live="polite">${esc(moneyText)}</span>` : ''}
  ${count ? `<span class="hint char-count" data-count-for="${id}"></span>` : ''}
  ${hint ? `<span class="hint">${hint}</span>` : ''}
  ${errorFor(ctx, key)}
</div>`;
}

function textarea(ctx, key, label, { hint = '', rows = 3, ltr = false, count = 0, code = false } = {}) {
  const f = settings.FIELDS.get(key);
  const id = idOf(key);
  const v = shown(ctx, key);
  return `<div class="field${ctx.errors && ctx.errors[key] ? ' has-error' : ''}">
  <label for="${id}">${label}${defaultNote(key)}</label>
  <textarea id="${id}" name="${esc(key)}" rows="${rows}"${ltr ? ' class="ltr code-input" dir="ltr"' : code ? ' class="code-input"' : ''}${f.max ? ` maxlength="${f.max}"` : ''}${count ? ` data-count="${count}"` : ''}${!ltr && f.default ? ` placeholder="${esc(truncate(f.default, 200))}"` : ''}>${esc(v ?? '')}</textarea>
  ${count ? `<span class="hint char-count" data-count-for="${id}"></span>` : ''}
  ${hint ? `<span class="hint">${hint}</span>` : ''}
  ${errorFor(ctx, key)}
</div>`;
}

// Hidden "0" + checkbox "1": an unticked box still reaches the server.
function check(ctx, key, label, hint = '') {
  const v = shown(ctx, key);
  const on = v === true || v === '1' || v === 'on' || v === 'true';
  return `<div class="field">
  <label class="check"><input type="hidden" name="${esc(key)}" value="0"><input type="checkbox" name="${esc(key)}" value="1"${on ? ' checked' : ''}> ${label}${defaultNote(key)}</label>
  ${hint ? `<span class="hint">${hint}</span>` : ''}
</div>`;
}

function select(ctx, key, label, options, hint = '') {
  const id = idOf(key);
  const v = String(shown(ctx, key) ?? '');
  return `<div class="field${ctx.errors && ctx.errors[key] ? ' has-error' : ''}">
  <label for="${id}">${label}</label>
  <select id="${id}" name="${esc(key)}">${options.map(([val, text]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select>
  ${hint ? `<span class="hint">${hint}</span>` : ''}
  ${errorFor(ctx, key)}
</div>`;
}

function mask(v, { head = 0 } = {}) {
  if (!v) return '';
  if (v.length <= 8) return '••••';
  return `${head ? v.slice(0, head) : ''}••••••••${v.slice(-4)}`;
}

// Secrets are never echoed back: show a masked hint, empty input = keep.
function secret(ctx, key, label, { hint = '', head = 0 } = {}) {
  const f = settings.FIELDS.get(key);
  const id = idOf(key);
  const current = settings.value(key);
  const saved = settings.has(key);
  const state = current
    ? `<span class="badge ok ltr">${esc(mask(current, { head }))}</span> <span class="muted">${saved ? 'ذخیره‌شده در تنظیمات' : 'از تنظیمات سرور'}</span>`
    : '<span class="badge">تنظیم نشده</span>';
  return `<div class="field${ctx.errors && ctx.errors[key] ? ' has-error' : ''}">
  <label for="${id}">${label}</label>
  <div class="row secret-state">${state}</div>
  <input id="${id}" name="${esc(key)}" type="password" class="ltr" autocomplete="new-password" spellcheck="false"${f.max ? ` maxlength="${f.max}"` : ''} placeholder="${current ? 'برای تغییر، مقدار جدید را وارد کنید' : ''}">
  ${saved ? `<label class="check hint"><input type="checkbox" name="clear:${esc(key)}" value="1"> پاک کردن مقدار ذخیره‌شده${f.default ? ' (برگشت به مقدار سرور)' : ''}</label>` : ''}
  ${hint ? `<span class="hint">${hint}</span>` : ''}
  ${errorFor(ctx, key)}
</div>`;
}

function saveBar(tab) {
  return `<div class="save-bar"><button class="btn btn-primary">ذخیره‌ی تغییرات</button><span class="hint">تغییرات بلافاصله روی سایت اعمال می‌شود.</span></div>`;
}

function resetForm(tab, what = 'همه‌ی فیلدهای این بخش') {
  return `<form class="reset-form" method="post" action="/admin/settings/${tab}/reset"><button class="btn btn-sm btn-ghost" data-confirm="${esc(what)} به مقدار پیش‌فرض برگردد؟">↺ برگرداندن این بخش به پیش‌فرض</button></form>`;
}

// Parses the submitted registry fields. A field missing from the body is left
// unchanged; any error means nothing is saved.
function collect(body, keys) {
  const changes = {};
  const errors = {};
  const values = {};
  for (const key of keys) {
    const f = settings.FIELDS.get(key);
    if (f.type === 'secret' && body[`clear:${key}`]) {
      changes[key] = null;
      continue;
    }
    if (!has(body, key)) continue;
    if (f.type !== 'secret') values[key] = str(body[key]);
    const r = settings.parse(key, body[key]);
    if (r.error) errors[key] = r.error;
    else if (r.value !== undefined) changes[key] = r.value;
  }
  return { changes, errors, values };
}

function resyncDemo() {
  try {
    demo.ensure();
  } catch (e) {
    console.error('demo bot re-sync failed:', e.message);
  }
}

// ---- Tabs made only of registry fields ----------------------------------------------

const TAB_KEYS = {
  general: ['siteName', 'siteNameEn', 'supportPhone', 'supportEmail', 'supportTelegram', 'trustBadgesHtml', 'announce.enabled', 'announce.text', 'announce.link'],
  home: ['home.heroTitle', 'home.heroText', 'home.heroButton', 'home.seoTitle', 'home.seoDescription'],
  plans: [...settings.FIELDS.keys()].filter(k => k.startsWith('plan.') || k.startsWith('duration.')),
  referral: ['referral.commissionPercent', 'referral.buyerDiscountPercent', 'referral.minPayoutToman'],
  payment: ['payment.mode', 'payment.merchant'],
  ai: ['llm.baseUrl', 'llm.model', 'llm.apiKey', 'llm.timeoutMs', 'llm.maxTokens'],
};

const SITE_HINT = 'هر جا <code>{{site}}</code> بنویسید، نام سایت جایش می‌نشیند.';
const HTML_NOTE = 'این فیلد <strong>HTML</strong> است و همان‌طور که می‌نویسید در سایت نمایش داده می‌شود؛ فقط کد مطمئن (مثلاً کدی که خود اینماد یا زرین‌پال می‌دهد) را این‌جا بگذارید.';

function generalView(ctx) {
  const a = settings.announcement();
  return `<form class="form settings-form" method="post" action="/admin/settings/general" novalidate>
<div class="panel"><h2>نام و برند</h2>
  <div class="grid grid-2">
    ${input(ctx, 'siteName', 'نام سایت', { hint: `در سربرگ، پاورقی، عنوان صفحه‌ها و همه‌ی متن‌ها استفاده می‌شود. خالی = «${esc(settings.DEFAULTS.siteName)}».` })}
    ${input(ctx, 'siteNameEn', 'نام لاتین', { ltr: true, hint: 'برای جاهایی که فارسی مناسب نیست (مثلاً گزارش‌های سرور).' })}
  </div>
</div>
<div class="panel"><h2>راه‌های تماس</h2>
  <p class="muted">در پاورقی همه‌ی صفحه‌ها و صفحه‌ی ورود نمایش داده می‌شود. هر کدام را خالی بگذارید نمایش داده نمی‌شود.</p>
  <div class="grid grid-3">
    ${input(ctx, 'supportPhone', 'تلفن پشتیبانی', { ltr: true, type: 'tel', placeholder: '021-12345678' })}
    ${input(ctx, 'supportEmail', 'ایمیل', { ltr: true, type: 'email', placeholder: 'support@example.ir' })}
    ${input(ctx, 'supportTelegram', 'پیام‌رسان (بله / تلگرام)', { placeholder: '@example' })}
  </div>
</div>
<div class="panel"><h2>نوار اطلاعیه</h2>
  <p class="muted">یک نوار باریک بالای همه‌ی صفحه‌های عمومی سایت؛ برای تخفیف، خبر یا اطلاع‌رسانی.</p>
  ${a.enabled ? `<div class="announce-bar announce-preview"><div>${a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(brand(a.text))} ←</a>` : esc(brand(a.text))}</div></div>` : ''}
  ${check(ctx, 'announce.enabled', 'نوار اطلاعیه نمایش داده شود')}
  ${input(ctx, 'announce.text', 'متن اطلاعیه', { count: 120, placeholder: 'مثلاً: ۲۰٪ تخفیف پلن سالانه تا آخر ماه 🎉', hint: 'متن ساده (بدون HTML).' })}
  ${input(ctx, 'announce.link', 'لینک (اختیاری)', { ltr: true, placeholder: '/pricing', hint: 'صفحه‌ای از همین سایت مثل <code>/pricing</code> یا آدرس کامل با <code>https://</code>.' })}
</div>
<div class="panel"><h2>نمادهای اعتماد (اینماد، زرین‌پال و …)</h2>
  <div class="notice" style="margin-bottom:12px">${HTML_NOTE}</div>
  ${textarea(ctx, 'trustBadgesHtml', 'کد HTML نمادها', { rows: 5, ltr: true, hint: 'در پاورقی سایت، ستون «تماس» نمایش داده می‌شود.' })}
</div>
${saveBar('general')}
</form>
${resetForm('general')}`;
}

function homeView(ctx) {
  const title = String(shown(ctx, 'home.heroTitle') || '');
  return `<form class="form settings-form" method="post" action="/admin/settings/home" novalidate>
<div class="panel"><h2>بخش اصلی صفحه‌ی اول</h2>
  <div class="hero-preview" aria-label="پیش‌نمایش عنوان"><span class="hint">پیش‌نمایش:</span><div class="hero-preview-title" data-hero-preview>${esc(brand(title)).replace(/\*([^*\n]+)\*/g, '<span class="grad">$1</span>').replace(/\*/g, '')}</div></div>
  ${input(ctx, 'home.heroTitle', 'عنوان بزرگ', { hint: `بخشی را که می‌خواهید رنگی (گرادیان) شود بین دو ستاره بگذارید؛ مثلاً: <code dir="rtl">جواب بدهید *۲۴ ساعته*</code>. ${SITE_HINT}` })}
  ${textarea(ctx, 'home.heroText', 'متن زیر عنوان', { rows: 3, count: 300, hint: SITE_HINT })}
  ${input(ctx, 'home.heroButton', 'متن دکمه‌ی اصلی', { hint: 'دکمه به صفحه‌ی ثبت‌نام می‌رود.' })}
</div>
<div class="panel"><h2>سئوی صفحه‌ی اول</h2>
  <p class="muted">چیزی که گوگل در نتایج جستجو نشان می‌دهد.</p>
  ${input(ctx, 'home.seoTitle', 'عنوان صفحه (title)', { count: 65, hint: `بهتر است کمتر از ۶۵ نویسه باشد. ${SITE_HINT}` })}
  ${textarea(ctx, 'home.seoDescription', 'توضیح متا (meta description)', { rows: 2, count: 160, hint: 'بهترین طول: ۱۲۰ تا ۱۶۰ نویسه.' })}
</div>
${saveBar('home')}
</form>
${resetForm('home')}`;
}

function plansView(ctx) {
  const cards = Object.values(PLANS).map(p => {
    const k = f => `plan.${p.id}.${f}`;
    const F = key => settings.FIELDS.has(k(key));
    return `<div class="panel plan-edit"><h2>${esc(p.name)} <span class="badge ltr">${esc(p.id)}</span></h2>
  ${F('name') ? input(ctx, k('name'), 'نام پلن') : ''}
  ${F('priceMonthly') ? input(ctx, k('priceMonthly'), 'قیمت ماهانه', { money: true, suffix: 'تومان' }) : '<div class="field"><span class="label">قیمت ماهانه</span><span class="muted">رایگان (همیشه ۰)</span></div>'}
  <div class="grid grid-2 tight">
    ${F('bots') ? input(ctx, k('bots'), 'تعداد بات') : ''}
    ${F('faqs') ? input(ctx, k('faqs'), 'سؤال و جواب') : ''}
    ${F('answersPerMonth') ? input(ctx, k('answersPerMonth'), 'پاسخ در ماه') : ''}
    ${F('pages') ? input(ctx, k('pages'), 'صفحه‌ی سایت', { hint: 'یادگیری از سایت مشتری' }) : ''}
  </div>
  <div class="checks">
    ${F('ai') ? check(ctx, k('ai'), 'پاسخ با هوش مصنوعی') : ''}
    ${F('channels') ? check(ctx, k('channels'), 'اتصال بله و تلگرام') : ''}
    ${F('export') ? check(ctx, k('export'), 'خروجی اکسل') : ''}
    ${F('badge') ? check(ctx, k('badge'), 'نشان «قدرت‌گرفته از» در ویجت') : ''}
  </div>
</div>`;
  }).join('');
  const paid = Object.values(PLANS).filter(p => p.priceMonthly > 0);
  const table = `<div class="table-wrap"><table class="table"><thead><tr><th>پلن</th>${DURATIONS.map(d => `<th>${esc(d.label)}</th>`).join('')}</tr></thead><tbody>
${paid.map(p => `<tr><td>${esc(p.name)}</td>${DURATIONS.map(d => `<td>${formatToman(priceToman(p.id, d.months) || 0)}</td>`).join('')}</tr>`).join('')}
</tbody></table></div>`;
  return `<div class="panel"><p style="margin:0">قیمت‌ها به <strong>تومان</strong> است (مبلغ درگاه خودکار به ریال تبدیل می‌شود). تغییر محدودیت‌ها <strong>بلافاصله</strong> برای همه‌ی مشترکان همان پلن اعمال می‌شود؛ قیمت جدید فقط روی خریدهای بعدی اثر دارد.</p>
<p class="hint" style="margin:.5em 0 0">اگر محدودیت پلن رایگان را عوض کردید، متن «سؤالات متداول سایت» را هم به‌روز کنید.</p></div>
<form class="form settings-form" method="post" action="/admin/settings/plans" novalidate>
<div class="grid grid-3 plan-grid">${cards}</div>
<div class="panel"><h2>تخفیف پرداخت چندماهه</h2>
  <div class="grid grid-3">
    ${DURATIONS.map(d => input(ctx, `duration.${d.months}.discountPercent`, `${esc(d.label)} (${faDigits(d.months)} ماه)`, { suffix: '٪', hint: 'بین ۰ تا ۹۰' })).join('')}
  </div>
  <h3 style="margin-top:14px">قیمت نهایی فعلی (پرداخت یک‌جا)</h3>
  ${table}
  <p class="hint">قیمت‌ها به نزدیک‌ترین هزار تومان گرد می‌شوند.</p>
</div>
${saveBar('plans')}
</form>
${resetForm('plans', 'همه‌ی قیمت‌ها و محدودیت‌ها')}`;
}

function referralView(ctx) {
  const r = config.referral;
  const sample = priceToman('pro', 1) || 0;
  const disc = Math.round((sample * r.buyerDiscountPercent) / 100 / 1000) * 1000;
  const commission = Math.floor(((sample - disc) * r.commissionPercent) / 100);
  return `<form class="form settings-form" method="post" action="/admin/settings/referral" novalidate>
<div class="panel"><h2>پورسانت و تخفیف</h2>
  <div class="grid grid-3">
    ${input(ctx, 'referral.commissionPercent', 'پورسانت همکار از هر پرداخت', { suffix: '٪', hint: 'از هر پرداخت مشتری معرفی‌شده، تا وقتی تمدید می‌کند.' })}
    ${input(ctx, 'referral.buyerDiscountPercent', 'تخفیف اولین خرید مشتری', { suffix: '٪', hint: 'فقط برای اولین خرید کسی که با لینک معرفی آمده. حداکثر ۹۰.' })}
    ${input(ctx, 'referral.minPayoutToman', 'حداقل مبلغ تسویه', { money: true, suffix: 'تومان' })}
  </div>
  <div class="example-box">مثال با تنظیمات ذخیره‌شده: مشتری معرفی‌شده پلن ${esc(PLANS.pro.name)} یک‌ماهه را با ${faDigits(r.buyerDiscountPercent)}٪ تخفیف، <strong>${formatToman(sample - disc)}</strong> می‌خرد و همکار <strong>${formatToman(commission)}</strong> پورسانت می‌گیرد.</div>
  <p class="hint">این اعداد در صفحه‌ی <a href="/affiliate" target="_blank" rel="noopener">همکاری در فروش</a> و داشبورد همکاران هم نمایش داده می‌شوند. پورسانت خریدهای قبلی تغییر نمی‌کند.</p>
</div>
${saveBar('referral')}
</form>
${resetForm('referral')}`;
}

const MODE_INFO = {
  zarinpal: ['ok', 'فعال: درگاه واقعی زرین‌پال', 'پرداخت‌ها واقعی است و مبلغ به حساب زرین‌پال شما واریز می‌شود.'],
  sandbox: ['warn', 'آزمایشی (Sandbox زرین‌پال)', 'پول واقعی جابه‌جا نمی‌شود ولی پلن خریدار فعال می‌شود. فقط برای آزمایش؛ روی سایت اصلی روشن نگذارید.'],
  mock: ['warn', 'درگاه ساختگی (فقط توسعه)', 'صفحه‌ی پرداخت ساختگی محلی. روی سرور اصلی (production) هرگز فعال نمی‌شود.'],
  disabled: ['danger', 'غیرفعال', 'دکمه‌های پرداخت غیرفعال‌اند و به کاربران «درگاه به‌زودی فعال می‌شود» نشان داده می‌شود.'],
};

function paymentView(ctx) {
  const st = settings.paymentStatus();
  const [cls, label, desc] = MODE_INFO[st.effective] || MODE_INFO.disabled;
  let why = '';
  if (st.isProd && !st.hasMerchant) why = 'چون مرچنت کد زرین‌پال وارد نشده، روی سرور اصلی پرداخت غیرفعال است.';
  else if (st.wanted && st.wanted !== st.effective) why = 'حالت انتخاب‌شده روی این سرور مجاز نیست؛ حالت امن‌تر فعال شد.';
  const modes = [
    ['', 'خودکار (طبق تنظیمات سرور)'],
    ['zarinpal', 'فعال: درگاه واقعی زرین‌پال'],
    ['sandbox', 'آزمایشی: Sandbox زرین‌پال'],
    ['disabled', 'غیرفعال'],
    ...(config.isProd ? [] : [['mock', 'درگاه ساختگی محلی (فقط توسعه)']]),
  ];
  const callback = `${config.siteUrl}/pay/callback`;
  return `<div class="panel"><h2>وضعیت فعلی درگاه</h2>
  <div class="row"><span class="badge ${cls} badge-lg">${esc(label)}</span></div>
  <p class="muted" style="margin:.6em 0 0">${esc(desc)}</p>
  ${why ? `<p class="notice" style="margin:.8em 0 0">${esc(why)}</p>` : ''}
</div>
<form class="form settings-form" method="post" action="/admin/settings/payment" novalidate>
<div class="panel"><h2>درگاه زرین‌پال</h2>
  ${select(ctx, 'payment.mode', 'حالت پرداخت', modes, 'برای دریافت پول واقعی «درگاه واقعی» را انتخاب کنید و مرچنت کد را وارد کنید.')}
  ${secret(ctx, 'payment.merchant', 'مرچنت کد (Merchant ID)', { head: 4, hint: 'کد ۳۶ نویسه‌ای که در پنل زرین‌پال، بخش درگاه‌ها می‌بینید. برای امنیت، مقدار کامل آن هیچ‌وقت دوباره نمایش داده نمی‌شود؛ خالی بگذارید تا تغییر نکند.' })}
  <div class="field"><span class="label">آدرس بازگشت (Callback)</span>
    <div class="row"><input type="text" class="ltr" id="pay-callback" readonly value="${esc(callback)}" style="flex:1;min-width:220px"><button type="button" class="btn btn-sm btn-outline" data-copy="#pay-callback">کپی</button></div>
    <span class="hint">دامنه‌ی این آدرس باید با دامنه‌ای که در زرین‌پال ثبت کرده‌اید یکی باشد.</span></div>
</div>
${saveBar('payment')}
</form>
${resetForm('payment', 'حالت پرداخت و مرچنت کد')}`;
}

function testResultHtml(t) {
  if (!t) return '';
  return `<div class="${t.ok ? 'success' : 'error'} ai-test-box"><strong>${t.ok ? '✓ ' : '✗ '}${esc(t.message)}</strong>
${t.reply ? `<div class="hint">جواب مدل: «${esc(t.reply)}»</div>` : ''}
${t.models && t.models.length ? `<div class="hint">مدل‌های موجود روی سرور: <span class="ltr">${esc(t.models.slice(0, 20).join('، '))}</span></div>` : ''}</div>`;
}

function aiView(ctx) {
  const on = !!(config.llm.baseUrl && config.llm.model);
  return `<div class="panel"><h2>این بخش چیست؟</h2>
  <p>با وصل کردن یک <strong>مدل زبانی متن‌باز</strong> که روی <strong>سرور خودتان</strong> اجرا می‌کنید (مثلاً <strong>Ollama</strong> یا <strong>vLLM</strong> با مدل‌هایی مثل <strong>Qwen</strong> یا <strong>Gemma</strong>)، بات‌ها می‌توانند وقتی جواب دقیقی در سؤال و جواب‌ها نیست، از روی اطلاعات خود کسب‌وکار یک جواب کوتاه و طبیعی بنویسند. به هیچ سرویس خارجی وصل نمی‌شود؛ فقط به آدرسی که خودتان وارد می‌کنید.</p>
  <ul class="muted tight-list">
    <li>Ollama: آدرس <code class="ltr">http://127.0.0.1:11434/v1</code> و نام مدل مثل <code class="ltr">qwen2.5:7b-instruct</code> یا <code class="ltr">gemma2:9b</code></li>
    <li>vLLM: آدرس <code class="ltr">http://127.0.0.1:8000/v1</code> و نام مدل مثل <code class="ltr">Qwen/Qwen2.5-7B-Instruct</code></li>
  </ul>
  <p class="hint" style="margin:0">اینکه کدام پلن‌ها هوش مصنوعی دارند در بخش «قیمت‌ها و پلن‌ها» تعیین می‌شود. آدرس را خالی بگذارید تا این قابلیت کلاً خاموش باشد.</p>
</div>
<form class="form settings-form" method="post" action="/admin/settings/ai" novalidate id="ai-form">
<div class="panel"><div class="row-between"><h2 style="margin:0">اتصال به سرور مدل</h2>${on ? '<span class="badge ok">روشن</span>' : '<span class="badge">خاموش</span>'}</div>
  <div class="grid grid-2" style="margin-top:12px">
    ${input(ctx, 'llm.baseUrl', 'آدرس سرور (Base URL)', { ltr: true, type: 'url', placeholder: 'http://127.0.0.1:11434/v1', hint: 'آدرس سازگار با OpenAI که معمولاً به <code>/v1</code> ختم می‌شود.' })}
    ${input(ctx, 'llm.model', 'نام مدل', { ltr: true, placeholder: 'qwen2.5:7b-instruct' })}
  </div>
  ${secret(ctx, 'llm.apiKey', 'کلید دسترسی (API key)', { hint: 'اگر سرورتان کلید نمی‌خواهد (مثل Ollama) خالی بگذارید.' })}
  <div class="grid grid-2">
    ${input(ctx, 'llm.timeoutMs', 'حداکثر زمان انتظار', { suffix: 'ثانیه', hint: 'اگر مدل در این زمان جواب ندهد، بات بدون هوش مصنوعی ادامه می‌دهد.' })}
    ${input(ctx, 'llm.maxTokens', 'حداکثر طول جواب', { suffix: 'توکن', hint: 'حدود ۳۰۰ تا ۵۰۰ برای جواب‌های کوتاه پشتیبانی مناسب است.' })}
  </div>
  <div id="ai-test-result" aria-live="polite">${testResultHtml(ctx.test)}</div>
</div>
<div class="save-bar"><button class="btn btn-primary">ذخیره‌ی تغییرات</button><button class="btn btn-outline" formaction="/admin/settings/ai/test" data-ai-test>🔌 آزمایش اتصال</button><span class="hint">آزمایش با همین مقادیر فرم انجام می‌شود و چیزی ذخیره نمی‌کند.</span></div>
</form>
${resetForm('ai', 'تنظیمات هوش مصنوعی (شامل کلید)')}`;
}

const VIEWS = { general: generalView, home: homeView, plans: plansView, referral: referralView, payment: paymentView, ai: aiView };
const AFTER = { general: resyncDemo };

router.get('/admin/settings', (req, res) => res.redirect('/admin/settings/general'));

for (const tab of Object.keys(VIEWS)) {
  router.get(`/admin/settings/${tab}`, (req, res) => render(req, res, tab, VIEWS[tab]({})));

  router.post(`/admin/settings/${tab}`, form, (req, res) => {
    const r = collect(req.body, TAB_KEYS[tab]);
    if (Object.keys(r.errors).length) {
      return render(req, res, tab, VIEWS[tab](r), { status: 400, error: 'بعضی از فیلدها ایراد دارند (قرمز شده‌اند). چیزی ذخیره نشد.' });
    }
    settings.save(r.changes);
    if (AFTER[tab]) AFTER[tab]();
    res.redirect(`/admin/settings/${tab}?ok=1`);
  });

  router.post(`/admin/settings/${tab}/reset`, form, (req, res) => {
    settings.save(Object.fromEntries(TAB_KEYS[tab].map(k => [k, null])));
    if (AFTER[tab]) AFTER[tab]();
    res.redirect(`/admin/settings/${tab}?ok=reset`);
  });
}

// ---- AI: test the connection with the values currently in the form ----------------

function netError(e) {
  const cause = (e && e.cause) || {};
  const code = cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code) || (e && e.code) || '';
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'سرور در زمان تعیین‌شده جواب نداد.';
  if (/bad port/i.test(cause.message || '')) return 'این شماره‌ی پورت مجاز نیست؛ پورت سرور مدل را بررسی کنید.';
  if (code === 'ECONNREFUSED') return 'اتصال رد شد. سرور مدل روشن است؟ آدرس و پورت را بررسی کنید.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'نام این سرور پیدا نشد. آدرس را بررسی کنید.';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'اتصال وسط کار قطع شد.';
  if (/CERT|SSL|TLS/i.test(code)) return 'گواهی امنیتی (SSL) سرور معتبر نیست.';
  return `اتصال برقرار نشد${code ? ` (${code})` : ''}.`;
}

async function testLlm({ baseUrl, model, apiKey, timeoutMs }) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const timeout = Math.min(Math.max(timeoutMs || 15000, 2000), 60000);
  let models = null;
  try {
    const r = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(Math.min(timeout, 15000)) });
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'سرور کلید دسترسی (API key) را نپذیرفت.' };
    if (r.ok) {
      const data = await r.json().catch(() => null);
      if (data && Array.isArray(data.data)) models = data.data.map(m => String((m && m.id) || '')).filter(Boolean);
    }
  } catch (e) {
    return { ok: false, message: netError(e) };
  }
  if (!model) {
    return models
      ? { ok: true, message: 'سرور در دسترس است. حالا نام یکی از مدل‌ها را وارد کنید.', models }
      : { ok: false, message: 'سرور جواب داد ولی فهرست مدل‌ها را نداد. آدرس باید به /v1 ختم شود.' };
  }
  const started = Date.now();
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'فقط بنویس: سلام' }], max_tokens: 12, temperature: 0, stream: false }),
      signal: AbortSignal.timeout(timeout),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'سرور کلید دسترسی (API key) را نپذیرفت.', models };
    if (!r.ok) {
      const missing = models && !models.includes(model);
      return { ok: false, message: missing ? `مدل «${model}» روی این سرور نیست.` : `سرور خطا داد (کد ${r.status}).`, models };
    }
    const data = await r.json().catch(() => null);
    const reply = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    return { ok: true, message: `اتصال برقرار است و مدل در ${faDigits(secs)} ثانیه جواب داد.`, reply: String(reply).trim().slice(0, 200), models };
  } catch (e) {
    return { ok: false, message: netError(e), models };
  }
}

router.post('/admin/settings/ai/test', form, async (req, res) => {
  const body = req.body;
  const r = collect(body, TAB_KEYS.ai);
  let result;
  if (Object.keys(r.errors).length) {
    result = { ok: false, message: Object.values(r.errors)[0] };
  } else {
    const val = key => (has(r.changes, key) ? (r.changes[key] === null ? settings.FIELDS.get(key).default : r.changes[key]) : settings.value(key));
    const baseUrl = val('llm.baseUrl');
    result = baseUrl
      ? await testLlm({ baseUrl, model: val('llm.model'), apiKey: val('llm.apiKey'), timeoutMs: val('llm.timeoutMs') })
      : { ok: false, message: 'اول آدرس سرور مدل را وارد کنید.' };
  }
  if ((req.get('accept') || '').includes('application/json')) return res.json(result);
  render(req, res, 'ai', aiView({ values: r.values, errors: r.errors, test: result }));
});

// ---- Site FAQ (home + pricing pages, and the home-page demo bot) ------------------

function faqRow(i, f, err = '') {
  return `<li class="faq-edit-row${err ? ' has-error' : ''}" data-row>
  <div class="faq-edit-head">
    <label class="pos-label">ردیف <input type="text" inputmode="numeric" class="ltr pos-input" name="pos_${i}" value="${i + 1}" data-pos></label>
    <div class="row">
      <button type="button" class="btn btn-sm btn-ghost" data-move="up" aria-label="بالاتر">↑</button>
      <button type="button" class="btn btn-sm btn-ghost" data-move="down" aria-label="پایین‌تر">↓</button>
      <label class="check del-check"><input type="checkbox" name="del_${i}" value="1" data-del> حذف</label>
    </div>
  </div>
  <div class="field"><label for="q_${i}">سؤال</label><input id="q_${i}" type="text" name="q_${i}" maxlength="300" value="${esc(f.q)}"></div>
  <div class="field"><label for="a_${i}">جواب</label><textarea id="a_${i}" name="a_${i}" rows="3" maxlength="3000">${esc(f.a)}</textarea></div>
  ${err ? `<span class="field-error">${esc(err)}</span>` : ''}
</li>`;
}

function faqView(list, { errors = {} } = {}) {
  const edited = settings.has('siteFaq');
  const rows = [...list, { q: '', a: '' }];
  return `<div class="panel"><p style="margin:0">این سؤال‌ها در <a href="/#faq" target="_blank" rel="noopener">صفحه‌ی اول</a> و <a href="/pricing#faq" target="_blank" rel="noopener">صفحه‌ی قیمت‌ها</a> نمایش داده می‌شوند و <strong>چت‌بات نمونه‌ی صفحه‌ی اول</strong> هم از همین‌ها جواب می‌دهد. متن ساده است (نه HTML). ${SITE_HINT}</p>
${edited ? '' : '<p class="hint" style="margin:.5em 0 0">الان نسخه‌ی اولیه‌ی سؤال‌ها نمایش داده می‌شود.</p>'}</div>
<form class="form settings-form" method="post" action="/admin/settings/faq" id="faq-editor" novalidate>
<input type="hidden" name="count" value="${rows.length}" data-count-field>
<ol class="faq-edit-list" data-rows>${rows.map((f, i) => faqRow(i, f, errors[i])).join('')}</ol>
<template id="faq-row-tpl">${faqRow('__i__', { q: '', a: '' })}</template>
<div class="save-bar"><button type="button" class="btn btn-outline" data-faq-add>+ افزودن سؤال</button><button class="btn btn-primary">ذخیره‌ی تغییرات</button><span class="hint">ردیف خالی ذخیره نمی‌شود.</span></div>
</form>
${edited ? resetForm('faq', 'سؤالات متداول سایت') : ''}`;
}

router.get('/admin/settings/faq', (req, res) => render(req, res, 'faq', faqView(settings.get('siteFaq') || content.builtin.siteFaq)));

router.post('/admin/settings/faq', form, (req, res) => {
  const b = req.body;
  const count = Math.min(Math.max(parseInt(str(b.count), 10) || 0, 0), 500);
  const rows = [];
  const errors = {};
  for (let i = 0; i < count; i++) {
    if (!has(b, `q_${i}`) && !has(b, `a_${i}`)) continue;
    const q = str(b[`q_${i}`]).trim().replace(/\s+/g, ' ');
    const a = str(b[`a_${i}`]).trim();
    if (str(b[`del_${i}`]) === '1' || (!q && !a)) continue;
    const pos = Number(enDigits(str(b[`pos_${i}`]).trim()));
    rows.push({ q, a, pos: Number.isFinite(pos) ? pos : 1e9, i });
  }
  rows.sort((x, y) => x.pos - y.pos || x.i - y.i);
  rows.forEach((r, n) => {
    if (!r.q) errors[n] = 'سؤال خالی است.';
    else if (!r.a) errors[n] = 'جواب خالی است.';
    else if (r.q.length > 300) errors[n] = 'سؤال حداکثر ۳۰۰ نویسه.';
    else if (r.a.length > 3000) errors[n] = 'جواب حداکثر ۳۰۰۰ نویسه.';
  });
  const list = rows.map(r => ({ q: r.q, a: r.a }));
  if (Object.keys(errors).length) {
    return render(req, res, 'faq', faqView(list, { errors }), { status: 400, error: 'بعضی از ردیف‌ها کامل نیستند. چیزی ذخیره نشد.' });
  }
  settings.set('siteFaq', list);
  resyncDemo();
  res.redirect('/admin/settings/faq?ok=1');
});

router.post('/admin/settings/faq/reset', form, (req, res) => {
  settings.set('siteFaq', null);
  resyncDemo();
  res.redirect('/admin/settings/faq?ok=reset');
});

// ---- Blog ------------------------------------------------------------------------

// URL-safe slug that keeps Persian letters: «چت‌بات چیست؟» -> «چت-بات-چیست».
function slugify(s) {
  return enDigits(String(s || ''))
    .toLowerCase()
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/ۀ/g, 'ه').replace(/[أإ]/g, 'ا')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[\s‌‍‎‏_]+/g, '-')
    .replace(/[^a-z0-9ء-غف-يپچژکگی-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90)
    .replace(/-$/, '');
}

function slugTaken(slug) {
  return content.isBuiltinPost(slug) || !!settings.posts.get(slug);
}

function validDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function estimateMinutes(html) {
  const words = String(html).replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function faDate(iso) {
  if (!validDay(String(iso || ''))) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${iso}T12:00:00Z`));
  } catch {
    return faDigits(iso);
  }
}

const postUrl = slug => `/blog/${encodeURIComponent(slug)}`;
const editUrl = slug => `/admin/settings/blog/edit?slug=${encodeURIComponent(slug)}`;

function blogList() {
  const list = content.adminPosts();
  const source = { builtin: '<span class="badge">مطلب اولیه</span>', edited: '<span class="badge primary">ویرایش‌شده</span>', custom: '<span class="badge primary">نوشته‌ی شما</span>' };
  const hidden = slug => `<input type="hidden" name="slug" value="${esc(slug)}">`;
  const rows = list.map(p => {
    const status = p.deleted ? '<span class="badge danger">حذف‌شده</span>' : p.published ? '<span class="badge ok">منتشرشده</span>' : '<span class="badge warn">پیش‌نویس</span>';
    const actions = p.deleted
      ? `<form method="post" action="/admin/settings/blog/restore">${hidden(p.slug)}<button class="btn btn-sm btn-outline">بازگردانی</button></form>`
      : `<a class="btn btn-sm btn-outline" href="${esc(editUrl(p.slug))}">ویرایش</a>
<a class="btn btn-sm btn-ghost" href="${esc(postUrl(p.slug))}" target="_blank" rel="noopener">${p.published ? 'مشاهده' : 'پیش‌نمایش'} ↗</a>
<form method="post" action="/admin/settings/blog/publish">${hidden(p.slug)}<input type="hidden" name="published" value="${p.published ? '0' : '1'}"><button class="btn btn-sm btn-ghost">${p.published ? 'لغو انتشار' : 'انتشار'}</button></form>
${p.source === 'edited' ? `<form method="post" action="/admin/settings/blog/restore">${hidden(p.slug)}<button class="btn btn-sm btn-ghost" data-confirm="ویرایش‌های شما پاک شود و نسخه‌ی اولیه‌ی این مطلب برگردد؟">نسخه‌ی اولیه</button></form>` : ''}
<form method="post" action="/admin/settings/blog/delete">${hidden(p.slug)}<button class="btn btn-sm btn-danger" data-confirm="این مطلب از سایت حذف شود؟">حذف</button></form>`;
    return `<tr${p.deleted ? ' class="row-off"' : ''}><td><strong>${esc(brand(p.title))}</strong><br><span class="muted slug">${esc(p.slug)}</span></td><td>${esc(faDate(p.date))}</td><td>${status}<br>${source[p.source]}</td><td><div class="row actions">${actions}</div></td></tr>`;
  }).join('');
  return `<div class="row-between" style="margin-bottom:14px"><p class="muted" style="margin:0">مطالب مجله در <a href="/blog" target="_blank" rel="noopener">/blog</a> و نقشه‌ی سایت (sitemap) می‌آیند. مطالب اولیه را هم می‌توانید ویرایش یا حذف کنید.</p>
<a class="btn btn-primary" href="/admin/settings/blog/new">+ نوشتن مطلب جدید</a></div>
<div class="panel"><div class="table-wrap"><table class="table blog-table"><thead><tr><th>عنوان</th><th>تاریخ</th><th>وضعیت</th><th></th></tr></thead><tbody>
${rows || '<tr><td colspan="4" class="muted">مطلبی نیست.</td></tr>'}
</tbody></table></div></div>`;
}

const HTML_HELP = `<details class="html-help"><summary>راهنمای کوتاه نوشتن متن (HTML)</summary>
<table class="table"><tbody>
<tr><td><code>&lt;h2&gt;تیتر بخش&lt;/h2&gt;</code></td><td>تیتر هر بخش (زیرتیتر: <code>&lt;h3&gt;</code>)</td></tr>
<tr><td><code>&lt;p&gt;یک پاراگراف&lt;/p&gt;</code></td><td>هر پاراگراف بین این دو</td></tr>
<tr><td><code>&lt;strong&gt;مهم&lt;/strong&gt;</code></td><td>متن پررنگ</td></tr>
<tr><td><code>&lt;ul&gt;&lt;li&gt;مورد&lt;/li&gt;&lt;/ul&gt;</code></td><td>فهرست نقطه‌ای (شماره‌دار: <code>&lt;ol&gt;</code>)</td></tr>
<tr><td><code>&lt;a href="/pricing"&gt;قیمت‌ها&lt;/a&gt;</code></td><td>لینک</td></tr>
<tr><td><code>&lt;blockquote&gt;نکته&lt;/blockquote&gt;</code></td><td>کادر نکته</td></tr>
</tbody></table>
<p class="hint">${SITE_HINT} این متن HTML است و همان‌طور که می‌نویسید نمایش داده می‌شود.</p></details>`;

function blogEdit(p, { errors = {}, isNew = false } = {}) {
  const e = k => (errors[k] ? `<span class="field-error">${esc(errors[k])}</span>` : '');
  const builtin = !isNew && content.isBuiltinPost(p.orig || p.slug);
  return `<p><a href="/admin/settings/blog">→ بازگشت به فهرست مطالب</a></p>
<form class="form settings-form" method="post" action="/admin/settings/blog/save" novalidate>
<input type="hidden" name="orig" value="${esc(isNew ? '' : (p.orig || p.slug))}">
<div class="blog-edit-grid">
  <div class="panel">
    <h2>${isNew ? 'مطلب جدید' : 'ویرایش مطلب'}</h2>
    <div class="field${errors.title ? ' has-error' : ''}"><label for="b-title">عنوان</label><input id="b-title" type="text" name="title" maxlength="200" required value="${esc(p.title)}" data-slug-source>${e('title')}</div>
    <div class="field${errors.slug ? ' has-error' : ''}"><label for="b-slug">نامک (آدرس مطلب)</label>
      <div class="input-prefix"><span class="ltr">/blog/</span><input id="b-slug" type="text" name="slug" maxlength="100" dir="auto" value="${esc(p.slug)}"${builtin ? ' readonly' : ''} data-slug-target placeholder="${esc(slugify(p.title))}"></div>
      <span class="hint">${builtin ? 'نامک مطالب اولیه ثابت است تا لینک‌های قبلی خراب نشود.' : 'خالی بگذارید تا از روی عنوان ساخته شود. فقط حروف فارسی یا انگلیسی، عدد و خط تیره.'}</span>${e('slug')}</div>
    <div class="field${errors.meta ? ' has-error' : ''}"><label for="b-meta">توضیح متا (برای گوگل)</label><textarea id="b-meta" name="meta" rows="2" maxlength="320" data-count="160">${esc(p.metaDescription)}</textarea><span class="hint char-count" data-count-for="b-meta"></span><span class="hint">خلاصه‌ی یکی‌دو جمله‌ای که زیر عنوان در نتایج گوگل می‌آید. بهترین طول: ۱۲۰ تا ۱۶۰ نویسه.</span>${e('meta')}</div>
    <div class="field${errors.body ? ' has-error' : ''}"><label for="b-body">متن مطلب (HTML)</label><textarea id="b-body" name="body" rows="24" class="code-input">${esc(p.bodyHtml)}</textarea>${e('body')}</div>
    ${HTML_HELP}
  </div>
  <div class="panel blog-side">
    <div class="field${errors.date ? ' has-error' : ''}"><label for="b-date">تاریخ انتشار</label><input id="b-date" type="date" class="ltr" name="date" value="${esc(p.date)}">${p.date && validDay(p.date) ? `<span class="hint">${esc(faDate(p.date))}</span>` : ''}${e('date')}</div>
    <div class="field${errors.minutes ? ' has-error' : ''}"><label for="b-min">زمان مطالعه (دقیقه)</label><input id="b-min" type="text" inputmode="numeric" class="ltr" name="minutes" value="${esc(p.readingMinutes ?? '')}" placeholder="خودکار"><span class="hint">خالی = خودکار از روی طول متن</span>${e('minutes')}</div>
    <div class="field"><label class="check"><input type="hidden" name="published" value="0"><input type="checkbox" name="published" value="1"${p.published ? ' checked' : ''}> منتشر شود</label><span class="hint">اگر تیک نخورد، پیش‌نویس می‌ماند و فقط شما می‌بینید.</span></div>
    <button class="btn btn-primary btn-block">ذخیره</button>
    ${!isNew ? `<a class="btn btn-ghost btn-block" style="margin-top:8px" href="${esc(postUrl(p.orig || p.slug))}" target="_blank" rel="noopener">مشاهده ↗</a>` : ''}
  </div>
</div>
</form>`;
}

router.get('/admin/settings/blog', (req, res) => render(req, res, 'blog', blogList()));

router.get('/admin/settings/blog/new', (req, res) => {
  render(req, res, 'blog', blogEdit({ title: '', slug: '', metaDescription: '', bodyHtml: '', date: new Date().toISOString().slice(0, 10), readingMinutes: '', published: true }, { isNew: true }));
});

router.get('/admin/settings/blog/edit', (req, res) => {
  const p = content.rawPost(str(req.query.slug));
  if (!p) return res.redirect('/admin/settings/blog');
  render(req, res, 'blog', blogEdit(p));
});

router.post('/admin/settings/blog/save', form, (req, res) => {
  const b = req.body;
  const orig = str(b.orig).trim();
  if (orig && !content.rawPost(orig)) return res.redirect('/admin/settings/blog');
  const builtin = !!orig && content.isBuiltinPost(orig);
  const title = str(b.title).trim().replace(/\s+/g, ' ');
  const slug = builtin ? orig : slugify(str(b.slug).trim() || title);
  const meta = str(b.meta).trim().replace(/\s+/g, ' ');
  const date = enDigits(str(b.date).trim());
  const minutesRaw = enDigits(str(b.minutes).trim());
  const bodyHtml = str(b.body).trim();
  const published = str(b.published) === '1';
  const errors = {};
  if (!title) errors.title = 'عنوان را وارد کنید.';
  else if (title.length > 200) errors.title = 'عنوان حداکثر ۲۰۰ نویسه.';
  if (!slug) errors.slug = 'نامک را وارد کنید (حروف فارسی یا انگلیسی، عدد و خط تیره).';
  else if (slug !== orig && slugTaken(slug)) errors.slug = 'این نامک برای مطلب دیگری استفاده شده (شاید یک مطلب حذف‌شده). نامک دیگری بنویسید.';
  if (meta.length > 320) errors.meta = 'توضیح متا حداکثر ۳۲۰ نویسه.';
  if (!validDay(date)) errors.date = 'تاریخ معتبر وارد کنید.';
  let readingMinutes = estimateMinutes(bodyHtml);
  if (minutesRaw) {
    if (!/^\d+$/.test(minutesRaw) || Number(minutesRaw) < 1 || Number(minutesRaw) > 240) errors.minutes = 'عددی بین ۱ تا ۲۴۰.';
    else readingMinutes = Number(minutesRaw);
  }
  if (!bodyHtml) errors.body = 'متن مطلب خالی است.';
  else if (bodyHtml.length > 500_000) errors.body = 'متن خیلی طولانی است.';
  if (Object.keys(errors).length) {
    const p = { orig, title, slug: builtin ? orig : str(b.slug).trim(), metaDescription: meta, date, readingMinutes: minutesRaw, bodyHtml, published };
    return render(req, res, 'blog', blogEdit(p, { errors, isNew: !orig }), { status: 400, error: 'بعضی از فیلدها ایراد دارند. چیزی ذخیره نشد.' });
  }
  settings.posts.save({ slug, title, metaDescription: meta, bodyHtml, date, readingMinutes, published }, orig && !builtin ? orig : null);
  res.redirect('/admin/settings/blog?ok=1');
});

router.post('/admin/settings/blog/publish', form, (req, res) => {
  const slug = str(req.body.slug);
  const published = str(req.body.published) === '1';
  const p = content.rawPost(slug);
  if (p) {
    if (settings.posts.get(slug)) settings.posts.setPublished(slug, published);
    else settings.posts.save({ ...p, published }); // first change to a built-in post: copy it
  }
  res.redirect('/admin/settings/blog?ok=published');
});

router.post('/admin/settings/blog/delete', form, (req, res) => {
  const slug = str(req.body.slug);
  if (content.rawPost(slug)) settings.posts.remove(slug, { tombstone: content.isBuiltinPost(slug) });
  res.redirect('/admin/settings/blog?ok=deleted');
});

// Built-in posts only: drop the admin's edits / tombstone.
router.post('/admin/settings/blog/restore', form, (req, res) => {
  const slug = str(req.body.slug);
  if (content.isBuiltinPost(slug)) settings.posts.reset(slug);
  res.redirect('/admin/settings/blog?ok=restored');
});

// ---- Static pages: terms / privacy / about -------------------------------------

const PAGE_LABELS = { terms: 'قوانین و مقررات', privacy: 'حریم خصوصی', about: 'درباره ما' };

function pagesView(key, { values = null, errors = {} } = {}) {
  const raw = content.rawPage(key);
  const v = values || raw;
  const e = k => (errors[k] ? `<span class="field-error">${esc(errors[k])}</span>` : '');
  return `<nav class="sub-tabs" aria-label="صفحه‌ها">${content.PAGE_KEYS.map(k => `<a href="/admin/settings/pages?key=${k}"${k === key ? ' class="active" aria-current="page"' : ''}>${PAGE_LABELS[k]}</a>`).join('')}</nav>
<form class="form settings-form" method="post" action="/admin/settings/pages" novalidate>
<input type="hidden" name="key" value="${esc(key)}">
<div class="panel"><div class="row-between"><h2 style="margin:0">${PAGE_LABELS[key]} <a class="hint" href="/${key}" target="_blank" rel="noopener">/${key} ↗</a></h2>${raw.edited ? '<span class="badge primary">ویرایش‌شده</span>' : '<span class="badge">متن اولیه</span>'}</div>
  <div class="notice" style="margin:12px 0">متن این صفحه‌ها HTML است و همان‌طور که می‌نویسید نمایش داده می‌شود. متن اولیه یک الگوی عمومی است؛ پیش از راه‌اندازی، آن را با اطلاعات واقعی کسب‌وکارتان کامل کنید و در صورت امکان به تأیید مشاور حقوقی برسانید.</div>
  <div class="field${errors.title ? ' has-error' : ''}"><label for="p-title">عنوان</label><input id="p-title" type="text" name="title" maxlength="120" value="${esc(v.title)}">${e('title')}</div>
  <div class="field${errors.body ? ' has-error' : ''}"><label for="p-body">متن (HTML)</label><textarea id="p-body" name="body" rows="26" class="code-input">${esc(v.bodyHtml)}</textarea>${e('body')}</div>
  ${HTML_HELP}
</div>
${saveBar('pages')}
</form>
${raw.edited ? `<form class="reset-form" method="post" action="/admin/settings/pages/reset"><input type="hidden" name="key" value="${esc(key)}"><button class="btn btn-sm btn-ghost" data-confirm="ویرایش‌های این صفحه پاک شود و متن اولیه برگردد؟">↺ برگرداندن متن اولیه</button></form>` : ''}`;
}

const pageKey = k => (content.PAGE_KEYS.includes(k) ? k : content.PAGE_KEYS[0]);

router.get('/admin/settings/pages', (req, res) => render(req, res, 'pages', pagesView(pageKey(str(req.query.key)))));

router.post('/admin/settings/pages', form, (req, res) => {
  const key = str(req.body.key);
  if (!content.PAGE_KEYS.includes(key)) return res.redirect('/admin/settings/pages');
  const title = str(req.body.title).trim().replace(/\s+/g, ' ');
  const bodyHtml = str(req.body.body).trim();
  const errors = {};
  if (!title) errors.title = 'عنوان را وارد کنید.';
  if (!bodyHtml) errors.body = 'متن صفحه خالی است.';
  else if (bodyHtml.length > 500_000) errors.body = 'متن خیلی طولانی است.';
  if (Object.keys(errors).length) {
    return render(req, res, 'pages', pagesView(key, { values: { title, bodyHtml }, errors }), { status: 400, error: 'بعضی از فیلدها ایراد دارند. چیزی ذخیره نشد.' });
  }
  const base = content.builtin.pages[key] || {};
  const same = base.title === title && String(base.bodyHtml || '').trim() === bodyHtml;
  settings.set(`page:${key}`, same ? null : { title, bodyHtml });
  res.redirect(`/admin/settings/pages?key=${key}&ok=1`);
});

router.post('/admin/settings/pages/reset', form, (req, res) => {
  const key = pageKey(str(req.body.key));
  settings.set(`page:${key}`, null);
  res.redirect(`/admin/settings/pages?key=${key}&ok=reset`);
});

module.exports = router;
module.exports.slugify = slugify;

'use strict';
// "اتصال به CRM و مرکز تماس": API keys, webhooks (+ delivery log), dial-link
// preset, Asterisk / Issabel AMI click-to-call, the screen-pop link, and the
// caller lookup page. Also mounts the token-authenticated REST API (/api/v1)
// and the public, signed screen-pop page (/pop/<token>).
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const integrations = require('../integrations');
const webhooks = require('../integrations/webhooks');
const apiKeys = require('../integrations/apiKeys');
const contacts = require('../integrations/contacts');
const dispatch = require('../integrations/dispatch');
const docs = require('../integrations/docs');
const { dashPage } = require('../views/layout');
const { faDateTime, ago } = require('../views/helpers');
const { esc, faDigits, formatNumber, shortId, rateLimiter, clientIp } = require('../util');

const { settings, ami, phone } = integrations;

integrations.init();

const router = express.Router();

// Token-authenticated REST API. It has no cookie session and no same-origin
// check; it is mounted first so nothing cookie-based can intercept it.
router.use(require('./apiV1'));

const form = express.urlencoded({ extended: false, limit: '16kb' });
const json = express.json({ limit: '8kb' });
const amiLimit = rateLimiter({ windowMs: 60_000, max: 20 });
const popLimit = rateLimiter({ windowMs: 60_000, max: 120 });

router.use(['/app/integrations', '/app/lookup'], auth.requireUser, auth.sameOrigin);

const BASE = '/app/integrations';

// ---- Helpers ---------------------------------------------------------------------------

function userBots(user) {
  return db.get().prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(user.id);
}

function render(req, res, { title, body, flash = '' }) {
  const list = userBots(req.user);
  res.send(dashPage({ title, body, user: req.user, bot: list[0] || null, bots: list, active: 'integrations', flash }));
}

function ownedBotId(req, raw) {
  const id = Number(raw);
  if (!id) return null;
  return userBots(req.user).some(b => b.id === id) ? id : null;
}

function wantsJson(req) {
  return req.is('application/json') || String(req.headers.accept || '').includes('application/json');
}

function cookieHeader(name, value, maxAgeSec) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/app; SameSite=Lax; HttpOnly; Max-Age=${maxAgeSec}`;
  if (config.siteUrl.startsWith('https://')) c += '; Secure';
  return c;
}

function readCookie(req, name) {
  return (req.cookies && req.cookies[name]) || '';
}

// One-time display of a freshly created API key (only its hash is stored).
const newKeys = new Map();
function stashKey(userId, key) {
  const now = Date.now();
  for (const [k, v] of newKeys) if (v.expires < now) newKeys.delete(k);
  const nonce = shortId(16);
  newKeys.set(nonce, { userId, key, expires: now + 10 * 60_000 });
  return nonce;
}
function takeKey(userId, nonce) {
  const v = newKeys.get(String(nonce || ''));
  if (!v || v.userId !== userId || v.expires < Date.now()) return '';
  newKeys.delete(String(nonce));
  return v.key;
}

const FLASH = {
  key_revoked: 'کلید باطل شد. سیستم‌هایی که از آن استفاده می‌کردند دیگر دسترسی ندارند.',
  hook_added: 'وب‌هوک اضافه شد. یک «رویداد آزمایشی» بفرستید تا از درستی آدرس مطمئن شوید.',
  hook_saved: 'وب‌هوک ذخیره شد.',
  hook_deleted: 'وب‌هوک حذف شد.',
  hook_rotated: 'کلید امضای جدید ساخته شد. آن را در سیستم مقصد هم عوض کنید.',
  dial_saved: 'تنظیم لینک تماس ذخیره شد.',
  ami_saved: 'تنظیمات Asterisk / Issabel ذخیره شد.',
  ext_saved: 'داخلی شما برای این مرورگر ذخیره شد.',
  pop_created: 'لینک نمایش تماس‌گیرنده ساخته شد.',
  pop_revoked: 'لینک نمایش تماس‌گیرنده غیرفعال شد و دیگر باز نمی‌شود.',
};

const ERRORS = {
  bad_url: 'آدرس وب‌هوک معتبر نیست (باید با http:// یا https:// شروع شود).',
  blocked_address: 'این آدرس به شبکه‌ی داخلی اشاره می‌کند و برای امنیت مجاز نیست. آدرس عمومی سرور CRM را بدهید.',
  dns_failed: 'این دامنه پیدا نشد. آدرس را بررسی کنید.',
  no_events: 'دست‌کم یک رویداد را انتخاب کنید.',
  too_many: 'حداکثر ۱۰ وب‌هوک و ۲۰ کلید فعال برای هر حساب.',
  bad_template: 'الگوی دلخواه معتبر نیست: باید با یک پروتکل (مثل sip: یا https:) شروع شود، {phone} داشته باشد و فاصله نداشته باشد.',
  bad_host: 'آدرس سرور معتبر نیست یا مجاز نیست (فقط نام دامنه یا IP، بدون http://).',
  bad_port: 'پورت باید عددی بین ۱ تا ۶۵۵۳۵ باشد (معمولاً ۵۰۳۸).',
  bad_field: 'نام کاربری و Context فقط می‌توانند حروف انگلیسی، عدد، نقطه، خط تیره و زیرخط داشته باشند.',
  rate_limited: 'تعداد درخواست‌ها زیاد بود؛ یک دقیقه‌ی دیگر امتحان کنید.',
};

function flashOf(req) {
  const q = req.query;
  if (FLASH[q.ok]) return `<span>${esc(FLASH[q.ok])}</span>`;
  if (q.test) {
    const code = Number(q.code) || 0;
    return q.test === 'ok'
      ? `<span>رویداد رسید ✅ (پاسخ ${faDigits(code)})</span>`
      : `<span class="ig-flash-err">ارسال نرسید${code ? ` (پاسخ ${faDigits(code)})` : ''}. جزئیات را در «ارسال‌های اخیر» ببینید؛ خودکار دوباره تلاش می‌کنیم.</span>`;
  }
  if (q.ami && ami.MESSAGES[q.ami]) {
    return q.ami === 'ok' ? '<span>اتصال به مرکز تماس برقرار شد ✅</span>' : `<span class="ig-flash-err">${esc(ami.MESSAGES[q.ami])}</span>`;
  }
  return '';
}

function errorOf(req) {
  return ERRORS[req.query.err] ? `<div class="error ig-alert" role="alert">${esc(ERRORS[req.query.err])}</div>` : '';
}

function botOptions(bots, selected) {
  return `<option value="">همه‌ی بات‌ها</option>${bots.map(b => `<option value="${b.id}"${b.id === selected ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}`;
}

function copyBox(id, text) {
  return `<div class="code-box ig-code"><button type="button" class="btn btn-sm btn-ghost copy-btn" data-copy="#${id}">کپی</button><code id="${id}">${esc(text)}</code></div>`;
}

function statusBadge(status) {
  return {
    success: '<span class="badge ok">رسید</span>',
    pending: '<span class="badge warn">در صف</span>',
    failed: '<span class="badge danger">ناموفق</span>',
  }[status] || `<span class="badge">${esc(status)}</span>`;
}

function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return String(text || ''); }
}

// ---- Page sections --------------------------------------------------------------------------

function intro() {
  const vendors = ['دیدار', 'پیام‌گستر', 'HubSpot', 'Salesforce', 'Zoho', 'RingCentral', 'Cisco', 'Issabel', 'Asterisk', 'Zoiper'];
  return `<section class="panel ig-hero">
  <div class="ig-cards">
    <a class="ig-card" href="#webhooks"><span class="ig-ic" aria-hidden="true">🔔</span><strong>وب‌هوک</strong><span>هر درخواست تماس یا گفتگوی تازه همان لحظه به CRM شما فرستاده می‌شود.</span></a>
    <a class="ig-card" href="#api"><span class="ig-ic" aria-hidden="true">🔑</span><strong>API</strong><span>CRM یا مرکز تماس اطلاعات مشتری و گفتگوها را بخواند و یادداشت بگذارد.</span></a>
    <a class="ig-card" href="#dial"><span class="ig-ic" aria-hidden="true">📞</span><strong>کلیک برای تماس</strong><span>شماره‌ها با یک کلیک در Zoiper، Jabber، سافت‌فون یا Issabel گرفته می‌شوند.</span></a>
    <a class="ig-card" href="#pop"><span class="ig-ic" aria-hidden="true">🪟</span><strong>نمایش تماس‌گیرنده</strong><span>وقتی مشتری زنگ می‌زند، سابقه‌ی گفتگوهایش جلوی اپراتور باز می‌شود.</span></a>
  </div>
  <div class="ig-vendors"><span class="muted">با این‌ها کار می‌کند:</span>${vendors.map(v => `<span class="chip">${esc(v)}</span>`).join('')}<span class="chip">و هر سیستم دیگر</span></div>
  <p class="muted ig-honest">برای هر نرم‌افزار رابط اختصاصی جداگانه نساخته‌ایم؛ از روش‌های استانداردی استفاده می‌کنیم که همه‌ی این سیستم‌ها دارند: «وب‌هوک ورودی» یا «فراخوانی API» در CRMها (دیدار، پیام‌گستر، HubSpot، Salesforce، Zoho) و لینک تماس و «باز کردن آدرس هنگام تماس ورودی» در مراکز تماس و سافت‌فون‌ها (RingCentral، Cisco، Zoiper، Issabel). اگر نرم‌افزار شما هیچ‌کدام از این‌ها را ندارد، معمولاً با یک اسکریپت کوچک یا ابزاری مثل n8n وصل می‌شود.</p>
</section>`;
}

function apiSection(req, bots, newKey) {
  const keys = apiKeys.list(req.user.id);
  const rows = keys.map(k => `<tr class="${k.revoked_at ? 'ig-off' : ''}">
    <td><strong>${esc(k.name || 'بدون نام')}</strong></td>
    <td class="ltr"><code>${esc(k.prefix)}…</code></td>
    <td>${k.bot_id ? esc(k.bot_name || '—') : '<span class="muted">همه‌ی بات‌ها</span>'}</td>
    <td class="muted">${esc(ago(k.created_at))}</td>
    <td class="muted">${k.last_used_at ? esc(ago(k.last_used_at)) : 'هنوز نه'}</td>
    <td>${k.revoked_at ? '<span class="badge">باطل شده</span>' : `<form method="post" action="${BASE}/keys/${k.id}/revoke"><button class="btn btn-sm btn-danger" data-confirm="این کلید باطل شود؟ سیستم‌هایی که از آن استفاده می‌کنند قطع می‌شوند.">ابطال</button></form>`}</td>
  </tr>`).join('');
  return `<section class="panel ig-section" id="api">
  <div class="ig-head"><span class="ig-ic" aria-hidden="true">🔑</span><div><h2>کلیدهای API</h2>
  <p class="muted">CRM یا مرکز تماس با این کلید به API دسترسی پیدا می‌کند: درخواست‌های تماس، گفتگوها، جست‌وجوی شماره و سؤال و جواب‌ها. هر کلید فقط اطلاعات حساب شما (یا فقط یک بات) را می‌بیند.</p></div></div>
  ${newKey ? `<div class="ig-newkey" role="status"><strong>کلید جدید ساخته شد. همین حالا کپی‌اش کنید؛ دیگر نمایش داده نمی‌شود.</strong>${copyBox('new-api-key', newKey)}</div>` : ''}
  ${keys.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>نام</th><th>کلید</th><th>دسترسی</th><th>ساخته شده</th><th>آخرین استفاده</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="ig-empty">هنوز کلیدی نساخته‌اید.</p>'}
  <form class="ig-inline-form" method="post" action="${BASE}/keys">
    <div class="field"><label for="key-name">نام کلید</label><input id="key-name" name="name" type="text" maxlength="60" placeholder="مثلاً: CRM دیدار" required></div>
    <div class="field"><label for="key-bot">دسترسی به</label><select id="key-bot" name="bot">${botOptions(bots, null)}</select></div>
    <button class="btn btn-primary">ساخت کلید</button>
  </form>
</section>`;
}

function deliveryRows(hook, list) {
  if (!list.length) return '<p class="ig-empty">هنوز چیزی فرستاده نشده.</p>';
  return `<div class="table-wrap"><table class="table ig-deliveries"><thead><tr><th>زمان</th><th>رویداد</th><th>وضعیت</th><th>پاسخ</th><th>مدت</th><th>تلاش</th><th></th></tr></thead><tbody>
${list.map(d => `<tr>
  <td class="muted" title="${esc(faDateTime(d.created_at))}">${esc(ago(d.created_at))}</td>
  <td class="ltr"><code>${esc(d.event)}</code></td>
  <td>${statusBadge(d.status)}${d.status === 'pending' && d.attempts && d.next_attempt_at ? `<div class="hint">تلاش بعدی: ${esc(faDateTime(d.next_attempt_at))}</div>` : ''}</td>
  <td class="ltr">${d.response_code ? `<code>${esc(d.response_code)}</code>` : ''}${d.error && !/^http_/.test(d.error) ? ` <span class="hint">${esc(d.error)}</span>` : ''}</td>
  <td class="muted ltr">${d.duration_ms != null ? `${esc(d.duration_ms)} ms` : ''}</td>
  <td class="muted">${faDigits(d.attempts)}</td>
  <td><div class="ig-actions">
    <details class="ig-payload"><summary class="btn btn-sm btn-ghost">محتوا</summary>
      <div class="ig-payload-body"><div class="hint ltr">X-Pasokhyar-Delivery: ${esc(d.uid)}</div><pre class="code-box">${esc(prettyJson(d.body))}</pre>
      ${d.response_body ? `<div class="hint">پاسخ سرور مقصد:</div><pre class="code-box">${esc(d.response_body)}</pre>` : ''}</div>
    </details>
    ${hook.enabled && d.status !== 'pending' ? `<form method="post" action="${BASE}/deliveries/${d.id}/redeliver"><button class="btn btn-sm btn-outline">ارسال دوباره</button></form>` : ''}
  </div></td>
</tr>`).join('')}
</tbody></table></div>`;
}

function eventChecks(selected) {
  return Object.entries(webhooks.EVENTS).map(([name, label]) => `<label class="ig-event"><input type="checkbox" name="events" value="${name}"${selected.includes(name) ? ' checked' : ''}><span><code>${name}</code><small>${esc(label)}</small></span></label>`).join('');
}

function webhooksSection(req, bots) {
  const hooks = webhooks.list(req.user.id);
  const openId = Number(req.query.open) || 0;
  const cards = hooks.map(h => {
    const list = webhooks.deliveries(h.id);
    const failing = h.last_status === 'failed';
    return `<article class="ig-hook${h.enabled ? '' : ' ig-off'}" id="hook-${h.id}">
  <div class="ig-hook-top">
    <div class="ig-hook-url"><code class="ltr">${esc(h.url)}</code>${h.description ? `<div class="muted">${esc(h.description)}</div>` : ''}</div>
    <div class="row">${h.enabled ? (failing ? '<span class="badge danger">خطا در ارسال</span>' : '<span class="badge ok">فعال</span>') : '<span class="badge">غیرفعال</span>'}
      <span class="badge primary">${h.bot_id ? esc(h.bot_name || '—') : 'همه‌ی بات‌ها'}</span></div>
  </div>
  <div class="ig-hook-events">${h.events.map(e => `<span class="chip ltr">${esc(e)}</span>`).join('') || '<span class="muted">رویدادی انتخاب نشده</span>'}</div>
  <div class="row ig-hook-actions">
    ${h.enabled ? `<form method="post" action="${BASE}/webhooks/${h.id}/test"><button class="btn btn-sm btn-primary">ارسال رویداد آزمایشی</button></form>` : ''}
    <form method="post" action="${BASE}/webhooks/${h.id}/toggle"><button class="btn btn-sm btn-ghost">${h.enabled ? 'غیرفعال کن' : 'فعال کن'}</button></form>
    <form method="post" action="${BASE}/webhooks/${h.id}/delete"><button class="btn btn-sm btn-danger" data-confirm="این وب‌هوک و سابقه‌ی ارسال‌هایش حذف شود؟">حذف</button></form>
  </div>
  <details class="ig-fold"><summary>کلید امضا (برای بررسی X-Pasokhyar-Signature)</summary>
    ${copyBox(`secret-${h.id}`, h.secret)}
    <form method="post" action="${BASE}/webhooks/${h.id}/rotate"><button class="btn btn-sm btn-ghost" data-confirm="کلید امضای جدید ساخته شود؟ کلید قبلی بلافاصله از کار می‌افتد.">ساخت کلید جدید</button></form>
  </details>
  <details class="ig-fold"><summary>ویرایش آدرس و رویدادها</summary>
    <form class="form" method="post" action="${BASE}/webhooks/${h.id}">
      <div class="field"><label for="wh-url-${h.id}">آدرس</label><input id="wh-url-${h.id}" type="url" name="url" class="ltr" required maxlength="500" value="${esc(h.url)}"></div>
      <div class="field"><label for="wh-desc-${h.id}">توضیح</label><input id="wh-desc-${h.id}" type="text" name="description" maxlength="120" value="${esc(h.description)}"></div>
      <div class="field"><span class="label">رویدادها</span><div class="ig-events">${eventChecks(h.events)}</div></div>
      <div class="field"><label for="wh-bot-${h.id}">فقط برای</label><select id="wh-bot-${h.id}" name="bot">${botOptions(bots, h.bot_id)}</select></div>
      <div><button class="btn btn-primary btn-sm">ذخیره</button></div>
    </form>
  </details>
  <details class="ig-fold"${openId === h.id ? ' open' : ''}><summary>ارسال‌های اخیر (${faDigits(list.length)})</summary>${deliveryRows(h, list)}</details>
</article>`;
  }).join('');
  const prefill = String(req.query.url || '').slice(0, 500);
  return `<section class="panel ig-section" id="webhooks">
  <div class="ig-head"><span class="ig-ic" aria-hidden="true">🔔</span><div><h2>وب‌هوک‌ها</h2>
  <p class="muted">آدرسی از CRM یا مرکز تماس‌تان بدهید؛ هر رویدادی که انتخاب کنید همان لحظه به‌صورت JSON با امضای HMAC به آن فرستاده می‌شود. اگر مقصد جواب نداد، تا ${faDigits(webhooks.MAX_ATTEMPTS)} بار با فاصله‌ی بیشتر دوباره تلاش می‌کنیم.</p></div></div>
  ${cards || '<p class="ig-empty">هنوز وب‌هوکی ندارید.</p>'}
  <details class="ig-add"${hooks.length && !prefill ? '' : ' open'}><summary class="btn btn-outline">➕ افزودن وب‌هوک</summary>
    <form class="form" method="post" action="${BASE}/webhooks">
      <div class="field"><label for="wh-url">آدرس دریافت (Webhook URL)</label><input id="wh-url" type="url" name="url" class="ltr" required maxlength="500" placeholder="https://crm.example.ir/webhooks/pasokhyar" value="${esc(prefill)}">
        <span class="hint">آدرس «وب‌هوک ورودی» (Incoming webhook) که CRM شما می‌دهد. آدرس‌های شبکه‌ی داخلی (مثل 192.168.x.x) پذیرفته نمی‌شوند.</span></div>
      <div class="field"><label for="wh-desc">توضیح <span class="hint">(اختیاری)</span></label><input id="wh-desc" type="text" name="description" maxlength="120" placeholder="مثلاً: ثبت سرنخ در دیدار"></div>
      <div class="field"><span class="label">رویدادها</span><div class="ig-events">${eventChecks(['lead.created', 'conversation.handoff'])}</div></div>
      <div class="field"><label for="wh-bot">فقط برای</label><select id="wh-bot" name="bot">${botOptions(bots, null)}</select></div>
      <div><button class="btn btn-primary">افزودن وب‌هوک</button></div>
    </form>
  </details>
</section>`;
}

function dialSection(req, s) {
  const presets = Object.entries(integrations.DIAL_PRESETS).map(([id, p]) => `<label class="ig-preset">
    <input type="radio" name="preset" value="${id}"${s.dial_preset === id ? ' checked' : ''}>
    <span><strong>${esc(p.label)}</strong><code class="ltr">${esc(p.template || 'your-app:{phone}')}</code><small>${esc(p.hint)}</small></span>
  </label>`).join('');
  const href = integrations.dialHref(req.user, '09121234567', s);
  return `<section class="panel ig-section" id="dial">
  <div class="ig-head"><span class="ig-ic" aria-hidden="true">📱</span><div><h2>لینک تماس (کلیک برای تماس)</h2>
  <p class="muted">شماره‌ی مشتری‌ها در درخواست‌های تماس، گفتگوی زنده و کنترل کیفیت به لینک تبدیل می‌شود. مشخص کنید با کلیک روی آن کدام برنامه شماره را بگیرد.</p></div></div>
  <form class="form" method="post" action="${BASE}/dial" id="dial-form">
    <div class="ig-presets">${presets}</div>
    <div class="ig-grid">
      <div class="field" data-show="custom"><label for="dial-tpl">الگوی دلخواه</label><input id="dial-tpl" name="template" type="text" class="ltr" maxlength="300" placeholder="microsip:{phone}" value="${esc(s.dial_template)}">
        <span class="hint">{phone} = شماره (مثل 09121234567)، {e164} = ‎+989121234567، {domain} = دامنه‌ی SIP</span></div>
      <div class="field" data-show="sip"><label for="dial-domain">دامنه یا IP مرکز تماس (SIP)</label><input id="dial-domain" name="domain" type="text" class="ltr" maxlength="120" placeholder="pbx.example.ir" value="${esc(s.sip_domain)}"></div>
      <div class="field"><label for="dial-prefix">پیش‌شماره <span class="hint">(اختیاری)</span></label><input id="dial-prefix" name="prefix" type="text" class="ltr" maxlength="8" placeholder="مثلاً 9 برای خط بیرون" value="${esc(s.dial_prefix)}"></div>
    </div>
    <div class="ig-preview"><span class="muted">نمونه:</span> <a id="dial-preview" class="ltr" href="${esc(href)}">${esc(href)}</a></div>
    <div><button class="btn btn-primary">ذخیره</button></div>
  </form>
</section>`;
}

function amiSection(req, s) {
  const exts = settings.parseExtensions(s.ami_extensions);
  const mine = readCookie(req, 'ami_ext');
  const configured = ami.configured(s);
  const status = configured ? '<span class="badge ok">فعال</span>' : (s.ami_host ? '<span class="badge warn">خاموش یا ناقص</span>' : '<span class="badge">تنظیم نشده</span>');
  return `<section class="panel ig-section" id="ami">
  <div class="ig-head"><span class="ig-ic" aria-hidden="true">☎️</span><div><h2>تماس از طریق Asterisk / Issabel ${status}</h2>
  <p class="muted">اگر مرکز تماس‌تان Issabel، FreePBX یا Asterisk است، دکمه‌ی «📞 تماس» کنار شماره‌ها اول تلفن داخلی اپراتور را زنگ می‌زند و وقتی گوشی را برداشت، شماره‌ی مشتری را می‌گیرد (از طریق AMI). سرور ما باید به پورت AMI دسترسی داشته باشد: نسخه‌ی سازمانی روی شبکه‌ی خودتان، یا VPN / باز کردن پورت فقط برای IP سرور ما.</p></div></div>
  <form class="form" method="post" action="${BASE}/ami" autocomplete="off">
    <label class="check"><input type="checkbox" name="enabled" value="1"${s.ami_enabled ? ' checked' : ''}> دکمه‌ی تماس از طریق مرکز تماس فعال باشد</label>
    <div class="ig-grid">
      <div class="field"><label for="ami-host">آدرس سرور (IP یا دامنه)</label><input id="ami-host" name="host" type="text" class="ltr" maxlength="253" placeholder="192.168.1.10" value="${esc(s.ami_host)}"></div>
      <div class="field"><label for="ami-port">پورت AMI</label><input id="ami-port" name="port" type="number" class="ltr" min="1" max="65535" value="${esc(s.ami_port || 5038)}"></div>
      <div class="field"><label for="ami-user">نام کاربری AMI</label><input id="ami-user" name="username" type="text" class="ltr" maxlength="64" placeholder="pasokhyar" value="${esc(s.ami_username)}"></div>
      <div class="field"><label for="ami-secret">رمز AMI</label><input id="ami-secret" name="secret" type="password" class="ltr" maxlength="128" autocomplete="new-password" placeholder="${s.ami_secret ? '•••••••• ذخیره شده' : ''}">${s.ami_secret ? '<span class="hint">برای تغییر، رمز جدید را بنویسید؛ خالی بماند یعنی همان قبلی.</span>' : ''}</div>
      <div class="field"><label for="ami-tech">نوع داخلی</label><select id="ami-tech" name="tech">${ami.TECHS.map(t => `<option value="${t}"${s.ami_tech === t ? ' selected' : ''}>${t === 'Local' ? 'Local (از طریق dialplan)' : t}</option>`).join('')}</select>
        <span class="hint">Issabel ۴ معمولاً SIP و FreePBX جدید PJSIP.</span></div>
      <div class="field"><label for="ami-context">Context</label><input id="ami-context" name="context" type="text" class="ltr" maxlength="64" value="${esc(s.ami_context)}"><span class="hint">در Issabel و FreePBX معمولاً from-internal</span></div>
      <div class="field"><label for="ami-cid">Caller ID <span class="hint">(اختیاری)</span></label><input id="ami-cid" name="caller_id" type="text" class="ltr" maxlength="60" placeholder='"Support" &lt;02100000000&gt;' value="${esc(s.ami_caller_id)}"></div>
      <div class="field"><label for="ami-prefix">پیش‌شماره‌ی خط بیرون <span class="hint">(اختیاری)</span></label><input id="ami-prefix" name="prefix" type="text" class="ltr" maxlength="8" placeholder="9" value="${esc(s.ami_prefix)}"></div>
    </div>
    <div class="field"><label for="ami-exts">داخلی اپراتورها <span class="hint">(هر خط یکی: شماره‌ی داخلی و نام)</span></label><textarea id="ami-exts" name="extensions" class="ltr" rows="3" placeholder="101 Maryam&#10;102 Ali">${esc(s.ami_extensions)}</textarea></div>
    <div class="row"><button class="btn btn-primary">ذخیره</button></div>
  </form>
  <div class="ig-ami-tools">
    <form method="post" action="${BASE}/ami/test" class="row" data-ami-test><button class="btn btn-outline"${s.ami_host ? '' : ' disabled'}>🔌 آزمایش اتصال</button><span class="ig-result" aria-live="polite"></span></form>
    ${exts.length ? `<form method="post" action="${BASE}/ami/me" class="row"><label for="ami-me" class="label">داخلی من در این مرورگر:</label><select id="ami-me" name="ext" class="ig-auto">${exts.map(x => `<option value="${esc(x.ext)}"${x.ext === mine ? ' selected' : ''}>${esc(x.ext)}${x.name ? ` — ${esc(x.name)}` : ''}</option>`).join('')}</select><button class="btn btn-sm btn-ghost">ذخیره</button></form>` : ''}
    ${configured ? `<form method="post" action="${BASE}/call" class="row ami-call"><label for="ami-try" class="label">تماس آزمایشی با:</label><input id="ami-try" name="phone" type="tel" class="ltr ig-auto" maxlength="20" placeholder="09121234567" required><button class="btn btn-sm btn-outline">📞 تماس</button></form>` : ''}
  </div>
  <details class="ig-fold"><summary>نمونه‌ی تنظیم AMI در Issabel / FreePBX</summary>
    <p class="muted">یک کاربر AMI جداگانه با کمترین دسترسی بسازید و فقط IP سرور ما را مجاز کنید. هیچ‌وقت پورت ۵۰۳۸ را بدون محدودیت IP روی اینترنت باز نکنید.</p>
    ${copyBox('manager-conf', docs.MANAGER_CONF)}
  </details>
</section>`;
}

function popSection(req, s) {
  const t = integrations.popToken(req.user);
  const url = t ? `${config.siteUrl}/pop/${t}?phone={phone}` : '';
  const days = '<select name="days" class="ig-auto" aria-label="مدت اعتبار"><option value="365">اعتبار یک ساله</option><option value="90">سه ماهه</option><option value="30">یک ماهه</option></select>';
  return `<section class="panel ig-section" id="pop">
  <div class="ig-head"><span class="ig-ic" aria-hidden="true">🪟</span><div><h2>نمایش اطلاعات تماس‌گیرنده (Screen pop)</h2>
  <p class="muted">وقتی مشتری زنگ می‌زند، نرم‌افزار مرکز تماس این آدرس را با شماره‌ی او باز می‌کند و اپراتور بدون ورود به داشبورد، درخواست‌های تماس و متن گفتگوهای قبلی همان شماره را می‌بیند. لینک امضاشده، تاریخ‌دار و قابل ابطال است و فقط اطلاعات حساب شما را نشان می‌دهد.</p></div></div>
  ${t ? `<div class="field"><span class="label">آدرس برای نرم‌افزار مرکز تماس</span>${copyBox('pop-url', url)}
      <span class="hint">معتبر تا ${esc(faDateTime(s.pop_expires_at))}. به‌جای <code>{phone}</code> متغیر «شماره‌ی تماس‌گیرنده» (Caller ID / ANI) نرم‌افزار خودتان را بگذارید. هر کس این آدرس را داشته باشد اطلاعات تماس‌گیرنده‌ها را می‌بیند؛ آن را فقط در تنظیمات مرکز تماس بگذارید.</span></div>
    <div class="row ig-pop-actions">
      <a class="btn btn-sm btn-outline" href="/pop/${esc(t)}?phone=09121234567" target="_blank" rel="noopener noreferrer">نمایش نمونه ↗</a>
      <form method="post" action="${BASE}/pop" class="row">${days}<button class="btn btn-sm btn-ghost" data-confirm="لینک جدید ساخته شود؟ لینک فعلی دیگر کار نمی‌کند.">ساخت لینک جدید</button></form>
      <form method="post" action="${BASE}/pop/revoke"><button class="btn btn-sm btn-danger" data-confirm="لینک غیرفعال شود؟">غیرفعال کردن</button></form>
    </div>`
    : `<form method="post" action="${BASE}/pop" class="row">${days}<button class="btn btn-primary">ساخت لینک نمایش تماس‌گیرنده</button></form>`}
  <div class="ig-vendor-steps">
    <div><strong>Zoiper</strong><p>در نسخه‌هایی که گزینه‌ی باز کردن آدرس وب هنگام تماس ورودی دارند، این آدرس را بگذارید و به‌جای {phone} متغیر شماره‌ی تماس‌گیرنده‌ی Zoiper را قرار دهید.</p></div>
    <div><strong>Cisco Finesse</strong><p>یک Workflow با اکشن Browser Pop بسازید و به‌جای {phone} متغیر شماره‌ی تماس‌گیرنده (ANI) را بگذارید.</p></div>
    <div><strong>Issabel / FreePBX</strong><p>در ابزار CRM یا «Caller ID lookup / URL pop» پنل اپراتور، همین آدرس را با متغیر Caller ID تنظیم کنید؛ یا از API <code class="ltr">/api/v1/contacts?phone=</code> استفاده کنید.</p></div>
    <div><strong>RingCentral و بقیه</strong><p>هر نرم‌افزاری که «باز کردن آدرس وب با شماره‌ی تماس‌گیرنده» دارد، با همین آدرس کار می‌کند. نام دقیق متغیر شماره را از راهنمای همان نرم‌افزار بردارید.</p></div>
  </div>
  <p class="muted">اپراتورهایی که وارد داشبورد شده‌اند از <a href="/app/lookup">صفحه‌ی جست‌وجوی تماس‌گیرنده</a> (<code class="ltr">/app/lookup?phone=</code>) هم می‌توانند استفاده کنند.</p>
</section>`;
}

function docsSection() {
  const samples = docs.samples();
  const curls = docs.curl();
  return `<section class="panel ig-section" id="docs">
  <div class="ig-head"><span class="ig-ic" aria-hidden="true">📘</span><div><h2>راهنما و نمونه کد</h2>
  <p class="muted">برای برنامه‌نویس یا پشتیبان CRM شما. همه‌ی پاسخ‌ها JSON هستند و زمان‌ها ISO 8601 (به وقت UTC).</p></div></div>

  <h3>API نسخه‌ی ۱</h3>
  <p class="muted">هدر <code class="ltr">Authorization: Bearer &lt;کلید&gt;</code> را بفرستید. حداکثر ۱۲۰ درخواست در دقیقه برای هر کلید. فهرست‌ها <code>limit</code> (تا ۲۰۰) و <code>offset</code> می‌گیرند و <code>total</code> برمی‌گردانند. شماره‌ها در هر قالبی پذیرفته می‌شوند: <span class="ltr">09121234567</span>، <span class="ltr">+989121234567</span>، <span class="ltr">00989121234567</span> یا با ارقام فارسی.</p>
  <div class="table-wrap"><table class="table ig-endpoints"><thead><tr><th>متد</th><th>مسیر</th><th>کار</th></tr></thead><tbody>
  ${docs.ENDPOINTS.map(([m, p, d]) => `<tr><td><span class="ig-method ig-${m.toLowerCase()}">${m}</span></td><td class="ltr"><code>${esc(p)}</code></td><td>${esc(d)}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="ig-examples">${curls.map(([title, code], i) => `<div><div class="label">${esc(title)}</div>${copyBox(`curl-${i}`, code)}</div>`).join('')}</div>

  <h3>وب‌هوک‌ها</h3>
  <p class="muted">هر رویداد یک درخواست <code>POST</code> با بدنه‌ی JSON است، با این هدرها:</p>
  <ul class="ig-headers">
    <li><code class="ltr">X-Pasokhyar-Event</code> نام رویداد (مثلاً lead.created؛ برای رویداد آزمایشی ping)</li>
    <li><code class="ltr">X-Pasokhyar-Delivery</code> شناسه‌ی یکتای این ارسال (در ارسال دوباره عوض می‌شود؛ <code>id</code> داخل بدنه ثابت می‌ماند و برای جلوگیری از ثبت تکراری مناسب است)</li>
    <li><code class="ltr">X-Pasokhyar-Signature</code> <span class="ltr">sha256=&lt;hex&gt;</span>؛ HMAC-SHA256 بدنه‌ی خام با کلید امضای همان وب‌هوک</li>
    <li><code class="ltr">X-Pasokhyar-Timestamp</code> زمان ارسال (ثانیه‌ی یونیکس)</li>
  </ul>
  <p class="muted">هر پاسخ 2xx یعنی رسید. در غیر این صورت (یا اگر ظرف ۱۰ ثانیه جواب نیاید) بعد از ۳۰ ثانیه، ۲ دقیقه، ۱۰ دقیقه، ۱ ساعت و ۶ ساعت دوباره می‌فرستیم. ریدایرکت دنبال نمی‌شود.</p>
  <div class="ig-samples">${Object.entries(samples).map(([name, body]) => `<details class="ig-fold"><summary><code class="ltr">${esc(name)}</code> — ${esc(webhooks.EVENTS[name])}</summary><pre class="code-box">${esc(body)}</pre></details>`).join('')}</div>
  <p class="muted"><code>message.created</code> برای هر پیام فرستاده می‌شود؛ <code>sender</code> یکی از visitor، bot، operator، system یا note (یادداشت داخلی) است.</p>

  <h3>بررسی امضا</h3>
  <div class="ig-grid ig-grid-code">
    <div><div class="label">Node.js</div>${copyBox('verify-node', docs.VERIFY_NODE)}</div>
    <div><div class="label">PHP</div>${copyBox('verify-php', docs.VERIFY_PHP)}</div>
  </div>

  <h3>آدرس نمایش تماس‌گیرنده</h3>
  ${copyBox('pop-pattern', `${config.siteUrl}/pop/<TOKEN>?phone=<CALLER_ID>`)}
  <p class="muted">توکن را از بخش «نمایش اطلاعات تماس‌گیرنده» بردارید. شماره در هر قالبی پذیرفته می‌شود.</p>
</section>`;
}

// ---- Dashboard page -------------------------------------------------------------------------

router.get(BASE, (req, res) => {
  const bots = userBots(req.user);
  const s = settings.get(req.user);
  const newKey = takeKey(req.user.id, req.query.newkey);
  res.set('Cache-Control', 'no-store');
  render(req, res, {
    title: 'اتصال به CRM و مرکز تماس',
    flash: flashOf(req),
    body: `<div class="page-title"><div><h1>اتصال به CRM و مرکز تماس</h1><p class="muted ig-sub">پاسخ‌یار را به CRM، سافت‌فون و مرکز تماس‌تان وصل کنید.</p></div></div>
${errorOf(req)}
<nav class="ig-nav" aria-label="بخش‌های این صفحه">
  <a href="#api">🔑 کلید API</a><a href="#webhooks">🔔 وب‌هوک</a><a href="#dial">📱 لینک تماس</a><a href="#ami">☎️ Asterisk / Issabel</a><a href="#pop">🪟 نمایش تماس‌گیرنده</a><a href="#docs">📘 راهنما</a>
</nav>
${intro()}
${apiSection(req, bots, newKey)}
${webhooksSection(req, bots)}
${dialSection(req, s)}
${amiSection(req, s)}
${popSection(req, s)}
${docsSection()}
<script src="/js/integrations.js" defer></script>`,
  });
});

// ---- API keys -------------------------------------------------------------------------------

router.post(`${BASE}/keys`, form, (req, res) => {
  const active = apiKeys.list(req.user.id).filter(k => !k.revoked_at).length;
  if (active >= 20) return res.redirect(`${BASE}?err=too_many#api`);
  const { key } = apiKeys.create(req.user.id, { name: req.body.name || 'API', botId: ownedBotId(req, req.body.bot) });
  res.redirect(`${BASE}?newkey=${stashKey(req.user.id, key)}#api`);
});

router.post(`${BASE}/keys/:id/revoke`, form, (req, res) => {
  apiKeys.revoke(req.user.id, req.params.id);
  res.redirect(`${BASE}?ok=key_revoked#api`);
});

// ---- Webhooks -------------------------------------------------------------------------------

function eventsOf(body) {
  return webhooks.cleanEvents([].concat(body.events || []));
}

router.post(`${BASE}/webhooks`, form, async (req, res) => {
  const back = err => res.redirect(`${BASE}?err=${err}&url=${encodeURIComponent(String(req.body.url || '').slice(0, 500))}#webhooks`);
  if (webhooks.list(req.user.id).length >= 10) return back('too_many');
  const events = eventsOf(req.body);
  if (!events.length) return back('no_events');
  const v = await webhooks.validateUrl(req.body.url);
  if (!v.ok) return back(v.error);
  const hook = webhooks.create(req.user.id, { url: v.url, events, botId: ownedBotId(req, req.body.bot), description: req.body.description || '' });
  res.redirect(`${BASE}?ok=hook_added#hook-${hook.id}`);
});

router.post(`${BASE}/webhooks/:id`, form, async (req, res) => {
  const hook = webhooks.getOwned(req.user.id, req.params.id);
  if (!hook) return res.redirect(`${BASE}#webhooks`);
  const events = eventsOf(req.body);
  if (!events.length) return res.redirect(`${BASE}?err=no_events#hook-${hook.id}`);
  const v = await webhooks.validateUrl(req.body.url);
  if (!v.ok) return res.redirect(`${BASE}?err=${v.error}#hook-${hook.id}`);
  webhooks.update(req.user.id, hook.id, { url: v.url, events, botId: ownedBotId(req, req.body.bot), description: req.body.description || '' });
  res.redirect(`${BASE}?ok=hook_saved#hook-${hook.id}`);
});

router.post(`${BASE}/webhooks/:id/toggle`, form, (req, res) => {
  const hook = webhooks.getOwned(req.user.id, req.params.id);
  if (hook) webhooks.update(req.user.id, hook.id, { enabled: !hook.enabled });
  res.redirect(`${BASE}?ok=hook_saved#hook-${Number(req.params.id) || ''}`);
});

router.post(`${BASE}/webhooks/:id/delete`, form, (req, res) => {
  webhooks.remove(req.user.id, req.params.id);
  res.redirect(`${BASE}?ok=hook_deleted#webhooks`);
});

router.post(`${BASE}/webhooks/:id/rotate`, form, (req, res) => {
  webhooks.rotateSecret(req.user.id, req.params.id);
  res.redirect(`${BASE}?ok=hook_rotated#hook-${Number(req.params.id) || ''}`);
});

function deliveryResult(req, res, d) {
  return webhooks.deliverNow(d.id).then(after => {
    const ok = !!after && after.status === 'success';
    const code = (after && after.response_code) || 0;
    if (wantsJson(req)) return res.json({ ok, code, error: (after && after.error) || '' });
    res.redirect(`${BASE}?test=${ok ? 'ok' : 'fail'}&code=${code}&open=${d.webhook_id}#hook-${d.webhook_id}`);
  });
}

// Sends a "ping" and waits for the first attempt so the owner sees the result.
router.post(`${BASE}/webhooks/:id/test`, form, async (req, res) => {
  const hook = webhooks.getOwned(req.user.id, req.params.id);
  if (!hook || !hook.enabled) return res.redirect(`${BASE}#webhooks`);
  await deliveryResult(req, res, dispatch.testEvent(req.user.id, hook));
});

router.post(`${BASE}/deliveries/:id/redeliver`, form, async (req, res) => {
  const d = webhooks.redeliver(req.user.id, req.params.id);
  if (!d) return res.redirect(`${BASE}#webhooks`);
  await deliveryResult(req, res, d);
});

// ---- Dial link ------------------------------------------------------------------------------

router.post(`${BASE}/dial`, form, (req, res) => {
  const preset = integrations.DIAL_PRESETS[req.body.preset] ? req.body.preset : 'tel';
  const patch = {
    dial_preset: preset,
    sip_domain: String(req.body.domain || '').trim().replace(/[^A-Za-z0-9.:_-]/g, '').slice(0, 120),
    dial_prefix: String(req.body.prefix || '').trim().replace(/[^0-9*#+]/g, '').slice(0, 8),
  };
  const tpl = String(req.body.template || '').trim();
  if (preset === 'custom' || tpl) {
    const clean = integrations.cleanTemplate(tpl);
    if (!clean && preset === 'custom') return res.redirect(`${BASE}?err=bad_template#dial`);
    patch.dial_template = clean || '';
  }
  settings.save(req.user, patch);
  res.redirect(`${BASE}?ok=dial_saved#dial`);
});

// ---- Asterisk / Issabel AMI -------------------------------------------------------------------

router.post(`${BASE}/ami`, form, (req, res) => {
  const b = req.body;
  const host = String(b.host || '').trim();
  const port = Number(b.port || 5038);
  if (host && !ami.validHost(host)) return res.redirect(`${BASE}?err=bad_host#ami`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.redirect(`${BASE}?err=bad_port#ami`);
  const username = String(b.username || '').trim();
  const context = String(b.context || '').trim() || 'from-internal';
  if ((username && !/^[A-Za-z0-9_.@-]{1,64}$/.test(username)) || !/^[A-Za-z0-9_.-]{1,64}$/.test(context)) {
    return res.redirect(`${BASE}?err=bad_field#ami`);
  }
  const patch = {
    ami_enabled: b.enabled ? 1 : 0,
    ami_host: host,
    ami_port: port,
    ami_username: username,
    ami_tech: ami.TECHS.includes(b.tech) ? b.tech : 'PJSIP',
    ami_context: context,
    ami_caller_id: ami.clean(b.caller_id, 60),
    ami_prefix: String(b.prefix || '').replace(/[^0-9*#]/g, '').slice(0, 8),
    ami_extensions: settings.parseExtensions(b.extensions).map(x => (x.name ? `${x.ext} ${x.name}` : x.ext)).join('\n'),
  };
  const secret = String(b.secret || '');
  if (secret) patch.ami_secret = ami.clean(secret, 128);
  settings.save(req.user, patch);
  res.redirect(`${BASE}?ok=ami_saved#ami`);
});

router.post(`${BASE}/ami/test`, form, json, async (req, res) => {
  const r = amiLimit(`u${req.user.id}`)
    ? await ami.testConnection(settings.get(req.user))
    : { ok: false, code: 'rate_limited', message: ERRORS.rate_limited };
  if (wantsJson(req)) return res.json({ ok: r.ok, code: r.code, message: r.message });
  res.redirect(`${BASE}?ami=${ami.MESSAGES[r.code] ? r.code : 'connect_failed'}#ami`);
});

router.post(`${BASE}/ami/me`, form, (req, res) => {
  const exts = settings.parseExtensions(settings.get(req.user).ami_extensions);
  const ext = exts.find(x => x.ext === String(req.body.ext || ''));
  if (ext) res.append('Set-Cookie', cookieHeader('ami_ext', ext.ext, 365 * 86400));
  res.redirect(`${BASE}?ok=ext_saved#ami`);
});

// Click-to-call: rings the operator's extension, then the customer. The PBX
// host and port always come from the saved settings, never from the request;
// the extension must be one of the configured ones.
router.post(`${BASE}/call`, form, json, async (req, res) => {
  const b = req.body || {};
  let r;
  if (!amiLimit(`u${req.user.id}`)) {
    r = { ok: false, code: 'rate_limited', message: ERRORS.rate_limited };
  } else {
    const s = settings.get(req.user);
    const exts = settings.parseExtensions(s.ami_extensions);
    const wanted = String(b.ext || readCookie(req, 'ami_ext') || '');
    const ext = (exts.find(x => x.ext === wanted) || exts[0] || {}).ext;
    r = await ami.originate(s, { ext, number: phone.local(b.phone) });
  }
  if (wantsJson(req)) return res.status(r.ok ? 200 : 400).json({ ok: r.ok, code: r.code, message: r.message });
  const code = ami.MESSAGES[r.code] || r.code === 'rate_limited' ? r.code : 'connect_failed';
  res.redirect(`/app/lookup?phone=${encodeURIComponent(String(b.phone || '').slice(0, 30))}&call=${code}`);
});

// ---- Screen-pop link --------------------------------------------------------------------------

router.post(`${BASE}/pop`, form, (req, res) => {
  integrations.createPopLink(req.user, req.body.days);
  res.redirect(`${BASE}?ok=pop_created#pop`);
});

router.post(`${BASE}/pop/revoke`, form, (req, res) => {
  integrations.revokePopLink(req.user);
  res.redirect(`${BASE}?ok=pop_revoked#pop`);
});

// ---- Caller lookup (logged in) and screen pop (signed link) ----------------------------------

const SENDER = { visitor: 'مشتری', bot: 'بات', operator: 'پشتیبان', note: 'یادداشت داخلی' };
const CHANNEL = { web: 'سایت', page: 'لینک اختصاصی', bale: 'بله', telegram: 'تلگرام' };

function qcBadge(qc) {
  if (!qc || qc.score == null) return '';
  const n = Math.round(qc.score);
  const cls = n >= 80 ? 'ok' : n >= 50 ? 'warn' : 'danger';
  return `<span class="badge ${cls}" title="آخرین نمره‌ی کنترل کیفیت">QC ${faDigits(n)}</span>`;
}

function transcript(messages) {
  if (!messages.length) return '<p class="muted">پیامی ثبت نشده.</p>';
  return `<div class="ig-transcript">${messages.map(m => (m.sender === 'system'
    ? `<div class="live-msg system"><span class="live-sys">${esc(m.text)}</span></div>`
    : `<div class="live-msg ${esc(m.sender)}"><div class="live-bubble"><div class="live-who">${esc(SENDER[m.sender] || m.sender)}${m.operator ? ` · ${esc(m.operator)}` : ''}</div><div class="live-text">${esc(m.text)}</div><div class="live-at">${esc(faDateTime(m.createdAt))}</div></div></div>`)).join('')}</div>`;
}

function contactHtml(r, { user, mode }) {
  const s = settings.get(user);
  const numberHtml = mode === 'app'
    ? integrations.phoneHtml(user, r.phone, s)
    : `<a class="dial-link ltr" href="${esc(integrations.dialHref(user, r.phone, s))}">${esc(r.phone)}</a>`;
  const found = r.leads.length + r.conversations.length > 0;
  const last = Math.max(0, ...r.leads.map(l => l.created_at), ...r.conversations.map(c => c.last_message_at));
  const head = `<div class="panel ig-contact">
    <div class="ig-avatar" aria-hidden="true">${esc((r.name || '؟').trim().slice(0, 1))}</div>
    <div class="ig-contact-main"><h2>${esc(r.name || (found ? 'بدون نام' : 'مشتری ناشناس'))}</h2>
      <div class="ig-contact-phone">${numberHtml}${r.e164 ? ` <span class="muted ltr">${esc(r.e164)}</span>` : ''}</div></div>
    <div class="ig-contact-stats">
      <div><strong>${formatNumber(r.leads.length)}</strong><span>درخواست تماس</span></div>
      <div><strong>${formatNumber(r.conversations.length)}</strong><span>گفتگو</span></div>
      <div><strong>${last ? esc(ago(last)) : '—'}</strong><span>آخرین ارتباط</span></div>
    </div>
  </div>`;
  if (!found) return `${head}<div class="panel empty"><div class="big">🔍</div><p>این شماره هنوز در درخواست‌های تماس یا گفتگوها ثبت نشده است.</p></div>`;
  const leads = r.leads.length ? `<div class="panel"><h3>درخواست‌های تماس</h3><div class="table-wrap"><table class="table"><thead><tr><th>بات</th><th>نام</th><th>پیام</th><th>زمان</th><th>وضعیت</th></tr></thead><tbody>
    ${r.leads.map(l => `<tr><td>${esc(l.bot_name)}</td><td>${esc(l.name || '—')}</td><td>${esc(l.message)}</td><td class="muted">${esc(faDateTime(l.created_at))}</td><td>${l.status === 'done' ? '<span class="badge ok">انجام شد</span>' : '<span class="badge warn">جدید</span>'}</td></tr>`).join('')}
  </tbody></table></div></div>` : '';
  const convs = r.conversations.length ? `<div class="panel"><h3>گفتگوها</h3>${r.conversations.map((c, i) => `<details class="ig-conv"${i === 0 ? ' open' : ''}>
    <summary><span class="ig-conv-title"><strong>${esc(c.bot_name)}</strong> · ${esc(CHANNEL[c.channel] || c.channel)} · ${faDigits(c.message_count)} پیام</span>
      <span class="row">${c.mode === 'human' ? '<span class="badge warn">منتظر پشتیبان</span>' : ''}${qcBadge(c.qc)}<span class="muted">${esc(faDateTime(c.last_message_at))}</span></span></summary>
    ${mode === 'app' ? `<div class="ig-conv-links"><a class="btn btn-sm btn-ghost" href="/app/bots/${c.bot_id}/live?c=${c.id}">باز کردن در گفتگوی زنده</a></div>` : ''}
    ${c.page_url ? `<div class="hint ltr ig-page-url">${esc(c.page_url)}</div>` : ''}
    ${transcript(c.messages || [])}
  </details>`).join('')}</div>` : '';
  return head + leads + convs;
}

function lookupFor(userId, raw) {
  const ids = db.get().prepare('SELECT id FROM bots WHERE user_id = ?').all(userId).map(b => b.id);
  return contacts.lookup(ids, raw, { transcripts: true, messageLimit: 200 });
}

function callFlash(code) {
  if (code === 'ok') return '<span>در حال برقراری تماس… اول تلفن داخلی شما زنگ می‌خورد. 📞</span>';
  return `<span class="ig-flash-err">${esc(ami.MESSAGES[code] || ERRORS.rate_limited)}</span>`;
}

router.get('/app/lookup', (req, res) => {
  const raw = String(req.query.phone || '').slice(0, 40);
  const r = raw ? lookupFor(req.user.id, raw) : null;
  res.set('Cache-Control', 'no-store');
  render(req, res, {
    title: 'جست‌وجوی تماس‌گیرنده',
    flash: req.query.call ? callFlash(String(req.query.call)) : '',
    body: `<div class="page-title"><h1>جست‌وجوی تماس‌گیرنده</h1><a class="btn btn-ghost btn-sm" href="${BASE}#pop">لینک نمایش خودکار برای مرکز تماس</a></div>
<form class="panel ig-search" method="get" action="/app/lookup" role="search"><label for="lk-phone" class="sr-only">شماره</label>
  <input id="lk-phone" name="phone" type="tel" class="ltr" placeholder="09121234567" value="${esc(raw)}" required maxlength="40"><button class="btn btn-primary">جست‌وجو</button></form>
${raw && !r ? '<div class="error ig-alert">این شماره معتبر نیست.</div>' : ''}
${r ? contactHtml(r, { user: req.user, mode: 'app' }) : '<p class="muted">شماره‌ی مشتری را در هر قالبی وارد کنید (با ‎+98، با ارقام فارسی یا بدون صفر اول).</p>'}
<script src="/js/integrations.js" defer></script>`,
  });
});

function popShell(title, body) {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} | ${esc(config.siteName)}</title>
<link rel="stylesheet" href="/css/fonts.css">
<link rel="stylesheet" href="/css/site.css">
</head>
<body class="pop-body">
<main class="pop-main">${body}</main>
</body>
</html>`;
}

// Opened by call-center software on an incoming call, without a login.
router.get('/pop/:token', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store, private');
  if (!popLimit(clientIp(req))) {
    return res.status(429).type('html').send(popShell('محدودیت', '<div class="empty"><p>درخواست‌ها زیاد بود. کمی بعد دوباره امتحان کنید.</p></div>'));
  }
  const userId = integrations.verifyPopToken(req.params.token);
  const user = userId ? db.get().prepare('SELECT id, name, company FROM users WHERE id = ?').get(userId) : null;
  if (!user) {
    return res.status(404).type('html').send(popShell('لینک نامعتبر', '<div class="empty"><div class="big">🔒</div><p>این لینک معتبر نیست، منقضی شده یا غیرفعال شده است.</p></div>'));
  }
  const raw = String(req.query.phone || req.query.number || req.query.ani || '').slice(0, 40);
  const r = raw ? lookupFor(userId, raw) : null;
  const header = `<header class="pop-top"><span class="pop-brand">${esc(config.siteName)}</span><span class="muted">${esc(user.company || user.name)}</span></header>`;
  const search = `<form class="panel ig-search" method="get" action="/pop/${esc(req.params.token)}"><input name="phone" type="tel" class="ltr" placeholder="09121234567" value="${esc(raw)}" required maxlength="40" aria-label="شماره"><button class="btn btn-primary">جست‌وجو</button></form>`;
  const body = r ? contactHtml(r, { user, mode: 'pop' }) : (raw ? '<div class="error ig-alert">این شماره معتبر نیست.</div>' : '<p class="muted">شماره‌ی تماس‌گیرنده را وارد کنید.</p>');
  res.type('html').send(popShell(r ? `تماس ${faDigits(r.phone)}` : 'نمایش تماس‌گیرنده', `${header}${search}${body}`));
});

module.exports = router;

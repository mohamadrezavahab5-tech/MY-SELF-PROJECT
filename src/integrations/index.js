'use strict';
// Integrations layer: connects an account to any CRM or call-center system
// through universal primitives instead of vendor-specific connectors:
//   - outgoing webhooks (signed JSON POSTs, persisted retry queue)  ./webhooks
//   - REST API v1 with per-account keys                              ../routes/apiV1
//   - polling feed of the same events                                ./dispatch
//   - click-to-call dial links for softphones (tel:, sip:, zoiper:…) dialHref()
//   - server-side click-to-call through Asterisk / Issabel AMI       ./ami
//   - screen-pop page for incoming calls (signed, revocable link)    popToken()
//
// Other parts of the dashboard use only: dialHref(), phoneHtml(), amiEnabled().
const crypto = require('crypto');
const settings = require('./settings');
const phone = require('./phone');
const ami = require('./ami');
const { esc, token } = require('../util');

// ---- Click-to-call dial link ---------------------------------------------------------

const DIAL_PRESETS = {
  tel: { label: 'تلفن و موبایل', template: 'tel:{phone}', hint: 'پیش‌فرض. روی موبایل شماره‌گیر گوشی و روی کامپیوتر برنامه‌ی پیش‌فرض تماس (مثلاً Zoiper، MicroSIP یا Teams) باز می‌شود.' },
  sip: { label: 'SIP', template: 'sip:{phone}@{domain}', hint: 'برای سافت‌فون‌هایی که لینک sip: را می‌گیرند. دامنه یا IP مرکز تماس را وارد کنید.' },
  callto: { label: 'callto:', template: 'callto:{phone}', hint: 'برای برنامه‌هایی مثل MicroSIP و Skype که لینک callto: را می‌گیرند.' },
  zoiper: { label: 'Zoiper', template: 'zoiper:{phone}', hint: 'Zoiper باید روی کامپیوتر اپراتور نصب و به داخلی‌اش وصل باشد.' },
  ciscotel: { label: 'Cisco Jabber', template: 'ciscotel:{phone}', hint: 'Cisco Jabber لینک‌های ciscotel: را شماره‌گیری می‌کند.' },
  custom: { label: 'دلخواه', template: '', hint: 'هر الگویی که نرم‌افزار شما می‌فهمد؛ مثلاً آدرس «click to dial» در CRM خودتان.' },
};

const BAD_SCHEMES = ['javascript', 'data', 'vbscript', 'file', 'blob', 'about', 'filesystem'];

// -> template string, or null when invalid.
function cleanTemplate(raw) {
  const t = String(raw || '').trim();
  if (!t || t.length > 300 || /[\s"'<>`\\]/.test(t)) return null;
  const m = t.match(/^([a-z][a-z0-9+.-]{1,31}):/i);
  if (!m || BAD_SCHEMES.includes(m[1].toLowerCase())) return null;
  if (!/\{(phone|e164)\}/.test(t)) return null;
  return t;
}

function templateOf(s) {
  if (s.dial_preset === 'custom') return cleanTemplate(s.dial_template) || DIAL_PRESETS.tel.template;
  if (s.dial_preset === 'sip' && !s.sip_domain) return 'sip:{phone}';
  return (DIAL_PRESETS[s.dial_preset] || DIAL_PRESETS.tel).template;
}

// The href that dials `number` with the account's softphone setting,
// e.g. "tel:09121234567" or "zoiper:09121234567". '' for an unusable number.
// `user` is a user row or id; pass `s` (settings) to skip the lookup in loops.
function dialHref(user, number, s = null) {
  const cfg = s || settings.get(user);
  const local = phone.local(number);
  if (!local || local.length < 2) return '';
  const e164 = phone.e164(number) || local;
  return templateOf(cfg)
    .replace(/\{phone\}/g, `${(cfg.dial_prefix || '').replace(/[^0-9*#+]/g, '')}${local}`)
    .replace(/\{e164\}/g, e164)
    .replace(/\{domain\}/g, encodeURIComponent(cfg.sip_domain || ''));
}

function amiEnabled(user, s = null) {
  return ami.configured(s || settings.get(user));
}

// Ready-made HTML for a phone number in dashboard tables: a dial link, plus a
// server-side "call" button when Asterisk / Issabel is connected. Without JS
// the button posts and lands on the caller's lookup page; with
// /js/integrations.js loaded it calls in place.
function phoneHtml(user, number, s = null) {
  const text = String(number || '').trim();
  if (!text) return '—';
  const cfg = s || settings.get(user);
  const href = dialHref(user, text, cfg);
  const link = href
    ? `<a class="dial-link ltr" href="${esc(href)}" title="تماس با نرم‌افزار تلفن">${esc(text)}</a>`
    : `<span class="ltr">${esc(text)}</span>`;
  if (!ami.configured(cfg)) return link;
  return `${link} <form class="ami-call" method="post" action="/app/integrations/call"><input type="hidden" name="phone" value="${esc(text)}"><button class="btn btn-sm btn-outline" title="تماس از طریق مرکز تماس (Asterisk / Issabel)">📞 تماس</button></form>`;
}

// ---- Screen-pop link -----------------------------------------------------------------
// /pop/<userId>.<expiry base36>.<HMAC(pop_key)> — signed, expiring, and revoked
// by rotating or clearing the account's pop_key.

function popSig(key, payload) {
  return crypto.createHmac('sha256', key).update(`screen-pop:${payload}`).digest('base64url').slice(0, 32);
}

function popToken(user) {
  const s = settings.get(user);
  if (!s.pop_key || !s.pop_expires_at || s.pop_expires_at <= Date.now()) return '';
  const payload = `${s.user_id}.${Number(s.pop_expires_at).toString(36)}`;
  return `${payload}.${popSig(s.pop_key, payload)}`;
}

function createPopLink(user, days = 365) {
  const d = [30, 90, 365].includes(Number(days)) ? Number(days) : 365;
  settings.save(user, { pop_key: token(24), pop_expires_at: Date.now() + d * 86400_000 });
  return popToken(user);
}

function revokePopLink(user) {
  settings.save(user, { pop_key: '', pop_expires_at: 0 });
}

// -> userId, or null when the token is malformed, expired or revoked.
function verifyPopToken(raw) {
  const m = String(raw || '').match(/^(\d{1,12})\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{32})$/);
  if (!m) return null;
  const s = settings.get(Number(m[1]));
  if (!s.pop_key) return null;
  const exp = parseInt(m[2], 36);
  if (exp !== Number(s.pop_expires_at) || exp <= Date.now()) return null;
  const want = Buffer.from(popSig(s.pop_key, `${m[1]}.${m[2]}`));
  const got = Buffer.from(m[3]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? Number(m[1]) : null;
}

let initialized = false;
function init() {
  if (initialized) return;
  initialized = true;
  require('./dispatch').init();
}

module.exports = {
  init,
  dialHref, phoneHtml, amiEnabled, cleanTemplate, DIAL_PRESETS,
  popToken, createPopLink, revokePopLink, verifyPopToken,
  settings, phone, ami,
  get webhooks() { return require('./webhooks'); },
  get apiKeys() { return require('./apiKeys'); },
  get contacts() { return require('./contacts'); },
  get dispatch() { return require('./dispatch'); },
};

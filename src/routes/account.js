'use strict';
const express = require('express');
const auth = require('../auth');
const db = require('../db');
const config = require('../config');
const { authPage } = require('../views/layout');
const { esc, normalizeMobile, rateLimiter, clientIp } = require('../util');

const router = express.Router();
const loginLimit = rateLimiter({ windowMs: 15 * 60_000, max: 20 });

// Only allow local redirect targets (no //evil.com, no absolute URLs).
function safeNext(value, fallback = '/app') {
  const v = String(value || '');
  return /^\/(?![/\\])[^\s]*$/.test(v) ? v : fallback;
}

function signupForm({ error = '', values = {}, next = '' } = {}) {
  return authPage({
    title: 'ثبت‌نام',
    body: `<h1>ساخت حساب رایگان</h1>
<p class="muted">کمتر از یک دقیقه. بدون نیاز به کارت بانکی.</p>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
<form class="form" method="post" action="/signup">
  <input type="hidden" name="next" value="${esc(next)}">
  <input type="hidden" name="industry" value="${esc(values.industry || '')}">
  <div class="field"><label for="name">نام و نام خانوادگی</label><input id="name" name="name" type="text" required maxlength="80" autocomplete="name" value="${esc(values.name || '')}"></div>
  <div class="field"><label for="company">نام کسب‌وکار یا سازمان</label><input id="company" name="company" type="text" required maxlength="80" autocomplete="organization" value="${esc(values.company || '')}"></div>
  <div class="field"><label for="phone">شماره موبایل</label><input id="phone" name="phone" type="tel" class="ltr" required inputmode="tel" autocomplete="tel" placeholder="09xxxxxxxxx" value="${esc(values.phone || '')}"></div>
  <div class="field"><label for="password">رمز عبور</label><input id="password" name="password" type="password" required minlength="8" autocomplete="new-password"><span class="hint">حداقل ۸ کاراکتر</span></div>
  <button class="btn btn-primary btn-block btn-lg">ساخت حساب و چت‌بات</button>
  <p class="hint center">ثبت‌نام یعنی موافقت با <a href="/terms" target="_blank">قوانین</a> و <a href="/privacy" target="_blank">حریم خصوصی</a>.</p>
</form>
<p class="auth-alt">حساب دارید؟ <a href="/login${next ? `?next=${encodeURIComponent(next)}` : ''}">وارد شوید</a></p>`,
  });
}

function loginForm({ error = '', phone = '', next = '' } = {}) {
  return authPage({
    title: 'ورود',
    body: `<h1>ورود به حساب</h1>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
<form class="form" method="post" action="/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <div class="field"><label for="phone">شماره موبایل</label><input id="phone" name="phone" type="tel" class="ltr" required inputmode="tel" autocomplete="username" value="${esc(phone)}"></div>
  <div class="field"><label for="password">رمز عبور</label><input id="password" name="password" type="password" required autocomplete="current-password"></div>
  <button class="btn btn-primary btn-block btn-lg">ورود</button>
</form>
<p class="auth-alt">حساب ندارید؟ <a href="/signup${next ? `?next=${encodeURIComponent(next)}` : ''}">ثبت‌نام رایگان</a></p>
<p class="auth-alt hint">رمز را فراموش کرده‌اید؟ ${config.supportPhone ? `با پشتیبانی (<a href="tel:${esc(config.supportPhone)}">${esc(config.supportPhone)}</a>) تماس بگیرید` : 'با پشتیبانی تماس بگیرید'} تا رمز موقت برایتان صادر شود.</p>`,
  });
}

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/app');
  res.send(signupForm({ next: safeNext(req.query.next, ''), values: { industry: String(req.query.industry || '') } }));
});

router.post('/signup', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
  const b = req.body;
  const values = { name: String(b.name || '').trim(), company: String(b.company || '').trim(), phone: String(b.phone || '').trim(), industry: String(b.industry || '') };
  const next = safeNext(b.next, '');
  const fail = error => res.status(400).send(signupForm({ error, values, next }));
  if (!loginLimit(`signup:${clientIp(req)}`)) return fail('تلاش‌های زیادی انجام شد. چند دقیقه‌ی دیگر دوباره امتحان کنید.');
  if (values.name.length < 2) return fail('نام را وارد کنید.');
  if (values.company.length < 2) return fail('نام کسب‌وکار را وارد کنید.');
  const phone = normalizeMobile(values.phone);
  if (!phone) return fail('شماره موبایل معتبر نیست. نمونه: 09121234567');
  if (String(b.password || '').length < 8) return fail('رمز عبور باید حداقل ۸ کاراکتر باشد.');
  if (db.get().prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) return fail('با این شماره قبلاً ثبت‌نام شده است. از صفحه‌ی ورود وارد شوید.');
  const user = auth.createUser({ phone, name: values.name, company: values.company, password: b.password, refCode: req.cookies.ref || '' });
  auth.startSession(res, user.id);
  const onboarding = `/app/onboarding${values.industry ? `?industry=${encodeURIComponent(values.industry)}` : ''}`;
  res.redirect(next && next !== '/app' ? `${onboarding}${values.industry ? '&' : '?'}next=${encodeURIComponent(next)}` : onboarding);
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.send(loginForm({ next: safeNext(req.query.next, '') }));
});

router.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const next = safeNext(req.body.next, '');
  const phoneRaw = String(req.body.phone || '');
  if (!loginLimit(`login:${clientIp(req)}`)) {
    return res.status(429).send(loginForm({ error: 'تلاش‌های زیادی انجام شد. ۱۵ دقیقه‌ی دیگر دوباره امتحان کنید.', phone: phoneRaw, next }));
  }
  const phone = normalizeMobile(phoneRaw);
  const user = phone && auth.checkLogin(phone, String(req.body.password || ''));
  if (!user) return res.status(400).send(loginForm({ error: 'شماره موبایل یا رمز عبور اشتباه است.', phone: phoneRaw, next }));
  auth.startSession(res, user.id);
  res.redirect(safeNext(next));
});

router.post('/logout', auth.sameOrigin, (req, res) => {
  auth.endSession(req, res);
  res.redirect('/');
});

module.exports = router;
module.exports.safeNext = safeNext;

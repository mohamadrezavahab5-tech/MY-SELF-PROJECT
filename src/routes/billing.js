'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const billing = require('../billing');
const zarinpal = require('../billing/zarinpal');
const { PLANS, DURATIONS, effectivePlan } = require('../plans');
const { dashPage, authPage } = require('../views/layout');
const { faDateTime, faDay } = require('../views/helpers');
const { esc, faDigits, formatNumber, formatToman, normalizeSheba } = require('../util');

const router = express.Router();
const form = express.urlencoded({ extended: false, limit: '8kb' });

function userBots(user) {
  return db.get().prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(user.id);
}

function render(req, res, { title, body, active, flash = '' }) {
  const list = userBots(req.user);
  res.send(dashPage({ title, body, user: req.user, bot: list[0] || null, bots: list, active, flash }));
}

const NEED = {
  export: 'خروجی اکسل در پلن‌های حرفه‌ای و سازمانی فعال است.',
  channels: 'اتصال به بله و تلگرام در پلن‌های حرفه‌ای و سازمانی فعال است.',
  faqs: 'به سقف تعداد سؤال‌های پلن فعلی رسیده‌اید.',
};

router.get('/app/billing', auth.requireUser, (req, res) => {
  const user = req.user;
  const plan = effectivePlan(user);
  const active = plan.id !== 'free';
  const want = PLANS[req.query.plan] && req.query.plan !== 'free' ? req.query.plan : '';
  const orders = db.get().prepare(`SELECT * FROM orders WHERE user_id = ? AND status = 'paid' ORDER BY id DESC LIMIT 20`).all(user.id);
  const mode = config.payment.mode;

  const planCard = p => {
    const rows = DURATIONS.map(d => {
      const q = billing.quote(user, p.id, d.months);
      return `<form method="post" action="/app/billing/checkout" class="row-between" style="padding:.5em 0;border-bottom:1px dashed var(--line)">
        <input type="hidden" name="plan" value="${p.id}"><input type="hidden" name="months" value="${d.months}">
        <span><strong>${esc(d.label)}</strong>${d.discountPercent ? ` <span class="badge ok">${faDigits(d.discountPercent)}٪ تخفیف</span>` : ''}<br>
        <span class="muted">${q.discount ? `<s>${formatNumber(q.base)}</s> ` : ''}${formatToman(q.amount)}</span></span>
        <button class="btn btn-sm ${p.id === want || (!want && p.id === 'pro') ? 'btn-primary' : 'btn-outline'}"${mode === 'disabled' ? ' disabled' : ''}>پرداخت</button>
      </form>`;
    }).join('');
    return `<div class="card price-card${p.id === want ? ' featured' : ''}" id="plan-${p.id}"><h3>${esc(p.name)}</h3>
      <p class="muted">${faDigits(p.bots)} بات · ${formatNumber(p.faqs)} سؤال · ${formatNumber(p.answersPerMonth)} پاسخ در ماه · اتصال بله · بدون نشان</p>${rows}</div>`;
  };

  const referred = user.referred_by && !orders.length;
  render(req, res, {
    title: 'اشتراک و پرداخت', active: 'billing',
    body: `<div class="page-title"><h1>اشتراک و پرداخت</h1></div>
${NEED[req.query.need] ? `<div class="notice" style="margin-bottom:16px">${esc(NEED[req.query.need])}</div>` : ''}
${req.query.paid ? '<div class="success" style="margin-bottom:16px">پرداخت موفق بود و پلن شما فعال شد. ممنون از اعتمادتان! 🎉</div>' : ''}
${req.query.failed ? '<div class="error" style="margin-bottom:16px">پرداخت انجام نشد. اگر مبلغی از حسابتان کم شده، حداکثر تا ۷۲ ساعت بعد خودکار برمی‌گردد.</div>' : ''}
${mode === 'disabled' ? '<div class="notice" style="margin-bottom:16px">درگاه پرداخت در حال راه‌اندازی است. به‌زودی فعال می‌شود.</div>' : ''}
${mode === 'mock' ? '<div class="notice" style="margin-bottom:16px">حالت آزمایشی: پرداخت‌ها واقعی نیستند.</div>' : ''}
<div class="panel"><div class="row-between"><div><div class="muted">پلن فعلی</div><h2 style="margin:0">${esc(plan.name)}</h2></div>
<div>${active ? `<span class="badge ok">فعال تا ${esc(faDay(user.plan_expires_at))}</span>` : '<span class="badge">رایگان</span>'}</div></div>
${active ? '<p class="muted" style="margin-top:10px">با پرداخت دوباره‌ی همین پلن، مدت آن به انتهای اشتراک فعلی اضافه می‌شود.</p>' : ''}</div>
${referred ? `<div class="success" style="margin-bottom:16px">🎁 چون با لینک معرفی آمده‌اید، ${faDigits(config.referral.buyerDiscountPercent)}٪ تخفیف اولین خرید برایتان اعمال شده است.</div>` : ''}
<div class="grid grid-2">${planCard(PLANS.pro)}${planCard(PLANS.business)}</div>
<div class="panel" style="margin-top:18px"><h2>تاریخچه‌ی پرداخت</h2>
${orders.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>تاریخ</th><th>پلن</th><th>مدت</th><th>مبلغ</th><th>کد پیگیری</th></tr></thead><tbody>
${orders.map(o => `<tr><td>${esc(faDateTime(o.paid_at))}</td><td>${esc(PLANS[o.plan] ? PLANS[o.plan].name : o.plan)}</td><td>${faDigits(o.months)} ماه</td><td>${formatToman(o.amount)}</td><td class="ltr">${esc(o.ref_id)}</td></tr>`).join('')}
</tbody></table></div>` : '<p class="muted">هنوز پرداختی نداشته‌اید.</p>'}</div>`,
  });
});

router.post('/app/billing/checkout', auth.requireUser, auth.sameOrigin, form, async (req, res) => {
  const planId = String(req.body.plan || '');
  const months = Number(req.body.months);
  if (!PLANS[planId] || planId === 'free' || !DURATIONS.some(d => d.months === months)) return res.redirect('/app/billing');
  if (config.payment.mode === 'disabled') return res.redirect('/app/billing');
  const order = billing.createOrder(req.user, planId, months);
  try {
    const { authority, url } = await zarinpal.request({
      amountRial: order.amount * 10,
      description: `اشتراک ${PLANS[planId].name} ${config.siteName} - ${months} ماه`,
      callbackUrl: `${config.siteUrl}/pay/callback`,
      mobile: req.user.phone,
    });
    billing.setAuthority(order.id, authority);
    res.redirect(url);
  } catch (e) {
    console.error('payment request failed:', e.message);
    billing.markFailed(order.id);
    res.redirect('/app/billing?failed=1');
  }
});

// Zarinpal redirects the buyer back here (GET ?Authority=...&Status=OK|NOK).
router.get('/pay/callback', async (req, res) => {
  const order = billing.orderByAuthority(req.query.Authority);
  if (!order) return res.redirect('/app/billing?failed=1');
  if (order.status === 'paid') return res.redirect('/app/billing?paid=1');
  if (req.query.Status !== 'OK') {
    billing.markFailed(order.id);
    return res.redirect('/app/billing?failed=1');
  }
  try {
    const v = await zarinpal.verify({ authority: order.authority, amountRial: order.amount * 10 });
    if (!v.ok) {
      billing.markFailed(order.id);
      return res.redirect('/app/billing?failed=1');
    }
    billing.markPaid(order.id, { refId: v.refId, cardPan: v.cardPan });
    res.redirect('/app/billing?paid=1');
  } catch (e) {
    // Network trouble while verifying: leave it pending so a retry of this URL can still verify.
    console.error('payment verify failed:', e.message);
    res.redirect('/app/billing?failed=1');
  }
});

// Local-development stand-in for the gateway page. The payment mode can change
// at runtime (/admin/settings), so it is checked per request; never in production.
router.get('/pay/mock/:authority', (req, res, next) => {
  if (config.isProd || config.payment.mode !== 'mock') return next();
  const order = billing.orderByAuthority(req.params.authority);
  if (!order) return res.status(404).send('not found');
  const back = s => `/pay/callback?Authority=${encodeURIComponent(order.authority)}&Status=${s}`;
  res.send(authPage({
    title: 'درگاه آزمایشی',
    body: `<h1>درگاه پرداخت آزمایشی</h1><p class="notice">این صفحه فقط در حالت توسعه نمایش داده می‌شود و پولی جابه‌جا نمی‌شود.</p>
<p>مبلغ: <strong>${formatToman(order.amount)}</strong></p>
<div class="row"><a class="btn btn-primary" href="${back('OK')}">پرداخت موفق</a><a class="btn btn-ghost" href="${back('NOK')}">انصراف</a></div>`,
  }));
});

// ---- Referral / affiliate ----------------------------------------------------------

router.get('/app/referral', auth.requireUser, (req, res) => {
  const user = req.user;
  const conn = db.get();
  const link = `${config.siteUrl}/?ref=${user.ref_code}`;
  const referred = conn.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?').get(user.id).n;
  const paying = conn.prepare(`SELECT COUNT(DISTINCT o.user_id) AS n FROM orders o WHERE o.referrer_id = ? AND o.status = 'paid'`).get(user.id).n;
  const commissions = conn.prepare(`
    SELECT c.*, u.company, u.name FROM commissions c JOIN orders o ON o.id = c.order_id JOIN users u ON u.id = o.user_id
    WHERE c.referrer_id = ? ORDER BY c.id DESC LIMIT 30
  `).all(user.id);
  const payouts = conn.prepare('SELECT * FROM payouts WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(user.id);
  const pending = payouts.some(p => p.status === 'requested');
  const min = config.referral.minPayoutToman;
  const flash = { sheba: 'شماره‌ی شبا ذخیره شد.', payout: 'درخواست تسویه ثبت شد. معمولاً ظرف ۳ روز کاری واریز می‌شود.' }[req.query.ok] || '';
  const err = { sheba: 'شماره‌ی شبا معتبر نیست. ۲۴ رقم بعد از IR را کامل وارد کنید.', min: `حداقل مبلغ تسویه ${formatToman(min)} است.`, nosheba: 'اول شماره‌ی شبا را ثبت کنید.' }[req.query.err] || '';
  const statusBadge = { requested: '<span class="badge warn">در انتظار</span>', paid: '<span class="badge ok">واریز شد</span>', rejected: '<span class="badge danger">رد شد</span>' };

  render(req, res, {
    title: 'کسب درآمد', active: 'referral', flash,
    body: `<div class="page-title"><h1>کسب درآمد با معرفی</h1></div>
${err ? `<div class="error" style="margin-bottom:16px">${esc(err)}</div>` : ''}
<div class="panel"><p>این لینک را به کسب‌وکارها بدهید. از <strong>هر پرداخت</strong> آن‌ها، تا وقتی اشتراکشان را تمدید کنند، <strong>${faDigits(config.referral.commissionPercent)}٪</strong> به موجودی شما اضافه می‌شود. خودشان هم ${faDigits(config.referral.buyerDiscountPercent)}٪ تخفیف اولین خرید می‌گیرند.</p>
<div class="row"><input type="text" class="ltr" id="ref-link" readonly value="${esc(link)}" style="flex:1;min-width:220px"><button type="button" class="btn btn-primary btn-sm" data-copy="#ref-link">کپی لینک</button></div>
<p class="hint" style="margin-top:8px">ویجت کاربران رایگانی که شما معرفی کرده‌اید هم لینک معرفی شما را دارد. هر کسب‌وکاری که از آنجا ثبت‌نام کند، مشتری شما حساب می‌شود.</p></div>
<div class="stats">
  <div class="stat"><div class="n">${formatNumber(referred)}</div><div class="l">ثبت‌نام با لینک شما</div></div>
  <div class="stat"><div class="n">${formatNumber(paying)}</div><div class="l">مشتری پرداخت‌کننده</div></div>
  <div class="stat"><div class="n">${formatNumber(user.total_earned)}</div><div class="l">کل درآمد (تومان)</div></div>
  <div class="stat"><div class="n">${formatNumber(user.balance)}</div><div class="l">موجودی قابل برداشت (تومان)</div></div>
</div>
<div class="grid grid-2">
<div class="panel"><h2>شماره‌ی شبا</h2>
  <form class="form" method="post" action="/app/referral/sheba"><input type="text" class="ltr" name="sheba" placeholder="IR000000000000000000000000" value="${esc(user.sheba)}" required><div><button class="btn btn-outline btn-sm">ذخیره</button></div></form></div>
<div class="panel"><h2>درخواست تسویه</h2>
  <p class="muted">حداقل مبلغ: ${formatToman(min)}</p>
  <form method="post" action="/app/referral/payout"><button class="btn btn-primary btn-sm"${user.balance < min || pending ? ' disabled' : ''}>${pending ? 'درخواست قبلی در حال بررسی است' : `برداشت ${formatToman(user.balance)}`}</button></form></div>
</div>
<div class="panel"><h2>پورسانت‌ها</h2>${commissions.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>تاریخ</th><th>مشتری</th><th>مبلغ</th></tr></thead><tbody>${commissions.map(c => `<tr><td>${esc(faDateTime(c.created_at))}</td><td>${esc(c.company || c.name)}</td><td>${formatToman(c.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">هنوز پورسانتی ثبت نشده.</p>'}</div>
${payouts.length ? `<div class="panel"><h2>تسویه‌ها</h2><div class="table-wrap"><table class="table"><thead><tr><th>تاریخ</th><th>مبلغ</th><th>وضعیت</th></tr></thead><tbody>${payouts.map(p => `<tr><td>${esc(faDateTime(p.created_at))}</td><td>${formatToman(p.amount)}</td><td>${statusBadge[p.status] || ''}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`,
  });
});

router.post('/app/referral/sheba', auth.requireUser, auth.sameOrigin, form, (req, res) => {
  const sheba = normalizeSheba(req.body.sheba);
  if (!sheba) return res.redirect('/app/referral?err=sheba');
  db.get().prepare('UPDATE users SET sheba = ? WHERE id = ?').run(sheba, req.user.id);
  res.redirect('/app/referral?ok=sheba');
});

router.post('/app/referral/payout', auth.requireUser, auth.sameOrigin, form, (req, res) => {
  const conn = db.get();
  const result = conn.transaction(() => {
    const user = conn.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user.sheba) return 'nosheba';
    if (user.balance < config.referral.minPayoutToman) return 'min';
    if (conn.prepare(`SELECT 1 FROM payouts WHERE user_id = ? AND status = 'requested'`).get(user.id)) return 'ok';
    // Move the balance into the payout request so it can't be requested twice.
    conn.prepare('INSERT INTO payouts (user_id, amount, sheba, created_at) VALUES (?, ?, ?, ?)').run(user.id, user.balance, user.sheba, Date.now());
    conn.prepare('UPDATE users SET balance = 0 WHERE id = ?').run(user.id);
    return 'ok';
  })();
  res.redirect(result === 'ok' ? '/app/referral?ok=payout' : `/app/referral?err=${result}`);
});

module.exports = router;

'use strict';
// Site-owner panel: revenue, customers, orders and affiliate payouts.
// Access: users whose phone is listed in the ADMIN_PHONES env var.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { PLANS } = require('../plans');
const { dashPage } = require('../views/layout');
const { faDateTime, faDay } = require('../views/helpers');
const { esc, formatNumber, formatToman, shortId, hashPassword } = require('../util');
const { SYSTEM_PHONE } = require('../demoBot');

const router = express.Router();
router.use('/admin', auth.requireAdmin, auth.sameOrigin);
const form = express.urlencoded({ extended: false, limit: '4kb' });

function render(req, res, title, body) {
  const bots = db.get().prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(req.user.id);
  res.send(dashPage({ title, body, user: req.user, bot: bots[0] || null, bots, active: 'admin' }));
}

router.get('/admin', (req, res) => {
  const conn = db.get();
  const now = Date.now();
  const d30 = now - 30 * 86400_000;
  const users = conn.prepare('SELECT COUNT(*) AS n FROM users WHERE phone != ?').get(SYSTEM_PHONE).n;
  const newUsers = conn.prepare('SELECT COUNT(*) AS n FROM users WHERE phone != ? AND created_at >= ?').get(SYSTEM_PHONE, d30).n;
  const paying = conn.prepare(`SELECT COUNT(*) AS n FROM users WHERE phone != ? AND plan != 'free' AND plan_expires_at > ?`).get(SYSTEM_PHONE, now).n;
  const rev30 = conn.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE status = 'paid' AND paid_at >= ?`).get(d30).s;
  const revAll = conn.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE status = 'paid'`).get().s;
  const owed = conn.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payouts WHERE status = 'requested'`).get().s;
  const msgs30 = conn.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?').get(d30).n;
  const recentUsers = conn.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM bots b WHERE b.user_id = u.id) AS nbots,
      (SELECT COUNT(*) FROM messages m JOIN bots b ON b.id = m.bot_id WHERE b.user_id = u.id) AS nmsgs
    FROM users u WHERE u.phone != ? ORDER BY u.id DESC LIMIT 50
  `).all(SYSTEM_PHONE);
  const orders = conn.prepare(`SELECT o.*, u.name, u.company, u.phone FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = 'paid' ORDER BY o.id DESC LIMIT 30`).all();
  const payouts = conn.prepare(`SELECT p.*, u.name, u.phone FROM payouts p JOIN users u ON u.id = p.user_id ORDER BY p.status != 'requested', p.id DESC LIMIT 50`).all();

  render(req, res, 'مدیریت سایت', `<div class="page-title"><h1>مدیریت سایت</h1></div>
${req.query.ok ? '<div class="flash">انجام شد.</div>' : ''}
<div class="stats">
  <div class="stat"><div class="n">${formatNumber(rev30)}</div><div class="l">درآمد ۳۰ روز (تومان)</div></div>
  <div class="stat"><div class="n">${formatNumber(paying)}</div><div class="l">مشترک فعال</div></div>
  <div class="stat"><div class="n">${formatNumber(users)}</div><div class="l">کاربر (${formatNumber(newUsers)} جدید در ۳۰ روز)</div></div>
  <div class="stat"><div class="n">${formatNumber(msgs30)}</div><div class="l">سؤال پاسخ‌داده‌شده ۳۰ روز</div></div>
</div>
<p class="muted">کل درآمد: ${formatToman(revAll)} · بدهی تسویه‌ی همکاران: ${formatToman(owed)}</p>

<div class="panel"><h2>درخواست‌های تسویه</h2>
${payouts.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>همکار</th><th>مبلغ</th><th>شبا</th><th>تاریخ</th><th></th></tr></thead><tbody>
${payouts.map(p => `<tr><td>${esc(p.name)}<br><span class="muted ltr">${esc(p.phone)}</span></td><td>${formatToman(p.amount)}</td><td class="ltr">${esc(p.sheba)}</td><td>${esc(faDateTime(p.created_at))}</td>
<td>${p.status === 'requested' ? `<form class="row" method="post" action="/admin/payouts/${p.id}"><button class="btn btn-sm btn-primary" name="status" value="paid" data-confirm="واریز انجام شده؟">واریز شد</button><button class="btn btn-sm btn-ghost" name="status" value="rejected" data-confirm="رد شود؟ مبلغ به موجودی همکار برمی‌گردد.">رد</button></form>` : (p.status === 'paid' ? '<span class="badge ok">واریز شد</span>' : '<span class="badge danger">رد شد</span>')}</td></tr>`).join('')}
</tbody></table></div>` : '<p class="muted">درخواستی نیست.</p>'}</div>

<div class="panel"><h2>آخرین پرداخت‌ها</h2>
${orders.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>مشتری</th><th>پلن</th><th>مبلغ</th><th>کد پیگیری</th><th>تاریخ</th></tr></thead><tbody>
${orders.map(o => `<tr><td>${esc(o.company || o.name)}<br><span class="muted ltr">${esc(o.phone)}</span></td><td>${esc(PLANS[o.plan] ? PLANS[o.plan].name : o.plan)} · ${formatNumber(o.months)} ماه</td><td>${formatToman(o.amount)}</td><td class="ltr">${esc(o.ref_id)}</td><td>${esc(faDateTime(o.paid_at))}</td></tr>`).join('')}
</tbody></table></div>` : '<p class="muted">هنوز پرداختی نبوده.</p>'}</div>

<div class="panel"><h2>کاربران</h2><div class="table-wrap"><table class="table"><thead><tr><th>نام / کسب‌وکار</th><th>موبایل</th><th>پلن</th><th>بات</th><th>سؤال‌ها</th><th>عضویت</th><th></th></tr></thead><tbody>
${recentUsers.map(u => {
    const active = u.plan !== 'free' && u.plan_expires_at > now;
    return `<tr><td>${esc(u.name)}<br><span class="muted">${esc(u.company)}</span></td><td class="ltr">${esc(u.phone)}</td><td>${active ? `<span class="badge ok">${esc(PLANS[u.plan].name)}</span><br><span class="muted">تا ${esc(faDay(u.plan_expires_at))}</span>` : '<span class="badge">رایگان</span>'}</td><td>${formatNumber(u.nbots)}</td><td>${formatNumber(u.nmsgs)}</td><td>${esc(faDay(u.created_at))}</td>
<td><form method="post" action="/admin/users/${u.id}/reset"><button class="btn btn-sm btn-ghost" data-confirm="برای این کاربر رمز موقت ساخته شود؟ رمز فعلی‌اش دیگر کار نمی‌کند.">رمز موقت</button></form></td></tr>`;
  }).join('')}
</tbody></table></div></div>`);
});

// There is no SMS provider, so a user who forgot their password calls
// support; the admin issues a temporary password here and reads it to them.
router.post('/admin/users/:id/reset', form, (req, res) => {
  const user = db.get().prepare('SELECT * FROM users WHERE id = ? AND phone != ?').get(Number(req.params.id), SYSTEM_PHONE);
  if (!user) return res.redirect('/admin');
  const temp = shortId(10);
  db.get().transaction(() => {
    db.get().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(temp), user.id);
    db.get().prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  })();
  res.set('Cache-Control', 'no-store');
  render(req, res, 'رمز موقت', `<div class="page-title"><h1>رمز موقت</h1></div>
<div class="panel"><p>رمز جدید <strong>${esc(user.name)}</strong> (<span class="ltr">${esc(user.phone)}</span>):</p>
<p class="code-box" style="font-size:1.4rem">${esc(temp)}</p>
<p class="muted">این رمز فقط همین یک بار نمایش داده می‌شود. آن را به کاربر بگویید.</p>
<a class="btn btn-outline" href="/admin">بازگشت</a></div>`);
});

router.post('/admin/payouts/:id', form, (req, res) => {
  const conn = db.get();
  const status = req.body.status === 'paid' ? 'paid' : req.body.status === 'rejected' ? 'rejected' : null;
  if (status) {
    conn.transaction(() => {
      const p = conn.prepare(`SELECT * FROM payouts WHERE id = ? AND status = 'requested'`).get(Number(req.params.id));
      if (!p) return;
      conn.prepare('UPDATE payouts SET status = ?, paid_at = ? WHERE id = ?').run(status, Date.now(), p.id);
      if (status === 'rejected') conn.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(p.amount, p.user_id);
    })();
  }
  res.redirect('/admin?ok=1');
});

module.exports = router;

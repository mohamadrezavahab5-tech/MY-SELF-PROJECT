'use strict';
// "Learn from your website": add the site, watch the crawl, test what the bot
// finds. Crawling itself lives in src/knowledge.js.
const express = require('express');
const db = require('../db');
const knowledge = require('../knowledge');
const { dashPage } = require('../views/layout');
const { faDateTime, ago } = require('../views/helpers');
const { esc, faDigits, formatNumber } = require('../util');

const router = express.Router();
const form = express.urlencoded({ extended: false, limit: '8kb' });

router.param('botId', (req, res, next, id) => {
  const bot = db.get().prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!bot) return res.redirect('/app');
  req.bot = bot;
  next();
});

const STATUS = {
  crawling: '<span class="badge warn">در حال خواندن…</span>',
  pending: '<span class="badge warn">در صف</span>',
  ready: '<span class="badge ok">آماده</span>',
  error: '<span class="badge danger">خطا</span>',
};

function url(bot, sub = '') {
  return `/app/bots/${bot.id}/knowledge${sub}`;
}

router.get('/app/bots/:botId/knowledge', (req, res) => {
  const bot = req.bot;
  const sources = knowledge.listSources(bot.id);
  const budget = knowledge.pageBudget(bot);
  const passages = db.get().prepare('SELECT COUNT(*) AS n FROM passages WHERE bot_id = ?').get(bot.id).n;
  const crawling = sources.some(s => s.status === 'crawling' || s.status === 'pending');
  const q = String(req.query.q || '').trim().slice(0, 300);
  const results = q ? knowledge.search(bot.id, q, { limit: 3 }) : [];
  const verdict = r => (r.score >= knowledge.THRESHOLDS.answer
    ? '<span class="badge ok">بات همین را جواب می‌دهد</span>'
    : r.score >= knowledge.THRESHOLDS.context
      ? '<span class="badge primary">برای پاسخ هوشمند استفاده می‌شود</span>'
      : '<span class="badge">ضعیف</span>');
  const flash = { added: 'خواندن سایت شروع شد. چند دقیقه طول می‌کشد؛ این صفحه خودش به‌روز می‌شود.', deleted: 'حذف شد.', recrawl: 'خواندن دوباره شروع شد.' }[req.query.ok] || '';
  const allBots = db.get().prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(req.user.id);

  res.send(dashPage({
    title: 'یادگیری از سایت',
    user: req.user,
    bot,
    bots: allBots,
    active: 'knowledge',
    flash,
    body: `${crawling ? '<meta http-equiv="refresh" content="5">' : ''}
<div class="page-title"><h1>یادگیری از سایت</h1><span class="badge primary">${formatNumber(budget.used)} از ${formatNumber(budget.limit)} صفحه</span></div>
<p class="muted">آدرس سایت‌تان را بدهید تا بات صفحه‌ها را بخواند. وقتی جواب سؤالی در «سؤال و جواب‌ها» نباشد، بات از متن سایت جواب می‌دهد و لینک همان صفحه را هم کنارش می‌گذارد.</p>
${req.query.err ? `<div class="error" style="margin-bottom:16px">${esc(req.query.err)}</div>` : ''}
<div class="panel">
  <form class="row" method="post" action="${url(bot)}">
    <label class="sr-only" for="k-url">آدرس سایت</label>
    <input id="k-url" type="text" name="url" class="ltr" required placeholder="example.ir" style="flex:1;min-width:220px">
    <button class="btn btn-primary"${budget.left ? '' : ' disabled'}>خواندن سایت</button>
  </form>
  ${budget.left ? '' : '<p class="notice" style="margin-top:12px">به سقف صفحه‌های پلن رسیده‌اید. <a href="/app/billing">ارتقای پلن</a></p>'}
  <p class="hint" style="margin-top:8px">صفحه‌های فروشگاه، سبد خرید، ورود و مانند این‌ها خودکار نادیده گرفته می‌شوند. سرعت خواندن آهسته است تا به سایت فشار نیاید.</p>
</div>
<div class="panel">
  <h2>منابع</h2>
  ${sources.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>سایت</th><th>وضعیت</th><th>صفحه</th><th>آخرین خواندن</th><th></th></tr></thead><tbody>
  ${sources.map(s => `<tr>
    <td class="ltr"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url.replace(/^https?:\/\//, ''))}</a>${s.error ? `<div class="hint" dir="rtl">${esc(s.error)}</div>` : ''}</td>
    <td>${STATUS[s.status] || esc(s.status)}</td>
    <td>${s.status === 'crawling' && s.progress !== undefined ? `${faDigits(s.progress)}…` : faDigits(s.pages)}</td>
    <td class="muted">${s.crawled_at ? `<span title="${esc(faDateTime(s.crawled_at))}">${esc(ago(s.crawled_at))}</span>` : '—'}</td>
    <td><div class="row">
      <form method="post" action="${url(bot, `/${s.id}/recrawl`)}"><button class="btn btn-sm btn-outline"${s.status === 'crawling' ? ' disabled' : ''}>خواندن دوباره</button></form>
      <form method="post" action="${url(bot, `/${s.id}/delete`)}"><button class="btn btn-sm btn-ghost" data-confirm="این منبع و همه‌ی متن‌هایش حذف شود؟">حذف</button></form>
    </div></td></tr>`).join('')}
  </tbody></table></div>
  <p class="hint">${faDigits(passages)} بخش متن آماده‌ی جست‌وجو است.</p>` : '<div class="empty"><div class="big">🌐</div><p>هنوز سایتی اضافه نشده است.</p></div>'}
</div>
<div class="panel">
  <h2>امتحان کنید</h2>
  <form class="row" method="get" action="${url(bot)}">
    <label class="sr-only" for="k-q">سؤال</label>
    <input id="k-q" type="search" name="q" value="${esc(q)}" placeholder="یک سؤال مثل مشتری بپرسید…" style="flex:1;min-width:220px">
    <button class="btn btn-outline">جست‌وجو</button>
  </form>
  ${q ? (results.length ? results.map(r => `<div class="card" style="margin-top:12px;box-shadow:none">
    <div class="row-between"><strong>${esc(r.title || r.url)}</strong><span class="row">${verdict(r)}<span class="badge">${faDigits(Math.round(r.score * 100))}٪</span></span></div>
    <p style="margin:.4em 0">${esc(knowledge.snippet(r, q, 400))}</p>
    <a class="hint ltr" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>
  </div>`).join('') : '<p class="muted" style="margin-top:12px">چیزی پیدا نشد.</p>') : ''}
</div>`,
  }));
});

router.post('/app/bots/:botId/knowledge', form, (req, res) => {
  try {
    knowledge.startCrawl(req.bot, req.body.url);
    res.redirect(url(req.bot, '?ok=added'));
  } catch (e) {
    res.redirect(url(req.bot, `?err=${encodeURIComponent(e.friendly || knowledge.friendlyError(e))}`));
  }
});

router.post('/app/bots/:botId/knowledge/:sourceId/recrawl', form, (req, res) => {
  try {
    knowledge.recrawl(req.bot, Number(req.params.sourceId));
    res.redirect(url(req.bot, '?ok=recrawl'));
  } catch (e) {
    res.redirect(url(req.bot, `?err=${encodeURIComponent(e.friendly || knowledge.friendlyError(e))}`));
  }
});

router.post('/app/bots/:botId/knowledge/:sourceId/delete', form, (req, res) => {
  knowledge.deleteSource(req.bot, Number(req.params.sourceId));
  res.redirect(url(req.bot, '?ok=deleted'));
});

module.exports = router;

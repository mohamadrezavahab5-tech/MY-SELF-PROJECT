'use strict';
// Quality control (QC) dashboard, under /app/bots/:botId/qc:
//   /             conversations with scores and flags, summary tiles, operator leaderboard
//   /c/:convId    one conversation: transcript, metrics, flags, auto/AI/human reviews, review form
//   /rubric       criteria, weights and rules editor
//   /kb           knowledge-base (FAQ) health checks
//   /export.csv   QC results
// Scoring and checks live in src/qc.js.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const llm = require('../llm');
const qc = require('../qc');
const { effectivePlan } = require('../plans');
const { dashPage } = require('../views/layout');
const { faDateTime, faDay, ago, markPlaceholders } = require('../views/helpers');
const { esc, faDigits, formatNumber } = require('../util');

const router = express.Router();
const form = express.urlencoded({ extended: false, limit: '64kb' });
const DAY = 86400_000;

qc.startJob();

// Login, same-origin POSTs and bot ownership, checked here too so this router
// is safe on its own.
router.use('/app/bots/:botId/qc', auth.requireUser, auth.sameOrigin);
router.param('botId', (req, res, next, id) => {
  if (!req.user) return auth.requireUser(req, res, next);
  const bot = db.get().prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!bot) return res.redirect('/app');
  req.bot = bot;
  next();
});

const FLASH = {
  rubric_saved: 'معیارها و قوانین ذخیره شد. گفتگوها با قوانین جدید دوباره بررسی می‌شوند.',
  rubric_reset: 'معیارها و قوانین به حالت پیش‌فرض برگشت.',
  review_saved: 'ارزیابی شما ثبت شد. ✅',
  review_deleted: 'ارزیابی حذف شد.',
  ai_queued: 'گفتگو در صف بررسی هوش مصنوعی قرار گرفت؛ نتیجه چند لحظه‌ی دیگر همین‌جا نمایش داده می‌شود.',
  auto_done: 'بررسی خودکار دوباره انجام شد.',
};

function str(v) {
  return typeof v === 'string' ? v : '';
}

function url(bot, sub = '') {
  return `/app/bots/${bot.id}/qc${sub}`;
}

function userBots(user) {
  return db.get().prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(user.id);
}

function render(req, res, { title, body, status = 200, flash }) {
  res.status(status).send(dashPage({
    title, user: req.user, bot: req.bot, bots: userBots(req.user), active: 'qc',
    body: `<div class="qc-page">${body}</div>\n<script src="/js/qc.js" defer></script>`,
    flash: flash !== undefined ? flash : (FLASH[req.query.ok] || ''),
  }));
}

function channelName(c) {
  return { web: 'سایت', page: 'لینک اختصاصی', bale: 'بله', telegram: 'تلگرام' }[c] || c;
}

function pct(x) {
  return x === null || x === undefined || !Number.isFinite(x) ? '—' : `${faDigits(Math.round(x))}٪`;
}

function scoreLevel(score, pass) {
  if (score === null || score === undefined) return 'none';
  if (score >= pass) return 'good';
  return score >= pass - 15 ? 'mid' : 'bad';
}

function scoreChip(score, pass, { cls = '', label = '' } = {}) {
  const lvl = scoreLevel(score, pass);
  const text = score === null || score === undefined ? '—' : faDigits(Math.round(score));
  return `<span class="qc-score ${lvl}${cls ? ` ${cls}` : ''}"${label ? ` aria-label="${esc(label)}"` : ''}>${text}</span>`;
}

const SOURCE_FA = { auto: 'خودکار', ai: 'هوش مصنوعی', human: 'ناظر' };
const SOURCE_SHORT = { auto: 'خودکار', ai: 'AI', human: 'ناظر' };
const LEVEL_BADGE = { high: 'danger', warn: 'warn', info: '' };
const LEVEL_ICON = { high: '🔴', warn: '🟠', info: '🔵' };
const LEVEL_ORDER = { high: 0, warn: 1, info: 2 };

function sortFlags(flags) {
  return [...flags].sort((a, b) => (LEVEL_ORDER[a.level] ?? 3) - (LEVEL_ORDER[b.level] ?? 3));
}

function flagBadges(flags, max = 3) {
  if (!flags || !flags.length) return '<span class="qc-clean">✓ بدون مشکل</span>';
  const sorted = sortFlags(flags);
  const shown = sorted.slice(0, max).map(f => `<span class="badge ${LEVEL_BADGE[f.level] || ''}" title="${esc(f.text)}">${esc(qc.FLAG_LABELS[f.code] || f.code)}</span>`);
  if (sorted.length > max) shown.push(`<span class="badge" title="${esc(sorted.slice(max).map(f => f.text).join('\n'))}">+${faDigits(sorted.length - max)}</span>`);
  return `<div class="qc-flags">${shown.join('')}</div>`;
}

function tabs(bot, active) {
  const kb = qc.kbHealthCached(bot.id);
  const t = (href, label, key) => `<a class="qc-tab${active === key ? ' active' : ''}" href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="qc-tabs" aria-label="بخش‌های کنترل کیفیت">
  ${t(url(bot), '<span aria-hidden="true">📋</span> گفتگوها و امتیازها', 'list')}
  ${t(url(bot, '/rubric'), '<span aria-hidden="true">📐</span> معیارها و قوانین', 'rubric')}
  ${t(url(bot, '/kb'), `<span aria-hidden="true">🩺</span> سلامت پایگاه دانش${kb && kb.issues ? ` <span class="badge warn">${faDigits(kb.issues)}</span>` : ''}`, 'kb')}
</nav>`;
}

function pageHead(title, actions = '') {
  return `<div class="page-title"><h1>${title}</h1>${actions ? `<div class="row">${actions}</div>` : ''}</div>`;
}

// ---- Overview -------------------------------------------------------------------

const PERIODS = [[1, '۲۴ ساعت اخیر'], [7, '۷ روز اخیر'], [30, '۳۰ روز اخیر'], [90, '۹۰ روز اخیر'], [0, 'همه‌ی زمان‌ها']];

function filtersOf(q) {
  const days = PERIODS.some(p => String(p[0]) === str(q.days)) ? Number(q.days) : 30;
  return {
    days,
    operator: str(q.op).trim().slice(0, 60),
    below: q.below === '1',
    handoff: q.handoff === '1',
    thumbs: q.thumbs === '1',
    unreviewed: q.unreviewed === '1',
    page: Math.max(1, Math.floor(Number(q.page) || 1)),
  };
}

function queryOf(f, extra = {}) {
  const v = { ...f, ...extra };
  const p = new URLSearchParams();
  if (v.days !== 30) p.set('days', String(v.days));
  if (v.operator) p.set('op', v.operator);
  for (const k of ['below', 'handoff', 'thumbs', 'unreviewed']) if (v[k]) p.set(k, '1');
  if (v.page > 1) p.set('page', String(v.page));
  const s = p.toString();
  return s ? `?${s}` : '';
}

function filterForm(bot, f, o) {
  const check = (name, label) => `<label class="check"><input type="checkbox" name="${name}" value="1"${f[name] ? ' checked' : ''}> ${label}</label>`;
  const opOptions = o.operators.map(n => `<option value="${esc(n)}"${n === f.operator ? ' selected' : ''}>${esc(n)}</option>`).join('');
  const any = f.operator || f.below || f.handoff || f.thumbs || f.unreviewed || f.days !== 30;
  return `<form class="qc-filters" method="get" action="${url(bot)}" data-qc-autosubmit>
  <div class="qc-filter-selects">
    <label><span class="label">بازه</span><select name="days">${PERIODS.map(([d, l]) => `<option value="${d}"${d === f.days ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label><span class="label">اپراتور</span><select name="op"><option value="">همه</option>${opOptions}${f.operator && !o.operators.includes(f.operator) ? `<option value="${esc(f.operator)}" selected>${esc(f.operator)}</option>` : ''}</select></label>
  </div>
  <div class="qc-filter-checks">
    ${check('below', `زیر حد قبولی (${faDigits(o.rubric.passScore)})`)}
    ${check('handoff', 'فقط گفتگوهای با اپراتور')}
    ${check('thumbs', 'دارای 👎')}
    ${check('unreviewed', 'بدون ارزیابی ناظر')}
  </div>
  <div class="row qc-filter-actions"><button class="btn btn-sm btn-outline">اعمال</button>${any ? `<a class="btn btn-sm btn-ghost" href="${url(bot)}">حذف فیلترها</a>` : ''}</div>
</form>`;
}

function tiles(o) {
  const s = o.summary;
  const pass = o.rubric.passScore;
  const avg = s.avgScore === null ? null : Math.round(s.avgScore);
  return `<div class="stats qc-stats">
  <div class="stat"><div class="n qc-n-${scoreLevel(avg, pass)}">${avg === null ? '—' : faDigits(avg)}<small> / ۱۰۰</small></div><div class="l">میانگین امتیاز کیفیت</div>${avg === null ? '' : `<div class="meter qc-meter-${scoreLevel(avg, pass)}"><span style="width:${avg}%"></span></div>`}</div>
  <div class="stat"><div class="n${s.belowPct ? ' qc-n-bad' : ''}">${pct(s.belowPct)}</div><div class="l">زیر حد قبولی (${faDigits(pass)} از ۱۰۰)</div></div>
  <div class="stat"><div class="n">${qc.formatDuration(s.avgFirstResponseSec, { short: true })}</div><div class="l">میانگین اولین پاسخ اپراتور</div></div>
  <div class="stat"><div class="n">${formatNumber(s.reviewed)}</div><div class="l">گفتگوی بررسی‌شده${s.humanReviewed ? ` · ${faDigits(s.humanReviewed)} توسط ناظر` : ''}</div></div>
</div>`;
}

function leaderboard(bot, f, o) {
  const pass = o.rubric.passScore;
  const missed = o.summary.missedHandoffs;
  const warn = missed ? `<div class="notice qc-gap">⚠️ ${faDigits(missed)} بار مشتری اپراتور خواست و کسی جواب نداد. <a href="${url(bot)}${queryOf(f, { handoff: true, page: 1 })}">نمایش این گفتگوها</a></div>` : '';
  if (!o.leaderboard.length) {
    return `<div class="panel"><h2>عملکرد اپراتورها</h2>${warn}<div class="empty qc-empty-sm"><div class="big">🎧</div><p>در این بازه گفتگویی به اپراتور انسانی نرسیده است. وقتی همکاران از «گفتگوی زنده» جواب بدهند، عملکردشان اینجا مقایسه می‌شود.</p></div></div>`;
  }
  const rows = o.leaderboard.map((e, i) => {
    const avg = e.avgScore === null ? null : Math.round(e.avgScore);
    const active = f.operator === e.name;
    return `<tr${active ? ' class="qc-row-active"' : ''}>
  <td data-label="رتبه" class="qc-rank">${faDigits(i + 1)}</td>
  <td data-label="اپراتور"><a href="${url(bot)}${queryOf(f, { operator: active ? '' : e.name, page: 1 })}"><strong>${esc(e.name)}</strong></a></td>
  <td data-label="گفتگو">${formatNumber(e.conversations)}</td>
  <td data-label="میانگین امتیاز"><div class="qc-bar-cell">${scoreChip(avg, pass, { cls: 'sm' })}<div class="qc-bar"><span class="${scoreLevel(avg, pass)}" style="width:${avg || 0}%"></span></div></div></td>
  <td data-label="اولین پاسخ">${qc.formatDuration(e.avgFirstResponseSec, { short: true })}</td>
  <td data-label="زیر حد قبولی">${e.below ? `<span class="badge danger">${faDigits(e.below)}</span>` : '<span class="muted">۰</span>'}</td>
  <td data-label="کلمه‌ی نامناسب">${e.forbidden ? `<span class="badge danger">${faDigits(e.forbidden)}</span>` : '<span class="muted">۰</span>'}</td>
</tr>`;
  }).join('');
  return `<div class="panel"><div class="row-between"><h2>عملکرد اپراتورها</h2><span class="hint">برای دیدن گفتگوهای هر اپراتور روی نامش بزنید.</span></div>${warn}
<div class="table-wrap"><table class="table qc-table qc-board"><thead><tr><th>#</th><th>اپراتور</th><th>گفتگو</th><th>میانگین امتیاز</th><th>میانگین اولین پاسخ</th><th>زیر حد قبولی</th><th>کلمه‌ی نامناسب</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function reviewTrio(r, pass) {
  const one = (label, v) => `<span class="qc-mini"><span>${label}</span>${scoreChip(v ? v.score : null, pass, { cls: 'sm' })}</span>`;
  return `<div class="qc-trio">${one('خودکار', r.auto)}${one('AI', r.ai)}${one('ناظر', r.human)}</div>`;
}

function visitorLabel(c) {
  return c.visitor_name ? esc(c.visitor_name) : 'بازدیدکننده';
}

function convRows(bot, o) {
  const pass = o.rubric.passScore;
  return o.rows.map(r => {
    const c = r.conv;
    const m = r.m;
    const who = m && m.operators.length
      ? `${m.operators.map(n => esc(n)).join('، ')}${m.firstResponseSec !== null ? `<div class="hint">اولین پاسخ: ${qc.formatDuration(m.firstResponseSec, { short: true })}</div>` : ''}`
      : (m && m.subject === 'handoff' ? '<span class="badge danger">بی‌پاسخ ماند</span>' : '<span class="badge">فقط بات</span>');
    const msgs = m ? m.counts.visitor + m.counts.bot + m.counts.operator : null;
    const state = r.active ? '<span class="badge primary">در جریان</span>' : (!r.auto ? '<span class="badge">در صف بررسی</span>' : flagBadges(r.auto.flags));
    return `<tr>
  <td data-label="گفتگو"><a class="qc-conv-link" href="${url(bot, `/c/${c.id}`)}"><strong>#${faDigits(c.id)}</strong> · ${visitorLabel(c)}</a>
    <div class="hint">${esc(channelName(c.channel))} · ${esc(ago(c.last_message_at))}${msgs !== null ? ` · ${faDigits(msgs)} پیام` : ''}${m && m.thumbsDown ? ` · ${faDigits(m.thumbsDown)} 👎` : ''}</div></td>
  <td data-label="پاسخگو">${who}</td>
  <td data-label="امتیاز نهایی"><div class="qc-final">${scoreChip(r.final, pass, { cls: 'md' })}${r.source ? `<span class="hint">${SOURCE_SHORT[r.source]}</span>` : ''}</div></td>
  <td data-label="ارزیابی‌ها">${reviewTrio(r, pass)}</td>
  <td data-label="مشکلات">${state}</td>
  <td class="qc-go"><a class="btn btn-sm btn-outline" href="${url(bot, `/c/${c.id}`)}">بررسی</a></td>
</tr>`;
  }).join('');
}

function pager(bot, f, o) {
  if (o.pages <= 1) return '';
  const link = (p, label, rel) => `<a class="btn btn-sm btn-ghost" rel="${rel}" href="${url(bot)}${queryOf(f, { page: p })}">${label}</a>`;
  return `<nav class="qc-pager" aria-label="صفحه‌بندی">
  ${o.page > 1 ? link(o.page - 1, '→ قبلی', 'prev') : '<span></span>'}
  <span class="muted">صفحه‌ی ${faDigits(o.page)} از ${faDigits(o.pages)}</span>
  ${o.page < o.pages ? link(o.page + 1, 'بعدی ←', 'next') : '<span></span>'}
</nav>`;
}

router.get('/app/bots/:botId/qc', (req, res) => {
  const bot = req.bot;
  const f = filtersOf(req.query);
  const rubric = qc.getRubric(bot);
  const since = f.days ? Date.now() - f.days * DAY : 0;
  // Catch up on conversations the background job has not reached yet.
  qc.reviewPending({ botId: bot.id, since, limit: 300, aiLimit: 5 });
  const nFaqs = db.get().prepare('SELECT COUNT(*) AS n FROM faqs WHERE bot_id = ?').get(bot.id).n;
  if (nFaqs <= 400) qc.kbHealth(bot.id); // cheap enough to keep the tab badge current
  const o = qc.overview(bot, { ...f, rubric });

  const list = o.rows.length
    ? `<div class="table-wrap"><table class="table qc-table qc-convs"><thead><tr><th>گفتگو</th><th>پاسخگو</th><th>امتیاز نهایی</th><th>ارزیابی‌ها</th><th>مشکلات</th><th><span class="sr-only">بررسی</span></th></tr></thead><tbody>${convRows(bot, o)}</tbody></table></div>${pager(bot, f, o)}`
    : `<div class="empty"><div class="big">🔎</div><p>${o.summary.total ? 'با این فیلترها گفتگویی پیدا نشد.' : 'در این بازه گفتگویی ثبت نشده است. وقتی مشتری‌ها با بات یا همکاران‌تان گفتگو کنند، هر گفتگو ۳۰ دقیقه بعد از پایان به‌طور خودکار بررسی و نمره‌دهی می‌شود.'}</p></div>`;

  render(req, res, {
    title: 'کنترل کیفیت',
    body: `${pageHead('کنترل کیفیت (QC)', o.total ? `<a class="btn btn-ghost btn-sm" href="${url(bot, `/export.csv${queryOf(f, { page: 1 })}`)}">⬇ خروجی CSV</a>` : '')}
${tabs(bot, 'list')}
<p class="muted qc-intro">هر گفتگو (بات و اپراتور) با <a href="${url(bot, '/rubric')}">معیارهای شما</a> نمره می‌گیرد: بررسی خودکار از روی متن و زمان پیام‌ها${llm.isConfigured() ? '، بررسی هوش مصنوعی' : ''} و ارزیابی ناظر. امتیاز نهایی هر گفتگو ارزیابی ناظر است و اگر نبود، ${llm.isConfigured() ? 'هوش مصنوعی و بعد ' : ''}بررسی خودکار.</p>
${filterForm(bot, f, o)}
${tiles(o)}
${leaderboard(bot, f, o)}
<div class="panel"><div class="row-between"><h2>گفتگوها <span class="badge primary">${formatNumber(o.total)}</span></h2><span class="hint">گفتگوها ۳۰ دقیقه بعد از آخرین پیام خودکار بررسی می‌شوند.</span></div>
${list}
</div>`,
  });
});

// ---- CSV export ------------------------------------------------------------------

function csvCell(v) {
  const s = String(v ?? '');
  // Neutralize spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

router.get('/app/bots/:botId/qc/export.csv', (req, res) => {
  const bot = req.bot;
  const f = filtersOf(req.query);
  const o = qc.overview(bot, { ...f, page: 1, rubric: qc.getRubric(bot) });
  const head = ['شناسه', 'آخرین پیام', 'بازدیدکننده', 'تلفن', 'کانال', 'اپراتور', 'پیام مشتری', 'اولین پاسخ (ثانیه)', 'میانگین پاسخ (ثانیه)', '👎',
    'امتیاز خودکار', 'امتیاز هوش مصنوعی', 'امتیاز ناظر', 'امتیاز نهایی', 'نتیجه', 'مشکلات'];
  const lines = [head.map(csvCell).join(',')];
  for (const r of o.all) {
    const m = r.m || {};
    const verdict = r.final === null ? '' : (r.final >= o.rubric.passScore ? 'قبول' : 'رد');
    lines.push([
      r.conv.id, faDateTime(r.conv.last_message_at), r.conv.visitor_name, r.conv.visitor_phone, channelName(r.conv.channel),
      (m.operators || []).join('، '), m.counts ? m.counts.visitor : '', m.firstResponseSec ?? '', m.avgResponseSec ?? '', m.thumbsDown ?? '',
      r.auto ? r.auto.score ?? '' : '', r.ai ? r.ai.score ?? '' : '', r.human ? r.human.score ?? '' : '', r.final ?? '', verdict,
      r.auto ? r.auto.flags.map(x => x.text).join(' | ') : '',
    ].map(csvCell).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="qc-${bot.id}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

// ---- Conversation detail ------------------------------------------------------------

const timeFmt = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' });
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });

function loadConv(req) {
  return qc.getConversation(req.bot.id, req.params.convId);
}

// Escapes text and wraps occurrences of the given words in <mark>.
function highlight(text, words) {
  const s = String(text);
  if (!words || !words.length) return esc(s);
  const lower = s.toLowerCase();
  const useLower = lower.length === s.length;
  const hay = useLower ? lower : s;
  const ranges = [];
  for (const w of words) {
    const lw = useLower ? String(w).toLowerCase() : String(w);
    if (!lw) continue;
    for (let i = hay.indexOf(lw); i >= 0; i = hay.indexOf(lw, i + lw.length)) ranges.push([i, i + lw.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a < pos) continue;
    out += esc(s.slice(pos, a)) + `<mark class="qc-hit">${esc(s.slice(a, b))}</mark>`;
    pos = b;
  }
  return out + esc(s.slice(pos));
}

const BOT_TYPE = {
  answer: '<span class="badge ok">جواب داد</span>',
  passage: '<span class="badge ok">از سایت</span>',
  ai: '<span class="badge primary">هوش مصنوعی</span>',
  suggest: '<span class="badge warn">پیشنهاد داد</span>',
  fallback: '<span class="badge danger">بی‌جواب</span>',
  limit: '<span class="badge danger">سقف مصرف</span>',
};

function transcriptHtml(conv, data, metrics, rubric) {
  const { chats, logs } = data;
  if (!chats.length) return '<div class="empty"><p>پیامی در این گفتگو ثبت نشده است.</p></div>';
  // Line up each bot message with its analytics row (same order, close in time) to show 👍/👎.
  const logOf = new Map();
  let j = 0;
  for (const c of chats) {
    if (c.sender !== 'bot') continue;
    while (j < logs.length && logs[j].created_at < c.created_at - 15_000) j++;
    if (j < logs.length && Math.abs(logs[j].created_at - c.created_at) <= 15_000) logOf.set(c.id, logs[j++]);
  }
  const hitsOf = new Map();
  for (const h of metrics.forbiddenHits) {
    if (!hitsOf.has(h.chatId)) hitsOf.set(h.chatId, []);
    if (!hitsOf.get(h.chatId).includes(h.word)) hitsOf.get(h.chatId).push(h.word);
  }
  const T = rubric.targetFirstResponseSec;
  let waitingSince = null;
  let lastDay = '';
  const out = [];
  for (const c of chats) {
    const day = dayKeyFmt.format(new Date(c.created_at));
    if (day !== lastDay) {
      out.push(`<div class="qc-day"><span>${esc(faDay(c.created_at))}</span></div>`);
      lastDay = day;
    }
    const time = `<time datetime="${new Date(c.created_at).toISOString()}" title="${esc(faDateTime(c.created_at))}">${esc(timeFmt.format(new Date(c.created_at)))}</time>`;
    if (c.sender === 'system') {
      if (waitingSince === null) waitingSince = c.created_at;
      out.push(`<div class="qc-sys"><span>${esc(c.text)}</span> ${time}</div>`);
      continue;
    }
    let who = '';
    let extra = '';
    if (c.sender === 'visitor') {
      who = conv.visitor_name ? esc(conv.visitor_name) : 'مشتری';
      if (waitingSince === null) waitingSince = c.created_at;
    } else if (c.sender === 'bot') {
      who = '🤖 بات';
      const log = logOf.get(c.id);
      extra = `${BOT_TYPE[(log && log.type) || c.meta.type] || ''}${log && log.helpful === 0 ? '<span class="badge danger" title="مشتری این پاسخ را نپسندید">👎</span>' : ''}${log && log.helpful === 1 ? '<span class="badge ok" title="مشتری این پاسخ را پسندید">👍</span>' : ''}`;
      waitingSince = null;
    } else if (c.sender === 'operator') {
      who = `🎧 ${esc(qc.operatorName(c))}`;
      if (waitingSince !== null) {
        const w = (c.created_at - waitingSince) / 1000;
        extra = `<span class="qc-wait${w > T ? ' slow' : ''}" title="زمان انتظار مشتری">⏱ ${esc(qc.formatDuration(w))}</span>`;
      }
      waitingSince = null;
    }
    const hits = hitsOf.get(c.id);
    out.push(`<div class="qc-msg from-${esc(c.sender)}${hits ? ' has-hit' : ''}" id="m-${c.id}">
  <div class="qc-msg-head"><span class="who">${who}</span>${extra}${time}</div>
  <div class="qc-msg-body">${highlight(c.text, hits)}</div>
  ${hits ? `<div class="qc-msg-flag">⚠️ کلمه‌ی نامناسب: ${hits.map(w => `«${esc(w)}»`).join('، ')}</div>` : ''}
</div>`);
  }
  return `<div class="qc-transcript" role="log" aria-label="متن گفتگو">${out.join('\n')}</div>`;
}

function metricsHtml(m) {
  const items = [
    ['مدت گفتگو', qc.formatDuration(m.durationSec)],
    ['پیام‌ها', `مشتری ${faDigits(m.counts.visitor)} · بات ${faDigits(m.counts.bot)} · اپراتور ${faDigits(m.counts.operator)}`],
  ];
  if (m.handoff) {
    items.push(['اولین پاسخ اپراتور', m.firstResponseSec === null ? '<span class="badge danger">پاسخی نیامد</span>' : qc.formatDuration(m.firstResponseSec)]);
    items.push(['میانگین زمان پاسخ', qc.formatDuration(m.avgResponseSec)]);
    if (m.maxResponseSec !== null && m.responses > 1) items.push(['طولانی‌ترین انتظار', qc.formatDuration(m.maxResponseSec)]);
  }
  if (m.botAnswered + m.botMissed > 0) {
    items.push(['نرخ پاسخ بات', `${pct(m.botAnswerRate * 100)} <span class="hint">(${faDigits(m.botAnswered)} از ${faDigits(m.botAnswered + m.botMissed)})</span>`]);
    items.push(['پیشنهاد / بی‌جواب', `${faDigits(m.botSuggest)} / ${faDigits(m.botFallback)}`]);
  }
  items.push(['بازخورد مشتری', `${faDigits(m.thumbsUp)} 👍 · ${faDigits(m.thumbsDown)} 👎`]);
  items.push(['شماره‌ی مشتری ثبت شد', m.leadCaptured ? '<span class="badge ok">بله</span>' : '<span class="badge">خیر</span>']);
  items.push(['آخرین پیام بی‌پاسخ', m.lastUnanswered ? '<span class="badge danger">بله</span>' : '<span class="badge ok">خیر</span>']);
  if (m.greeting) items.push(['سلام اپراتور', m.greeting === 'none' ? '<span class="badge warn">ندارد</span>' : '<span class="badge ok">دارد</span>']);
  if (m.closing !== null) items.push(['خداحافظی اپراتور', m.closing ? '<span class="badge ok">دارد</span>' : '<span class="badge warn">ندارد</span>']);
  return `<dl class="qc-metrics">${items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

function flagsHtml(flags) {
  if (!flags.length) return '<p class="qc-clean">✓ بررسی خودکار مشکلی پیدا نکرد.</p>';
  return `<ul class="qc-flag-list">${sortFlags(flags)
    .map(f => `<li class="lvl-${esc(f.level)}"><span aria-hidden="true">${LEVEL_ICON[f.level] || '•'}</span><span>${esc(f.text)}</span></li>`).join('')}</ul>`;
}

function fa1(n) {
  return faDigits(n).replace('.', '٫');
}

function criteriaMatrix(rubric, k) {
  const pass = rubric.passScore;
  const cell = (r, id) => {
    if (!r) return '<td class="muted">—</td>';
    const v = r.criteria[id];
    if (!v) return '<td class="muted" title="قابل ارزیابی نبود">—</td>';
    const s = v.score;
    const lvl = s === null ? 'none' : (s >= 8 ? 'good' : s >= 5 ? 'mid' : 'bad');
    return `<td><span class="qc-cs ${lvl}">${s === null ? '—' : fa1(s)}</span>${v.note ? `<div class="qc-note">${esc(v.note)}</div>` : ''}</td>`;
  };
  const rows = qc.activeCriteria(rubric).map(c => `<tr><th scope="row">${esc(c.label)} <span class="hint">(${faDigits(c.weight)})</span></th>${cell(k.auto, c.id)}${cell(k.ai, c.id)}${cell(k.human, c.id)}</tr>`).join('');
  const total = r => (r ? `<td>${scoreChip(r.score, pass, { cls: 'sm' })}</td>` : '<td class="muted">—</td>');
  return `<div class="table-wrap"><table class="table qc-matrix"><thead><tr><th>معیار (وزن)</th><th>خودکار</th><th>هوش مصنوعی</th><th>ناظر${k.human && k.human.reviewer_name ? `<div class="hint">${esc(k.human.reviewer_name)}</div>` : ''}</th></tr></thead>
<tbody>${rows}</tbody><tfoot><tr><th scope="row">امتیاز از ۱۰۰</th>${total(k.auto)}${total(k.ai)}${total(k.human)}</tr></tfoot></table></div>`;
}

function aiPanel(req, conv, k) {
  if (!llm.isConfigured()) return '';
  const bot = req.bot;
  const state = qc.aiState(conv.id);
  const allowed = effectivePlan(req.user).ai;
  let body = '';
  if (state === 'queued' || state === 'running') {
    body = `<div class="notice" data-qc-poll="${url(bot, `/c/${conv.id}/ai.json`)}"><span class="qc-spinner" aria-hidden="true"></span> ${state === 'running' ? 'هوش مصنوعی در حال بررسی این گفتگوست…' : 'در صف بررسی هوش مصنوعی…'}</div>`;
  } else {
    if (state === 'failed') body += '<div class="error qc-gap">بررسی هوش مصنوعی انجام نشد (مدل در دسترس نبود یا پاسخ نامعتبر داد). دوباره امتحان کنید.</div>';
    if (k.ai && k.ai.summary) body += `<p class="qc-ai-summary">${esc(k.ai.summary)}</p><p class="hint">${esc(ago(k.ai.created_at))}</p>`;
    body += allowed
      ? `<form method="post" action="${url(bot, `/c/${conv.id}/ai`)}"><button class="btn btn-outline btn-sm">🤖 ${k.ai ? 'بررسی دوباره با هوش مصنوعی' : 'بررسی با هوش مصنوعی'}</button></form>`
      : '<p class="hint">بررسی گفتگو با هوش مصنوعی در پلن‌های حرفه‌ای و سازمانی فعال است. <a href="/app/billing">ارتقای پلن</a></p>';
  }
  return `<div class="panel" id="ai"><h2>بررسی هوش مصنوعی</h2>${body}</div>`;
}

function reviewForm(req, conv, rubric, k) {
  const bot = req.bot;
  const rows = qc.activeCriteria(rubric).map(c => {
    const auto = k.auto && k.auto.criteria[c.id] ? k.auto.criteria[c.id].score : null;
    const ai = k.ai && k.ai.criteria[c.id] ? k.ai.criteria[c.id].score : null;
    const suggest = ai !== null ? ai : auto;
    const hints = [auto !== null ? `خودکار ${fa1(auto)}` : '', ai !== null ? `AI ${fa1(ai)}` : ''].filter(Boolean).join(' · ');
    const opts = ['<option value="">— قابل ارزیابی نیست</option>']
      .concat([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(n => `<option value="${n}">${faDigits(n)}${n === 10 ? ' — عالی' : n === 0 ? ' — بسیار ضعیف' : ''}</option>`)).join('');
    return `<div class="qc-crit-row">
  <div class="qc-crit-label"><label for="s-${esc(c.id)}"><strong>${esc(c.label)}</strong></label> <span class="badge">وزن ${faDigits(c.weight)}</span>${c.hint ? `<div class="hint">${esc(c.hint)}</div>` : ''}${hints ? `<div class="hint qc-suggest">پیشنهاد: ${hints}</div>` : ''}</div>
  <select id="s-${esc(c.id)}" name="s_${esc(c.id)}" data-weight="${c.weight}"${suggest !== null ? ` data-suggest="${Math.round(suggest)}"` : ''}>${opts}</select>
  <input type="text" name="n_${esc(c.id)}" maxlength="500" placeholder="یادداشت برای این معیار (اختیاری)" aria-label="یادداشت ${esc(c.label)}">
</div>`;
  }).join('');
  const history = k.humans.length ? `<h3 class="qc-sub">ارزیابی‌های ثبت‌شده</h3><ul class="qc-history">${[...k.humans].reverse().map(h => `<li>
  <div class="row-between"><span class="row">${scoreChip(h.score, rubric.passScore, { cls: 'sm' })} <strong>${esc(h.reviewer_name || 'ناظر')}</strong> <span class="hint">${esc(faDateTime(h.created_at))}</span></span>
  <form method="post" action="${url(bot, `/reviews/${h.id}/delete`)}"><button class="btn btn-ghost btn-sm" data-confirm="این ارزیابی حذف شود؟">حذف</button></form></div>
  ${h.summary ? `<p class="qc-review-summary">${esc(h.summary)}</p>` : ''}
</li>`).join('')}</ul>` : '';
  return `<div class="panel" id="review">
  <div class="row-between"><h2>ارزیابی ناظر</h2><button type="button" class="btn btn-ghost btn-sm hide" data-qc-fill>پر کردن با امتیازهای پیشنهادی</button></div>
  <p class="hint">به هر معیار از ۰ تا ۱۰ نمره بدهید. معیاری را که در این گفتگو معنا ندارد روی «قابل ارزیابی نیست» بگذارید تا در امتیاز حساب نشود.${k.human ? ' ارزیابی جدید جای امتیاز نهایی قبلی را می‌گیرد.' : ''}</p>
  ${req.query.err ? `<div class="error qc-gap">${esc(req.query.err)}</div>` : ''}
  <form class="form qc-review-form" method="post" action="${url(bot, `/c/${conv.id}/review`)}">
    ${rows}
    <div class="field"><label for="qc-summary">جمع‌بندی و بازخورد به اپراتور</label><textarea id="qc-summary" name="summary" rows="3" maxlength="2000" placeholder="نقاط قوت، اشکال‌ها و پیشنهاد برای دفعه‌ی بعد"></textarea></div>
    <div class="field qc-reviewer"><label for="qc-reviewer">نام ارزیاب</label><input id="qc-reviewer" type="text" name="reviewer" maxlength="60" value="${esc(req.user.name)}"></div>
    <div class="row-between"><div class="qc-live" aria-live="polite">امتیاز این ارزیابی: <b data-qc-total data-pass="${rubric.passScore}">—</b></div><button class="btn btn-primary">ثبت ارزیابی</button></div>
  </form>
  ${history}
</div>`;
}

router.get('/app/bots/:botId/qc/c/:convId', (req, res) => {
  const bot = req.bot;
  const conv = loadConv(req);
  if (!conv) return res.redirect(url(bot));
  const rubric = qc.getRubric(bot);
  const idle = !!conv.closed_at || Date.now() - conv.last_message_at >= qc.IDLE_MS;
  let k = qc.latestByKind(qc.reviewsFor(conv.id));
  if (idle && (!k.auto || k.auto.created_at < conv.last_message_at || k.auto.created_at < (rubric.updatedAt || 0))) {
    qc.autoReview(conv, { bot, rubric });
    k = qc.latestByKind(qc.reviewsFor(conv.id));
  }
  const data = qc.loadData(conv);
  const m = qc.computeMetrics(conv, rubric, data);
  const flags = k.auto ? k.auto.flags : qc.ruleFlags(m, rubric, bot);
  const fin = qc.finalOf(k);
  const pass = rubric.passScore;
  const verdict = fin.score === null ? '<span class="badge">بدون امتیاز</span>'
    : fin.score >= pass ? '<span class="qc-verdict good">قبول ✓</span>' : '<span class="qc-verdict bad">زیر حد قبولی</span>';
  const who = [conv.visitor_name && esc(conv.visitor_name), conv.visitor_phone && `<span class="ltr">${esc(conv.visitor_phone)}</span>`, esc(channelName(conv.channel)), esc(faDateTime(conv.created_at))].filter(Boolean).join(' · ');
  const page = /^https?:\/\//i.test(conv.page_url || '') ? conv.page_url : '';

  render(req, res, {
    title: `بررسی گفتگوی ${faDigits(conv.id)}`,
    body: `<a class="qc-back" href="${url(bot)}">→ همه‌ی گفتگوها</a>
${pageHead(`بررسی گفتگوی #${faDigits(conv.id)}`, `<form method="post" action="${url(bot, `/c/${conv.id}/auto`)}"><button class="btn btn-ghost btn-sm" title="بررسی خودکار با قوانین فعلی">↻ بررسی خودکار دوباره</button></form>`)}
<p class="muted qc-conv-meta">${who}${page ? ` · <a class="ltr" href="${esc(page)}" target="_blank" rel="noopener nofollow">${esc(page.replace(/^https?:\/\//i, '').slice(0, 60))}</a>` : ''}</p>
${!idle ? '<div class="notice qc-gap">این گفتگو هنوز در جریان است؛ ۳۰ دقیقه بعد از آخرین پیام به‌طور خودکار بررسی می‌شود.</div>' : ''}
<div class="qc-detail">
  <div class="qc-main">
    <div class="panel"><h2>متن گفتگو</h2>${transcriptHtml(conv, data, m, rubric)}</div>
    <div class="panel"><h2>ارزیابی معیارها</h2>${criteriaMatrix(rubric, k)}</div>
    ${reviewForm(req, conv, rubric, k)}
  </div>
  <aside class="qc-aside">
    <div class="panel qc-scorecard">
      <div class="qc-scorecard-top">${scoreChip(fin.score, pass, { cls: 'xl', label: 'امتیاز نهایی' })}
      <div>${verdict}<div class="hint">${fin.source ? `امتیاز نهایی از ارزیابی ${SOURCE_FA[fin.source]}` : 'هنوز ارزیابی نشده'} · حد قبولی ${faDigits(pass)}</div></div></div>
      ${reviewTrio({ auto: k.auto, ai: k.ai, human: k.human }, pass)}
    </div>
    <div class="panel"><h2>مشکلات</h2>${flagsHtml(flags)}</div>
    ${aiPanel(req, conv, k)}
    <div class="panel"><h2>شاخص‌ها</h2>${metricsHtml(m)}</div>
  </aside>
</div>`,
  });
});

router.post('/app/bots/:botId/qc/c/:convId/auto', form, (req, res) => {
  const conv = loadConv(req);
  if (!conv) return res.redirect(url(req.bot));
  qc.autoReview(conv, { bot: req.bot });
  res.redirect(url(req.bot, `/c/${conv.id}?ok=auto_done`));
});

router.post('/app/bots/:botId/qc/c/:convId/ai', form, (req, res) => {
  const conv = loadConv(req);
  if (!conv) return res.redirect(url(req.bot));
  if (!llm.isConfigured() || !effectivePlan(req.user).ai) return res.redirect(url(req.bot, `/c/${conv.id}`));
  qc.enqueueAi(conv.id);
  res.redirect(url(req.bot, `/c/${conv.id}?ok=ai_queued#ai`));
});

router.get('/app/bots/:botId/qc/c/:convId/ai.json', (req, res) => {
  const conv = loadConv(req);
  if (!conv) return res.status(404).json({ ok: false });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, state: qc.aiState(conv.id) });
});

router.post('/app/bots/:botId/qc/c/:convId/review', form, (req, res) => {
  const bot = req.bot;
  const conv = loadConv(req);
  if (!conv) return res.redirect(url(bot));
  const rubric = qc.getRubric(bot);
  const scores = {};
  const notes = {};
  for (const c of rubric.criteria) {
    scores[c.id] = str(req.body[`s_${c.id}`]);
    notes[c.id] = str(req.body[`n_${c.id}`]);
  }
  const r = qc.saveHumanReview(bot, conv, {
    reviewerName: str(req.body.reviewer).trim() || req.user.name,
    scores, notes, summary: str(req.body.summary),
  }, rubric);
  if (r.error) return res.redirect(url(bot, `/c/${conv.id}?err=${encodeURIComponent(r.error)}#review`));
  res.redirect(url(bot, `/c/${conv.id}?ok=review_saved#review`));
});

router.post('/app/bots/:botId/qc/reviews/:reviewId/delete', form, (req, res) => {
  const row = db.get().prepare(`SELECT conversation_id FROM qc_reviews WHERE id = ? AND bot_id = ? AND reviewer = 'human'`).get(Number(req.params.reviewId), req.bot.id);
  if (!row) return res.redirect(url(req.bot));
  qc.deleteHumanReview(req.bot.id, req.params.reviewId);
  res.redirect(url(req.bot, `/c/${row.conversation_id}?ok=review_deleted#review`));
});

// ---- Rubric & rules editor ------------------------------------------------------------

const RULE_FA = {
  greeting: 'پیام اول اپراتور یکی از عبارت‌های سلام را دارد (اگر در پیام دوم بیاید ۷ از ۱۰).',
  courtesy: 'هر کلمه‌ی ممنوع در پیام اپراتور یا بات ۴ نمره کم می‌کند.',
  accuracy: 'گفتگوهای بات: سهم سؤال‌های جواب‌گرفته منهای 👎. پاسخ اپراتور را هوش مصنوعی یا ناظر می‌سنجد.',
  resolution: 'آخرین پیام مشتری بی‌پاسخ نمانده؛ جواب بات، یا ثبت شماره برای پیگیری.',
  speed: 'اولین پاسخ و میانگین پاسخ اپراتور نسبت به زمان هدف (۵ برابر هدف = صفر).',
  closing: 'یکی از دو پیام آخر اپراتور عبارت جمع‌بندی یا خداحافظی دارد.',
  '': 'فقط با هوش مصنوعی یا ناظر نمره می‌گیرد.',
};

function rubricPage(req, res, rubric, { errors = [], status = 200 } = {}) {
  const bot = req.bot;
  const rows = rubric.criteria.slice(0, 10);
  const blanks = Math.max(0, Math.min(2, 10 - rows.length));
  const all = rows.concat(Array.from({ length: blanks }, () => ({ id: '', label: '', weight: '', hint: '', blank: true })));
  const sum = rows.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  const list = (name, value, label, hint, rowsN = 5) => `<div class="field"><label for="r-${name}">${label}</label><textarea id="r-${name}" name="${name}" rows="${rowsN}">${esc(value.join('\n'))}</textarea><span class="hint">${hint}</span></div>`;
  render(req, res, {
    status,
    title: 'معیارها و قوانین QC',
    body: `${pageHead('کنترل کیفیت (QC)')}
${tabs(bot, 'rubric')}
${errors.length ? `<div class="error qc-gap" role="alert"><strong>ذخیره نشد:</strong><ul>${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form class="form" method="post" action="${url(bot, '/rubric')}" data-qc-rubric>
<div class="panel">
  <h2>معیارهای ارزیابی</h2>
  <p class="muted">هر گفتگو در هر معیار از ۰ تا ۱۰ نمره می‌گیرد و وزن هر معیار سهمش از امتیاز ۱۰۰ است. جمع وزن‌ها باید ۱۰۰ شود؛ وزن ۰ یعنی معیار غیرفعال. معیاری که در یک گفتگو معنا ندارد (مثلاً سلام اپراتور در گفتگوی بات) در امتیاز آن گفتگو حساب نمی‌شود.</p>
  <div class="qc-rubric">
    <div class="qc-rubric-head" aria-hidden="true"><span>عنوان معیار</span><span>وزن</span><span>راهنمای ارزیاب</span></div>
    ${all.map((c, i) => `<div class="qc-rubric-row${c.blank ? ' blank' : ''}">
      <input type="hidden" name="c_id_${i}" value="${esc(c.id)}">
      <input type="text" name="c_label_${i}" maxlength="60" value="${esc(c.label)}" placeholder="${c.blank ? 'معیار جدید (اختیاری)، مثلاً: رعایت اسکریپت فروش' : ''}" aria-label="عنوان معیار ${faDigits(i + 1)}">
      <input type="number" name="c_weight_${i}" min="0" max="100" step="1" inputmode="numeric" value="${esc(c.weight)}" aria-label="وزن" data-qc-weight>
      <input type="text" name="c_hint_${i}" maxlength="200" value="${esc(c.hint || '')}" placeholder="توضیح کوتاه برای ارزیاب و هوش مصنوعی" aria-label="راهنمای ارزیاب">
      <div class="qc-rule hint"><span aria-hidden="true">${c.blank ? '➕' : (qc.ruleOf(c) ? '⚙️' : '👤')}</span> ${c.blank ? 'معیار دلخواه؛ با هوش مصنوعی یا ناظر نمره می‌گیرد.' : `<span>${qc.ruleOf(c) ? 'بررسی خودکار: ' : ''}${esc(RULE_FA[qc.ruleOf(c)])}</span>`}</div>
    </div>`).join('')}
  </div>
  <div class="qc-weight-sum ${sum === 100 ? 'ok' : 'bad'}" data-qc-sum>جمع وزن‌ها: <b>${faDigits(sum)}</b> از ۱۰۰</div>
</div>
<div class="panel">
  <h2>قوانین بررسی خودکار</h2>
  <p class="muted">هر عبارت در یک خط. مقایسه با نرمال‌سازی فارسی انجام می‌شود: «ي/ی»، «ك/ک»، اعراب، کشیده‌نویسی و فاصله/نیم‌فاصله فرقی نمی‌کند و کلمه‌ها کامل مقایسه می‌شوند («خر» با «خرید» یکی نیست).</p>
  <div class="grid grid-2">
    ${list('forbidden', rubric.forbidden, 'کلمه‌ها و عبارت‌های ممنوع', 'کلمه‌های بی‌ادبانه یا خلاف لحن برند، مثلاً نام رقبا. اگر در پیام اپراتور یا بات بیاید علامت می‌خورد.', 6)}
    ${list('required', rubric.required, 'عبارت‌های الزامی دیگر (اختیاری)', 'عبارت‌هایی که اپراتور باید در هر گفتگو بگوید؛ مثلاً «شماره پیگیری».', 6)}
    ${list('greetings', rubric.greetings, 'عبارت‌های سلام و شروع گفتگو', 'اپراتور باید در پیام اولش یکی از این‌ها را بگوید.')}
    ${list('closings', rubric.closings, 'عبارت‌های جمع‌بندی و خداحافظی', 'یکی از دو پیام آخر اپراتور باید یکی از این‌ها را داشته باشد.')}
  </div>
  <div class="grid grid-2 qc-gap-top">
    <div class="field"><label for="r-target">زمان هدف برای اولین پاسخ اپراتور (ثانیه)</label><input id="r-target" type="number" name="target" min="5" max="3600" step="1" inputmode="numeric" value="${esc(rubric.targetFirstResponseSec)}"><span class="hint">از لحظه‌ای که مشتری اپراتور می‌خواهد تا اولین پیام اپراتور.</span></div>
    <div class="field"><label for="r-pass">حد قبولی (از ۱۰۰)</label><input id="r-pass" type="number" name="pass" min="0" max="100" step="1" inputmode="numeric" value="${esc(rubric.passScore)}"><span class="hint">گفتگوهای با امتیاز کمتر «زیر حد قبولی» حساب می‌شوند.</span></div>
  </div>
  ${llm.isConfigured() ? `<input type="hidden" name="ai_shown" value="1"><label class="check qc-gap-top"><input type="checkbox" name="aiAuto" value="1"${rubric.aiAuto ? ' checked' : ''}> گفتگوهای مهم (با اپراتور، 👎، زیر حد قبولی یا طولانی) خودکار با هوش مصنوعی هم بررسی شوند${effectivePlan(req.user).ai ? '' : ' <span class="badge">پلن حرفه‌ای</span>'}</label>` : ''}
</div>
<div class="row-between"><button class="btn btn-primary">ذخیره‌ی معیارها و قوانین</button>
  <button class="btn btn-ghost btn-sm" formaction="${url(bot, '/rubric/reset')}" formnovalidate data-confirm="همه‌ی معیارها و قوانین به حالت پیش‌فرض برگردد؟">بازگشت به پیش‌فرض</button></div>
</form>`,
  });
}

router.get('/app/bots/:botId/qc/rubric', (req, res) => {
  rubricPage(req, res, qc.getRubric(req.bot));
});

router.post('/app/bots/:botId/qc/rubric', form, (req, res) => {
  const b = req.body;
  const current = qc.getRubric(req.bot);
  const criteria = [];
  for (let i = 0; i < 12; i++) {
    if (b[`c_label_${i}`] === undefined && b[`c_id_${i}`] === undefined) continue;
    const label = str(b[`c_label_${i}`]).trim();
    const weight = str(b[`c_weight_${i}`]).trim();
    const id = str(b[`c_id_${i}`]).trim();
    if (!label && !id && !weight) continue; // untouched blank row
    criteria.push({ id, label, weight: weight === '' ? '0' : weight, hint: str(b[`c_hint_${i}`]) });
  }
  const { rubric, errors } = qc.validateRubric({
    criteria,
    forbidden: str(b.forbidden),
    greetings: str(b.greetings),
    closings: str(b.closings),
    required: str(b.required),
    targetFirstResponseSec: str(b.target),
    passScore: str(b.pass),
    aiAuto: b.ai_shown ? !!b.aiAuto : current.aiAuto,
  });
  if (errors.length) {
    // Show the owner's input back as typed.
    const shown = { ...rubric, criteria, targetFirstResponseSec: str(b.target), passScore: str(b.pass) };
    return rubricPage(req, res, shown, { errors, status: 400 });
  }
  qc.saveRubric(req.bot.id, rubric);
  res.redirect(url(req.bot, '/rubric?ok=rubric_saved'));
});

router.post('/app/bots/:botId/qc/rubric/reset', form, (req, res) => {
  qc.resetRubric(req.bot.id);
  res.redirect(url(req.bot, '/rubric?ok=rubric_reset'));
});

// ---- Knowledge-base health --------------------------------------------------------------

function faqLink(bot, f) {
  return `<a href="/app/bots/${bot.id}/faqs#faq-${f.id}">${esc(f.question)}</a>`;
}

function kbSection(id, icon, title, hint, items, count) {
  return `<section class="panel qc-kb" id="${id}">
  <div class="row-between"><h2><span aria-hidden="true">${icon}</span> ${title}</h2>${count ? `<span class="badge warn">${faDigits(count)}</span>` : '<span class="badge ok">✓ موردی نیست</span>'}</div>
  <p class="hint">${hint}</p>
  ${items.length ? `<ul class="qc-kb-list">${items.join('')}</ul>` : ''}
</section>`;
}

router.get('/app/bots/:botId/qc/kb', (req, res) => {
  const bot = req.bot;
  const kb = qc.kbHealth(bot.id, { fresh: req.query.refresh === '1' });
  const N = 50;
  const items = (list, fn) => list.slice(0, N).map(fn).concat(list.length > N ? [`<li class="muted">و ${faDigits(list.length - N)} مورد دیگر…</li>`] : []);
  const disliked = items(kb.disliked, f => `<li><div>${faqLink(bot, f)}<div class="hint qc-clamp">${esc(f.answer)}</div></div>
    <div class="qc-kb-meta"><span class="badge danger">${faDigits(f.down)} 👎 از ${faDigits(f.down + f.up)} رأی</span><span class="hint">${faDigits(f.answers)} بار پاسخ در ۹۰ روز</span></div></li>`);
  const dups = items(kb.duplicates, d => `<li class="qc-dup"><div><div>${faqLink(bot, d.a)}</div><div class="qc-dup-sep" aria-hidden="true">↕</div><div>${faqLink(bot, d.b)}</div></div>
    <div class="qc-kb-meta"><span class="badge ${d.score >= 0.9 ? 'danger' : 'warn'}">${faDigits(Math.round(d.score * 100))}٪ شباهت</span></div></li>`);
  const ph = items(kb.placeholders, f => `<li><div>${faqLink(bot, f)}<div class="hint qc-clamp">${markPlaceholders(f.answer)}</div></div></li>`);
  const stale = items(kb.stale, f => `<li><div>${faqLink(bot, f)}</div><div class="qc-kb-meta"><span class="hint">آخرین ویرایش: ${esc(faDay(f.updatedAt))}</span></div></li>`);
  const unused = items(kb.unused, f => `<li><div>${faqLink(bot, f)}</div><div class="qc-kb-meta"><span class="hint">ساخته‌شده: ${esc(faDay(f.createdAt))}</span></div></li>`);

  render(req, res, {
    title: 'سلامت پایگاه دانش',
    body: `${pageHead('کنترل کیفیت (QC)', `<a class="btn btn-ghost btn-sm" href="${url(bot, '/kb?refresh=1')}">↻ بررسی دوباره</a>`)}
${tabs(bot, 'kb')}
<p class="muted qc-intro">کیفیت جواب‌های بات به کیفیت سؤال و جواب‌های شما بستگی دارد. این بخش سؤال و جواب‌هایی را نشان می‌دهد که احتمالاً باید اصلاح، ادغام یا حذف شوند. روی هر سؤال بزنید تا در صفحه‌ی «سؤال و جواب‌ها» ویرایشش کنید.</p>
<div class="stats qc-stats">
  <div class="stat"><div class="n">${formatNumber(kb.total)}</div><div class="l">سؤال و جواب (${faDigits(kb.enabled)} فعال)</div></div>
  <div class="stat"><div class="n${kb.issues ? ' qc-n-mid' : ' qc-n-good'}">${formatNumber(kb.issues)}</div><div class="l">مورد نیازمند توجه</div></div>
  <div class="stat"><div class="n${kb.disliked.length ? ' qc-n-bad' : ''}">${formatNumber(kb.disliked.length)}</div><div class="l">جواب با 👎 زیاد</div></div>
  <div class="stat"><div class="n">${formatNumber(kb.duplicates.length)}</div><div class="l">جفت سؤال تکراری</div></div>
</div>
${kb.total ? `${kbSection('kb-disliked', '👎', 'جواب‌هایی که مشتری‌ها نپسندیدند', 'حداقل دو بازخورد منفی در ۹۰ روز اخیر و بیشتر از بازخوردهای مثبت. جواب را کامل‌تر یا دقیق‌تر کنید.', disliked, kb.disliked.length)}
${kbSection('kb-duplicates', '🔁', 'سؤال‌های تکراری یا خیلی شبیه', 'سؤال‌های شبیه هم باعث می‌شوند بات به‌جای جواب مستقیم، پیشنهاد بدهد. یکی را نگه دارید و دیگری را به «شکل‌های دیگر پرسیدن» آن اضافه کنید.', dups, kb.duplicates.length)}
${kbSection('kb-placeholders', '✏️', 'جاهای خالی [داخل کروشه]', 'این جواب‌ها هنوز متن نمونه دارند و مشتری همان کروشه‌ها را می‌بیند.', ph, kb.placeholders.length)}
${kbSection('kb-stale', '🕰️', 'جواب‌های قدیمی', 'بیش از ۶ ماه ویرایش نشده‌اند. قیمت‌ها، ساعت کاری و شرایط را دوباره بررسی کنید.', stale, kb.stale.length)}
${kbSection('kb-unused', '💤', 'سؤال‌های بی‌استفاده', 'بیش از ۹۰ روز است که بات با این‌ها به هیچ سؤالی جواب نداده. شاید باید شکل پرسیدنشان را عوض کنید یا حذفشان کنید.', unused, kb.unused.length)}
${kb.dupChecked < kb.enabled ? `<p class="hint">برای سرعت، تکراری‌ها بین ${formatNumber(kb.dupChecked)} سؤال اول بررسی شد.</p>` : ''}
<p class="hint">آخرین بررسی: ${esc(ago(kb.checkedAt))}</p>`
    : `<div class="panel"><div class="empty"><div class="big">📝</div><p>هنوز سؤال و جوابی اضافه نکرده‌اید.</p><a class="btn btn-primary btn-sm" href="/app/bots/${bot.id}/faqs">افزودن سؤال و جواب</a></div></div>`}`,
  });
});

module.exports = router;

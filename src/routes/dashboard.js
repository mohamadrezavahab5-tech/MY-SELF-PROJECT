'use strict';
// Logged-in dashboard: bots, FAQ management, the "unanswered questions"
// learning inbox, leads, test console, install & settings.
const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../db');
const bots = require('../bots');
const auth = require('../auth');
const config = require('../config');
const content = require('../content');
const channels = require('../channels');
const engine = require('../nlp/engine');
const { effectivePlan, PLANS } = require('../plans');
const { dashPage } = require('../views/layout');
const { faDateTime, ago, markPlaceholders, hasPlaceholder, TYPE_BADGE } = require('../views/helpers');
const { esc, faDigits, formatNumber } = require('../util');
const { safeNext } = require('./account');

const router = express.Router();
router.use('/app', auth.requireUser, auth.sameOrigin);
const form = express.urlencoded({ extended: false, limit: '64kb' });

const FLASH = {
  created: 'بات ساخته شد. 🎉',
  faq_added: 'سؤال اضافه شد.',
  faq_saved: 'تغییرات ذخیره شد.',
  faq_deleted: 'سؤال حذف شد.',
  imported: 'سؤال‌ها وارد شدند.',
  learned: 'یاد گرفت! دفعه‌ی بعد خودش جواب می‌دهد. 🎓',
  ignored: 'از فهرست حذف شد.',
  settings: 'تنظیمات ذخیره شد.',
  lead_done: 'درخواست به‌عنوان انجام‌شده علامت خورد.',
  connected: 'اتصال برقرار شد. ✅',
  disconnected: 'اتصال قطع شد.',
  domains: 'دامنه‌های مجاز ذخیره شد.',
};

function flashOf(req) {
  const extra = req.query.n ? ` (${faDigits(Number(req.query.n) || 0)} مورد)` : '';
  return FLASH[req.query.ok] ? FLASH[req.query.ok] + extra : '';
}

function userBots(user) {
  return db.get().prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(user.id);
}

function render(req, res, { title, body, bot = null, active = '', flash }) {
  res.send(dashPage({
    title, body, user: req.user, bot, bots: userBots(req.user), active,
    flash: flash !== undefined ? flash : flashOf(req),
  }));
}

function botUrl(bot, sub = '') {
  return `/app/bots/${bot.id}${sub}`;
}

function faqCount(botId) {
  return db.get().prepare('SELECT COUNT(*) AS n FROM faqs WHERE bot_id = ?').get(botId).n;
}

// Loads :botId and checks ownership.
router.param('botId', (req, res, next, id) => {
  const bot = db.get().prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!bot) return res.redirect('/app');
  req.bot = bot;
  next();
});

router.get('/app', (req, res) => {
  const list = userBots(req.user);
  if (!list.length) return res.redirect('/app/onboarding');
  res.redirect(botUrl(list[0]));
});

router.get('/app/switch', (req, res) => {
  const bot = db.get().prepare('SELECT id FROM bots WHERE id = ? AND user_id = ?').get(Number(req.query.id), req.user.id);
  res.redirect(bot ? `/app/bots/${bot.id}` : '/app');
});

// ---- Onboarding / new bot -------------------------------------------------

function newBotForm(req, { title, intro }) {
  const pre = String(req.query.industry || '');
  const opts = content.industries.map(i => `<label><input type="radio" name="industry" value="${esc(i.id)}"${i.id === pre ? ' checked' : ''}> <span>${esc(i.icon)} ${esc(i.name)}</span></label>`).join('');
  return `<div class="page-title"><h1>${esc(title)}</h1></div>
<div class="panel">
  <p class="muted">${esc(intro)}</p>
  <form class="form" method="post" action="/app/bots/new">
    <input type="hidden" name="next" value="${esc(safeNext(req.query.next, ''))}">
    <div class="field"><label for="name">اسم بات (همان اسمی که مشتری می‌بیند)</label><input id="name" name="name" type="text" required maxlength="60" value="${esc(req.user.company || '')}"></div>
    <div class="field"><span class="label">حوزه‌ی کاری</span>
      <div class="industry-pick">${opts}<label><input type="radio" name="industry" value=""${pre ? '' : ' checked'}> <span>✳️ سایر</span></label></div>
    </div>
    <label class="check"><input type="checkbox" name="starter" value="1" checked> سؤال و جواب‌های آماده‌ی این حوزه را اضافه کن (بعداً ویرایششان می‌کنید)</label>
    <div><button class="btn btn-primary btn-lg">ساخت بات</button></div>
  </form>
</div>`;
}

router.get('/app/onboarding', (req, res) => {
  if (userBots(req.user).length) return res.redirect('/app');
  render(req, res, {
    title: 'ساخت اولین بات',
    active: 'newbot',
    body: newBotForm(req, { title: `${req.user.name}، خوش آمدید! 👋`, intro: 'اول بات‌تان را بسازیم. حوزه‌ی کاری‌تان را انتخاب کنید تا با سؤال و جواب‌های آماده شروع کنید. دو دقیقه بیشتر طول نمی‌کشد.' }),
  });
});

router.get('/app/bots/new', (req, res) => {
  const plan = effectivePlan(req.user);
  if (userBots(req.user).length >= plan.bots) {
    return render(req, res, {
      title: 'بات جدید', active: 'newbot',
      body: `<div class="page-title"><h1>بات جدید</h1></div><div class="panel"><p>پلن فعلی شما (${esc(plan.name)}) حداکثر ${faDigits(plan.bots)} بات دارد. برای ساخت بات‌های بیشتر پلن <strong>${esc(PLANS.business.name)}</strong> را انتخاب کنید.</p><a class="btn btn-primary" href="/app/billing?plan=business">ارتقای پلن</a></div>`,
    });
  }
  render(req, res, { title: 'بات جدید', active: 'newbot', body: newBotForm(req, { title: 'بات جدید', intro: 'برای یک سایت، شعبه یا بخش دیگر، یک بات جداگانه بسازید.' }) });
});

router.post('/app/bots/new', form, (req, res) => {
  const plan = effectivePlan(req.user);
  if (userBots(req.user).length >= plan.bots) return res.redirect('/app/bots/new');
  const name = String(req.body.name || '').trim().slice(0, 60) || req.user.company || 'بات من';
  const industry = content.industryById(String(req.body.industry || ''));
  const bot = bots.createBot(req.user.id, { name, industry: industry ? industry.id : '' });
  let imported = 0;
  if (industry && req.body.starter) imported = importStarter(bot, industry, plan);
  const next = safeNext(req.body.next, '');
  if (next) return res.redirect(next);
  res.redirect(botUrl(bot, `/faqs?ok=created${imported ? '&starter=1' : ''}`));
});

function importStarter(bot, industry, plan) {
  const room = Math.max(0, plan.faqs - faqCount(bot.id));
  const list = industry.starterFaqs.slice(0, room);
  db.get().transaction(() => { for (const f of list) bots.addFaq(bot.id, f); })();
  return list.length;
}

// ---- Overview ---------------------------------------------------------------

router.get('/app/bots/:botId', (req, res) => {
  const bot = req.bot;
  const conn = db.get();
  const plan = effectivePlan(req.user);
  const used = bots.answersThisMonth(req.user.id);
  const since = Date.now() - 30 * 86400_000;
  const counts = conn.prepare(`
    SELECT
      SUM(type = 'answer') AS answered,
      SUM(type IN ('suggest','fallback','limit')) AS missed,
      COUNT(*) AS total
    FROM messages WHERE bot_id = ? AND created_at >= ? AND channel != 'test'
  `).get(bot.id, since);
  const open = conn.prepare(`SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND type != 'answer' AND resolved = 0 AND channel != 'test'`).get(bot.id).n;
  const newLeads = conn.prepare(`SELECT COUNT(*) AS n FROM leads WHERE bot_id = ? AND status = 'new'`).get(bot.id).n;
  const nFaqs = faqCount(bot.id);
  const needEdit = conn.prepare('SELECT answer FROM faqs WHERE bot_id = ?').all(bot.id).filter(r => hasPlaceholder(r.answer)).length;
  const everUsed = conn.prepare(`SELECT 1 FROM messages WHERE bot_id = ? AND channel IN ('web','page','bale','telegram') LIMIT 1`).get(bot.id);
  const tested = conn.prepare(`SELECT 1 FROM messages WHERE bot_id = ? LIMIT 1`).get(bot.id);
  const rate = counts.total ? Math.round((counts.answered / counts.total) * 100) : 0;
  const pct = Math.min(100, Math.round((used / plan.answersPerMonth) * 100));
  const recent = conn.prepare(`SELECT * FROM messages WHERE bot_id = ? AND channel != 'test' ORDER BY id DESC LIMIT 8`).all(bot.id);

  const steps = [
    [nFaqs >= 5, 'حداقل ۵ سؤال و جواب اضافه کنید', botUrl(bot, '/faqs')],
    [nFaqs > 0 && needEdit === 0, 'جاهای خالی [داخل کروشه] را در جواب‌ها پر کنید', botUrl(bot, '/faqs?filter=placeholders')],
    [!!tested, 'بات را امتحان کنید', botUrl(bot, '/test')],
    [!!everUsed, 'بات را روی سایت نصب کنید یا لینکش را به اشتراک بگذارید', botUrl(bot, '/install')],
  ];
  const allDone = steps.every(s => s[0]);

  render(req, res, {
    title: bot.name, bot, active: 'overview',
    body: `<div class="page-title"><h1>${esc(bot.name)}</h1><a class="btn btn-outline btn-sm" href="/c/${esc(bot.public_key)}" target="_blank" rel="noopener">مشاهده‌ی صفحه‌ی گفتگو ↗</a></div>
${allDone ? '' : `<div class="panel"><h2>قدم‌های راه‌اندازی</h2><ul class="checklist">${steps.map(([done, text, href]) => `<li class="${done ? 'done' : ''}"><span class="dot">${done ? '✓' : ''}</span><a class="t" href="${href}">${esc(text)}</a></li>`).join('')}</ul></div>`}
<div class="stats">
  <div class="stat"><div class="n">${formatNumber(used)}</div><div class="l">پاسخ این ماه از ${formatNumber(plan.answersPerMonth)}</div><div class="meter${pct >= 100 ? ' full' : ''}"><span style="width:${pct}%"></span></div></div>
  <div class="stat"><div class="n">${faDigits(rate)}٪</div><div class="l">نرخ پاسخ‌گویی ۳۰ روز اخیر</div></div>
  <div class="stat"><div class="n">${formatNumber(open)}</div><div class="l"><a href="${botUrl(bot, '/inbox')}">سؤال بی‌جواب</a></div></div>
  <div class="stat"><div class="n">${formatNumber(newLeads)}</div><div class="l"><a href="${botUrl(bot, '/leads')}">درخواست تماس جدید</a></div></div>
</div>
${pct >= 80 && plan.id !== 'business' ? `<div class="notice" style="margin-bottom:18px">${pct >= 100 ? 'سقف پاسخ ماهانه تمام شده و بات فعلاً فقط شماره‌ی مشتری‌ها را می‌گیرد.' : 'به سقف پاسخ ماهانه نزدیک شده‌اید.'} <a href="/app/billing">ارتقای پلن ←</a></div>` : ''}
<div class="panel"><div class="row-between"><h2>آخرین گفتگوها</h2><a class="btn btn-sm btn-ghost" href="${botUrl(bot, '/inbox')}">سؤال‌های بی‌جواب</a></div>
${recent.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>سؤال مشتری</th><th>نتیجه</th><th>کانال</th><th>زمان</th></tr></thead><tbody>
${recent.map(m => `<tr><td>${esc(m.question)}</td><td>${TYPE_BADGE[m.type] || ''}</td><td>${esc(channelName(m.channel))}</td><td class="muted">${esc(ago(m.created_at))}</td></tr>`).join('')}
</tbody></table></div>` : '<div class="empty"><div class="big">💬</div><p>هنوز گفتگویی نبوده. بات را روی سایت نصب کنید یا لینکش را به اشتراک بگذارید.</p></div>'}
</div>`,
  });
});

function channelName(c) {
  return { web: 'سایت', page: 'لینک اختصاصی', bale: 'بله', telegram: 'تلگرام', test: 'تست' }[c] || c;
}

// ---- FAQ management ---------------------------------------------------------

function parseAlternates(text) {
  return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function faqItem(bot, f) {
  const alts = bots.safeJsonArray(f.alternates);
  return `<details class="faq-item${f.enabled ? '' : ' off'}" id="faq-${f.id}">
  <summary><div><div class="q">${esc(f.question)}</div><div class="a">${markPlaceholders(f.answer)}</div></div>
    <div class="meta">${hasPlaceholder(f.answer) ? '<span class="badge warn">نیاز به ویرایش</span>' : ''}${f.enabled ? '' : '<span class="badge">غیرفعال</span>'}<span class="badge" title="تعداد پاسخ">${faDigits(f.hits)} پاسخ</span></div>
  </summary>
  <form class="form" method="post" action="${botUrl(bot, `/faqs/${f.id}`)}">
    <div class="field"><label>سؤال</label><input type="text" name="question" required maxlength="300" value="${esc(f.question)}"></div>
    <div class="field"><label>شکل‌های دیگر پرسیدن همین سؤال <span class="hint">(هر خط یکی، اختیاری)</span></label><textarea name="alternates" rows="3">${esc(alts.join('\n'))}</textarea></div>
    <div class="field"><label>جواب</label><textarea name="answer" required maxlength="3000" rows="4">${esc(f.answer)}</textarea></div>
    <label class="check"><input type="checkbox" name="enabled" value="1"${f.enabled ? ' checked' : ''}> فعال</label>
    <div class="row"><button class="btn btn-primary btn-sm">ذخیره</button>
      <button class="btn btn-danger btn-sm" formaction="${botUrl(bot, `/faqs/${f.id}/delete`)}" data-confirm="این سؤال حذف شود؟">حذف</button></div>
  </form>
</details>`;
}

router.get('/app/bots/:botId/faqs', (req, res) => {
  const bot = req.bot;
  const plan = effectivePlan(req.user);
  const q = String(req.query.q || '').trim();
  const filter = String(req.query.filter || '');
  let rows = db.get().prepare('SELECT * FROM faqs WHERE bot_id = ? ORDER BY id DESC').all(bot.id);
  const total = rows.length;
  if (filter === 'placeholders') rows = rows.filter(r => hasPlaceholder(r.answer));
  if (q) {
    const nq = engine.normalize(q);
    rows = rows.filter(r => engine.normalize(`${r.question} ${r.alternates} ${r.answer}`).includes(nq));
  }
  const needEdit = db.get().prepare('SELECT answer FROM faqs WHERE bot_id = ?').all(bot.id).filter(r => hasPlaceholder(r.answer)).length;
  const full = total >= plan.faqs;
  const industry = content.industryById(bot.industry);

  render(req, res, {
    title: 'سؤال و جواب‌ها', bot, active: 'faqs',
    body: `<div class="page-title"><h1>سؤال و جواب‌ها <span class="badge primary">${faDigits(total)} از ${formatNumber(plan.faqs)}</span></h1>
  <div class="row"><a class="btn btn-ghost btn-sm" href="#import">ورود گروهی</a><a class="btn btn-ghost btn-sm" href="${botUrl(bot, '/faqs/export.xlsx')}">خروجی اکسل</a></div></div>
${req.query.starter ? `<div class="notice" style="margin-bottom:16px">سؤال‌های آماده اضافه شدند. جاهای <mark class="placeholder-mark">[داخل کروشه]</mark> را با اطلاعات کسب‌وکارتان پر کنید و سؤال‌هایی را که به کارتان نمی‌آید حذف کنید.</div>` : ''}
${needEdit && filter !== 'placeholders' ? `<div class="notice" style="margin-bottom:16px">${faDigits(needEdit)} جواب هنوز جای خالی دارد. <a href="?filter=placeholders">نمایش همین‌ها</a></div>` : ''}
<details class="panel add-faq"${total && !req.query.question ? '' : ' open'}>
  <summary><span class="btn btn-primary btn-sm">➕ افزودن سؤال جدید</span></summary>
  ${full ? `<p class="notice">به سقف سؤال‌های پلن ${esc(plan.name)} رسیده‌اید. <a href="/app/billing">ارتقای پلن</a></p>` : `
  <form class="form" method="post" action="${botUrl(bot, '/faqs')}">
    <div class="field"><label for="nq">سؤال</label><input id="nq" type="text" name="question" required maxlength="300" placeholder="مثلاً: هزینه‌ی ارسال چقدر است؟" value="${esc(req.query.question || '')}"></div>
    <div class="field"><label for="na">شکل‌های دیگر پرسیدن <span class="hint">(هر خط یکی، اختیاری؛ دقت بات را بالا می‌برد)</span></label><textarea id="na" name="alternates" rows="2" placeholder="هزینه پست چنده&#10;ارسال رایگان دارید؟"></textarea></div>
    <div class="field"><label for="nans">جواب</label><textarea id="nans" name="answer" required maxlength="3000" rows="3"></textarea></div>
    <div><button class="btn btn-primary">افزودن</button></div>
  </form>`}
</details>
<form class="row" method="get" style="margin-bottom:12px"><input type="search" name="q" placeholder="جستجو در سؤال‌ها…" value="${esc(q)}" style="max-width:320px">${filter ? `<input type="hidden" name="filter" value="${esc(filter)}">` : ''}<button class="btn btn-ghost btn-sm">جستجو</button>${q || filter ? `<a class="btn btn-sm btn-ghost" href="${botUrl(bot, '/faqs')}">همه</a>` : ''}</form>
${rows.length ? rows.map(f => faqItem(bot, f)).join('') : `<div class="empty"><div class="big">📝</div><p>${q || filter ? 'موردی پیدا نشد.' : 'هنوز سؤالی اضافه نکرده‌اید.'}</p></div>`}
<div class="panel" id="import" style="margin-top:24px">
  <h2>ورود گروهی</h2>
  ${industry || content.industries.length ? `<form class="row" method="post" action="${botUrl(bot, '/faqs/starter')}" style="margin-bottom:16px">
    <label class="label" for="starter-ind">بسته‌ی آماده:</label>
    <select id="starter-ind" name="industry" style="max-width:260px">${content.industries.map(i => `<option value="${esc(i.id)}"${industry && industry.id === i.id ? ' selected' : ''}>${esc(i.icon)} ${esc(i.name)} (${faDigits(i.starterFaqs.length)} سؤال)</option>`).join('')}</select>
    <button class="btn btn-outline btn-sm">افزودن بسته</button>
  </form>` : ''}
  <form class="form" method="post" action="${botUrl(bot, '/faqs/import-text')}">
    <div class="field"><label for="bulk">متن سؤال و جواب‌ها</label>
      <textarea id="bulk" name="text" rows="6" placeholder="سؤال: ساعت کاری شما چیست؟&#10;جواب: شنبه تا پنجشنبه ۹ تا ۱۸&#10;&#10;سؤال: ...&#10;جواب: ..."></textarea>
      <span class="hint">هر سؤال با «سؤال:» و جوابش با «جواب:» شروع شود. می‌توانید مستقیم از فایل Word یا صفحه‌ی سؤالات متداول سایتتان کپی کنید.</span></div>
    <div><button class="btn btn-outline btn-sm">ورود متن</button></div>
  </form>
  <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
  <div class="field"><span class="label">فایل اکسل یا CSV</span>
    <span class="hint">ستون اول: سؤال، ستون دوم: جواب، ستون سوم (اختیاری): شکل‌های دیگر سؤال که با «|» جدا شده‌اند. ردیف اول اگر عنوان باشد نادیده گرفته می‌شود.</span>
    <div class="row"><input type="file" id="import-file" accept=".xlsx,.csv" data-upload="${botUrl(bot, '/faqs/import-file')}"><span id="import-status" class="hint"></span></div>
  </div>
</div>`,
  });
});

function canAddFaq(req, n = 1) {
  return faqCount(req.bot.id) + n <= effectivePlan(req.user).faqs;
}

router.post('/app/bots/:botId/faqs', form, (req, res) => {
  const question = String(req.body.question || '').trim().slice(0, 300);
  const answer = String(req.body.answer || '').trim().slice(0, 3000);
  if (!question || !answer || !canAddFaq(req)) return res.redirect(botUrl(req.bot, '/faqs'));
  bots.addFaq(req.bot.id, { question, answer, alternates: parseAlternates(req.body.alternates) });
  res.redirect(botUrl(req.bot, '/faqs?ok=faq_added'));
});

router.post('/app/bots/:botId/faqs/starter', form, (req, res) => {
  const industry = content.industryById(String(req.body.industry || ''));
  if (!industry) return res.redirect(botUrl(req.bot, '/faqs'));
  const n = importStarter(req.bot, industry, effectivePlan(req.user));
  res.redirect(botUrl(req.bot, `/faqs?ok=imported&n=${n}&starter=1`));
});

// "سؤال: ... جواب: ..." blocks, as pasted from a Word doc or FAQ page.
function parseQaText(text) {
  const out = [];
  const re = /(?:^|\n)\s*(?:سؤال|سوال|س|Q)\s*[:：\-]\s*([\s\S]*?)\n\s*(?:جواب|پاسخ|ج|A)\s*[:：\-]\s*([\s\S]*?)(?=\n\s*(?:سؤال|سوال|س|Q)\s*[:：\-]|$)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const question = m[1].trim().replace(/\s+/g, ' ');
    const answer = m[2].trim();
    if (question && answer) out.push({ question: question.slice(0, 300), answer: answer.slice(0, 3000), alternates: [] });
  }
  return out;
}

function importList(req, list) {
  const room = Math.max(0, effectivePlan(req.user).faqs - faqCount(req.bot.id));
  const take = list.slice(0, room);
  db.get().transaction(() => { for (const f of take) bots.addFaq(req.bot.id, f); })();
  return take.length;
}

router.post('/app/bots/:botId/faqs/import-text', form, (req, res) => {
  const n = importList(req, parseQaText(req.body.text));
  res.redirect(botUrl(req.bot, `/faqs?ok=imported&n=${n}`));
});

function rowsToFaqs(rows) {
  const out = [];
  for (const r of rows) {
    const [question, answer, alts] = r.map(c => String(c ?? '').trim());
    if (!question || !answer) continue;
    if (/^(سؤال|سوال|question)$/i.test(question)) continue; // header row
    out.push({ question: question.slice(0, 300), answer: answer.slice(0, 3000), alternates: alts ? alts.split('|').map(s => s.trim()).filter(Boolean) : [] });
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(t => t.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
  }
  return String(v);
}

router.post('/app/bots/:botId/faqs/import-file', express.raw({ type: '*/*', limit: '4mb' }), async (req, res) => {
  try {
    const name = String(req.query.name || '').toLowerCase();
    let rows;
    if (name.endsWith('.csv')) {
      rows = parseCsv(req.body.toString('utf8'));
    } else {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.body);
      const ws = wb.worksheets[0];
      rows = [];
      ws.eachRow(r => { rows.push([1, 2, 3].map(i => cellText(r.getCell(i).value))); });
    }
    const n = importList(req, rowsToFaqs(rows));
    res.json({ ok: true, imported: n, redirect: botUrl(req.bot, `/faqs?ok=imported&n=${n}`) });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'فایل خوانده نشد. فایل اکسل (xlsx) یا CSV با ستون سؤال و جواب بفرستید.' });
  }
});

router.get('/app/bots/:botId/faqs/export.xlsx', async (req, res) => {
  const plan = effectivePlan(req.user);
  if (!plan.export) return res.redirect('/app/billing?need=export');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('FAQ', { views: [{ rightToLeft: true }] });
  ws.columns = [{ header: 'سؤال', width: 45 }, { header: 'جواب', width: 70 }, { header: 'شکل‌های دیگر', width: 45 }, { header: 'تعداد پاسخ', width: 12 }];
  for (const f of db.get().prepare('SELECT * FROM faqs WHERE bot_id = ? ORDER BY id').all(req.bot.id)) {
    ws.addRow([f.question, f.answer, bots.safeJsonArray(f.alternates).join(' | '), f.hits]);
  }
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="faq-${req.bot.id}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

router.post('/app/bots/:botId/faqs/:faqId', form, (req, res) => {
  const question = String(req.body.question || '').trim().slice(0, 300);
  const answer = String(req.body.answer || '').trim().slice(0, 3000);
  if (question && answer) {
    bots.updateFaq(req.bot.id, Number(req.params.faqId), {
      question, answer, alternates: parseAlternates(req.body.alternates), enabled: !!req.body.enabled,
    });
  }
  res.redirect(botUrl(req.bot, `/faqs?ok=faq_saved#faq-${Number(req.params.faqId)}`));
});

router.post('/app/bots/:botId/faqs/:faqId/delete', form, (req, res) => {
  bots.deleteFaq(req.bot.id, Number(req.params.faqId));
  res.redirect(botUrl(req.bot, '/faqs?ok=faq_deleted'));
});

// ---- Unanswered-questions inbox (the learning loop) ---------------------------

router.get('/app/bots/:botId/inbox', (req, res) => {
  const bot = req.bot;
  const rows = db.get().prepare(`
    SELECT * FROM messages WHERE bot_id = ? AND type != 'answer' AND resolved = 0 AND channel != 'test'
    ORDER BY id DESC LIMIT 500
  `).all(bot.id);
  // Group identical questions (after normalization) so repeats show as one row.
  const groups = new Map();
  for (const m of rows) {
    const key = engine.normalize(m.question) || m.question;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { msg: m, count: 1 });
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count || b.msg.id - a.msg.id);
  const faqs = db.get().prepare('SELECT id, question FROM faqs WHERE bot_id = ? ORDER BY question').all(bot.id);
  const options = faqs.map(f => `<option value="${f.id}">${esc(f.question.slice(0, 90))}</option>`).join('');

  render(req, res, {
    title: 'سؤال‌های بی‌جواب', bot, active: 'inbox',
    body: `<div class="page-title"><h1>سؤال‌های بی‌جواب <span class="badge primary">${faDigits(list.length)}</span></h1></div>
<p class="muted">این‌ها سؤال‌هایی است که بات جوابشان را با اطمینان پیدا نکرد. برای هرکدام یا جواب جدید بنویسید یا بگویید منظور مشتری کدام سؤال موجود بوده. از دفعه‌ی بعد، بات خودش جواب می‌دهد.</p>
${list.length ? list.map(({ msg, count }) => `<div class="panel" id="m-${msg.id}">
  <div class="row-between"><strong>«${esc(msg.question)}»</strong><span class="row">${count > 1 ? `<span class="badge warn">${faDigits(count)} بار پرسیده شده</span>` : ''}${TYPE_BADGE[msg.type] || ''}<span class="muted" style="font-size:.85rem">${esc(ago(msg.created_at))}</span></span></div>
  <details style="margin-top:10px"><summary class="btn btn-sm btn-primary">نوشتن جواب جدید</summary>
    <form class="form" method="post" action="${botUrl(bot, `/inbox/${msg.id}/answer`)}" style="margin-top:12px">
      <div class="field"><label>سؤال (می‌توانید مرتبش کنید)</label><input type="text" name="question" required maxlength="300" value="${esc(msg.question)}"></div>
      <div class="field"><label>جواب</label><textarea name="answer" required maxlength="3000" rows="3"></textarea></div>
      <div><button class="btn btn-primary btn-sm">ذخیره و یادگیری</button></div>
    </form>
  </details>
  ${faqs.length ? `<form class="row" method="post" action="${botUrl(bot, `/inbox/${msg.id}/attach`)}" style="margin-top:10px">
    <label class="hint" for="att-${msg.id}">یا منظورش این سؤال موجود بود:</label>
    <select id="att-${msg.id}" name="faqId" style="max-width:360px">${msg.faq_id ? options.replace(`value="${msg.faq_id}"`, `value="${msg.faq_id}" selected`) : options}</select>
    <button class="btn btn-outline btn-sm">وصل کن</button>
  </form>` : ''}
  <form method="post" action="${botUrl(bot, `/inbox/${msg.id}/ignore`)}" style="margin-top:8px"><button class="btn btn-ghost btn-sm">نادیده بگیر</button></form>
</div>`).join('') : '<div class="empty"><div class="big">🎉</div><p>سؤال بی‌جوابی نمانده!</p></div>'}`,
  });
});

function loadMsg(req) {
  return db.get().prepare('SELECT * FROM messages WHERE id = ? AND bot_id = ?').get(Number(req.params.msgId), req.bot.id);
}

// Resolve every open message with the same normalized wording.
function resolveSimilar(bot, question) {
  const key = engine.normalize(question);
  const open = db.get().prepare(`SELECT id, question FROM messages WHERE bot_id = ? AND type != 'answer' AND resolved = 0`).all(bot.id);
  const upd = db.get().prepare('UPDATE messages SET resolved = 1 WHERE id = ?');
  db.get().transaction(() => { for (const m of open) if (engine.normalize(m.question) === key) upd.run(m.id); })();
}

router.post('/app/bots/:botId/inbox/:msgId/answer', form, (req, res) => {
  const msg = loadMsg(req);
  const question = String(req.body.question || '').trim().slice(0, 300);
  const answer = String(req.body.answer || '').trim().slice(0, 3000);
  if (!msg || !question || !answer) return res.redirect(botUrl(req.bot, '/inbox'));
  if (!canAddFaq(req)) return res.redirect('/app/billing?need=faqs');
  const alternates = engine.normalize(question) !== engine.normalize(msg.question) ? [msg.question] : [];
  bots.addFaq(req.bot.id, { question, answer, alternates });
  resolveSimilar(req.bot, msg.question);
  res.redirect(botUrl(req.bot, '/inbox?ok=learned'));
});

router.post('/app/bots/:botId/inbox/:msgId/attach', form, (req, res) => {
  const msg = loadMsg(req);
  if (msg) {
    bots.addAlternate(req.bot.id, Number(req.body.faqId), msg.question.slice(0, 300));
    resolveSimilar(req.bot, msg.question);
  }
  res.redirect(botUrl(req.bot, '/inbox?ok=learned'));
});

router.post('/app/bots/:botId/inbox/:msgId/ignore', form, (req, res) => {
  const msg = loadMsg(req);
  if (msg) resolveSimilar(req.bot, msg.question);
  res.redirect(botUrl(req.bot, '/inbox?ok=ignored'));
});

// ---- Leads --------------------------------------------------------------------

router.get('/app/bots/:botId/leads', (req, res) => {
  const bot = req.bot;
  const rows = db.get().prepare('SELECT * FROM leads WHERE bot_id = ? ORDER BY status = \'done\', id DESC LIMIT 500').all(bot.id);
  render(req, res, {
    title: 'درخواست تماس', bot, active: 'leads',
    body: `<div class="page-title"><h1>درخواست‌های تماس</h1>${rows.length ? `<a class="btn btn-ghost btn-sm" href="${botUrl(bot, '/leads.csv')}">دانلود CSV</a>` : ''}</div>
<p class="muted">وقتی بات جواب سؤالی را نمی‌داند، از مشتری نام و شماره می‌گیرد تا خودتان تماس بگیرید.</p>
<div class="panel">${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>نام</th><th>شماره</th><th>پیام</th><th>زمان</th><th></th></tr></thead><tbody>
${rows.map(l => `<tr${l.status === 'done' ? ' style="opacity:.55"' : ''}><td>${esc(l.name || '—')}</td><td class="ltr"><a href="tel:${esc(l.phone)}">${esc(l.phone)}</a></td><td>${esc(l.message)}</td><td class="muted">${esc(faDateTime(l.created_at))}</td>
<td>${l.status === 'new' ? `<form method="post" action="${botUrl(bot, `/leads/${l.id}/done`)}"><button class="btn btn-sm btn-outline">تماس گرفتم ✓</button></form>` : '<span class="badge ok">انجام شد</span>'}</td></tr>`).join('')}
</tbody></table></div>` : '<div class="empty"><div class="big">📞</div><p>هنوز درخواستی ثبت نشده.</p></div>'}</div>`,
  });
});

router.post('/app/bots/:botId/leads/:leadId/done', form, (req, res) => {
  db.get().prepare(`UPDATE leads SET status = 'done' WHERE id = ? AND bot_id = ?`).run(Number(req.params.leadId), req.bot.id);
  res.redirect(botUrl(req.bot, '/leads?ok=lead_done'));
});

function csvCell(v) {
  const s = String(v ?? '');
  // Neutralize spreadsheet formula injection.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

router.get('/app/bots/:botId/leads.csv', (req, res) => {
  const rows = db.get().prepare('SELECT * FROM leads WHERE bot_id = ? ORDER BY id DESC').all(req.bot.id);
  const lines = [['نام', 'شماره', 'پیام', 'زمان', 'وضعیت'].map(csvCell).join(',')];
  for (const l of rows) lines.push([l.name, l.phone, l.message, faDateTime(l.created_at), l.status === 'done' ? 'انجام شد' : 'جدید'].map(csvCell).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="leads-${req.bot.id}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

// ---- Test console ---------------------------------------------------------------

router.get('/app/bots/:botId/test', (req, res) => {
  const bot = req.bot;
  render(req, res, {
    title: 'امتحان بات', bot, active: 'test',
    body: `<div class="page-title"><h1>امتحان بات</h1></div>
<p class="muted">مثل یک مشتری سؤال بپرسید و ببینید بات چه جوابی می‌دهد و چقدر مطمئن است. این گفتگوها در آمار و سقف مصرف حساب نمی‌شوند.</p>
<div class="panel" id="test-console" data-endpoint="${botUrl(bot, '/test.json')}">
  <div class="test-log" id="test-log" role="log" aria-live="polite"><div class="bubble bot">${esc(bot.welcome)}</div></div>
  <form class="row" id="test-form"><input type="text" id="test-q" required maxlength="500" placeholder="یک سؤال بپرسید…" style="flex:1;min-width:200px" autocomplete="off"><button class="btn btn-primary">بپرس</button></form>
</div>`,
  });
});

router.post('/app/bots/:botId/test.json', express.json({ limit: '4kb' }), (req, res) => {
  const q = String((req.body && req.body.q) || '').slice(0, 500);
  const reply = bots.ask(req.bot, q, { sessionId: `test:${req.user.id}`, channel: 'test' });
  // Debug view: the top candidates with their scores, so owners see why.
  res.json({ ok: true, reply, top: bots.debugSearch(req.bot, q) });
});

// ---- Install & channels ---------------------------------------------------------

router.get('/app/bots/:botId/install', (req, res) => {
  const bot = req.bot;
  const plan = effectivePlan(req.user);
  const snippet = `<script src="${config.siteUrl}/widget.js" data-bot="${bot.public_key}" async></script>`;
  const pageUrl = `${config.siteUrl}/c/${bot.public_key}`;
  const channelBox = (id) => {
    const ch = channels.CHANNELS[id];
    const connected = !!bot[ch.tokenCol];
    if (!plan.channels) return `<p class="muted">اتصال به ${ch.name} در پلن‌های حرفه‌ای و سازمانی فعال است. <a href="/app/billing">ارتقای پلن</a></p>`;
    if (connected) {
      return `<p><span class="badge ok">متصل</span> بات ${ch.name} شما فعال است و به پیام‌ها جواب می‌دهد.</p>
<form method="post" action="${botUrl(bot, `/channels/${id}/disconnect`)}"><button class="btn btn-danger btn-sm" data-confirm="اتصال قطع شود؟">قطع اتصال</button></form>`;
    }
    return `<form class="form" method="post" action="${botUrl(bot, `/channels/${id}`)}">
  <div class="field"><label>توکن ربات ${ch.name}</label><input type="text" class="ltr" name="token" required placeholder="123456789:AA..." autocomplete="off"></div>
  <div><button class="btn btn-outline btn-sm">اتصال</button></div>
</form>`;
  };
  render(req, res, {
    title: 'نصب روی سایت', bot, active: 'install',
    flash: req.query.err ? '' : undefined,
    body: `<div class="page-title"><h1>نصب و انتشار</h1></div>
${req.query.err ? `<div class="error" style="margin-bottom:16px">${esc(req.query.err)}</div>` : ''}
<div class="panel">
  <h2>🔌 روی سایت خودتان</h2>
  <p>این کد را کپی کنید و قبل از <code>&lt;/body&gt;</code> در همه‌ی صفحه‌های سایت بگذارید. دکمه‌ی گفتگو گوشه‌ی صفحه ظاهر می‌شود.</p>
  <div class="code-box" id="snippet">${esc(snippet)}<button type="button" class="btn btn-sm btn-outline copy-btn" data-copy="#snippet-raw">کپی</button></div>
  <textarea id="snippet-raw" class="hide" readonly>${esc(snippet)}</textarea>
  <details style="margin-top:14px"><summary><strong>راهنمای وردپرس</strong></summary>
    <ol><li>از پیشخوان وردپرس، افزونه‌ی «WPCode» یا «Insert Headers and Footers» را نصب کنید.</li><li>به بخش تنظیمات افزونه بروید و کد بالا را در کادر <strong>Footer</strong> بچسبانید.</li><li>ذخیره کنید و سایت را باز کنید. دکمه‌ی گفتگو باید ظاهر شود.</li></ol>
  </details>
  <details><summary><strong>سایت‌سازها (پرتال، میهن‌وب‌هاست، ژاکت و…)</strong></summary><p>در تنظیمات سایت‌ساز دنبال گزینه‌ای مثل «کد سفارشی»، «اسکریپت پایین صفحه» یا «Custom code» بگردید و کد را آنجا بچسبانید.</p></details>
</div>
<div class="panel">
  <h2>🔗 لینک اختصاصی گفتگو</h2>
  <p>بدون نیاز به سایت: این لینک را در بیو اینستاگرام، پیام‌رسان‌ها، کارت ویزیت یا QR کد بگذارید.</p>
  <div class="row"><input type="text" class="ltr" readonly value="${esc(pageUrl)}" id="page-url" style="flex:1;min-width:220px"><button type="button" class="btn btn-outline btn-sm" data-copy="#page-url">کپی</button><a class="btn btn-ghost btn-sm" href="${esc(pageUrl)}" target="_blank" rel="noopener">باز کردن ↗</a></div>
</div>
<div class="panel">
  <h2>💬 ربات بله</h2>
  <p class="muted">در بله با <span class="ltr">@botfather</span> یک ربات بسازید، توکنش را اینجا بچسبانید. از آن به بعد ربات به پیام‌های مشتری‌ها جواب می‌دهد.</p>
  ${channelBox('bale')}
</div>
<div class="panel">
  <h2>✈️ ربات تلگرام</h2>
  <p class="muted">فقط وقتی کار می‌کند که سرور سایت خارج از ایران باشد، چون دسترسی سرورهای داخلی به تلگرام بسته است.</p>
  ${channelBox('telegram')}
</div>
<div class="panel">
  <h2>🛡️ دامنه‌های مجاز (اختیاری)</h2>
  <p class="muted">اگر پر شود، ویجت فقط روی همین دامنه‌ها کار می‌کند. هر دامنه در یک خط، مثلاً <span class="ltr">example.ir</span></p>
  <form class="form" method="post" action="${botUrl(bot, '/install/domains')}"><textarea name="domains" class="ltr" rows="2">${esc(bot.allowed_domains.split(/[\s,]+/).filter(Boolean).join('\n'))}</textarea><div><button class="btn btn-outline btn-sm">ذخیره</button></div></form>
</div>`,
  });
});

router.post('/app/bots/:botId/install/domains', form, (req, res) => {
  const list = String(req.body.domains || '').toLowerCase().split(/[\s,]+/)
    .map(d => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').trim())
    .filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)).slice(0, 20);
  db.get().prepare('UPDATE bots SET allowed_domains = ?, updated_at = ? WHERE id = ?').run(list.join(','), Date.now(), req.bot.id);
  res.redirect(botUrl(req.bot, '/install?ok=domains'));
});

router.post('/app/bots/:botId/channels/:channel', form, async (req, res) => {
  const ch = channels.CHANNELS[req.params.channel];
  if (!ch) return res.redirect(botUrl(req.bot, '/install'));
  if (!effectivePlan(req.user).channels) return res.redirect('/app/billing?need=channels');
  try {
    await channels.connect(req.bot, req.params.channel, req.body.token);
    res.redirect(botUrl(req.bot, '/install?ok=connected'));
  } catch (e) {
    const msg = /معتبر/.test(e.message) ? e.message : `اتصال به ${ch.name} برقرار نشد: ${e.message}`;
    res.redirect(botUrl(req.bot, `/install?err=${encodeURIComponent(msg)}`));
  }
});

router.post('/app/bots/:botId/channels/:channel/disconnect', form, async (req, res) => {
  if (channels.CHANNELS[req.params.channel]) await channels.disconnect(req.bot, req.params.channel);
  res.redirect(botUrl(req.bot, '/install?ok=disconnected'));
});

// ---- Settings -------------------------------------------------------------------

router.get('/app/bots/:botId/settings', (req, res) => {
  const bot = req.bot;
  render(req, res, {
    title: 'تنظیمات بات', bot, active: 'settings',
    body: `<div class="page-title"><h1>تنظیمات بات</h1></div>
<div class="panel"><form class="form" method="post" action="${botUrl(bot, '/settings')}">
  <div class="field"><label for="s-name">اسم بات</label><input id="s-name" type="text" name="name" required maxlength="60" value="${esc(bot.name)}"></div>
  <div class="field"><label for="s-w">پیام خوشامد</label><textarea id="s-w" name="welcome" rows="2" maxlength="500">${esc(bot.welcome)}</textarea></div>
  <div class="field"><label for="s-f">پیام وقتی جواب را نمی‌داند</label><textarea id="s-f" name="fallback" rows="2" maxlength="500">${esc(bot.fallback)}</textarea></div>
  <div class="row"><div class="field"><label for="s-c">رنگ</label><input id="s-c" type="color" name="color" value="${esc(bot.color)}"></div>
    <div class="field"><label for="s-p">جای دکمه</label><select id="s-p" name="position"><option value="right"${bot.position === 'right' ? ' selected' : ''}>پایین راست</option><option value="left"${bot.position === 'left' ? ' selected' : ''}>پایین چپ</option></select></div></div>
  <label class="check"><input type="checkbox" name="lead_form" value="1"${bot.lead_form ? ' checked' : ''}> وقتی جواب را نمی‌داند، نام و شماره‌ی مشتری را بگیرد</label>
  <div><button class="btn btn-primary">ذخیره</button></div>
</form></div>
<div class="panel"><h2>حذف بات</h2><p class="muted">همه‌ی سؤال‌ها، گفتگوها و درخواست‌های این بات برای همیشه پاک می‌شود.</p>
<form method="post" action="${botUrl(bot, '/delete')}"><button class="btn btn-danger btn-sm" data-confirm="مطمئنید؟ این کار برگشت‌پذیر نیست.">حذف بات</button></form></div>`,
  });
});

router.post('/app/bots/:botId/settings', form, (req, res) => {
  const b = req.body;
  const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : req.bot.color;
  db.get().prepare(`
    UPDATE bots SET name = ?, welcome = ?, fallback = ?, color = ?, position = ?, lead_form = ?, updated_at = ? WHERE id = ?
  `).run(
    String(b.name || '').trim().slice(0, 60) || req.bot.name,
    String(b.welcome || '').trim().slice(0, 500) || req.bot.welcome,
    String(b.fallback || '').trim().slice(0, 500) || req.bot.fallback,
    color, b.position === 'left' ? 'left' : 'right', b.lead_form ? 1 : 0, Date.now(), req.bot.id,
  );
  res.redirect(botUrl(req.bot, '/settings?ok=settings'));
});

router.post('/app/bots/:botId/delete', form, async (req, res) => {
  for (const id of Object.keys(channels.CHANNELS)) if (req.bot[channels.CHANNELS[id].tokenCol]) await channels.disconnect(req.bot, id);
  db.get().prepare('DELETE FROM bots WHERE id = ?').run(req.bot.id);
  bots.invalidate(req.bot.id);
  res.redirect('/app');
});

module.exports = router;

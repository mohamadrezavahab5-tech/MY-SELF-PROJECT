'use strict';
// Analytics ("گزارش‌ها"): how much the bot handled on its own, when visitors
// ask, what they ask most, and which questions still need an answer.
//
// All figures exclude the dashboard's test console (channel 'test'). Days and
// hours are Tehran time; charts read right-to-left (oldest day / hour 0 at the
// right edge, today / hour 23 at the left), like the rest of the RTL page.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const engine = require('../nlp/engine');
const charts = require('../views/charts');
const { dashPage } = require('../views/layout');
const { ago } = require('../views/helpers');
const { esc, faDigits, formatNumber } = require('../util');

const router = express.Router();

const DAY = 86400000;
const HOUR = 3600000;
// Iran has kept a fixed UTC+03:30 (no daylight saving) since 2022, so SQLite
// can bucket timestamps by Tehran day and hour with integer arithmetic.
const TEHRAN_OFFSET = 12600000;
const PERIODS = [7, 30, 90];
const DEFAULT_PERIOD = 30;

// messages.type groups
const AUTO = `'answer','passage','ai'`;
const MISSED = `'fallback','limit'`;

// Saturday-first Persian week. SQLite day number d (days since 1970-01-01,
// a Thursday) maps to index (d + 5) % 7.
const WEEKDAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];
const WEEKDAYS_SHORT = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

const CHANNELS = [
  { id: 'web', name: 'ویجت سایت', color: 'var(--viz-web)' },
  { id: 'page', name: 'لینک اختصاصی', color: 'var(--viz-page)' },
  { id: 'bale', name: 'بله', color: 'var(--viz-bale)' },
  { id: 'telegram', name: 'تلگرام', color: 'var(--viz-telegram)' },
];

const SERIES = [
  { key: 'auto', label: 'پاسخ خودکار', color: 'var(--viz-answered)' },
  { key: 'suggested', label: 'پیشنهاد سؤال مشابه', color: 'var(--viz-suggested)' },
  { key: 'missed', label: 'بی‌جواب', color: 'var(--viz-missed)' },
];

const HEAT_RAMP = ['var(--viz-h1)', 'var(--viz-h2)', 'var(--viz-h3)', 'var(--viz-h4)', 'var(--viz-h5)'];

// ---- Dates -------------------------------------------------------------------

const jalaliFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long', year: 'numeric' });

function dayNumber(ms) {
  return Math.floor((ms + TEHRAN_OFFSET) / DAY);
}

// Tehran midnight (as a UTC timestamp) that starts day number d.
function dayStart(d) {
  return d * DAY - TEHRAN_OFFSET;
}

function jalali(d) {
  const parts = jalaliFmt.formatToParts(new Date(dayStart(d) + 12 * HOUR));
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  return { day: get('day'), month: get('month'), year: get('year'), weekday: WEEKDAYS[(d + 5) % 7] };
}

function rangeLabel(fromDay, toDay) {
  const a = jalali(fromDay);
  const b = jalali(toDay);
  const left = a.year === b.year ? `${a.day} ${a.month}` : `${a.day} ${a.month} ${a.year}`;
  return `${left} تا ${b.day} ${b.month} ${b.year}`;
}

// ---- Data --------------------------------------------------------------------

const COUNTS = ['total', 'auto', 'faq', 'passage', 'ai', 'suggested', 'missed', 'up', 'rated'];

function countsOf(row) {
  const out = {};
  for (const k of COUNTS) out[k] = row ? Number(row[k]) || 0 : 0;
  return out;
}

function sumCounts(list) {
  const out = countsOf(null);
  for (const d of list) for (const k of COUNTS) out[k] += d[k];
  return out;
}

// Everything the page shows, for bot `botId`, over the last `days` Tehran
// calendar days (today included) and the same-length period before it.
function collect(botId, days, now = Date.now()) {
  const conn = db.get();
  const today = dayNumber(now);
  const firstDay = today - days + 1;
  const start = dayStart(firstDay);
  const end = dayStart(today + 1);
  const prevStart = dayStart(firstDay - days);
  const range = [botId, start, end];

  // One indexed pass over both periods, bucketed by Tehran day.
  const dayRows = conn.prepare(`
    SELECT (created_at + ${TEHRAN_OFFSET}) / ${DAY} AS d,
      COUNT(*) AS total,
      SUM(type IN (${AUTO})) AS auto,
      SUM(type = 'answer') AS faq,
      SUM(type = 'passage') AS passage,
      SUM(type = 'ai') AS ai,
      SUM(type = 'suggest') AS suggested,
      SUM(type IN (${MISSED})) AS missed,
      SUM(type IN (${AUTO}) AND helpful = 1) AS up,
      SUM(type IN (${AUTO}) AND helpful IS NOT NULL) AS rated
    FROM messages
    WHERE bot_id = ? AND created_at >= ? AND created_at < ? AND channel != 'test'
    GROUP BY d
  `).all(botId, prevStart, end);
  const byDay = new Map(dayRows.map(r => [Number(r.d), r]));
  const daily = [];
  for (let d = firstDay; d <= today; d++) daily.push({ d, ...countsOf(byDay.get(d)) });
  const current = sumCounts(daily);
  const previous = sumCounts(dayRows.filter(r => Number(r.d) < firstDay).map(countsOf));

  const leadRows = conn.prepare(`
    SELECT (created_at + ${TEHRAN_OFFSET}) / ${DAY} AS d, COUNT(*) AS n, SUM(status = 'new') AS open
    FROM leads WHERE bot_id = ? AND created_at >= ? AND created_at < ? GROUP BY d
  `).all(botId, prevStart, end);
  const leadsByDay = new Map(leadRows.map(r => [Number(r.d), Number(r.n)]));
  const leads = { current: 0, previous: 0, open: 0, daily: daily.map(x => leadsByDay.get(x.d) || 0) };
  for (const r of leadRows) {
    if (Number(r.d) >= firstDay) {
      leads.current += Number(r.n);
      leads.open += Number(r.open) || 0;
    } else {
      leads.previous += Number(r.n);
    }
  }

  // Conversations handed to a person during the period: still waiting in
  // 'human' mode, or an operator replied.
  const handoffs = conn.prepare(`
    SELECT COUNT(*) AS n FROM conversations c
    WHERE c.bot_id = ? AND c.last_message_at >= ? AND c.channel != 'test' AND (
      (c.mode = 'human' AND c.last_message_at < ?)
      OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender = 'operator' AND m.created_at >= ? AND m.created_at < ?)
    )
  `).get(botId, start, end, start, end).n;

  // Saturday-first weekday x hour of day.
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of conn.prepare(`
    SELECT ((created_at + ${TEHRAN_OFFSET}) / ${DAY} + 5) % 7 AS wd, ((created_at + ${TEHRAN_OFFSET}) / ${HOUR}) % 24 AS h, COUNT(*) AS n
    FROM messages WHERE bot_id = ? AND created_at >= ? AND created_at < ? AND channel != 'test'
    GROUP BY wd, h
  `).all(...range)) {
    heat[Number(r.wd)][Number(r.h)] = Number(r.n);
  }

  const channelRows = conn.prepare(`
    SELECT channel, COUNT(*) AS total, SUM(type IN (${AUTO})) AS auto
    FROM messages WHERE bot_id = ? AND created_at >= ? AND created_at < ? AND channel != 'test'
    GROUP BY channel
  `).all(...range);
  const channels = CHANNELS.map(ch => {
    const r = channelRows.find(x => x.channel === ch.id);
    return { ...ch, total: r ? Number(r.total) : 0, auto: r ? Number(r.auto) : 0 };
  });
  for (const r of channelRows) {
    if (!CHANNELS.some(ch => ch.id === r.channel)) {
      channels.push({ id: r.channel, name: r.channel, color: 'var(--viz-other)', total: Number(r.total), auto: Number(r.auto) });
    }
  }

  const topAnswered = conn.prepare(`
    SELECT m.faq_id AS id, f.question, COUNT(*) AS n, SUM(m.helpful = 1) AS up, SUM(m.helpful = 0) AS down
    FROM messages m JOIN faqs f ON f.id = m.faq_id AND f.bot_id = m.bot_id
    WHERE m.bot_id = ? AND m.created_at >= ? AND m.created_at < ? AND m.channel != 'test' AND m.type = 'answer'
    GROUP BY m.faq_id ORDER BY n DESC, m.faq_id LIMIT 8
  `).all(...range).map(r => ({ id: r.id, question: r.question, n: Number(r.n), up: Number(r.up) || 0, down: Number(r.down) || 0 }));

  // Grouped by exact text in SQL, then merged by the engine's normalized form
  // (the same grouping the unanswered-questions inbox uses).
  const groups = new Map();
  for (const r of conn.prepare(`
    SELECT question, COUNT(*) AS n, MAX(created_at) AS last, MAX(CASE WHEN resolved = 0 THEN id END) AS open_id
    FROM messages
    WHERE bot_id = ? AND created_at >= ? AND created_at < ? AND channel != 'test' AND type IN ('suggest','fallback')
    GROUP BY question ORDER BY n DESC LIMIT 2000
  `).all(...range)) {
    const key = engine.normalize(r.question) || r.question;
    const n = Number(r.n);
    const openId = r.open_id ? Number(r.open_id) : null;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { question: r.question, n, best: n, last: Number(r.last), openId });
    } else {
      g.n += n;
      if (n > g.best) { g.best = n; g.question = r.question; }
      g.last = Math.max(g.last, Number(r.last));
      if (openId && (!g.openId || openId > g.openId)) g.openId = openId;
    }
  }
  const topMissed = [...groups.values()].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 8);

  const everUsed = !!conn.prepare(`SELECT 1 FROM messages WHERE bot_id = ? AND channel != 'test' LIMIT 1`).get(botId);

  return { days, today, firstDay, start, end, daily, current, previous, leads, handoffs, heat, channels, topAnswered, topMissed, everUsed };
}

// ---- View helpers ----------------------------------------------------------------

function pct(part, whole) {
  return whole > 0 ? (part / whole) * 100 : null;
}

function faPct(v) {
  return v === null ? '—' : `${faDigits(Math.round(v))}٪`;
}

// Change vs the previous period. kind: 'count' (relative %) | 'rate' (points).
// good: 'up' | 'down' | null (neutral) picks the color; an arrow and a
// screen-reader word always carry the direction, so color is never alone.
function delta(cur, prev, { kind = 'count', good = null } = {}) {
  if (cur === null || prev === null) return '<span class="rp-delta flat" title="در دوره‌ی قبل داده‌ای نبود">—</span>';
  let diff;
  let text;
  if (kind === 'rate') {
    diff = Math.round(cur - prev);
    text = `${faDigits(Math.abs(diff))} واحد`;
  } else {
    if (prev === 0) return cur > 0 ? '<span class="rp-delta flat" title="در دوره‌ی قبل صفر بود">تازه</span>' : '<span class="rp-delta flat">بدون تغییر</span>';
    diff = Math.round(((cur - prev) / prev) * 100);
    text = `${faDigits(Math.abs(diff))}٪`;
  }
  if (diff === 0) return '<span class="rp-delta flat">بدون تغییر</span>';
  const dir = diff > 0 ? 'up' : 'down';
  const tone = good ? (good === dir ? 'good' : 'bad') : 'flat';
  const word = diff > 0 ? 'افزایش' : 'کاهش';
  return `<span class="rp-delta ${tone}" title="${word}${kind === 'rate' ? ' (واحد درصد)' : ''}"><span aria-hidden="true">${diff > 0 ? '▲' : '▼'}</span><span class="sr-only">${word}</span> ${text}</span>`;
}

// Sum consecutive days (aligned to today) so tile sparklines stay <= 15 points.
function bucket(values, maxPoints = 15) {
  const size = Math.max(1, Math.ceil(values.length / maxPoints));
  const out = [];
  for (let endIdx = values.length; endIdx > 0; endIdx -= size) {
    let s = 0;
    for (let i = Math.max(0, endIdx - size); i < endIdx; i++) s += values[i];
    out.unshift(s);
  }
  return out;
}

function tile({ label, value, deltaHtml, sub = '', visual = '' }) {
  return `<div class="rp-kpi">
  <div class="rp-kpi-label">${label}</div>
  <div class="rp-kpi-row"><span class="rp-kpi-value">${value}</span>${deltaHtml}</div>
  <div class="rp-kpi-sub">${sub}</div>
  <div class="rp-kpi-visual">${visual}</div>
</div>`;
}

function periodNav(bot, days) {
  return `<nav class="rp-period" aria-label="بازه‌ی زمانی">${PERIODS.map(p => `<a href="/app/bots/${bot.id}/reports?days=${p}"${p === days ? ' aria-current="page"' : ''}>${faDigits(p)} روز</a>`).join('')}</nav>`;
}

// Which day columns get an x label: every day for a week, else a steady
// stride counted back from today so today is always labeled.
function tickStride(days) {
  return days <= 7 ? 1 : days <= 30 ? 5 : 15;
}

function perDayText(total, days) {
  const v = total / days;
  if (v === 0 || v >= 10) return formatNumber(v);
  return faDigits(v.toFixed(1)).replace('.', '٫');
}

// ---- Page sections --------------------------------------------------------------------

function kpis(bot, data) {
  const { current: c, previous: p, leads, handoffs, days } = data;
  const autoRate = pct(c.auto, c.total);
  const missRate = pct(c.missed, c.total);
  const sat = pct(c.up, c.rated);
  const spark = (vals, label) => charts.sparkline(bucket(vals), { ariaLabel: label });

  return `<section class="rp-kpis" aria-label="خلاصه‌ی ${faDigits(days)} روز اخیر">
${tile({
    label: 'سؤال دریافتی',
    value: formatNumber(c.total),
    deltaHtml: delta(c.total, p.total),
    sub: `میانگین ${perDayText(c.total, days)} در روز`,
    visual: spark(data.daily.map(x => x.total), 'روند سؤال‌های روزانه'),
  })}
${tile({
    label: 'پاسخ خودکار',
    value: faPct(autoRate),
    deltaHtml: delta(autoRate, pct(p.auto, p.total), { kind: 'rate', good: 'up' }),
    sub: `${formatNumber(c.auto)} سؤال بدون دخالت شما`,
    visual: charts.meter((autoRate || 0) / 100, { color: 'var(--viz-answered)', ariaLabel: `نرخ پاسخ خودکار ${faPct(autoRate)}` }),
  })}
${tile({
    label: 'بی‌جواب ماند',
    value: formatNumber(c.missed),
    deltaHtml: delta(c.missed, p.missed, { good: 'down' }),
    sub: `${faPct(missRate)} سؤال‌ها · <a href="/app/bots/${bot.id}/live">${formatNumber(handoffs)} درخواست اپراتور</a>`,
    visual: spark(data.daily.map(x => x.missed), 'روند سؤال‌های بی‌جواب'),
  })}
${tile({
    label: 'درخواست تماس',
    value: formatNumber(leads.current),
    deltaHtml: delta(leads.current, leads.previous),
    sub: leads.open ? `<a href="/app/bots/${bot.id}/leads">${formatNumber(leads.open)} مورد منتظر تماس شما</a>` : (leads.current ? 'همه پیگیری شده‌اند' : 'درخواستی ثبت نشده'),
    visual: spark(leads.daily, 'روند درخواست‌های تماس'),
  })}
${tile({
    label: 'رضایت از پاسخ‌ها',
    value: faPct(sat),
    deltaHtml: sat === null ? '' : delta(sat, pct(p.up, p.rated), { kind: 'rate', good: 'up' }),
    sub: c.rated ? `<span aria-hidden="true">👍</span> ${formatNumber(c.up)} از ${formatNumber(c.rated)} رأی` : 'هنوز رأیی ثبت نشده',
    visual: charts.meter((sat || 0) / 100, { color: 'var(--viz-answered)', ariaLabel: `رضایت ${faPct(sat)}` }),
  })}
</section>`;
}

function dailySection(data) {
  const { daily, today, days, current } = data;
  const stride = tickStride(days);
  let lastMonth = '';
  // Labels are decided oldest -> newest so a month name shows where it starts.
  const slots = daily.map(x => {
    const j = jalali(x.d);
    const isToday = x.d === today;
    const tick = (today - x.d) % stride === 0;
    let sub = '';
    if (tick) {
      sub = j.month !== lastMonth ? j.month : '';
      lastMonth = j.month;
    }
    return {
      values: [x.auto, x.suggested, x.missed],
      tick,
      label: isToday ? 'امروز' : j.day,
      sub: isToday ? `${j.day} ${j.month}` : sub,
      tip: {
        t: `${j.weekday} ${j.day} ${j.month}${isToday ? ' (امروز)' : ''}`,
        r: SERIES.map(s => [s.label, formatNumber(x[s.key]), s.color]),
        f: `جمع: ${formatNumber(x.total)} سؤال`,
      },
    };
  });
  const sources = [];
  if (current.passage || current.ai) {
    sources.push(`از سؤال و جواب‌ها ${formatNumber(current.faq)}`);
    if (current.passage) sources.push(`از محتوای سایت ${formatNumber(current.passage)}`);
    if (current.ai) sources.push(`با هوش مصنوعی ${formatNumber(current.ai)}`);
  }
  const table = charts.tableView({
    caption: 'سؤال‌ها در هر روز',
    head: ['روز', ...SERIES.map(s => s.label), 'جمع'],
    rows: daily.slice().reverse().map(x => {
      const j = jalali(x.d);
      return [`${j.weekday} ${j.day} ${j.month}`, ...SERIES.map(s => formatNumber(x[s.key])), formatNumber(x.total)];
    }),
  });
  return `<section class="panel rp-panel" aria-labelledby="rp-daily">
  <div class="rp-panel-head">
    <div><h2 id="rp-daily">سؤال‌ها در هر روز</h2><p class="rp-note">هر ستون یک روز است؛ قدیمی‌ترین روز سمت راست و امروز سمت چپ.</p></div>
    ${charts.legend(SERIES.map(s => ({ label: s.label, color: s.color, value: formatNumber(current[s.key]) })))}
  </div>
  ${charts.columnChart({ slots, series: SERIES, height: 190, ariaLabel: `نمودار ستونی تعداد سؤال‌ها در ${faDigits(days)} روز اخیر به تفکیک نتیجه` })}
  ${sources.length ? `<p class="rp-note rp-sources">پاسخ‌های خودکار: ${sources.join(' · ')}</p>` : ''}
  ${table}
</section>`;
}

function hourRange(h) {
  return `${faDigits(h)} تا ${faDigits((h + 1) % 24)}`;
}

function heatSection(data) {
  const { heat } = data;
  const rows = WEEKDAYS.map((w, i) => ({ label: w, short: WEEKDAYS_SHORT[i] }));
  const cols = Array.from({ length: 24 }, (_, h) => ({ tick: h % 3 === 0 ? faDigits(h) : '' }));
  let peak = { v: 0, r: 0, h: 0 };
  heat.forEach((row, r) => row.forEach((v, h) => { if (v > peak.v) peak = { v, r, h }; }));
  const dayTotals = heat.map(row => row.reduce((a, v) => a + v, 0));
  const hourTotals = Array.from({ length: 24 }, (_, h) => heat.reduce((a, row) => a + row[h], 0));
  const total = dayTotals.reduce((a, v) => a + v, 0);
  const busiestDay = dayTotals.indexOf(Math.max(...dayTotals));
  // Busiest 3-hour window across the week (wrapping past midnight).
  let win = { v: -1, h: 0 };
  for (let h = 0; h < 24; h++) {
    const v = hourTotals[h] + hourTotals[(h + 1) % 24] + hourTotals[(h + 2) % 24];
    if (v > win.v) win = { v, h };
  }
  const insight = total ? `<div class="rp-insights">
    <div><span class="rp-insight-k">شلوغ‌ترین بازه‌ی روز</span><b>ساعت ${faDigits(win.h)} تا ${faDigits((win.h + 3) % 24)}</b><span class="rp-insight-n">${faPct(pct(win.v, total))} سؤال‌ها</span></div>
    <div><span class="rp-insight-k">شلوغ‌ترین روز هفته</span><b>${WEEKDAYS[busiestDay]}</b><span class="rp-insight-n">${faPct(pct(dayTotals[busiestDay], total))} سؤال‌ها</span></div>
    <div><span class="rp-insight-k">اوج سؤال‌ها</span><b>${WEEKDAYS[peak.r]}، ساعت ${hourRange(peak.h)}</b><span class="rp-insight-n">${formatNumber(peak.v)} سؤال</span></div>
  </div>` : '';
  const table = charts.tableView({
    caption: 'تعداد سؤال به تفکیک ساعت و روز هفته',
    head: ['ساعت', ...WEEKDAYS],
    rows: Array.from({ length: 24 }, (_, h) => [hourRange(h), ...heat.map(row => formatNumber(row[h]))]),
  });
  return `<section class="panel rp-panel" aria-labelledby="rp-heat">
  <div class="rp-panel-head">
    <div><h2 id="rp-heat">ساعت‌های شلوغ</h2><p class="rp-note">مشتری‌ها چه روزها و ساعت‌هایی بیشتر سؤال می‌پرسند (به وقت تهران)؛ برای برنامه‌ریزی حضور اپراتور.</p></div>
  </div>
  ${insight}
  ${charts.heatmap({
    rows, cols, values: heat, ramp: HEAT_RAMP, empty: 'var(--viz-empty)', cellHeight: 26,
    ariaLabel: 'نقشه‌ی حرارتی تعداد سؤال به تفکیک روز هفته و ساعت',
    tip: (r, h, v) => ({ t: `${WEEKDAYS[r]}، ساعت ${hourRange(h)}`, r: [['سؤال', formatNumber(v)]] }),
  })}
  <div class="rp-heat-foot"><span class="rp-note">ساعت‌ها از راست به چپ: ۰ تا ۲۳</span>${charts.scaleLegend(HEAT_RAMP, { empty: 'var(--viz-empty)', emptyLabel: 'بدون سؤال', low: 'کم', high: 'زیاد' })}</div>
  ${table}
</section>`;
}

// Visitor votes on an FAQ answer; flags answers people often dislike.
function faqMeta(bot, f) {
  const rated = f.up + f.down;
  if (!rated) return '';
  const share = pct(f.up, rated);
  const flagged = f.down >= 3 && f.down / rated >= 0.3;
  const votes = `رضایت ${faPct(share)} از ${formatNumber(rated)} رأی`;
  return flagged
    ? `<div class="rp-rank-meta"><span class="rp-flag"><span aria-hidden="true">👎</span> ${formatNumber(f.down)} رأی منفی · ${votes}</span><a href="/app/bots/${bot.id}/faqs#faq-${f.id}">بازبینی جواب ←</a></div>`
    : `<div class="rp-rank-meta"><span>${votes}</span></div>`;
}

function topAnsweredSection(bot, data) {
  const list = data.topAnswered;
  const max = list.length ? list[0].n : 0;
  const body = list.length ? `<ol class="rp-rank">${list.map(f => `<li>
    <div class="rp-rank-row"><a class="rp-rank-q" href="/app/bots/${bot.id}/faqs#faq-${f.id}">${esc(f.question)}</a><span class="rp-rank-n">${formatNumber(f.n)}</span></div>
    ${charts.hbar(f.n, max, { color: 'var(--viz-answered)' })}
    ${faqMeta(bot, f)}
  </li>`).join('')}</ol>` : '<p class="rp-empty-note">در این بازه هنوز با سؤال و جواب‌های شما به سؤالی پاسخ داده نشده.</p>';
  return `<section class="panel rp-panel" aria-labelledby="rp-top">
  <div class="rp-panel-head"><div><h2 id="rp-top">پرتکرارترین سؤال‌های پاسخ‌داده</h2><p class="rp-note">سؤال و جواب‌هایی که بات بیشتر از همه با آن‌ها جواب داده.</p></div></div>
  ${body}
  <a class="rp-more" href="/app/bots/${bot.id}/faqs">همه‌ی سؤال و جواب‌ها ←</a>
</section>`;
}

function topMissedSection(bot, data) {
  const list = data.topMissed;
  const max = list.length ? list[0].n : 0;
  const inbox = `/app/bots/${bot.id}/inbox`;
  const body = list.length ? `<ol class="rp-rank">${list.map(g => `<li>
    <div class="rp-rank-row">${g.openId ? `<a class="rp-rank-q" href="${inbox}#m-${g.openId}">«${esc(g.question)}»</a>` : `<span class="rp-rank-q">«${esc(g.question)}»</span>`}<span class="rp-rank-n">${formatNumber(g.n)}</span></div>
    ${charts.hbar(g.n, max, { color: 'var(--viz-missed)' })}
    <div class="rp-rank-meta"><span>آخرین بار ${esc(ago(g.last))}</span>${g.openId ? `<a href="${inbox}#m-${g.openId}">جواب بدهید ←</a>` : '<span class="badge ok">رسیدگی شد</span>'}</div>
  </li>`).join('')}</ol>` : '<p class="rp-empty-note"><span aria-hidden="true">🎉</span> در این بازه سؤال بی‌جوابی نبوده.</p>';
  return `<section class="panel rp-panel" aria-labelledby="rp-missed">
  <div class="rp-panel-head"><div><h2 id="rp-missed">پرتکرارترین سؤال‌های بی‌جواب</h2><p class="rp-note">بات برای این‌ها جواب مطمئنی نداشت. به هرکدام جواب بدهید تا بات یاد بگیرد.</p></div></div>
  ${body}
  <a class="rp-more" href="${inbox}">صندوق سؤال‌های بی‌جواب ←</a>
</section>`;
}

function channelSection(data) {
  const chans = data.channels;
  const total = chans.reduce((a, ch) => a + ch.total, 0);
  const bar = charts.shareBar(chans.map(ch => ({
    value: ch.total,
    color: ch.color,
    tip: { t: ch.name, r: [['سؤال', formatNumber(ch.total), ch.color], ['سهم', faPct(pct(ch.total, total))]] },
  })), { height: 18, ariaLabel: `سهم کانال‌ها از ${formatNumber(total)} سؤال` });
  const rows = chans.map(ch => `<tr${ch.total ? '' : ' class="rp-zero"'}><th scope="row"><i class="viz-sw" style="background:${esc(ch.color)}"></i>${esc(ch.name)}</th><td>${formatNumber(ch.total)}</td><td>${faPct(pct(ch.total, total))}</td><td>${faPct(pct(ch.auto, ch.total))}</td></tr>`).join('');
  return `<section class="panel rp-panel" aria-labelledby="rp-ch">
  <div class="rp-panel-head"><div><h2 id="rp-ch">کانال‌ها</h2><p class="rp-note">مشتری‌ها از کجا سؤال پرسیده‌اند.</p></div></div>
  ${bar}
  <div class="table-wrap"><table class="table rp-ch-table"><thead><tr><th scope="col">کانال</th><th scope="col">سؤال</th><th scope="col">سهم</th><th scope="col">پاسخ خودکار</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

function ghostChart() {
  // Rising toward the left: newer days sit on the left in this RTL page.
  const heights = [104, 84, 70, 92, 74, 62, 80, 58, 66, 41, 52, 34];
  const w = 100 / heights.length;
  return `<svg class="rp-ghost" width="100%" height="120" aria-hidden="true">${heights.map((h, i) => `<rect x="${(i * w + w * 0.22).toFixed(2)}%" width="${(w * 0.56).toFixed(2)}%" y="${120 - h}" height="${h}" rx="4" ry="4"/>`).join('')}<line x1="0" x2="100%" y1="119.5" y2="119.5"/></svg>`;
}

function emptyState(bot) {
  return `<section class="panel rp-empty">
  ${ghostChart()}
  <h2>هنوز گزارشی برای نمایش نیست</h2>
  <p>به‌محض اینکه مشتری‌ها از بات سؤال بپرسند، اینجا می‌بینید بات چند سؤال را خودش جواب داده، مشتری‌ها چه ساعت‌هایی بیشتر سؤال می‌پرسند و کدام سؤال‌ها هنوز جواب ندارند.</p>
  <div class="row rp-empty-actions"><a class="btn btn-primary" href="/app/bots/${bot.id}/install">نصب بات روی سایت</a><a class="btn btn-ghost" href="/app/bots/${bot.id}/test">امتحان بات</a></div>
  <p class="hint">گفتگوهای بخش «امتحان بات» در گزارش‌ها حساب نمی‌شوند.</p>
</section>`;
}

function view(bot, data) {
  const head = `<div class="page-title rp-head">
  <div><h1>گزارش‌ها</h1>${data.everUsed ? `<p class="rp-range">${esc(rangeLabel(data.firstDay, data.today))} · به وقت تهران</p>` : ''}</div>
  ${data.everUsed ? periodNav(bot, data.days) : ''}
</div>`;
  if (!data.everUsed) return `<div class="rp">${head}${emptyState(bot)}</div>`;
  const quiet = data.current.total === 0
    ? `<div class="notice rp-quiet">در ${faDigits(data.days)} روز اخیر سؤالی ثبت نشده.${data.days < 90 ? ` <a href="/app/bots/${bot.id}/reports?days=90">گزارش ۹۰ روز اخیر را ببینید</a>` : ''}</div>`
    : '';
  return `<div class="rp">
${head}
${quiet}
<p class="rp-compare">درصد تغییرها نسبت به ${faDigits(data.days)} روز قبل از این بازه است.</p>
${kpis(bot, data)}
${dailySection(data)}
${heatSection(data)}
<div class="rp-grid">
${topMissedSection(bot, data)}
${topAnsweredSection(bot, data)}
</div>
${channelSection(data)}
</div>
<script src="/js/reports.js" defer></script>`;
}

// ---- Routes -----------------------------------------------------------------------

// Loads :botId and checks ownership (same idiom as the dashboard router).
router.param('botId', (req, res, next, id) => {
  if (!req.user) return auth.requireUser(req, res, next);
  const bot = db.get().prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!bot) return res.redirect('/app');
  req.bot = bot;
  next();
});

router.get('/app/bots/:botId/reports', auth.requireUser, (req, res) => {
  const days = PERIODS.includes(Number(req.query.days)) ? Number(req.query.days) : DEFAULT_PERIOD;
  const data = collect(req.bot.id, days);
  const bots = db.get().prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(req.user.id);
  res.send(dashPage({ title: 'گزارش‌ها', body: view(req.bot, data), user: req.user, bot: req.bot, bots, active: 'reports' }));
});

module.exports = router;
module.exports.collect = collect;
module.exports.TEHRAN_OFFSET = TEHRAN_OFFSET;

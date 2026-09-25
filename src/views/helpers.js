'use strict';
const { esc, faDigits } = require('../util');

const faDateFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'Asia/Tehran', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const faDayFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'Asia/Tehran', year: 'numeric', month: 'long', day: 'numeric',
});

function faDateTime(ms) {
  return ms ? faDateFmt.format(new Date(ms)) : '—';
}

function faDay(ms) {
  return ms ? faDayFmt.format(new Date(ms)) : '—';
}

// Relative time for recent activity ("۵ دقیقه پیش").
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'همین الان';
  if (s < 3600) return `${faDigits(Math.floor(s / 60))} دقیقه پیش`;
  if (s < 86400) return `${faDigits(Math.floor(s / 3600))} ساعت پیش`;
  if (s < 7 * 86400) return `${faDigits(Math.floor(s / 86400))} روز پیش`;
  return faDay(ms);
}

// Escape, then highlight unfilled [placeholders] from starter packs.
function markPlaceholders(text) {
  return esc(text).replace(/\[([^\]\n]{1,40})\]/g, '<mark class="placeholder-mark">[$1]</mark>');
}

function hasPlaceholder(text) {
  return /\[[^\]\n]{1,40}\]/.test(String(text || ''));
}

const TYPE_BADGE = {
  answer: '<span class="badge ok">جواب داد</span>',
  passage: '<span class="badge ok">از متن سایت</span>',
  ai: '<span class="badge primary">پاسخ هوشمند</span>',
  suggest: '<span class="badge warn">پیشنهاد داد</span>',
  fallback: '<span class="badge danger">بی‌جواب</span>',
  limit: '<span class="badge danger">سقف مصرف</span>',
};

module.exports = { faDateTime, faDay, ago, markPlaceholders, hasPlaceholder, TYPE_BADGE };

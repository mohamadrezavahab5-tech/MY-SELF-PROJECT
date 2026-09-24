'use strict';
// Page shells. Every view returns a body string; these wrap it in the full
// HTML document with SEO meta, header and footer.
const config = require('../config');
const { esc } = require('../util');

function brand(text) {
  return String(text ?? '').replace(/\{\{site\}\}/g, config.siteName);
}

function abs(pathname) {
  return config.siteUrl + pathname;
}

function jsonLdTag(data) {
  if (!data) return '';
  const list = Array.isArray(data) ? data : [data];
  // "</" inside JSON would close the script tag early.
  return list.map(d => `<script type="application/ld+json">${JSON.stringify(d).replace(/</g, '\\u003c')}</script>`).join('\n');
}

function head({ title, description, path = '/', noindex = false, jsonLd = null, ogType = 'website' }) {
  const fullTitle = brand(title);
  const desc = brand(description || '');
  const canonical = abs(path);
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(fullTitle)}</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ''}
${noindex ? '<meta name="robots" content="noindex, nofollow">' : `<link rel="canonical" href="${esc(canonical)}">`}
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="${esc(config.siteName)}">
<meta property="og:title" content="${esc(fullTitle)}">
${desc ? `<meta property="og:description" content="${esc(desc)}">` : ''}
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(abs('/img/og.png'))}">
<meta property="og:locale" content="fa_IR">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#4f46e5">
<link rel="icon" href="/img/icon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/vazirmatn-arabic-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/fonts.css">
<link rel="stylesheet" href="/css/site.css">
${jsonLdTag(jsonLd)}
</head>`;
}

function header(user) {
  const account = user
    ? `<a class="btn btn-sm btn-primary" href="/app">داشبورد</a>`
    : `<a class="nav-link" href="/login">ورود</a><a class="btn btn-sm btn-primary" href="/signup">شروع رایگان</a>`;
  return `<header class="site-header">
  <div class="container header-row">
    <a class="logo" href="/" aria-label="${esc(config.siteName)}">${logoMark()}<span>${esc(config.siteName)}</span></a>
    <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-hidden="true">
    <label for="nav-toggle" class="nav-burger" aria-label="منو"><span></span></label>
    <nav class="main-nav" aria-label="منوی اصلی">
      <a class="nav-link" href="/#how">چطور کار می‌کند</a>
      <a class="nav-link" href="/industries">کاربردها</a>
      <a class="nav-link" href="/pricing">قیمت‌ها</a>
      <a class="nav-link" href="/blog">مجله</a>
      <a class="nav-link" href="/affiliate">همکاری در فروش</a>
      <span class="nav-account">${account}</span>
    </nav>
  </div>
</header>`;
}

function logoMark() {
  return `<svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><path d="M6 4h20a4 4 0 0 1 4 4v13a4 4 0 0 1-4 4H14l-6 5v-5H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="url(#lg)"/><circle cx="11" cy="14.5" r="2" fill="#fff"/><circle cx="16" cy="14.5" r="2" fill="#fff"/><circle cx="21" cy="14.5" r="2" fill="#fff"/></svg>`;
}

function footer() {
  const contact = [
    config.supportPhone && `<li>تلفن: <a href="tel:${esc(config.supportPhone)}">${esc(config.supportPhone)}</a></li>`,
    config.supportEmail && `<li>ایمیل: <a href="mailto:${esc(config.supportEmail)}">${esc(config.supportEmail)}</a></li>`,
    config.supportTelegram && `<li>پیام‌رسان: ${esc(config.supportTelegram)}</li>`,
  ].filter(Boolean).join('');
  return `<footer class="site-footer">
  <div class="container footer-grid">
    <div>
      <a class="logo" href="/">${logoMark()}<span>${esc(config.siteName)}</span></a>
      <p class="muted">چت‌بات پاسخگوی فارسی برای سایت و پیام‌رسان‌ها. ۲۴ ساعته، بدون اپراتور، فقط با پاسخ‌های تأییدشده‌ی خود شما.</p>
    </div>
    <div>
      <h3>محصول</h3>
      <ul><li><a href="/pricing">قیمت‌ها</a></li><li><a href="/industries">کاربردها</a></li><li><a href="/enterprise">نسخه‌ی سازمانی</a></li><li><a href="/signup">ساخت چت‌بات رایگان</a></li><li><a href="/affiliate">همکاری در فروش</a></li></ul>
    </div>
    <div>
      <h3>منابع</h3>
      <ul><li><a href="/blog">مجله</a></li><li><a href="/faq-templates">نمونه سؤالات متداول</a></li><li><a href="/about">درباره ما</a></li><li><a href="/terms">قوانین</a></li><li><a href="/privacy">حریم خصوصی</a></li></ul>
    </div>
    <div>
      <h3>تماس</h3>
      <ul>${contact || '<li><a href="/about">درباره ما</a></li>'}</ul>
      ${config.trustBadgesHtml ? `<div class="trust-badges">${config.trustBadgesHtml}</div>` : ''}
    </div>
  </div>
  <div class="container copyright muted">© ${new Date().getFullYear()} ${esc(config.siteName)}</div>
</footer>`;
}

// Public marketing page.
function page(opts) {
  const { body, user = null, demoWidget = false } = opts;
  return `${head(opts)}
<body>
${header(user)}
<main id="main">${body}</main>
${footer()}
${demoWidget ? `<script src="/widget.js" data-bot="${esc(demoWidget)}" async></script>` : ''}
</body>
</html>`;
}

// Logged-in dashboard page with side navigation.
function dashPage({ title, body, user, bot = null, bots = [], active = '', flash = '' }) {
  const b = bot ? `/app/bots/${bot.id}` : '';
  const botNav = bot ? `
      <div class="side-label">${esc(bot.name)}</div>
      ${navItem(`${b}`, 'نمای کلی', active === 'overview', '📊')}
      ${navItem(`${b}/faqs`, 'سؤال و جواب‌ها', active === 'faqs', '💬')}
      ${navItem(`${b}/inbox`, 'سؤال‌های بی‌جواب', active === 'inbox', '📥')}
      ${navItem(`${b}/leads`, 'درخواست تماس', active === 'leads', '📞')}
      ${navItem(`${b}/test`, 'امتحان بات', active === 'test', '🧪')}
      ${navItem(`${b}/install`, 'نصب روی سایت', active === 'install', '🔌')}
      ${navItem(`${b}/settings`, 'تنظیمات بات', active === 'settings', '⚙️')}` : '';
  const switcher = bots.length > 1 ? `<form class="bot-switch" method="get" action="/app/switch"><select name="id" onchange="this.form.submit()" aria-label="انتخاب بات">${bots.map(x => `<option value="${x.id}"${bot && x.id === bot.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></form>` : '';
  return `${head({ title: `${title} | ${config.siteName}`, noindex: true })}
<body class="dash">
<header class="dash-top">
  <a class="logo" href="/app">${logoMark()}<span>${esc(config.siteName)}</span></a>
  <div class="dash-top-actions">
    <span class="muted hide-sm">${esc(user.name)}</span>
    <form method="post" action="/logout"><button class="btn btn-sm btn-ghost">خروج</button></form>
  </div>
</header>
<div class="dash-wrap">
  <aside class="dash-side">
    ${switcher}
    <nav>
      ${botNav}
      <div class="side-label">حساب</div>
      ${navItem('/app/billing', 'اشتراک و پرداخت', active === 'billing', '💳')}
      ${navItem('/app/referral', 'کسب درآمد', active === 'referral', '🎁')}
      ${navItem('/app/bots/new', 'بات جدید', active === 'newbot', '➕')}
      ${user.is_admin ? navItem('/admin', 'مدیریت سایت', active === 'admin', '🛡️') : ''}
    </nav>
  </aside>
  <main class="dash-main" id="main">
    ${flash ? `<div class="flash">${flash}</div>` : ''}
    ${body}
  </main>
</div>
<script src="/js/dash.js" defer></script>
</body>
</html>`;
}

function navItem(href, label, active, icon) {
  return `<a class="side-link${active ? ' active' : ''}" href="${href}"${active ? ' aria-current="page"' : ''}><span aria-hidden="true">${icon}</span>${label}</a>`;
}

// Minimal centered page for auth / checkout screens.
function authPage({ title, body }) {
  return `${head({ title: `${title} | ${config.siteName}`, noindex: true })}
<body class="auth-body">
<main class="auth-card" id="main">
  <a class="logo auth-logo" href="/">${logoMark()}<span>${esc(config.siteName)}</span></a>
  ${body}
</main>
</body>
</html>`;
}

module.exports = { page, dashPage, authPage, brand, abs, logoMark };

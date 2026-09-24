/*! پاسخ‌یار chat widget — <script src="https://HOST/widget.js" data-bot="KEY" async></script>
 * data-mode="page": full-viewport chat for the hosted page /c/:key (no launcher).
 * No dependencies; talks only to its own origin; renders in a Shadow DOM so host
 * CSS can't break it. Server/user text is only ever inserted as text nodes. */
(() => {
'use strict';
if (window.Pasokhyar && window.Pasokhyar.version) return; // included twice

// currentScript is null when executed from a loader callback, so fall back.
const script = document.currentScript || document.querySelector('script[data-bot][src*="widget.js"]');
const KEY = script && (script.getAttribute('data-bot') || '').trim();
if (!KEY) { console.warn('[pasokhyar] data-bot attribute is missing'); return; }
let ORIGIN;
try { ORIGIN = new URL(script.src, location.href).origin; } catch (e) { return; }
const PAGE = script.getAttribute('data-mode') === 'page';
const API = ORIGIN + '/api/w/' + encodeURIComponent(KEY);
const MAX_LOG = 40;
const MOBILE = matchMedia('(max-width: 480px)');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const TOUCH = matchMedia('(pointer: coarse)');

const T = {
  subtitle: 'پاسخگوی خودکار · معمولاً فوری',
  welcome: 'سلام! 👋 چطور می‌توانم کمکتان کنم؟',
  placeholder: 'سؤالتان را بنویسید…',
  related: 'سؤال‌های مرتبط',
  none: 'هیچ‌کدام',
  noneReply: 'باشه 🙂 اگر شماره‌تان را بگذارید، همکاران ما تماس می‌گیرند و جواب سؤالتان را می‌دهند.',
  helpful: 'مفید بود؟',
  thanks: 'ممنون از بازخوردتان',
  unhelpful: 'متأسفیم که این پاسخ کمکی نکرد. اگر مایلید شماره‌تان را بگذارید تا همکاران ما با شما تماس بگیرند.',
  slowDown: 'کمی آهسته‌تر 🙂 چند ثانیه دیگر دوباره امتحان کنید.',
  offline: 'پیام ارسال نشد؛ اتصال اینترنت را بررسی کنید.',
  failed: 'مشکلی پیش آمد و پاسخی دریافت نشد.',
  gone: 'این پاسخ دیگر در دسترس نیست. لطفاً سؤالتان را بنویسید.',
  retry: 'تلاش دوباره',
  leadTitle: 'درخواست تماس',
  leadSend: 'ثبت درخواست تماس',
  leadDone: 'درخواست شما ثبت شد.',
  unavailable: 'این گفتگو در حال حاضر در دسترس نیست.',
};

// --- utils
const wait = ms => new Promise(r => setTimeout(r, ms));
const DIGIT = /[0-9۰-۹٠-٩]/;
const toEn = s => String(s).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x6F0).replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660);

// Storage can throw (private mode, blocked site data): always guarded.
const PREFIX = 'pasokhyar:' + KEY + ':', LS = 'localStorage', SS = 'sessionStorage';
const sget = (area, k) => { try { return window[area].getItem(PREFIX + k); } catch (e) { return null; } };
const sset = (area, k, v) => { try { window[area].setItem(PREFIX + k, v); } catch (e) { /* ignore */ } };

// One visitor id per browser per bot.
let sid = sget(LS, 'sid');
if (!sid || !/^[\w-]{8,64}$/.test(sid)) {
  try { sid = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join(''); }
  catch (e) { sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
  sset(LS, 'sid', sid);
}

// History, short keys: { r: 'u'|'b', t: text, k?: reply type, id?: messageId,
// s?: [{id, question}], o?: "none of these" chip, fb?: 1|0, lead?: 'open'|'done', lm?: thank-you }
let log = [];
try {
  const v = JSON.parse(sget(LS, 'log') || '[]');
  if (Array.isArray(v)) log = v.filter(m => m && (m.r === 'u' || m.r === 'b') && typeof m.t === 'string');
} catch (e) { /* corrupt → start fresh */ }
function save() {
  if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
  sset(LS, 'log', JSON.stringify(log));
}

// Always resolves to { status, data }; status 0 = network error or timeout.
async function api(path, body) {
  const ctrl = window.AbortController ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      signal: ctrl ? ctrl.signal : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
    return { status: res.status, data: data || {} };
  } catch (e) {
    return { status: 0, data: {} };
  } finally {
    clearTimeout(timer);
  }
}

// Tiny DOM builder; string children become text nodes.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const button = (props, ...kids) => h('button', Object.assign({ type: 'button' }, props), ...kids);

// Icons (Lucide-style strokes); several paths separated by "|".
const ICONS = {
  // Solid bubble with three dots punched out (evenodd).
  chat: 'M12 3.5c-5.1 0-9.2 3.6-9.2 8 0 2.4 1.2 4.6 3.1 6.1-.2 1.4-.9 2.6-1.9 3.6 2.1.1 4-.6 5.4-1.8.8.2 1.7.3 2.6.3 5.1 0 9.2-3.6 9.2-8.1S17.1 3.5 12 3.5zM6.9 11.6a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0zm3.8 0a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0zm3.8 0a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0z',
  close: 'M18 6 6 18|m6 6 12 12',
  down: 'm6 9 6 6 6-6',
  send: 'M3.4 20.4 20.9 12.9a1 1 0 0 0 0-1.8L3.4 3.6a.9.9 0 0 0-1.3 1l1.8 6.1L13 12l-9.1 1.3-1.8 6.1a.9.9 0 0 0 1.3 1z',
  up: 'M7 10v12|M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 8a2 2 0 0 1-1.9 1.4H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9z',
  dn: 'M17 14V2|M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9z',
  restart: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8|M3 3v5h5',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  check: 'M21.8 10A10 10 0 1 1 17 3.3|m9 11 3 3L22 4',
  alert: 'M12 8v4|M12 16h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
};
function icon(name, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', (name === 'chat' || name === 'send' ? 'solid ' : '') + (cls || ''));
  for (const d of ICONS[name].split('|')) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill-rule', 'evenodd');
    svg.appendChild(p);
  }
  return svg;
}

// --- colors
function parseHex(c) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
  if (!m) return null;
  const n = parseInt(m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1], 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function lum(rgb) {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const mix = (rgb, to, t) => rgb.map((v, i) => Math.round(v + (to[i] - v) * t));
const rgba = (rgb, a) => 'rgba(' + rgb.join(',') + ',' + a + ')';

// Brand color → text color on it (black/white, whichever contrasts more), a
// gradient stop, and an "ink" shade readable on white (≥ 4.5:1).
function palette(rgb) {
  const L = lum(rgb);
  const white = contrast(L, 1) >= contrast(L, 0);
  let ink = rgb;
  for (let i = 0; i < 12 && contrast(lum(ink), 1) < 4.5; i++) ink = mix(ink, [0, 0, 0], 0.12);
  return {
    '--c': rgba(rgb, 1),
    '--c2': rgba(white ? mix(rgb, [0, 0, 0], 0.18) : mix(rgb, [255, 255, 255], 0.2), 1),
    '--on': white ? '#fff' : '#111827',
    '--on-1': white ? 'rgba(255,255,255,.14)' : 'rgba(17,24,39,.07)',
    '--on-2': white ? 'rgba(255,255,255,.24)' : 'rgba(17,24,39,.12)',
    '--ink': rgba(ink, 1),
    '--ink-1': rgba(ink, 0.07),
    '--ink-2': rgba(ink, 0.16),
    '--ink-3': rgba(ink, 0.32),
  };
}

// --- rich text
// Plain text → DOM: newlines kept via pre-wrap; http(s) URLs and Iranian phone
// numbers (mobile/landline, Latin or Persian digits) become links.
const LINK_RE = new RegExp('https?://[^\\s<>"«»]+|(?:\\+98|0098|[0۰٠])[ -]?[1-9۱-۹١-٩](?:[ -]?[0-9۰-۹٠-٩]){9}', 'gi');
function richText(el, text) {
  let last = 0, m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    const i = m.index;
    let s = m[0], a = null;
    if (/^http/i.test(s)) {
      s = s.replace(/[.,;:!?)\]}'"،؛؟…]+$/, ''); // trailing punctuation belongs to the sentence
      let ok = false;
      try { ok = /^https?:$/.test(new URL(s).protocol); } catch (e) { /* invalid */ }
      if (ok) a = h('a', { href: s, target: '_blank', rel: 'noopener', dir: 'ltr' }, s);
    } else if (!DIGIT.test(text[i - 1] || '') && !DIGIT.test(text[i + s.length] || '')) {
      a = h('a', { href: 'tel:' + toEn(s).replace(/[^\d+]/g, ''), dir: 'ltr' }, s);
    }
    if (!a) continue;
    if (i > last) el.append(text.slice(last, i));
    el.append(a);
    LINK_RE.lastIndex = last = i + s.length;
  }
  if (last < text.length) el.append(text.slice(last));
  return el;
}

// --- stylesheets
// Constructable stylesheets (unaffected by a host's style-src CSP), else <style>.
function addCss(target, text) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    target.adoptedStyleSheets = target.adoptedStyleSheets.concat(sheet);
  } catch (e) {
    const st = document.createElement('style');
    st.textContent = text;
    (target === document ? document.head || document.documentElement : target).appendChild(st);
  }
}

// @font-face doesn't work inside shadow roots: add it to the host document
// under a private family name so it can't clash with the site's fonts.
function injectFonts() {
  if (window.__pasokhyarFonts) return;
  window.__pasokhyarFonts = true;
  const ranges = {
    arabic: 'U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC',
    latin: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  };
  let css = '';
  for (const f in ranges) {
    css += "@font-face{font-family:'PasokhyarVazirmatn';font-weight:100 900;font-display:swap;src:url(" + ORIGIN +
      '/fonts/vazirmatn-' + f + "-wght-normal.woff2) format('woff2');unicode-range:" + ranges[f] + '}';
  }
  addCss(document, css);
}

const STYLE = `
:host{all:initial!important}
*,::before,::after{box-sizing:border-box}
.root{--g:linear-gradient(140deg,var(--c),var(--c2));--e:cubic-bezier(.2,.8,.2,1);--line:#e7e9ee;--text:#1c2331;--muted:#6b7280;--k:15,23,42;
 --sh:0 0 0 1px rgba(var(--k),.06),0 10px 24px -6px rgba(var(--k),.18),0 28px 64px -12px rgba(var(--k),.3);
 font:400 14.5px/1.8 PasokhyarVazirmatn,Vazirmatn,Tahoma,sans-serif;color:var(--text);direction:rtl;text-align:right;
 letter-spacing:normal;word-spacing:normal;text-transform:none;color-scheme:light;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
button,input,textarea{font:inherit;color:inherit;letter-spacing:inherit;margin:0}
button{cursor:pointer;background:none;border:0;padding:0;-webkit-tap-highlight-color:transparent}
svg{display:block;width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.solid{fill:currentColor;stroke:none}
a{color:var(--ink);text-underline-offset:3px}
:focus:not(:focus-visible){outline:none}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.z{z-index:2147483000}
.c{display:grid;place-items:center}
.launcher,.head,.av,.send,.btn{background:var(--g);color:var(--on)}
.bot .bubble,.lead{background:#fff;border:1px solid var(--line);box-shadow:0 1px 2px rgba(var(--k),.04)}
.launcher,.panel{position:fixed;right:20px}
.left .launcher,.left .panel{right:auto;left:20px}

.launcher{bottom:calc(20px + env(safe-area-inset-bottom,0px));width:60px;height:60px;border-radius:50%;
 box-shadow:0 2px 6px rgba(var(--k),.14),0 10px 28px -6px rgba(var(--k),.35);transition:transform .25s var(--e),opacity .2s;animation:pop .35s var(--e) both}
.launcher:hover{transform:scale(1.06)}
.launcher svg{position:absolute;width:30px;height:30px;transition:transform .3s var(--e),opacity .2s}
.launcher .i-close{width:24px;height:24px;opacity:0;transform:rotate(-90deg) scale(.5)}
.open .launcher .i-chat{opacity:0;transform:rotate(90deg) scale(.5)}
.open .launcher .i-close{opacity:1;transform:none}
.dot{position:absolute;top:1px;right:1px;width:14px;height:14px;border-radius:50%;background:#ef4444;border:2.5px solid #fff;transform:scale(0);transition:transform .25s cubic-bezier(.3,1.6,.5,1)}
.unread .dot{transform:scale(1)}

.panel{bottom:calc(96px + env(safe-area-inset-bottom,0px));width:384px;height:600px;height:min(640px,calc(100vh - 120px));min-height:360px;background:#fff;border-radius:20px;
 display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--sh);transform-origin:100% 100%;opacity:0;visibility:hidden;pointer-events:none;
 transform:translateY(14px) scale(.97);transition:opacity .2s,transform .28s var(--e),visibility 0s .28s}
.left .panel{transform-origin:0 100%}
.open .panel{opacity:1;visibility:visible;pointer-events:auto;transform:none;transition-delay:0s}

.head{flex:none;display:flex;align-items:center;gap:12px;padding:16px 18px 16px 12px}
.hav{position:relative;flex:none;width:42px;height:42px;border-radius:50%;background:var(--on-2);font-size:18px;font-weight:700}
.hav::after{content:'';position:absolute;bottom:0;left:0;width:11px;height:11px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2.5px var(--c2)}
.htxt{flex:1;min-width:0}
.hname{margin:0;font-size:16px;font-weight:700;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hsub{font-size:12.5px;line-height:1.6;opacity:.85}
.hbtn{flex:none;width:38px;height:38px;border-radius:12px;opacity:.9;transition:.15s}
.hbtn:hover{background:var(--on-1);opacity:1}
.hbtn:focus-visible{outline-color:var(--on);outline-offset:-2px}
.hbtn .i-x{display:none}
.restart svg{width:18px;height:18px}
.empty .restart{visibility:hidden}

.log{position:relative;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:18px 14px 12px;background:#f6f7f9;scrollbar-width:thin;scrollbar-color:#d4d7de transparent}
.row{display:flex;align-items:flex-start;gap:8px;margin-top:14px}
.row:first-child{margin-top:0}
.bot+.bot,.user+.user{margin-top:6px}
.anim{animation:rise .28s var(--e) both}
.user{justify-content:flex-end}
.av{flex:none;width:28px;height:28px;border-radius:50%;margin-top:2px;font-size:12.5px;font-weight:700;line-height:1}
.bot+.bot .av{visibility:hidden}
.col{min-width:0;max-width:calc(100% - 44px);display:flex;flex-direction:column;align-items:flex-start}
.col.wide{width:calc(100% - 36px);max-width:none}
.bubble{max-width:100%;padding:9px 14px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.bot .bubble{border-top-right-radius:6px}
.user .bubble{max-width:80%;background:var(--c);color:var(--on);border-top-left-radius:6px}
.user a{color:inherit}
.label{font-size:12px;color:var(--muted);margin:10px 4px 0}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip,.retry{background:#fff;color:var(--ink);border:1px solid var(--ink-3);border-radius:99px;transition:.15s}
.chip{padding:6px 14px;font-size:13.5px;line-height:1.65;text-align:right}
.chip:hover,.retry:hover{background:var(--ink-1);border-color:var(--ink)}
.chip.ghost{color:var(--muted);border:1px dashed #d0d4db}
.chip.ghost:hover{background:#eef0f3}
.busy .chip,.busy .retry{opacity:.55;cursor:default}

.fb{display:flex;align-items:center;gap:2px;min-height:30px;margin-top:3px;padding:0 4px;font-size:12px;color:var(--muted)}
.fb span{margin-left:4px}
.fb button{width:30px;height:30px;border-radius:9px;color:#9aa1ad;transition:.15s}
.fb button:hover{background:#eceef2;color:var(--text)}
.fb svg{width:15px;height:15px}
.fb .done{color:var(--ink);width:14px;height:14px;margin-left:6px}

.typing .bubble{display:flex;gap:5px;padding:14px 16px}
.typing i{width:7px;height:7px;border-radius:50%;background:#a3a9b5;animation:blink 1.1s infinite ease-in-out}
.typing i:nth-child(2){animation-delay:.15s}
.typing i:nth-child(3){animation-delay:.3s}
.err .bubble{display:flex;gap:8px;background:#fff6f6;border-color:#f6d2d2;color:#9b1c1c}
.err .bubble svg{width:17px;height:17px;margin-top:4px}
.retry{display:inline-flex;align-items:center;gap:6px;margin-top:6px;padding:5px 12px;font-size:13px}
.retry svg{width:14px;height:14px}

.lead{width:100%;margin-top:8px;padding:14px 14px 12px;border-radius:16px}
.lead-h{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-weight:700;font-size:14px}
.lead-h span{width:28px;height:28px;border-radius:9px;background:var(--ink-1);color:var(--ink)}
.lead-h svg{width:15px;height:15px}
.fld{display:block;margin-bottom:10px}
.lbl{display:block;margin-bottom:4px;font-size:12.5px;font-weight:500;color:#475063}
.lbl small{color:#9aa1ad;font-weight:400}
.fld input,.fld textarea{display:block;width:100%;padding:8px 12px;border:1px solid #d9dde4;border-radius:11px;background:#fff;font-size:14px;line-height:1.6;resize:none;transition:.15s}
.fld ::placeholder{color:#a8aeb9}
.fld input:focus,.fld textarea:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px var(--ink-2)}
.fld [aria-invalid=true],.fld [aria-invalid=true]:focus{border-color:#dc2626}
.fld [aria-invalid=true]:focus{box-shadow:0 0 0 3px rgba(220,38,38,.15)}
.ltr{direction:ltr;text-align:left}
.ferr{display:block;margin-top:4px;font-size:12px;color:#b91c1c}
.ferr:empty{display:none}
.btn{display:block;width:100%;padding:10px;border-radius:11px;font-weight:700;font-size:14px;line-height:1.5;transition:.15s}
.btn:hover{filter:brightness(1.06)}
.btn[disabled]{opacity:.65;cursor:default;filter:none}
.ok{display:flex;gap:10px;width:100%;margin-top:8px;padding:12px 14px;border-radius:16px;background:#effcf5;border:1px solid #c5ecd6;color:#0f5132;font-size:13.5px}
.ok svg{color:#16a34a;margin-top:2px}

.composer{flex:none;padding:10px 12px 12px;background:#fff;border-top:1px solid var(--line)}
.field{display:flex;align-items:flex-end;gap:8px;padding:5px 16px 5px 5px;background:#f3f4f7;border:1px solid transparent;border-radius:24px;transition:.15s}
.field:focus-within{background:#fff;border-color:var(--ink-3);box-shadow:0 0 0 3px var(--ink-1)}
.input{flex:1;min-width:0;height:38px;max-height:132px;padding:7px 0;border:0;background:none;resize:none;font-size:14.5px;line-height:1.65;outline:none!important}
.input::placeholder{color:#9aa1ad}
.send{flex:none;width:38px;height:38px;border-radius:50%;transition:.15s}
.send svg{width:18px;height:18px;transform:scaleX(-1) translateX(1px)}
.send:not(:disabled):hover{transform:scale(1.06)}
.send:disabled{background:#dfe2e8;color:#fff;cursor:default}
.badge{flex:none;display:flex;justify-content:center;align-items:center;gap:5px;margin-top:-3px;padding:0 0 9px;background:#fff;font-size:11.5px;color:#a0a6b1;text-decoration:none}
.badge:hover{color:#5f6673}
.badge i{width:6px;height:6px;border-radius:50%;background:var(--c)}

.page{position:fixed;top:0;right:0;bottom:0;left:0;display:flex;justify-content:center;background:#eef0f4}
.page::before{content:'';position:absolute;top:0;right:0;left:0;height:230px;background:var(--g)}
.page .panel{position:relative;right:auto;left:auto;bottom:auto;width:100%;max-width:720px;height:auto;min-height:0;margin:32px 16px;
 opacity:1;visibility:visible;pointer-events:auto;transform:none;transition:none}
.page .head{padding:18px 24px 18px 16px}
.page .log{padding:24px 24px 16px}
.page .col{max-width:min(540px,calc(100% - 44px))}
.page .col.wide{width:min(440px,calc(100% - 36px))}
.page .user .bubble{max-width:540px}
.page .composer{padding:12px 20px 14px}
.fail{position:relative;align-self:center;margin:16px;padding:28px 32px;border-radius:18px;background:#fff;color:var(--muted);text-align:center;box-shadow:var(--sh)}
.fail p{margin:0 0 14px}

@media (max-width:760px){
 .page{background:#fff}
 .page::before{display:none}
 .page .panel{margin:0;border-radius:0;max-width:none;box-shadow:none}
 .page .log{padding:18px 14px 12px}
 .page .head{padding-top:calc(14px + env(safe-area-inset-top,0px))}
 .page .composer{padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px))}
 .badge{padding-bottom:calc(8px + env(safe-area-inset-bottom,0px))}
 .composer:has(+.badge){padding-bottom:10px}
}
@media (max-width:480px){
 .float .panel{top:0;right:0;bottom:0;left:0;width:auto;height:auto;min-height:0;border-radius:0;transform:translateY(28px)}
 .float.open .panel{transform:none}
 .float.open .launcher{opacity:0;visibility:hidden;transition:none}
 .float .head{padding-top:calc(14px + env(safe-area-inset-top,0px))}
 .float .composer{padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px))}
 .float .composer:has(+.badge){padding-bottom:10px}
 .hbtn .i-x{display:block}
 .hbtn .i-down{display:none}
 .launcher{right:16px}
 .left .launcher{left:16px}
 .input,.fld input,.fld textarea{font-size:16px}
}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
@keyframes pop{from{opacity:0;transform:scale(.6)}}
@keyframes blink{0%,60%,100%{transform:none;opacity:.45}30%{transform:translateY(-4px);opacity:1}}
.instant *{transition:none!important;animation:none!important}
@media (prefers-reduced-motion:reduce){*,::before,::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}}
@media print{.root{display:none}}
`;

// --- state
let cfg = null, ready = false, isOpen = false, pendingOpen = false, busy = false, uid = 0;
let shadow, rootEl, launcher, panel, logEl, input, sendBtn;
const leadEls = new WeakMap(); // message → its open lead form (to drop stale ones)

function normalize(b) {
  const s = x => (typeof x === 'string' ? x.trim() : '');
  const badge = b.badge || {};
  return {
    name: s(b.name).slice(0, 60) || 'پشتیبانی',
    welcome: s(b.welcome) || T.welcome,
    rgb: parseHex(b.color) || [79, 70, 229],
    left: b.position === 'left',
    leadForm: !!b.leadForm,
    placeholder: s(b.placeholder) || T.placeholder,
    suggestions: (Array.isArray(b.suggestions) ? b.suggestions : []).map(s).filter(Boolean).slice(0, 4),
    badge: badge.show && /^https?:\/\//i.test(badge.url || '') ? { text: s(badge.text), url: badge.url } : null,
  };
}

const initial = () => Array.from(cfg.name.replace(/\s+/g, ''))[0] || '؟';
const avatar = () => h('div', { class: 'av c', 'aria-hidden': 'true' }, initial());
const newHost = () => {
  const host = document.createElement('pasokhyar-widget'); // custom tag: host `div {}` rules don't match
  const root = host.attachShadow({ mode: 'open' });
  addCss(root, STYLE);
  document.body.appendChild(host);
  return root;
};
const themed = (el, rgb) => { const p = palette(rgb); for (const k in p) el.style.setProperty(k, p[k]); return el; };

// --- build
function build() {
  injectFonts();
  shadow = newHost();
  rootEl = themed(h('div', { class: 'root ' + (PAGE ? 'page z' : 'float') + (cfg.left ? ' left' : ''), dir: 'rtl', lang: 'fa' }), cfg.rgb);
  const label = 'گفتگو با ' + cfg.name;

  if (!PAGE) {
    launcher = button({ class: 'launcher z c', 'aria-expanded': 'false', 'aria-controls': 'pk-panel', 'aria-label': label, onclick: () => setOpen(!isOpen) },
      icon('chat', 'i-chat'), icon('close', 'i-close'), h('span', { class: 'dot' }));
  }

  const head = h('div', { class: 'head' },
    h('div', { class: 'hav c', 'aria-hidden': 'true' }, initial()),
    h('div', { class: 'htxt' }, h(PAGE ? 'h1' : 'h2', { class: 'hname' }, cfg.name), h('div', { class: 'hsub' }, T.subtitle)),
    button({ class: 'hbtn c restart', 'aria-label': 'شروع گفتگوی تازه', title: 'گفتگوی تازه', onclick: restart }, icon('restart')),
    PAGE ? null : button({ class: 'hbtn c', 'aria-label': 'بستن گفتگو', title: 'بستن', onclick: () => setOpen(false, true) },
      icon('down', 'i-down'), icon('close', 'i-x')));

  logEl = h('div', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-label': 'پیام‌های گفتگو', tabindex: '-1' });
  input = h('textarea', {
    class: 'input', rows: '1', maxlength: '500', dir: 'auto', enterkeyhint: 'send', placeholder: cfg.placeholder, 'aria-label': 'پیام شما',
    oninput: () => { autosize(); updateSend(); },
    // Enter sends, Shift+Enter = newline; ignore Enter that confirms an IME composition.
    onkeydown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } },
  });
  sendBtn = h('button', { type: 'submit', class: 'send c', 'aria-label': 'ارسال', disabled: true }, icon('send'));

  panel = h('section', { id: 'pk-panel', class: 'panel z', tabindex: '-1', role: PAGE ? 'main' : 'dialog', 'aria-label': label },
    head, logEl,
    h('form', { class: 'composer', onsubmit: e => { e.preventDefault(); submit(); } }, h('div', { class: 'field' }, input, sendBtn)),
    cfg.badge && h('a', { class: 'badge', href: cfg.badge.url, target: '_blank', rel: 'noopener' }, h('i'), cfg.badge.text));

  rootEl.append(panel);
  if (!PAGE) rootEl.append(launcher);
  shadow.appendChild(rootEl);

  // Esc closes. Keys typed into our fields must not trigger host-site shortcuts.
  const inField = e => /^(INPUT|TEXTAREA)$/.test(e.target && e.target.tagName);
  shadow.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen) { e.stopPropagation(); setOpen(false, true); } else if (inField(e)) e.stopPropagation();
  });
  for (const t of ['keyup', 'keypress']) shadow.addEventListener(t, e => { if (inField(e)) e.stopPropagation(); });

  renderAll();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
}
function updateSend() { sendBtn.disabled = busy || !input.value.trim(); }
function setBusy(b) {
  busy = b;
  rootEl.classList.toggle('busy', b);
  logEl.setAttribute('aria-busy', String(b));
  updateSend();
}
const focusInput = () => { if (!TOUCH.matches) input.focus({ preventScroll: true }); };

// --- rendering
function renderAll() {
  logEl.textContent = '';
  const col = h('div', { class: 'col' }, richText(h('div', { class: 'bubble' }), cfg.welcome));
  logEl.append(h('div', { class: 'row bot' }, avatar(), col));
  // Starter chips only until the visitor has said something.
  if (cfg.suggestions.length && !log.some(m => m.r === 'u')) {
    col.append(h('div', { class: 'chips starters' },
      cfg.suggestions.map(q => button({ class: 'chip', onclick: () => { if (!busy) ask(q); } }, q))));
  }
  for (const m of log) logEl.append(renderMsg(m));
  rootEl.classList.toggle('empty', !log.length);
  scrollEnd(false);
}

function renderMsg(m) {
  if (m.r === 'u') return h('div', { class: 'row user' }, h('div', { class: 'bubble', dir: 'auto' }, m.t));
  const col = h('div', { class: 'col' }, richText(h('div', { class: 'bubble' }), m.t));
  const sugg = Array.isArray(m.s) ? m.s.filter(s => s && s.id != null && typeof s.question === 'string') : [];
  if (m.k === 'answer' && m.id) col.append(feedback(m));
  if (sugg.length) {
    if (m.k === 'answer') col.append(h('div', { class: 'label' }, T.related));
    const fromId = m.k === 'suggest' ? m.id : null; // server learns what the visitor meant
    col.append(h('div', { class: 'chips' },
      sugg.map(s => button({ class: 'chip', onclick: () => pickFaq(s, fromId) }, s.question)),
      m.o && button({ class: 'chip ghost', onclick: noneOfThese }, T.none)));
  }
  if (m.lead) { col.classList.add('wide'); col.append(leadBlock(m)); }
  return h('div', { class: 'row bot' }, avatar(), col);
}

function push(m) {
  if (m.lead === 'open') dropOpenLeadForms();
  log.push(m);
  save();
  rootEl.classList.remove('empty');
  const row = renderMsg(m);
  row.classList.add('anim');
  logEl.append(row);
  reveal(row);
}

function scrollTo(top, smooth) {
  try { logEl.scrollTo({ top, behavior: smooth && !REDUCED.matches ? 'smooth' : 'auto' }); } catch (e) { logEl.scrollTop = top; }
}
const scrollEnd = smooth => requestAnimationFrame(() => scrollTo(logEl.scrollHeight, smooth));
// Scroll to the end — or to the row's top if it's taller than the view.
const reveal = row => requestAnimationFrame(() =>
  scrollTo(row.offsetHeight > logEl.clientHeight - 40 ? row.offsetTop - 12 : logEl.scrollHeight, true));

function showTyping() {
  const row = h('div', { class: 'row bot typing anim', 'aria-hidden': 'true' }, avatar(),
    h('div', { class: 'col' }, h('div', { class: 'bubble' }, h('i'), h('i'), h('i'))));
  logEl.append(row);
  scrollEnd(true);
  return row;
}

// A short, length-aware beat so replies feel typed rather than instant (0.45–0.8 s).
const typingDelay = text => 450 + Math.min(350, (text || '').length * 2);

// Client-side bot line (no round-trip), same typing beat.
async function botSay(m) {
  setBusy(true);
  const t = showTyping();
  await wait(typingDelay(m.t));
  t.remove();
  setBusy(false);
  push(m);
}

// --- conversation
function submit() {
  const q = input.value.trim();
  if (!q || busy) return;
  input.value = '';
  autosize();
  ask(q);
}
function ask(q) {
  push({ r: 'u', t: q });
  converse('/ask', { q });
}
function pickFaq(s, fromId) {
  if (busy) return;
  push({ r: 'u', t: s.question });
  converse('/pick', { faqId: s.id, messageId: fromId || undefined });
}
function noneOfThese() {
  if (busy) return;
  push({ r: 'u', t: T.none });
  botSay({ r: 'b', k: 'info', t: T.noneReply, lead: 'open' });
}

async function converse(path, payload) {
  if (busy) return;
  setBusy(true);
  for (const el of logEl.querySelectorAll('.starters,.err')) el.remove();
  const typing = showTyping();
  const t0 = Date.now();
  const { status, data } = await api(path, Object.assign({ sid, channel: PAGE ? 'page' : undefined }, payload));
  const text = typeof data.answer === 'string' ? data.answer : '';
  await wait(typingDelay(text) - (Date.now() - t0));
  typing.remove();
  setBusy(false);

  if (status === 200 && data.ok && text) {
    const m = { r: 'b', k: data.type, t: text };
    if (data.messageId) m.id = data.messageId;
    if (Array.isArray(data.suggestions) && data.suggestions.length) {
      m.s = data.suggestions.slice(0, 5).map(s => ({ id: s.id, question: String(s.question || '') }));
    }
    if (data.type === 'suggest') { if (data.offerLead && cfg.leadForm) m.o = 1; } else if (data.offerLead) m.lead = 'open';
    push(m);
  } else if (status === 429) {
    push({ r: 'b', k: 'info', t: text || T.slowDown });
  } else if (status === 404 && path === '/pick') {
    push({ r: 'b', k: 'info', t: T.gone });
  } else {
    const row = h('div', { class: 'row bot err anim', role: 'alert' }, avatar(), h('div', { class: 'col' },
      h('div', { class: 'bubble' }, icon('alert'), h('span', null, status ? T.failed : T.offline)),
      button({ class: 'retry', onclick: () => { if (!busy) converse(path, payload); } }, icon('restart'), T.retry)));
    logEl.append(row);
    reveal(row);
  }
  if (!isOpen && !PAGE) setUnread(true);
}

function feedback(m) {
  const wrap = h('div', { class: 'fb' });
  const btn = (good, label) => button({ class: 'c', 'aria-label': 'پاسخ ' + label, title: label, onclick: () => rate(good) }, icon(good ? 'up' : 'dn'));
  const draw = () => {
    wrap.textContent = '';
    if (m.fb == null) wrap.append(h('span', null, T.helpful), btn(true, 'مفید بود'), btn(false, 'مفید نبود'));
    else wrap.append(icon(m.fb ? 'up' : 'dn', 'done'), h('span', { role: 'status' }, T.thanks));
  };
  const rate = good => {
    const hadFocus = wrap.contains(shadow.activeElement);
    m.fb = good ? 1 : 0;
    save();
    draw();
    if (hadFocus) focusInput(); // the pressed button is gone
    api('/feedback', { messageId: m.id, helpful: good });
    if (!good && cfg.leadForm && !busy) botSay({ r: 'b', k: 'info', t: T.unhelpful, lead: 'open' });
  };
  draw();
  return wrap;
}

// Only one unsubmitted lead form at a time: a newer offer replaces older ones.
function dropOpenLeadForms() {
  for (const m of log) {
    if (m.lead !== 'open') continue;
    delete m.lead;
    const el = leadEls.get(m);
    if (el && el.parentNode) { el.parentNode.classList.remove('wide'); el.remove(); }
  }
}

function leadBlock(m) {
  if (m.lead === 'done') return h('div', { class: 'ok', role: 'status' }, icon('check'), h('span', null, m.lm || T.leadDone));
  const n = ++uid;
  const errs = new Map(); // control → its error line
  const field = (label, ctl) => {
    let err = null;
    if (ctl.required) {
      err = h('span', { class: 'ferr', id: 'pk-e' + n + ctl.name, 'aria-live': 'polite' });
      ctl.setAttribute('aria-describedby', err.id);
      errs.set(ctl, err);
      ctl.addEventListener('input', () => setErr(ctl, ''));
    }
    return h('label', { class: 'fld' }, h('span', { class: 'lbl' }, label), ctl, err);
  };
  const setErr = (ctl, text) => {
    ctl.setAttribute('aria-invalid', String(!!text));
    errs.get(ctl).textContent = text;
  };
  const name = h('input', { type: 'text', name: 'name', autocomplete: 'name', maxlength: '100', required: true });
  const phone = h('input', { type: 'tel', name: 'phone', class: 'ltr', autocomplete: 'tel', inputmode: 'tel', maxlength: '20', required: true, placeholder: '۰۹۱۲ ۳۴۵ ۶۷۸۹' });
  const msg = h('textarea', { name: 'message', rows: '2', maxlength: '1000' });
  const btn = h('button', { type: 'submit', class: 'btn' }, T.leadSend);
  const formErr = h('span', { class: 'ferr', role: 'alert' });
  const form = h('form', { class: 'lead', novalidate: true, 'aria-label': T.leadTitle },
    h('div', { class: 'lead-h' }, h('span', { class: 'c' }, icon('phone')), T.leadTitle),
    field('نام', name), field('شماره موبایل', phone), field(['توضیح ', h('small', null, '(اختیاری)')], msg),
    btn, formErr);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (btn.disabled) return;
    formErr.textContent = '';
    const nm = name.value.trim();
    // Loose check; the server has the final say.
    const ph = toEn(phone.value).replace(/[\s\-()]/g, '');
    let bad = null;
    if (!/^\+?\d{8,15}$/.test(ph)) { setErr(phone, 'شماره موبایل را درست وارد کنید؛ مثلاً ۰۹۱۲۳۴۵۶۷۸۹'); bad = phone; }
    if (!nm) { setErr(name, 'لطفاً نامتان را بنویسید.'); bad = name; }
    if (bad) return bad.focus();

    btn.disabled = true;
    btn.textContent = 'در حال ارسال…';
    const { status, data } = await api('/lead', { sid, name: nm, phone: ph, message: msg.value.trim() });
    btn.disabled = false;
    btn.textContent = T.leadSend;
    if (status === 200 && data.ok) {
      m.lead = 'done';
      m.lm = typeof data.message === 'string' && data.message ? data.message : T.leadDone;
      save();
      const done = leadBlock(m);
      form.replaceWith(done);
      leadEls.delete(m);
      focusInput();
      reveal(done.parentNode.parentNode);
    } else if (status === 400 && data.error === 'bad_phone') {
      setErr(phone, 'این شماره معتبر نیست؛ لطفاً شماره موبایل را بررسی کنید.');
      phone.focus();
    } else {
      formErr.textContent = status === 429 ? 'درخواست‌های زیادی ثبت شده؛ کمی بعد دوباره امتحان کنید.'
        : status ? 'ثبت درخواست ممکن نشد؛ لطفاً دوباره امتحان کنید.' : 'ارسال نشد؛ اتصال اینترنت را بررسی کنید و دوباره بزنید.';
    }
  });
  leadEls.set(m, form);
  return form;
}

function restart() {
  if (busy) return;
  log = [];
  save();
  renderAll();
  focusInput();
}

// --- open/close
function setUnread(v) { if (rootEl && !PAGE) rootEl.classList.toggle('unread', v); }

function setOpen(v, focusLauncher) {
  if (!ready) { pendingOpen = v; return; }
  if (PAGE || v === isOpen) return;
  isOpen = v;
  rootEl.classList.toggle('open', v);
  launcher.setAttribute('aria-expanded', String(v));
  launcher.setAttribute('aria-label', v ? 'بستن گفتگو' : 'گفتگو با ' + cfg.name);
  sset(SS, 'open', v ? '1' : '');
  if (v) {
    setUnread(false);
    scrollEnd(false);
    // Touch: focus the dialog, not the input (the keyboard would cover the chat).
    setTimeout(() => (TOUCH.matches ? panel : input).focus({ preventScroll: true }), 60);
  } else if (focusLauncher || panel.contains(shadow.activeElement)) {
    launcher.focus({ preventScroll: true });
  }
}

// --- boot
window.Pasokhyar = {
  version: '1.0',
  open: () => setOpen(true),
  close: () => setOpen(false),
  toggle: () => setOpen(!(ready ? isOpen : pendingOpen)),
};
// Any host element with a data-pasokhyar-open attribute opens the chat.
document.addEventListener('click', e => {
  const t = e.target && e.target.closest && e.target.closest('[data-pasokhyar-open]');
  if (t) { e.preventDefault(); setOpen(true); }
});

(async () => {
  const [res] = await Promise.all([
    api('/config'),
    new Promise(r => (document.body ? r() : document.addEventListener('DOMContentLoaded', r, { once: true }))),
  ]);
  if (res.status !== 200 || !res.data.ok || !res.data.bot) {
    console.warn('[pasokhyar] widget disabled:', res.data.error || res.status || 'network error');
    if (PAGE) { // hosted page: a friendly message instead of a blank screen
      injectFonts();
      newHost().append(themed(h('div', { class: 'root page z', dir: 'rtl', lang: 'fa' }, h('div', { class: 'fail' }, h('p', null, T.unavailable),
        button({ class: 'retry', onclick: () => location.reload() }, icon('restart'), T.retry))), [107, 114, 128]));
    }
    return;
  }
  cfg = normalize(res.data.bot);
  build();
  ready = true;
  // Stay open across navigations in this tab — not on phones, where the panel
  // is full-screen and would cover every page.
  const restore = !PAGE && sget(SS, 'open') === '1' && !MOBILE.matches;
  if (pendingOpen || restore) {
    if (!pendingOpen) rootEl.classList.add('instant'); // no animation on restore
    setOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => rootEl.classList.remove('instant')));
  } else if (PAGE) {
    focusInput();
  }
})();
})();

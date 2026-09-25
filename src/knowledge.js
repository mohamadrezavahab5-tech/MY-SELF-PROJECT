'use strict';
// Website knowledge: read a customer's website, keep the main text of each
// page as passages, and find the passage that answers a visitor's question.
// Contract: docs/ARCHITECTURE.md "Knowledge contract".
//
// Crawl (background job per source)
// ---------------------------------
//   robots.txt (Disallow/Allow for our agent or `*`, Crawl-delay, Sitemap:)
//   -> sitemaps (robots' Sitemap: lines, else /sitemap.xml, /sitemap_index.xml,
//      /wp-sitemap.xml; sitemap indexes followed; tag/author/category maps skipped)
//   -> priority queue: start page, then support-looking pages (about, contact,
//      FAQ, shipping, returns, … also Persian slugs), shallow before deep,
//      then everything else found in sitemaps and links. Same site only
//      (www./non-www. alike); carts, accounts, feeds, tags, search results,
//      deep pagination and non-HTML files are skipped; tracking parameters are
//      dropped and the query sorted.
//   Pages are fetched with importer.fetchPage (SSRF-guarded), 2 at a time with
//   a short pause, under a total time cap. On success the source's passages are
//   replaced in one transaction.
//
// Extraction (no DOM library): a tolerant HTML tree builder, then boilerplate
// removal (nav/header/footer/aside/forms, class/id hints such as menu,
// sidebar, breadcrumb, comments, share, related, cookie, popup; link-dense
// blocks), then the main-content root (.entry-content, Elementor page content,
// <article>, <main>, …). Headings — including accordion titles, bold-only
// lines and short questions — structure the text.
//
// Passages: ~250–700 characters, split on heading/paragraph boundaries, each
// with its page title and nearest heading. Paragraphs repeated across pages
// (site-wide banners, template text) are kept once.
//
// Retrieval: BM25F over passages analysed with the FAQ engine's Persian
// analyzer (same normalization, colloquial forms, stemming, synonym groups),
// heading and title weighted above body, near-spellings for typos. The top
// candidates then get a calibrated [0,1] confidence (score()): how much of
// the question's information the passage covers — in its heading/title or
// within one 1–3 sentence window, which is what snippet() shows — how much its
// heading is about the question, and a penalty when the question's most
// informative word is missing from it. All of these are ratios, so the
// THRESHOLDS mean the same for a 5-page and a 3,000-page site.

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const db = require('./db');
const importer = require('./importer');
const engine = require('./nlp/engine');
const A = require('./nlp/analyzer');
const { normalize, normalizeTokens } = require('./nlp/normalize');
const { effectivePlan } = require('./plans');

// answer: show the passage's snippet as the reply; context: good enough to hand
// to the AI as grounding. Chosen with the evaluation in test/knowledge.test.js
// (fixture sites in test/fixtures/knowledge).
const THRESHOLDS = { answer: 0.6, context: 0.4 };

const CRAWL = {
  concurrency: 2,
  delayMs: 400, // pause after each request, per worker
  maxCrawlDelayMs: 5000, // robots.txt Crawl-delay is honoured up to this
  timeCapMs: 5 * 60_000, // total crawl time (scaled up to timeCapMaxMs for big plans)
  timeCapMaxMs: 10 * 60_000,
  fetchTimeoutMs: 25_000, // hard cap per request (fetchPage also has a socket timeout)
  staleMs: 15 * 60_000, // a crawl running longer than this is treated as dead
  maxActive: 2, // crawls running at once on this server; others wait their turn
  maxFrontier: 5000,
  maxSitemaps: 8,
  maxSitemapUrls: 5000,
  maxPageChars: 60_000,
  maxPassagesPerPage: 40,
  maxPassagesPerSource: 15_000,
  maxSourcesPerBot: 10,
};
const CHUNK = { min: 250, max: 700 };

// ================================================================ URLs

// Tracking / session parameters: dropped when normalizing a URL.
const TRACKING_PARAM = /^(?:utm_\w*|gclid|gclsrc|dclid|gbraid|wbraid|fbclid|yclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|srsltid|ref|referrer|spm|scid|trk|hsa_\w+|_hs\w+|mkt_tok|zanpid|amp|fb_action_ids|fb_action_types|fb_source|sessionid|sid|phpsessid|jsessionid)$/i;
// A URL carrying one of these is an action, a search or a filtered listing.
const JUNK_PARAM = /^(?:add-to-cart|add_to_cart|add_to_wishlist|add-to-compare|remove_item|removed_item|undo_item|s|q|search|query|orderby|order|sort|filter_\w+|min_price|max_price|rating_filter|query_type_\w+|replytocom|action|redirect_to|redirect|return_url|wc-ajax|_wpnonce|nonce|attachment_id|preview|preview_id|preview_nonce|print|format|output|download|login|logout|currency|view|per_page|product_view|shop_view|display|share|like|comment|unapproved|moderation-hash|doing_wp_cron|ver|replyto)$/i;
// Whole path segments that mark carts, accounts, feeds, archives, admin.
const JUNK_SEGMENT = new Set([
  'cart', 'basket', 'checkout', 'my-account', 'myaccount', 'account', 'wishlist', 'compare', 'login', 'log-in',
  'signin', 'sign-in', 'logout', 'log-out', 'register', 'wp-admin', 'wp-login.php', 'wp-json', 'wp-content',
  'wp-includes', 'xmlrpc.php', 'wp-signup.php', 'wp-cron.php', 'feed', 'rss', 'atom', 'trackback', 'embed',
  'tag', 'tags', 'product-tag', 'author', 'search', 'cdn-cgi', 'print', 'amp', 'order-received', 'order-pay',
  'lost-password', 'edit-account', 'customer-logout', 'sabad-kharid', 'سبد-خرید', 'سبد', 'تسویه-حساب',
  'حساب-کاربری', 'حساب-من', 'ورود', 'خروج', 'ورود-ثبت-نام', 'علاقه-مندی', 'علاقه‌مندی‌ها', 'مقایسه', 'برچسب',
  'نویسنده', 'جستجو',
]);
const SKIP_EXT = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|pdf|zip|rar|7z|gz|tgz|tar|bz2|xz|exe|msi|dmg|apk|ipa|iso|bin|docx?|xlsx?|pptx?|odt|ods|csv|txt|rtf|epub|mp3|mp4|m4a|m4v|mov|avi|mkv|wmv|flv|webm|wav|ogg|oga|ogv|aac|flac|css|js|mjs|json|xml|rss|atom|woff2?|ttf|otf|eot|map|psd|ai|eps|swf|torrent)$/i;
// Pages a support bot most needs; crawled first when the plan allows few pages.
const IMPORTANT = /(?:about|contact|faq|help|support|shipping|delivery|return|refund|warranty|guarantee|terms|rules|policy|privacy|payment|pricing|price|tariff|services?|how-to|درباره|تماس|سوال|سؤال|پرسش|ارسال|تحویل|مرجوع|بازگشت|بازگرداندن|قوانین|مقررات|شرایط|ضمانت|گارانتی|پرداخت|راهنما|پشتیبانی|حریم|خدمات|تعرفه|قیمت|نحوه|شعب|نمایندگی)/;
const LISTING = /(?:^|\/)(?:category|categories|product-category|product_cat|archives?|shop|blog|page|دسته|دسته-بندی|فروشگاه)(?:\/|$)/;

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Absolute, canonical-ish URL object, or null for anything we won't fetch.
function normalizeUrl(raw, base) {
  let u;
  try {
    u = new URL(String(raw || '').trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if (/\/\/+/.test(u.pathname)) u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  if (u.search) {
    const params = [...u.searchParams].filter(([k]) => !TRACKING_PARAM.test(k));
    params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    u.search = params.length ? new URLSearchParams(params).toString() : '';
  }
  return u;
}

// www./non-www. (and http/https) are the same site.
function siteOf(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\d*\./, '');
}

// Dedupe key: the same page regardless of scheme, www., trailing slash or %-case.
function urlKey(u) {
  let path = safeDecode(u.pathname);
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return siteOf(u.hostname) + path + (u.search ? '?' + safeDecode(u.search.slice(1)) : '');
}

function isJunkUrl(u) {
  const path = safeDecode(u.pathname).toLowerCase();
  if (SKIP_EXT.test(path)) return true;
  const segs = path.split('/').filter(Boolean);
  for (const s of segs) {
    if (JUNK_SEGMENT.has(s) || /^comment-page-\d+$/.test(s)) return true;
  }
  // pagination beyond page 2: /page/3/, ?paged=3, ?page=3
  const pi = segs.lastIndexOf('page');
  if (pi >= 0 && /^\d+$/.test(segs[pi + 1] || '') && Number(segs[pi + 1]) > 2) return true;
  for (const [k, v] of u.searchParams) {
    if (JUNK_PARAM.test(k)) return true;
    if ((k === 'paged' || k === 'page' || k === 'pg') && Number(v) > 2) return true;
  }
  return false;
}

function urlPriority(u, hops, from) {
  const path = safeDecode(u.pathname).toLowerCase();
  const depth = path.split('/').filter(Boolean).length;
  let p = -Math.min(depth, 8) * 4 - hops * 6;
  if (from === 'start') p += 1000;
  if (IMPORTANT.test(path) || IMPORTANT.test(safeDecode(u.search))) p += 40;
  if (from === 'sm-page') p += 12;
  if (from === 'sm-post') p -= 4;
  if (LISTING.test(path)) p -= 15;
  if (u.search) p -= 8;
  return p;
}

// Highest priority first; FIFO among equals. (Pops are few: a linear scan is fine.)
class Frontier {
  constructor() {
    this.items = [];
    this.seq = 0;
  }
  get size() {
    return this.items.length;
  }
  push(u, pri, hops) {
    this.items.push({ u, pri, hops, seq: this.seq++ });
  }
  pop() {
    const items = this.items;
    if (!items.length) return null;
    let b = 0;
    for (let i = 1; i < items.length; i++) {
      const x = items[i];
      const y = items[b];
      if (x.pri > y.pri || (x.pri === y.pri && x.seq < y.seq)) b = i;
    }
    const it = items[b];
    items[b] = items[items.length - 1];
    items.pop();
    return it;
  }
}

// ================================================================ robots.txt

const AGENT_TOKENS = ['pasokhyar', 'faqimporter'];

function robotsPattern(path) {
  let p = safeDecode(path);
  const anchored = p.endsWith('$');
  if (anchored) p = p.slice(0, -1);
  const body = p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastAgent = false;
  for (const raw of String(text || '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastAgent) groups.push((cur = { agents: [], rules: [], delay: null }));
      cur.agents.push(val.toLowerCase());
      lastAgent = true;
      continue;
    }
    lastAgent = false;
    if (key === 'sitemap') {
      if (val) sitemaps.push(val);
    } else if (cur && (key === 'disallow' || key === 'allow')) {
      if (val) cur.rules.push({ allow: key === 'allow', path: val }); // empty Disallow = allow all
    } else if (cur && key === 'crawl-delay') {
      const d = parseFloat(val);
      if (Number.isFinite(d) && d > 0) cur.delay = d;
    }
  }
  const mine = groups.filter(g => g.agents.some(a => AGENT_TOKENS.some(t => a.includes(t))));
  const chosen = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
  const rules = [];
  let delay = null;
  for (const g of chosen) {
    for (const r of g.rules) rules.push({ allow: r.allow, re: robotsPattern(r.path), len: r.path.length });
    if (g.delay) delay = Math.max(delay || 0, g.delay);
  }
  return { rules, delay, sitemaps };
}

// Longest matching rule wins; Allow wins a tie.
function robotsAllows(robots, u) {
  if (!robots || !robots.rules.length) return true;
  const path = safeDecode(u.pathname + u.search);
  let best = null;
  for (const r of robots.rules) {
    if (!r.re.test(path)) continue;
    if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = r;
  }
  return !best || best.allow;
}

// ================================================================ sitemaps

function parseSitemap(xml) {
  const s = String(xml || '');
  const locs = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(s)) && locs.length < 50_000) locs.push(decodeEntities(m[1]).trim());
  return /<sitemapindex[\s>]/i.test(s) ? { sitemaps: locs, urls: [] } : { sitemaps: [], urls: locs };
}

const JUNK_SITEMAP = /(?:tag|author|user|attachment|image|video|categor|product_cat|product-cat|taxonom|archive|brand|portfolio|news|elementor)/i;

function sitemapKind(u) {
  const name = safeDecode(u.pathname).toLowerCase();
  if (/page/.test(name)) return 'sm-page';
  if (/post/.test(name) && !/product/.test(name)) return 'sm-post';
  return 'sm';
}
const SITEMAP_RANK = { 'sm-page': 0, sm: 1, 'sm-post': 2 };

// ================================================================ fetching

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(t));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// robots.txt is text/plain, which importer.fetchPage (HTML/XML only) refuses.
// This is fetchPage's SSRF guard for one small text file: every resolved
// address must be public, checked at connect time; literal IPs are checked up
// front; each redirect goes through the same checks.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some(a => importer.isPrivateIp(a.address))) return callback(new Error('blocked_address'));
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function fetchText(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(rawUrl); } catch { return reject(new Error('bad_url')); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new Error('bad_url'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && importer.isPrivateIp(host)) return reject(new Error('blocked_address'));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      lookup: guardedLookup,
      timeout: 10_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FAQImporter/1.0)', Accept: 'text/plain,*/*;q=0.5' },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 3) return reject(new Error('too_many_redirects'));
        return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`http_${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > 512 * 1024) { req.destroy(new Error('too_large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// fetch(url, kind) -> Promise<string>; kind: 'robots' | 'sitemap' | 'page'.
function defaultFetch(url, kind) {
  return kind === 'robots' ? fetchText(url) : importer.fetchPage(url);
}

// ================================================================ HTML -> tree

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '‌', zwj: '‍', rlm: '', lrm: '',
  laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', times: '×', divide: '÷', deg: '°', shy: '',
  thinsp: ' ', ensp: ' ', emsp: ' ', euro: '€', pound: '£', cent: '¢', sect: '§', para: '¶', rarr: '→', larr: '←',
};
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+[0-9]*);?/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    const v = ENTITIES[e.toLowerCase()];
    if (v === undefined) return m;
    // Without «;» only the classic ones («&amp», «&nbsp») are entities.
    return m.endsWith(';') || /^(amp|lt|gt|quot|nbsp)$/i.test(e) ? v : m;
  });
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
  'source', 'track', 'wbr', 'keygen', 'command', 'basefont', 'frame']);
// Their content is not markup, and never page text (<title> is kept aside).
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template', 'iframe', 'noembed', 'noframes']);
const KEEP_ATTRS = new Set(['id', 'class', 'role', 'href', 'rel', 'name', 'property', 'content', 'itemprop',
  'data-elementor-type', 'hidden']);
const INLINE = new Set(['a', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'big', 'font', 'mark', 'sup',
  'sub', 'abbr', 'cite', 'code', 'kbd', 'q', 'time', 'label', 'bdi', 'bdo', 'del', 'ins', 'var', 'dfn', 'data', 'nobr']);
const HEADING = /^h[1-6]$/;
const MAX_DEPTH = 400;

const ATTR_RE = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
function parseAttrs(text) {
  const attrs = {};
  if (!text) return attrs;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(text))) {
    const k = m[1].toLowerCase();
    if (!KEEP_ATTRS.has(k) || k in attrs) continue;
    attrs[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const rawEndCache = new Map();
function rawEnd(name) {
  let re = rawEndCache.get(name);
  if (!re) rawEndCache.set(name, (re = new RegExp(`</${name}\\s*>`, 'ig')));
  return re;
}

function makeEl(tag, attrs) {
  return {
    tag, attrs, children: [], parent: null,
    id: (attrs.id || '').toLowerCase(), cls: (attrs.class || '').toLowerCase(),
    len: 0, linkLen: 0, links: 0, marker: false, junk: false,
  };
}

// Tolerant tree builder: implied end tags for p/li/dt/dd/tr/td/headings,
// unmatched end tags ignored, nesting depth capped. Linear time.
function parseHtml(html) {
  const root = makeEl('#root', {});
  const stack = [root];
  let title = '';
  const n = html.length;
  const top = () => stack[stack.length - 1];
  const addText = s => {
    const c = top().children;
    if (typeof c[c.length - 1] === 'string') c[c.length - 1] += s;
    else c.push(s);
  };
  // Close the nearest open element named in `names`, unless a `boundary` element comes first.
  const closeOpen = (names, boundary) => {
    for (let i = stack.length - 1; i > 0; i--) {
      const t = stack[i].tag;
      if (names.includes(t)) {
        stack.length = i;
        return;
      }
      if (boundary(t)) return;
    }
  };
  const notInline = t => !INLINE.has(t) && t !== 'p';
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      addText(html.slice(i));
      break;
    }
    if (lt > i) addText(html.slice(i, lt));
    const c1 = html.charCodeAt(lt + 1);
    if (c1 === 33) { // <!-- -->, <!DOCTYPE>, <![CDATA[ ]]>
      let e;
      if (html.startsWith('<!--', lt)) e = html.indexOf('-->', lt + 4) + 3;
      else if (html.startsWith('<![CDATA[', lt)) e = html.indexOf(']]>', lt) + 3;
      else e = html.indexOf('>', lt) + 1;
      i = e > lt ? e : n;
      continue;
    }
    if (c1 === 63) { // <? ... >
      const e = html.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const closing = c1 === 47;
    let j = lt + (closing ? 2 : 1);
    const ns = j;
    const c = html.charCodeAt(j) | 0x20;
    if (!(c >= 97 && c <= 122)) {
      addText('<');
      i = lt + 1;
      continue;
    }
    while (j < n) {
      const d = html.charCodeAt(j);
      if (d === 32 || d === 9 || d === 10 || d === 13 || d === 12 || d === 47 || d === 62) break;
      j++;
    }
    const name = html.slice(ns, j).toLowerCase();
    // End of the tag, skipping quoted attribute values.
    let k = j;
    let q = 0;
    let eq = false;
    for (; k < n; k++) {
      const d = html.charCodeAt(k);
      if (q) {
        if (d === q) q = 0;
        continue;
      }
      if (d === 62) break;
      if (d === 61) eq = true;
      else if ((d === 34 || d === 39) && eq) {
        q = d;
        eq = false;
      } else if (d !== 32 && d !== 9 && d !== 10 && d !== 13) eq = false;
    }
    if (k >= n) { // unterminated quote: settle for the first '>'
      k = html.indexOf('>', j);
      if (k < 0) break;
    }
    const attrText = html.slice(j, k);
    i = k + 1;

    if (closing) {
      if (name === 'br') {
        top().children.push(makeEl('br', {}));
        continue;
      }
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    if (RAW_TAGS.has(name)) {
      const re = rawEnd(name);
      re.lastIndex = i;
      const m = re.exec(html);
      if (name === 'title' && !title) title = html.slice(i, m ? m.index : n);
      i = m ? m.index + m[0].length : n;
      continue;
    }
    const el = makeEl(name, parseAttrs(attrText));
    // implied end tags
    if (name === 'li') closeOpen(['li'], t => t === 'ul' || t === 'ol' || t === 'menu');
    else if (name === 'dt' || name === 'dd') closeOpen(['dt', 'dd'], t => t === 'dl');
    else if (name === 'tr') closeOpen(['tr'], t => t === 'table' || t === 'thead' || t === 'tbody' || t === 'tfoot');
    else if (name === 'td' || name === 'th') closeOpen(['td', 'th'], t => t === 'tr' || t === 'table');
    else if (name === 'thead' || name === 'tbody' || name === 'tfoot') closeOpen(['thead', 'tbody', 'tfoot'], t => t === 'table');
    else if (name === 'a') closeOpen(['a'], notInline);
    else if (name === 'option') closeOpen(['option'], t => t === 'select' || t === 'datalist');
    if (!INLINE.has(name) && !VOID_TAGS.has(name)) {
      closeOpen(['p'], notInline);
      if (HEADING.test(name)) closeOpen(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], notInline);
    }
    el.parent = top();
    top().children.push(el);
    if (!VOID_TAGS.has(name) && !attrText.endsWith('/') && stack.length < MAX_DEPTH) stack.push(el);
  }
  return { root, title: title ? cleanInline(decodeEntities(title)) : '' };
}

// Depth-first elements; `live` skips boilerplate subtrees.
function* walkEls(node, live = false) {
  const st = [node];
  while (st.length) {
    const el = st.pop();
    if (live && el.junk) continue;
    yield el;
    for (let i = el.children.length - 1; i >= 0; i--) if (typeof el.children[i] !== 'string') st.push(el.children[i]);
  }
}

function findFirst(node, pred, live = false) {
  for (const el of walkEls(node, live)) if (pred(el)) return el;
  return null;
}

// ================================================================ extraction

// Never page text.
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'object', 'embed',
  'select', 'option', 'optgroup', 'datalist', 'textarea', 'input', 'audio', 'video', 'picture', 'map', 'head',
  'math', 'dialog', 'meta', 'link', 'title', 'img', 'source']);
// Semantic boilerplate.
const BOILER_TAGS = new Set(['nav', 'header', 'footer', 'aside', 'menu']);
const JUNK_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog',
  'menu', 'menubar', 'toolbar']);
// Boilerplate class/id words, matched as whole words of one class name (words
// separated by - or _). STRONG ones remove the element; WEAK ones only when it
// is mostly links (a restaurant's «menu» section is content, a site menu is links).
const STRONG_JUNK = /(?:^|[-_])(?:nav|navbar|navigation|navmenu|breadcrumbs?|sidebar|widget-area|widgets|comments?|commentlist|comment-list|comment-respond|respond|disqus|share|sharing|sharedaddy|addtoany|social|socials|related|upsells|cross-sells|cookies?|cookie-notice|gdpr|consent|popup|popups|modal|newsletter|subscribe|advert|advertisement|ads|adsense|pagination|pager|author-box|author-bio|about-author|post-navigation|nav-links|footer|colophon|topbar|top-bar|toolbar|offcanvas|off-canvas|mobile-menu|skip-link|screen-reader-text|sr-only|visually-hidden|search-form|searchform|login-form|copyright|back-to-top|scroll-top|scrolltop|reviews?|entry-meta|post-meta|product_meta|slick-cloned|swiper-slide-duplicate)(?:$|[-_])/;
const WEAK_JUNK = /(?:^|[-_])(?:menu|menus|megamenu|widget|tags|tagcloud|tag-cloud|meta|links|categories|category-list)(?:$|[-_])/;
const HEADER_NAME = /^(?:(?:site|main|top|global|mobile|sticky|elementor-location)[-_]?)?header(?:[-_](?:wrap|wrapper|inner|main|top|bottom|area|container|nav))?$|^masthead$/;
// Layout modifiers («has-sidebar», «no-sidebar», «ast-right-sidebar») are not boilerplate.
const LAYOUT_NAME = /^(?:has|no|with|without|is|show|hide|enable|disable|layout|page-template|template|single|archive|ast-(?:left|right|no)-sidebar)(?:[-_]|$)/;
// Page-builder classes: only STRONG words count («elementor-widget-text-editor» is content).
const BUILDER_NAME = /^(?:elementor|e-con|jet-|et_pb|et-|vc_|wpb|wp-block|fl-|brxe|ct-|kt-|uagb|stk-)/;
// The page's own content.
const CONTENT_NAME = /^(?:entry-content|post-content|page-content|article-content|article-body|post-body|entry-body|single-content|content-body|td-post-content|post-entry|blog-content|the-content|single-post-content|post-text|story-body|news-content|product-description|woocommerce-product-details__short-description)$/;
const ELEMENTOR_CONTENT = /^(?:wp-page|wp-post|single|single-post|single-page|product|section|page)$/;
const ACCORDION_NAME = /(?:^|[-_])(?:tab-title|accordion-title|accordion-header|accordion-button|accordion-heading|toggle-title|faq-question|faq-title|question|e-n-accordion-item-title|elementor-toggle-title|panel-title|collapse-title)(?:$|[-_])/;

function classNames(el) {
  const out = el.cls ? el.cls.split(/\s+/).filter(Boolean) : [];
  if (el.id) out.push(el.id);
  return out;
}

// Elements that hold the page's own content. (<article> counts only when the
// page has a single one: comments and related posts use it too.)
function isContentMarker(el) {
  if (el.tag === 'main') return true;
  const a = el.attrs;
  if (a.role === 'main' || a.itemprop === 'articleBody' || a.itemprop === 'mainContentOfPage') return true;
  if (a['data-elementor-type'] && ELEMENTOR_CONTENT.test(a['data-elementor-type'])) return true;
  return classNames(el).some(c => CONTENT_NAME.test(c));
}

function isAccordionTitle(el) {
  if (el.tag === 'summary' || el.tag === 'dt') return true;
  return classNames(el).some(c => ACCORDION_NAME.test(c));
}

// Bottom-up: text length, link text length, link count, content-marker flag.
function measure(el) {
  if (DROP_TAGS.has(el.tag)) return el;
  let len = 0;
  let linkLen = 0;
  let links = el.tag === 'a' && el.attrs.href ? 1 : 0;
  let marker = isContentMarker(el);
  for (const c of el.children) {
    if (typeof c === 'string') {
      len += c.replace(/\s+|&nbsp;/g, '').length;
      continue;
    }
    measure(c);
    len += c.len;
    linkLen += c.linkLen;
    links += c.links;
    if (c.marker) marker = true;
  }
  el.len = len;
  el.linkLen = el.tag === 'a' && el.attrs.href ? len : linkLen;
  el.links = links;
  el.marker = marker;
  return el;
}

// Top-down boilerplate marking; `bodyLen` is the text length of the whole page.
function markJunk(el, bodyLen) {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (junkReason(c, bodyLen)) c.junk = true;
    else markJunk(c, bodyLen);
  }
}

function junkReason(el, bodyLen) {
  const tag = el.tag;
  if (DROP_TAGS.has(tag)) return 'drop';
  if (tag === 'button') return isAccordionTitle(el) ? '' : 'ui'; // FAQ toggles are sometimes buttons
  if (el.attrs.hidden !== undefined && el.len < 40) return 'hidden';
  const density = el.len ? el.linkLen / el.len : 0;
  const share = bodyLen ? el.len / bodyLen : 0;
  // Semantic boilerplate, unless it wraps the page's content (some themes put
  // <main> inside <header>; ASP.NET sites wrap the whole page in a <form>).
  if (BOILER_TAGS.has(tag) || JUNK_ROLES.has(el.attrs.role)) return el.marker && tag !== 'nav' ? '' : 'boiler';
  // Tab strips are links (WooCommerce tabs); accordions (also role=tablist) are text.
  if (el.attrs.role === 'tablist' && density > 0.5) return 'tabs';
  if (tag === 'form') return el.marker || share > 0.5 ? '' : 'form';
  const edt = el.attrs['data-elementor-type'];
  if (edt === 'header' || edt === 'footer' || edt === 'popup') return 'boiler';
  let strong = false;
  let weak = false;
  for (const c of classNames(el)) {
    if (LAYOUT_NAME.test(c)) continue;
    if (STRONG_JUNK.test(c) || HEADER_NAME.test(c)) strong = true;
    else if (!BUILDER_NAME.test(c) && WEAK_JUNK.test(c)) weak = true;
  }
  if (strong || weak) {
    if (el.marker || (share > 0.8 && density < 0.5)) return ''; // a layout wrapper around the content
    if (strong || density > 0.3 || el.len < 20) return 'hint';
  }
  // Link lists: menus, tag clouds, "more posts", product grids, tables of contents.
  if (el.links >= 4 && density > 0.7 && !el.marker && share < 0.9) return 'links';
  // A lone link: «مشاهده محصولات», «ادامه مطلب», buttons.
  if (el.links && el.len < 40 && density > 0.95 && !INLINE.has(tag) && !HEADING.test(tag) && !isAccordionTitle(el) && !el.marker) return 'cta';
  return '';
}

function cleanInline(s) {
  return s
    .replace(/[​‎‏‪-‮⁦-⁩﻿­]/g, '')
    .replace(/[\s  -   　]+/g, ' ')
    .replace(/‌{2,}/g, '‌')
    .trim();
}

// Plain text of a subtree (boilerplate excluded), blocks separated by spaces.
function textOf(el) {
  let out = '';
  const rec = node => {
    for (const c of node.children) {
      if (typeof c === 'string') out += c;
      else if (!c.junk && !DROP_TAGS.has(c.tag)) {
        const block = !INLINE.has(c.tag);
        if (block) out += ' ';
        rec(c);
        if (block) out += ' ';
      }
    }
  };
  rec(el);
  return cleanInline(decodeEntities(out));
}

const CELL_BLOCKS = new Set(['table', 'ul', 'ol', 'dl', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'form']);

// A table row of plain cells -> "cell: cell" (spec tables) or "a | b | c";
// null for layout tables (cells holding blocks).
function simpleRow(tr) {
  const cells = [];
  for (const c of tr.children) {
    if (typeof c === 'string') {
      if (c.trim()) return null;
      continue;
    }
    if (c.junk) continue;
    if (c.tag !== 'td' && c.tag !== 'th') return null;
    if (findFirst(c, x => x !== c && CELL_BLOCKS.has(x.tag))) return null;
    cells.push(textOf(c));
  }
  const filled = cells.filter(Boolean);
  if (!filled.length) return '';
  return filled.length === 2 ? `${filled[0].replace(/\s*[:：]$/, '')}: ${filled[1]}` : filled.join(' | ');
}

function isHeadingLine(l, hasMore) {
  const t = l.text;
  if (t.length > 150 || /[.!…]$/.test(t)) return false;
  if (l.strong && t.length <= 90) return true;
  // A short question: FAQ pages written as plain paragraphs.
  return /[؟?]$/.test(t) && t.length >= 6 && (hasMore || t.length <= 120);
}

// Content roots -> blocks: { h: 0 (paragraph) | 1-6 (heading level), text }.
function collectBlocks(roots) {
  const blocks = [];
  let lines = []; // current paragraph: [{ text, strong }]
  let line = '';
  let strongChars = 0;
  let bullet = false;
  let total = 0;
  const endLine = () => {
    const t = cleanInline(decodeEntities(line));
    if (t) {
      const bare = t.replace(/[\s:.،,!؟?]/g, '').length;
      lines.push({ text: t, strong: bare > 0 && strongChars >= bare * 0.9 });
    }
    line = '';
    strongChars = 0;
  };
  const push = b => {
    if (total > CRAWL.maxPageChars) return;
    total += b.text.length;
    blocks.push(b);
  };
  const flush = () => {
    endLine();
    if (!lines.length) {
      bullet = false;
      return;
    }
    let start = 0;
    // A bold-only or question first line is a heading («<p><strong>ارسال</strong><br>…»).
    if (!bullet && isHeadingLine(lines[0], lines.length > 1)) {
      push({ h: lines[0].strong ? 5 : 6, text: lines[0].text.replace(/\s*[:：]\s*$/, '') });
      start = 1;
    }
    if (start < lines.length) {
      const text = lines.slice(start).map(l => l.text).join('\n');
      push({ h: 0, text: (bullet ? '• ' : '') + text });
    }
    lines = [];
    bullet = false;
  };
  const heading = (level, el) => {
    flush();
    const t = textOf(el);
    if (t) push({ h: level, text: t.slice(0, 300) });
  };
  const walk = (node, strong) => {
    for (const c of node.children) {
      if (typeof c === 'string') {
        line += c;
        if (strong) strongChars += c.replace(/[\s:.،,!؟?]|&nbsp;/g, '').length;
        continue;
      }
      if (c.junk || DROP_TAGS.has(c.tag)) continue;
      const tag = c.tag;
      if (tag === 'br') {
        endLine();
      } else if (HEADING.test(tag)) {
        heading(Number(tag[1]), c);
      } else if (isAccordionTitle(c) && c.len > 0 && c.len <= 250) {
        heading(4, c);
      } else if (tag === 'tr' && simpleRow(c) !== null) {
        flush();
        const row = simpleRow(c);
        if (row) push({ h: 0, text: row });
      } else if (tag === 'li' || tag === 'dd') {
        flush();
        bullet = tag === 'li';
        walk(c, strong);
        flush();
      } else if (INLINE.has(tag)) {
        walk(c, strong || tag === 'strong' || tag === 'b');
      } else if (tag === 'td' || tag === 'th') {
        line += ' ';
        walk(c, strong);
        line += ' ';
      } else {
        flush();
        walk(c, strong);
        flush();
      }
    }
  };
  for (const r of roots) {
    walk(r, false);
    flush();
  }
  return blocks;
}

function metaContent(root, pred) {
  const el = findFirst(root, x => x.tag === 'meta' && pred(x.attrs));
  return el ? cleanInline(el.attrs.content || '') : '';
}

// Text length of a subtree without its boilerplate.
function liveLength(el) {
  if (el.junk) return 0;
  let n = 0;
  for (const c of el.children) {
    if (typeof c === 'string') n += c.replace(/\s+/g, '').length;
    else if (!c.junk && !DROP_TAGS.has(c.tag)) n += liveLength(c);
  }
  return n;
}

function outermost(node, pred) {
  const out = [];
  const rec = el => {
    for (const c of el.children) {
      if (typeof c === 'string' || c.junk) continue;
      if (pred(c)) out.push(c);
      else rec(c);
    }
  };
  rec(node);
  return out;
}

const TITLE_SEP = /\s+[|\-–—:«»•·~]\s+/;
function stripSiteName(title, siteName) {
  const t = cleanInline(title || '');
  if (!siteName || !t.includes(siteName) || t === siteName) return t;
  const parts = t.split(TITLE_SEP).filter(p => p.trim() && p.trim() !== siteName);
  return parts.length ? parts.join(' - ') : t;
}

// HTML -> { title, blocks, listing, links, base, canonical, noindex, nofollow }
function extractPage(html, pageUrl) {
  const { root, title: docTitle } = parseHtml(String(html || ''));
  const body = findFirst(root, el => el.tag === 'body') || root;

  const robotsMeta = metaContent(root, a => /^(robots|pasokhyar|faqimporter)$/i.test(a.name || '')).toLowerCase();
  const canonEl = findFirst(root, el => el.tag === 'link' && /(^|\s)canonical(\s|$)/i.test(el.attrs.rel || '') && el.attrs.href);
  const baseEl = findFirst(root, el => el.tag === 'base' && el.attrs.href);
  const baseUrl = baseEl && normalizeUrl(baseEl.attrs.href, pageUrl);
  const siteName = metaContent(root, a => a.property === 'og:site_name');
  const ogTitle = metaContent(root, a => a.property === 'og:title');

  // Links from the whole page (menus and footers are how pages are found).
  const links = [];
  for (const el of walkEls(root)) {
    if ((el.tag === 'a' || el.tag === 'area') && el.attrs.href && !/(^|\s)nofollow(\s|$)/i.test(el.attrs.rel || '')) {
      if (links.length < 2000) links.push(el.attrs.href);
    }
  }

  measure(body);
  const articles = outermost(body, el => el.tag === 'article');
  if (articles.length === 1) for (let p = articles[0]; p && !p.marker; p = p.parent) p.marker = true;
  markJunk(body, body.len);

  // Main content: the biggest <main>-like container if it holds a fair share
  // of the text, then the content bodies inside it when they cover most of it.
  let main = body;
  let best = null;
  for (const el of walkEls(body, true)) {
    if (el === body) continue;
    if (el.tag === 'main' || el.attrs.role === 'main' || /^(main|content|primary|main-content|maincontent|site-content)$/.test(el.id) ||
      classNames(el).some(c => /^(site-main|main-content|content-area|site-content)$/.test(c))) {
      if (!best || el.len > best.len) best = el;
    }
  }
  if (best && liveLength(best) >= liveLength(body) * 0.25) main = best;
  const mainLen = liveLength(main);
  let roots = [main];
  // Product pages: title, price and summary sit outside .entry-content.
  const isProduct = !!findFirst(main, el => classNames(el).some(c => c === 'entry-summary' || c === 'product_title'), true);
  if (!isProduct) {
    const bodies = outermost(main, el => classNames(el).some(c => CONTENT_NAME.test(c)) || el.attrs.itemprop === 'articleBody' ||
      (!!el.attrs['data-elementor-type'] && ELEMENTOR_CONTENT.test(el.attrs['data-elementor-type'])));
    const bodiesLen = bodies.reduce((s, el) => s + liveLength(el), 0);
    if (bodies.length && bodiesLen >= mainLen * 0.5) roots = bodies;
    else {
      const articles = outermost(main, el => el.tag === 'article');
      if (articles.length === 1 && liveLength(articles[0]) >= mainLen * 0.5) roots = articles;
    }
  }

  // Title: the page's own <h1> (not a logo), else og:title / <title> without the site name.
  const h1 = findFirst(main, el => el.tag === 'h1', true) ||
    findFirst(body, el => el.tag === 'h1' && !classNames(el).some(c => /site-title|logo|brand/.test(c)) && !insideTag(el, 'nav'));
  let title = h1 ? textOf(h1) : '';
  if (title.length < 2) title = stripSiteName(ogTitle || docTitle, siteName);

  // Archives (blog index, categories, tags, search, shop) only repeat excerpts
  // of other pages: follow their links, don't learn their text.
  const listing = /(?:^|\s)(?:blog|archive|category|tag|author|search|search-results|date|post-type-archive(?:-[\w-]+)?|tax-[\w-]+)(?:\s|$)/.test(body.cls) && !/(?:^|\s)single(?:\s|$)/.test(body.cls) ||
    outermost(main, el => el.tag === 'article').length >= 3;
  return {
    title: title.slice(0, 200),
    blocks: collectBlocks(roots),
    listing,
    links,
    base: baseUrl ? baseUrl.href : pageUrl,
    canonical: canonEl ? canonEl.attrs.href : '',
    noindex: /noindex|none/.test(robotsMeta),
    nofollow: /nofollow|none/.test(robotsMeta),
  };
}

function insideTag(el, tag) {
  for (let p = el.parent; p; p = p.parent) if (p.tag === tag) return true;
  return false;
}

// Titles from <title> usually carry the site name: drop an affix most pages share.
function cleanTitles(pages) {
  if (pages.length < 3) return;
  const head = new Map();
  const tail = new Map();
  for (const p of pages) {
    const parts = p.title.split(TITLE_SEP);
    if (parts.length < 2) continue;
    head.set(parts[0], (head.get(parts[0]) || 0) + 1);
    tail.set(parts[parts.length - 1], (tail.get(parts[parts.length - 1]) || 0) + 1);
  }
  const min = Math.max(3, pages.length * 0.5);
  const commonTail = new Set([...tail].filter(([, c]) => c >= min).map(([k]) => k));
  const commonHead = new Set([...head].filter(([, c]) => c >= min).map(([k]) => k));
  for (const p of pages) {
    let parts = p.title.split(TITLE_SEP);
    if (parts.length < 2) continue;
    if (commonTail.has(parts[parts.length - 1])) parts = parts.slice(0, -1);
    if (parts.length > 1 && commonHead.has(parts[0])) parts = parts.slice(1);
    p.title = parts.join(' - ');
  }
}

// ================================================================ passages

// Sentences: split after . ! ? ؟ … followed by a space, and at line breaks.
function splitSentences(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+/)) {
    for (const s of line.split(/(?<=[.!?؟…])\s+/)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

// Break an over-long piece at clause punctuation, else at a space.
function splitHard(s, max) {
  const out = [];
  let rest = s;
  while (rest.length > max) {
    const win = rest.slice(0, max);
    let cut = Math.max(win.lastIndexOf('، '), win.lastIndexOf(', '), win.lastIndexOf('؛ '), win.lastIndexOf('; '), win.lastIndexOf(': '));
    if (cut < max * 0.4) cut = win.lastIndexOf(' ');
    if (cut < max * 0.4) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function splitLong(p, max) {
  const out = [];
  let cur = '';
  for (const s of splitSentences(p)) {
    for (const piece of s.length > max ? splitHard(s, max) : [s]) {
      if (cur && cur.length + 1 + piece.length > max) {
        out.push(cur);
        cur = piece;
      } else cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Blocks -> [{ heading, text }], ~min..max characters, never across a heading.
function chunkBlocks(blocks, { min = CHUNK.min, max = CHUNK.max } = {}) {
  const out = [];
  let heading = '';
  let paras = [];
  const flush = () => {
    if (!paras.length) return;
    const pieces = [];
    for (const p of paras) {
      if (p.length <= max) pieces.push(p);
      else pieces.push(...splitLong(p, max));
    }
    const chunks = [];
    let cur = '';
    for (const piece of pieces) {
      const joined = cur ? cur.length + 1 + piece.length : piece.length;
      // over max: start a new chunk, unless the current one is still small
      if (cur && joined > max && !(cur.length < min && joined <= max + 150)) {
        chunks.push(cur);
        cur = piece;
      } else cur = cur ? `${cur}\n${piece}` : piece;
    }
    if (cur) {
      const last = chunks[chunks.length - 1];
      if (last && cur.length < min && last.length + 1 + cur.length <= max + 150) chunks[chunks.length - 1] = `${last}\n${cur}`;
      else chunks.push(cur);
    }
    for (const text of chunks) out.push({ heading, text });
    paras = [];
  };
  for (const b of blocks) {
    if (b.h) {
      flush();
      heading = b.text.slice(0, 200);
    } else if (b.text) paras.push(b.text);
  }
  flush();
  return out;
}

// Crawled pages -> [{ url, title, heading, text }] for the passages table.
function buildPassages(pages, { maxPassages = CRAWL.maxPassagesPerSource } = {}) {
  cleanTitles(pages);
  // On how many pages each paragraph appears (site-wide banners, template text).
  const freq = new Map();
  for (const p of pages) {
    const here = new Set();
    for (const b of p.blocks) {
      if (b.h) continue;
      const k = normalize(b.text);
      if (k && !here.has(k)) {
        here.add(k);
        freq.set(k, (freq.get(k) || 0) + 1);
      }
    }
  }
  const chrome = Math.max(4, Math.ceil(pages.length * 0.4));
  const firstPage = new Map();
  const seen = new Set();
  const out = [];
  for (let pi = 0; pi < pages.length && out.length < maxPassages; pi++) {
    const p = pages[pi];
    const kept = [];
    for (const b of p.blocks) {
      if (b.h) {
        kept.push(b);
        continue;
      }
      const k = normalize(b.text);
      if (!k) continue;
      const f = freq.get(k) || 0;
      if (f >= 2) {
        if (f >= chrome && k.length < 60) continue; // template chrome («افزودن به سبد», «۰ دیدگاه»)
        const first = firstPage.get(k);
        if (first === undefined) firstPage.set(k, pi);
        else if (first !== pi && (k.length >= 25 || f >= 3)) continue; // keep the first copy only
      }
      kept.push(b);
    }
    let n = 0;
    for (const c of chunkBlocks(kept)) {
      if (c.text.replace(/\s/g, '').length < 2) continue;
      const key = `${normalize(c.heading)}|${normalize(c.text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: p.url, title: p.title, heading: c.heading, text: c.text });
      if (++n >= CRAWL.maxPassagesPerPage || out.length >= maxPassages) break;
    }
  }
  return out;
}

// ================================================================ crawl

async function loadRobots(start, fetchFn) {
  try {
    const txt = await withTimeout(Promise.resolve(fetchFn(`${start.protocol}//${start.host}/robots.txt`, 'robots')), 15_000);
    return parseRobots(String(txt || '').slice(0, 300_000));
  } catch {
    return parseRobots(''); // no robots.txt: everything allowed
  }
}

async function loadSitemapUrls(start, robots, fetchFn, sameSite, until, stop) {
  const origin = `${start.protocol}//${start.host}`;
  const out = [];
  const done = new Set();
  let fetched = 0;
  const run = async list => {
    let found = false;
    while (list.length && fetched < CRAWL.maxSitemaps && Date.now() < until && !stop()) {
      const { u, guess } = list.shift();
      if (guess && found) break; // one guessed location that works is enough
      if (done.has(u.href)) continue;
      done.add(u.href);
      fetched++;
      let xml;
      try {
        xml = await withTimeout(Promise.resolve(fetchFn(u.href, 'sitemap')), CRAWL.fetchTimeoutMs);
      } catch {
        continue;
      }
      const sm = parseSitemap(xml);
      if (!sm.urls.length && !sm.sitemaps.length) continue;
      found = true;
      const kind = sitemapKind(u);
      for (const loc of sm.urls) {
        if (out.length >= CRAWL.maxSitemapUrls) break;
        out.push({ loc, kind });
      }
      const children = sm.sitemaps.map(s => normalizeUrl(s, origin))
        .filter(c => c && sameSite(c) && !JUNK_SITEMAP.test(safeDecode(c.pathname)))
        .sort((a, b) => SITEMAP_RANK[sitemapKind(a)] - SITEMAP_RANK[sitemapKind(b)]);
      list.unshift(...children.map(c => ({ u: c, guess: false })));
    }
    return found;
  };
  const listed = robots.sitemaps.map(s => normalizeUrl(s, origin)).filter(u => u && sameSite(u)).map(u => ({ u, guess: false }));
  const ok = listed.length ? await run(listed) : false;
  if (!ok) await run(['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'].map(p => ({ u: new URL(p, origin), guess: true })));
  return out;
}

// Crawls one site: { pages: [{ url, title, blocks }], error, stats }.
async function crawlSite(startUrl, opts = {}) {
  const fetchFn = opts.fetch || defaultFetch;
  const maxPages = Math.max(1, Math.floor(opts.maxPages) || 20);
  const stop = opts.stop || (() => false);
  const progress = opts.onProgress || (() => {});
  const timeCap = opts.timeCapMs || Math.min(CRAWL.timeCapMaxMs, Math.max(CRAWL.timeCapMs, maxPages * 1000));
  const deadline = Date.now() + timeCap;
  const stats = { fetched: 0, failed: 0, robots: 0, skipped: 0 };
  const start = normalizeUrl(startUrl);
  if (!start) return { pages: [], error: new Error('bad_url'), stats };
  const site = siteOf(start.hostname);
  const sameSite = u => siteOf(u.hostname) === site;
  const https = start.protocol === 'https:';

  const robots = await loadRobots(start, fetchFn);
  const conc = robots.delay ? 1 : CRAWL.concurrency;
  const delay = robots.delay ? Math.min(CRAWL.maxCrawlDelayMs, Math.max(CRAWL.delayMs, robots.delay * 1000)) : CRAWL.delayMs;

  const seen = new Set();
  const frontier = new Frontier();
  const enqueue = (u, hops, from) => {
    if (!u || !sameSite(u) || isJunkUrl(u)) return;
    if (https && u.protocol === 'http:') { // the site speaks https: no mixed links
      u.protocol = 'https:';
      if (u.port === '80') u.port = '';
    }
    const key = urlKey(u);
    if (seen.has(key) || seen.size >= CRAWL.maxFrontier) return;
    seen.add(key);
    if (!robotsAllows(robots, u)) {
      stats.robots++;
      return;
    }
    frontier.push(u, urlPriority(u, hops, from), hops);
  };
  enqueue(start, 0, 'start');
  for (const { loc, kind } of await loadSitemapUrls(start, robots, fetchFn, sameSite, deadline, stop)) {
    enqueue(normalizeUrl(loc, start), 1, kind);
  }
  if (!frontier.size) return { pages: [], error: new Error(stats.robots ? 'robots' : 'bad_url'), stats };

  const pages = [];
  const indexed = new Set(); // url keys (incl. canonical ones) whose content we have
  const hashes = new Set();
  let siteNoindex = null;
  let firstError = null;
  let inFlight = 0;
  let attempts = 0;
  const maxAttempts = maxPages * 3 + 10;

  const handle = (item, html) => {
    const page = extractPage(html, item.u.href);
    if (!page.nofollow) {
      for (const href of page.links) enqueue(normalizeUrl(href, page.base), item.hops + 1, 'link');
    }
    // A site that marks every page noindex (WordPress's «discourage search
    // engines» left on) still wants its bot to learn.
    if (siteNoindex === null) siteNoindex = page.noindex;
    if ((page.noindex && !siteNoindex) || page.listing) return void stats.skipped++;
    let url = item.u;
    const ownKey = urlKey(url);
    if (page.canonical) {
      const cu = normalizeUrl(page.canonical, item.u.href);
      if (cu && !sameSite(cu)) return void stats.skipped++; // redirected to / copied from another site
      if (cu && !isJunkUrl(cu)) {
        const ck = urlKey(cu);
        if (ck !== ownKey) {
          if (indexed.has(ck)) return void stats.skipped++;
          seen.add(ck);
          indexed.add(ck);
          url = cu;
        }
      }
    }
    const text = page.blocks.map(b => b.text).join('\n');
    if (text.replace(/\s/g, '').length < 40) return void stats.skipped++;
    const hash = normalize(text.slice(0, 20_000));
    if (hashes.has(hash)) return void stats.skipped++;
    hashes.add(hash);
    indexed.add(ownKey);
    if (pages.length < maxPages) pages.push({ url: url.href, title: page.title || safeDecode(url.pathname), blocks: page.blocks });
  };

  const worker = async () => {
    for (;;) {
      if (pages.length >= maxPages || stop() || Date.now() > deadline || attempts >= maxAttempts) return;
      const item = frontier.pop();
      if (!item) {
        if (inFlight === 0) return;
        await sleep(100);
        continue;
      }
      attempts++;
      inFlight++;
      let html = null;
      try {
        html = await withTimeout(Promise.resolve(fetchFn(item.u.href, 'page')), CRAWL.fetchTimeoutMs);
        stats.fetched++;
      } catch (e) {
        stats.failed++;
        if (!firstError) firstError = e;
      } finally {
        inFlight--;
      }
      if (html !== null && !stop()) {
        try {
          handle(item, String(html));
        } catch {
          stats.failed++;
        }
      }
      progress(pages.length, stats);
      if (delay) await sleep(delay);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  const error = pages.length ? null : (stop() ? new Error('stopped') : firstError && !stats.fetched ? firstError : new Error('empty'));
  return { pages, error, stats };
}

// ================================================================ sources (DB)

// Crawls of this process: sourceId -> { botId, runningSince, reserved, pages, stopped, promise }.
// The app runs as one process (like util.rateLimiter), so a 'crawling' row
// that is not in this map was interrupted by a restart.
const active = new Map();
let running = 0;
const waiting = [];

async function acquireSlot() {
  while (running >= CRAWL.maxActive) await new Promise(resolve => waiting.push(resolve));
  running++;
}
function releaseSlot() {
  running--;
  const next = waiting.shift();
  if (next) next();
}

const ERRORS = {
  bad_url: 'آدرس سایت معتبر نیست. آدرس کامل را مثل https://example.ir وارد کنید.',
  blocked_address: 'این آدرس قابل دسترسی نیست.',
  timeout: 'سایت دیر جواب داد. کمی بعد دوباره امتحان کنید.',
  not_html: 'این آدرس یک صفحه‌ی وب نیست.',
  too_large: 'صفحه‌های سایت خیلی بزرگ هستند.',
  too_many_redirects: 'سایت مدام به آدرس دیگری منتقل می‌شود. آدرس نهایی سایت را وارد کنید.',
  robots: 'فایل robots.txt سایت اجازه‌ی خواندن صفحه‌ها را نمی‌دهد.',
  empty: 'در صفحه‌های سایت متن قابل استفاده‌ای پیدا نشد. اگر سایت فقط با جاوااسکریپت ساخته شده، متنش بدون مرورگر دیده نمی‌شود.',
  http_401: 'سایت رمز عبور می‌خواهد (خطای ۴۰۱).',
  http_403: 'سایت اجازه‌ی دسترسی نداد (خطای ۴۰۳). اگر فایروال یا سرویس ضدربات دارید، دسترسی را باز کنید.',
  http_404: 'صفحه پیدا نشد (خطای ۴۰۴). آدرس را بررسی کنید.',
  http_429: 'سایت تعداد درخواست‌ها را محدود کرده است. کمی بعد دوباره امتحان کنید.',
  http_5xx: 'سرور سایت خطا داد. کمی بعد دوباره امتحان کنید.',
  ENOTFOUND: 'دامنه پیدا نشد. آدرس را بررسی کنید.',
  EAI_AGAIN: 'دامنه پیدا نشد. آدرس را بررسی کنید.',
  connect: 'اتصال به سایت برقرار نشد. مطمئن شوید سایت باز می‌شود.',
  ssl: 'گواهی امنیتی (SSL) سایت معتبر نیست. آدرس را با http:// امتحان کنید.',
  interrupted: 'خواندن سایت نیمه‌کاره ماند (سرور دوباره راه‌اندازی شد). «خواندن دوباره» را بزنید.',
  stopped: 'خواندن سایت متوقف شد.',
  page_limit: 'به سقف صفحه‌های پلن‌تان رسیده‌اید.',
  too_many_sources: 'تعداد سایت‌های این بات به سقف رسیده است.',
};

function friendlyError(e) {
  const code = String((e && (e.code || e.message)) || '');
  if (ERRORS[code]) return ERRORS[code];
  if (/^http_5\d\d$/.test(code)) return ERRORS.http_5xx;
  if (/^http_\d+$/.test(code)) return `سایت خطای ${code.slice(5).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d])} داد.`;
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return ERRORS.ssl;
  if (/ECONN|EHOST|ENETUNREACH|EPIPE|socket hang up/i.test(code)) return ERRORS.connect;
  return 'خواندن سایت انجام نشد. آدرس را بررسی کنید و دوباره امتحان کنید.';
}

function codeError(code) {
  const e = new Error(code);
  e.code = code;
  e.friendly = ERRORS[code];
  return e;
}

// Accepts «example.ir», «www.example.ir/about», full URLs.
function cleanStartUrl(raw) {
  let s = String(raw || '').trim();
  if (!s || s.length > 2000) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d/.test(s)) return null; // another scheme
    s = `https://${s.replace(/^\/+/, '')}`;
  }
  const u = normalizeUrl(s);
  if (!u || !/\./.test(u.hostname) || u.hostname.length > 253) return null;
  return u;
}

function getSource(botId, sourceId) {
  return db.get().prepare('SELECT * FROM sources WHERE id = ? AND bot_id = ?').get(Number(sourceId), botId) || null;
}

// Pages this bot may still learn: its owner's plan minus its other sources.
function pageBudget(bot, excludeSourceId = 0) {
  const owner = db.get().prepare('SELECT * FROM users WHERE id = ?').get(bot.user_id);
  const plan = effectivePlan(owner);
  let used = 0;
  for (const s of db.get().prepare('SELECT id, pages FROM sources WHERE bot_id = ? AND id != ?').all(bot.id, excludeSourceId)) {
    const a = active.get(s.id);
    used += a ? Math.max(a.reserved, s.pages) : s.pages;
  }
  return { limit: plan.pages, used, left: Math.max(0, plan.pages - used) };
}

function launch(bot, source, maxPages, testFetch) {
  const entry = { botId: bot.id, runningSince: 0, reserved: maxPages, pages: 0, stopped: false, promise: null };
  active.set(source.id, entry);
  entry.promise = runCrawl(bot, source, maxPages, entry, testFetch)
    .catch(e => {
      console.error('knowledge: crawl failed', e);
      try {
        db.get().prepare(`UPDATE sources SET status = 'error', error = ? WHERE id = ? AND status = 'crawling'`).run(friendlyError(e), source.id);
      } catch { /* database gone (tests) */ }
    })
    .finally(() => {
      if (active.get(source.id) === entry) active.delete(source.id);
    });
}

async function runCrawl(bot, source, maxPages, entry, testFetch) {
  await acquireSlot();
  let result;
  try {
    entry.runningSince = Date.now();
    result = await crawlSite(source.url, {
      maxPages,
      fetch: testFetch,
      stop: () => entry.stopped,
      onProgress: n => { entry.pages = n; },
    });
  } catch (e) {
    result = { pages: [], error: e };
  } finally {
    releaseSlot();
  }
  if (entry.stopped) return;
  const conn = db.get();
  if (!result.pages.length) {
    // Keep what an earlier crawl learned; only report the failure.
    conn.prepare(`UPDATE sources SET status = 'error', error = ? WHERE id = ? AND bot_id = ?`)
      .run(friendlyError(result.error), source.id, bot.id);
    return;
  }
  const passages = buildPassages(result.pages, { maxPassages: Math.min(CRAWL.maxPassagesPerSource, maxPages * CRAWL.maxPassagesPerPage) });
  const now = Date.now();
  conn.transaction(() => {
    if (!getSource(bot.id, source.id)) return; // deleted meanwhile
    conn.prepare('DELETE FROM passages WHERE source_id = ?').run(source.id);
    const ins = conn.prepare('INSERT INTO passages (bot_id, source_id, url, title, heading, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const p of passages) ins.run(bot.id, source.id, p.url, p.title, p.heading, p.text, now);
    conn.prepare(`UPDATE sources SET status = 'ready', pages = ?, error = '', crawled_at = ? WHERE id = ?`)
      .run(result.pages.length, now, source.id);
  })();
  invalidate(bot.id);
  // Build the search index now rather than inside a visitor's request.
  setImmediate(() => {
    try { loadIndex(bot.id); } catch { /* built lazily on the next search */ }
  });
}

// Starts learning a site; returns the source row (status 'crawling'). The same
// site added again is re-crawled. Throws an Error with .code 'bad_url' |
// 'page_limit' | 'too_many_sources' and a Persian .friendly message.
// opts.maxPages caps the pages (the owner's plan always applies too).
// opts.fetchForTestsOnly(url, kind) -> Promise<string> replaces the network.
// TESTS ONLY: it bypasses the SSRF guard, never pass user input to it.
function startCrawl(bot, url, opts = {}) {
  const u = cleanStartUrl(url);
  if (!u) throw codeError('bad_url');
  const conn = db.get();
  const existing = conn.prepare('SELECT * FROM sources WHERE bot_id = ?').all(bot.id)
    .find(s => { const su = normalizeUrl(s.url); return su && urlKey(su) === urlKey(u); });
  if (existing) return recrawl(bot, existing.id, opts);
  if (conn.prepare('SELECT COUNT(*) AS n FROM sources WHERE bot_id = ?').get(bot.id).n >= CRAWL.maxSourcesPerBot) {
    throw codeError('too_many_sources');
  }
  const maxPages = Math.min(pageBudget(bot).left, opts.maxPages > 0 ? opts.maxPages : Infinity);
  if (maxPages <= 0) throw codeError('page_limit');
  const info = conn.prepare(`INSERT INTO sources (bot_id, url, status, pages, error, created_at) VALUES (?, ?, 'crawling', 0, '', ?)`)
    .run(bot.id, u.href, Date.now());
  const source = getSource(bot.id, Number(info.lastInsertRowid));
  launch(bot, source, maxPages, opts.fetchForTestsOnly);
  return source;
}

// Re-reads a source's site (returns the row, or null if it isn't this bot's).
function recrawl(bot, sourceId, opts = {}) {
  const source = getSource(bot.id, sourceId);
  if (!source) return null;
  if (active.has(source.id)) return source;
  const maxPages = Math.min(pageBudget(bot, source.id).left, opts.maxPages > 0 ? opts.maxPages : Infinity);
  if (maxPages <= 0) throw codeError('page_limit');
  db.get().prepare(`UPDATE sources SET status = 'crawling', error = '' WHERE id = ?`).run(source.id);
  launch(bot, source, maxPages, opts.fetchForTestsOnly);
  return getSource(bot.id, source.id);
}

function deleteSource(bot, sourceId) {
  const id = Number(sourceId);
  const a = active.get(id);
  if (a && a.botId === bot.id) {
    a.stopped = true;
    active.delete(id);
  }
  const conn = db.get();
  conn.transaction(() => {
    conn.prepare('DELETE FROM passages WHERE source_id = ? AND bot_id = ?').run(id, bot.id);
    conn.prepare('DELETE FROM sources WHERE id = ? AND bot_id = ?').run(id, bot.id);
  })();
  invalidate(bot.id);
}

// The bot's sources; a crawling row also gets `progress` (pages read so far).
// Crawls interrupted by a restart, or running past CRAWL.staleMs, become
// restartable errors.
function listSources(botId) {
  const conn = db.get();
  const rows = conn.prepare('SELECT * FROM sources WHERE bot_id = ? ORDER BY id').all(botId);
  for (const r of rows) {
    if (r.status !== 'crawling' && r.status !== 'pending') continue;
    const a = active.get(r.id);
    if (a && (!a.runningSince || Date.now() - a.runningSince < CRAWL.staleMs)) {
      r.progress = a.pages;
      continue;
    }
    if (a) a.stopped = true;
    active.delete(r.id);
    r.status = 'error';
    r.error = ERRORS.interrupted;
    conn.prepare(`UPDATE sources SET status = 'error', error = ? WHERE id = ? AND status IN ('crawling', 'pending')`).run(r.error, r.id);
  }
  return rows;
}

// ================================================================ search index

const P = {
  W_TITLE: 1.2, // BM25F field weights (candidate ranking)
  W_HEAD: 2.5,
  W_BODY: 1,
  B: 0.5, // body length normalization
  K: 1.2, // term-frequency saturation
  SYN: 0.9, // credit for a synonym-group match
  PART_HI: 0.7, // query word vs a passage phrase containing it
  PART_LO: 0.5, // query phrase vs a passage word (half of it)
  FUZZ_MIN: 0.72, // minimum similarity of a near-spelling
  OOV_IDF: 0.8, // weight of a query word the site never uses
  IDF_FLOOR: 0.1,
  TITLE_F: 0.8, // credit of a query word found only in the page title
  BODY_F: 0.7, // ...only in the passage, outside the best sentence window
  HB: 0.75, // score *= HB + (1-HB) * heading alignment
  UMPOW: 0.6, // score *= (1 - unmatched)^UMPOW
  QEXP: 1.1, // score = coverage^QEXP * ...
  MASS0: 0.45, // query information needed for full confidence
  TOPK: 40, // candidates scored exactly
  MAX_BODY_TOKENS: 400,
};

// Question frames («قبول میکنید؟», «انجام میدید؟») and words for the business
// itself («آدرس فروشگاه», «ساعت کاری کلینیک») say little about which passage
// answers; the FAQ engine's lexicon doesn't list them because FAQ questions
// rarely contain them.
const LOCAL_PRIOR = new Map();
for (const [w, words] of [
  [0.3, 'قبول انجام ارائه موجود'],
  [0.4, 'فروشگاه سایت وبسایت شرکت کلینیک مطب مجموعه موسسه آموزشگاه دفتر'],
]) {
  for (const word of words.split(' ')) for (const t of A.analyze(word)) LOCAL_PRIOR.set(t, w);
}

// How informative a term is, before IDF. A phrase is as informative as its
// most informative part («قبول_کرد» = «قبول»).
function prior(t) {
  const local = LOCAL_PRIOR.get(t);
  if (local !== undefined) return local;
  const parts = A.phraseParts(t);
  if (!parts) return A.prior(t);
  return Math.min(A.prior(t), Math.max(...parts.map(p => (LOCAL_PRIOR.has(p) ? LOCAL_PRIOR.get(p) : A.prior(p)))));
}

const indexCache = new Map(); // botId -> { sig, index }, LRU
const INDEX_CACHE_MAX = 60;
const INDEX_REF = Symbol('knowledgeIndex');

function invalidate(botId) {
  indexCache.delete(botId);
}

// Any passage write changes the count or the max id, so a cached index can
// never be stale, whoever changed the table.
function signature(botId) {
  const r = db.get().prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM passages WHERE bot_id = ?').get(botId);
  return { n: r.n, key: `${r.n}:${r.m}` };
}

function loadIndex(botId) {
  const sig = signature(botId);
  if (!sig.n) {
    indexCache.delete(botId);
    return null;
  }
  const hit = indexCache.get(botId);
  if (hit && hit.sig === sig.key) {
    indexCache.delete(botId);
    indexCache.set(botId, hit);
    return hit.index;
  }
  const rows = db.get().prepare('SELECT id, url, title, heading, text FROM passages WHERE bot_id = ? ORDER BY id').all(botId);
  const index = buildIndex(rows);
  indexCache.set(botId, { sig: sig.key, index });
  while (indexCache.size > INDEX_CACHE_MAX) indexCache.delete(indexCache.keys().next().value);
  return index;
}

// Keys of a text: its terms, the parts of phrase terms («ثبت_نام» -> ثبت, نام)
// and its synonym groups ('~price'). Map key -> tf.
function keysOf(tokens, ctx, out = new Map()) {
  const add = k => out.set(k, (out.get(k) || 0) + 1);
  for (const t of A.contentTerms(tokens, ctx)) {
    add(t);
    const parts = A.phraseParts(t);
    if (parts) for (const p of parts) add(p);
    const groups = A.TERM_GROUPS.get(t);
    if (groups) for (const [g, w] of groups) if (w >= 0.7) add('~' + g);
  }
  return out;
}

function buildIndex(rows) {
  const n = rows.length;
  const rawVocab = new Set();
  const toks = new Array(n);
  const titleToks = new Map();
  for (let d = 0; d < n; d++) {
    const r = rows[d];
    let tt = titleToks.get(r.title);
    if (!tt) titleToks.set(r.title, (tt = normalizeTokens(r.title)));
    const h = normalizeTokens(r.heading);
    let b = normalizeTokens(r.text);
    if (b.length > P.MAX_BODY_TOKENS) b = b.slice(0, P.MAX_BODY_TOKENS);
    toks[d] = { h, b, tt };
    for (const x of tt) rawVocab.add(x);
    for (const x of h) rawVocab.add(x);
    for (const x of b) rawVocab.add(x);
  }
  const ctx = A.createContext(rawVocab);

  const post = new Map(); // key -> { d, t, h, b } (arrays)
  const titleKeys = new Map();
  const lenB = new Float64Array(n);
  let sumB = 0;
  const vocabTerms = new Set(); // single-word terms, for typo matching
  const compPhrases = new Map(); // component -> phrase terms containing it
  for (let d = 0; d < n; d++) {
    let tk = titleKeys.get(rows[d].title);
    if (!tk) titleKeys.set(rows[d].title, (tk = keysOf(toks[d].tt, ctx)));
    const hk = keysOf(toks[d].h, ctx);
    const bk = keysOf(toks[d].b, ctx);
    let blen = 0;
    for (const [k, c] of bk) if (k[0] !== '~') blen += c;
    lenB[d] = blen;
    sumB += blen;
    for (const k of new Set([...tk.keys(), ...hk.keys(), ...bk.keys()])) {
      let p = post.get(k);
      if (!p) post.set(k, (p = { d: [], t: [], h: [], b: [] }));
      p.d.push(d);
      p.t.push(tk.get(k) || 0);
      p.h.push(hk.get(k) || 0);
      p.b.push(bk.get(k) || 0);
      if (k[0] === '~') continue;
      if (k.includes('_')) {
        for (const part of A.phraseParts(k)) {
          let l = compPhrases.get(part);
          if (!l) compPhrases.set(part, (l = new Set()));
          l.add(k);
        }
      } else vocabTerms.add(k);
    }
  }
  const avgB = sumB / (n || 1) || 1;
  const lnorm = new Float64Array(n);
  for (let d = 0; d < n; d++) lnorm[d] = 1 / (1 - P.B + (P.B * lenB[d]) / avgB);
  const postings = new Map();
  for (const [k, p] of post) {
    postings.set(k, { d: Int32Array.from(p.d), t: Float32Array.from(p.t), h: Float32Array.from(p.h), b: Float32Array.from(p.b) });
  }
  A.sealContext(ctx);

  // Typo lookup: character trigram -> vocabulary terms.
  const grams = new Map();
  const fuzzyList = [];
  for (const term of vocabTerms) {
    if (term.length < 3 || /^[\da-z]+$/.test(term)) continue;
    const id = fuzzyList.length;
    fuzzyList.push(term);
    for (const g of trigrams(term)) {
      let l = grams.get(g);
      if (!l) grams.set(g, (l = []));
      l.push(id);
    }
  }
  return {
    n, rows, ctx, postings, lnorm, compPhrases, grams, fuzzyList,
    idf1: Math.log(1 + (n - 1 + 0.5) / 1.5) || 1,
    docs: new Array(n), // lazily analysed passages (scoring, snippets)
    acc: new Float64Array(n), best: new Float64Array(n), stamp: new Int32Array(n).fill(-1),
  };
}

function trigrams(term) {
  const s = `<${term}>`;
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

// IDF normalized to [IDF_FLOOR, 1] (1 = a word in a single passage).
function idfNorm(index, df) {
  if (!df) return P.OOV_IDF;
  const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
  return Math.max(P.IDF_FLOOR, Math.min(1, idf / index.idf1));
}

function dfOf(index, k) {
  const p = index.postings.get(k);
  return p ? p.d.length : 0;
}

// Near-spellings of an unknown query word among the site's words.
function fuzzy(index, t) {
  if (t.length < 4 || /[\da-z_]/.test(t)) return [];
  const counts = new Map();
  const tg = trigrams(t);
  for (const g of tg) {
    const l = index.grams.get(g);
    if (!l || l.length > 3000) continue;
    for (const id of l) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const need = Math.max(2, Math.floor(tg.size / 3));
  const cands = [...counts].filter(([, c]) => c >= need).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const out = [];
  for (const [id] of cands) {
    const f = index.fuzzyList[id];
    const len = Math.max(t.length, f.length);
    const max = len <= 5 ? 1 : len <= 8 ? 1.6 : 2.2;
    const dist = engine._internal.editDistance(t, f, max);
    let sim = dist === Infinity ? 0 : 1 - dist / len;
    // morphology the stemmer missed: «کاربران» vs «کاربر»
    const short = t.length < f.length ? t : f;
    const long = t.length < f.length ? f : t;
    if (short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3) sim = Math.max(sim, 0.85);
    if (sim >= P.FUZZ_MIN) out.push([f, sim]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, 3);
}

// Query -> [{ term, w, keys: Map(key -> credit) }] (only keys the index has).
function analyzeQuery(index, query) {
  let tokens = normalizeTokens(String(query || '').slice(0, 500));
  if (!tokens.length) return [];
  tokens = A.fixSpacing(tokens, index.ctx);
  const out = [];
  for (const t of new Set(A.contentTerms(tokens, index.ctx))) {
    const keys = new Map();
    const put = (k, c) => {
      if (index.postings.has(k) && c > (keys.get(k) || 0)) keys.set(k, c);
    };
    const addTerm = (term, credit) => {
      put(term, credit);
      const groups = A.TERM_GROUPS.get(term);
      if (groups) for (const [g, mw] of groups) put('~' + g, credit * P.SYN * mw);
      const parts = A.phraseParts(term);
      if (parts) for (const p of parts) put(p, credit * P.PART_LO);
      const phrases = index.compPhrases.get(term);
      if (phrases) for (const ph of phrases) put(ph, credit * P.PART_HI);
    };
    addTerm(t, 1);
    let w;
    if (index.postings.has(t)) {
      w = prior(t) * idfNorm(index, dfOf(index, t));
    } else {
      w = prior(t) * P.OOV_IDF;
      // Known only through a synonym: as informative as that synonym group.
      let syn = null;
      for (const [k, c] of keys) if (k[0] === '~' && (!syn || c > syn[1])) syn = [k, c];
      if (syn) w = prior(t) * idfNorm(index, dfOf(index, syn[0]));
      else if (!A.phraseParts(t) && !keys.size) {
        const fz = fuzzy(index, t);
        if (fz.length) {
          w = Math.min(w, Math.max(prior(fz[0][0]) * idfNorm(index, dfOf(index, fz[0][0])), 0.2));
          for (const [f, sim] of fz) addTerm(f, sim);
        }
      }
    }
    out.push({ term: t, w, keys });
  }
  return out;
}

// Lazily analysed passage: key sets of heading, title, body and each sentence.
function docInfo(index, d) {
  let info = index.docs[d];
  if (info) return info;
  const r = index.rows[d];
  const set = text => new Set(keysOf(normalizeTokens(text), index.ctx).keys());
  const sentences = splitSentences(r.text).slice(0, 80).map(s => ({ text: s, keys: set(s) }));
  const body = new Set();
  for (const s of sentences) for (const k of s.keys) body.add(k);
  // What the passage is about: its heading's terms, or its title's.
  const about = [...new Set(A.contentTerms(normalizeTokens(r.heading || r.title), index.ctx))].map(h => {
    const keys = new Set([h]);
    const parts = A.phraseParts(h);
    if (parts) for (const p of parts) keys.add(p);
    const groups = A.TERM_GROUPS.get(h);
    if (groups) for (const [g] of groups) keys.add('~' + g);
    return { w: prior(h) * idfNorm(index, dfOf(index, h)), keys };
  });
  info = { head: set(r.heading), title: set(r.title), body, sentences, about };
  index.docs[d] = info;
  return info;
}

function creditIn(qt, set) {
  let c = 0;
  for (const [k, v] of qt.keys) if (v > c && set.has(k)) c = v;
  return c;
}

// Best run of 1–3 consecutive sentences for the query: { start, end, cov }.
// `fixed[i]`: credit query term i already has from the heading/title.
function bestWindow(sentences, q, fixed) {
  let best = { start: 0, end: 0, cov: -1 };
  const nq = q.length;
  const cred = sentences.map(s => q.map(qt => creditIn(qt, s.keys)));
  for (let s = 0; s < sentences.length; s++) {
    const c = new Float64Array(nq);
    for (let e = s; e < sentences.length && e < s + 3; e++) {
      let cov = 0;
      for (let i = 0; i < nq; i++) {
        if (cred[e][i] > c[i]) c[i] = cred[e][i];
        cov += q[i].w * Math.max(c[i], fixed ? fixed[i] : 0);
      }
      // more coverage wins; equal coverage: fewer sentences, then earlier
      if (cov > best.cov + 1e-9 || (cov > best.cov - 1e-9 && e - s < best.end - best.start)) best = { start: s, end: e, cov };
    }
  }
  return best;
}

// Calibrated confidence in [0,1] that passage d answers query q.
function score(index, q, mass, d, detail) {
  const info = docInfo(index, d);
  const nq = q.length;
  const fixed = new Float64Array(nq);
  for (let i = 0; i < nq; i++) fixed[i] = Math.max(creditIn(q[i], info.head), P.TITLE_F * creditIn(q[i], info.title));
  const win = bestWindow(info.sentences, q, fixed);
  let cov = 0;
  let unmatched = 0;
  for (let i = 0; i < nq; i++) {
    let inWin = 0;
    for (let e = win.start; e <= win.end && e < info.sentences.length; e++) inWin = Math.max(inWin, creditIn(q[i], info.sentences[e].keys));
    const m = Math.max(fixed[i], inWin, P.BODY_F * creditIn(q[i], info.body));
    cov += q[i].w * m;
    if (m < 0.3 && q[i].w / mass > unmatched) unmatched = q[i].w / mass;
  }
  cov /= mass;
  // Alignment: share of the heading's (or title's) information the question asks about.
  let aw = 0;
  let am = 0;
  for (const h of info.about) {
    aw += h.w;
    let c = 0;
    for (const qt of q) c = Math.max(c, creditIn(qt, h.keys));
    am += h.w * c;
  }
  const align = aw ? am / aw : 0;
  const damp = mass >= P.MASS0 ? 1 : Math.pow(mass / P.MASS0, 0.8);
  const s = Math.pow(cov, P.QEXP) * Math.pow(1 - unmatched, P.UMPOW) * (P.HB + (1 - P.HB) * align) * damp;
  if (detail) Object.assign(detail, { cov, unmatched, align, damp, window: [win.start, win.end] });
  return Math.min(1, Math.max(0, s));
}

// Top passages for a question: [{ id, url, title, heading, text, score }], score in [0,1].
function search(botId, query, { limit = 3, explain = false } = {}) {
  if (typeof query !== 'string' || !query.trim()) return [];
  const index = loadIndex(botId);
  if (!index) return [];
  const q = analyzeQuery(index, query);
  let mass = 0;
  for (const qt of q) mass += qt.w;
  if (!q.length || mass <= 0) return [];

  // 1. BM25F candidates.
  const { acc, best, stamp, lnorm } = index;
  const touched = [];
  const seen = new Uint8Array(index.n);
  for (let i = 0; i < q.length; i++) {
    const hit = [];
    for (const [k, c] of q[i].keys) {
      const p = index.postings.get(k);
      const idf = idfNorm(index, p.d.length);
      for (let j = 0; j < p.d.length; j++) {
        const d = p.d[j];
        const tf = P.W_TITLE * p.t[j] + P.W_HEAD * p.h[j] + P.W_BODY * p.b[j] * lnorm[d];
        const s = (c * idf * tf * (P.K + 1)) / (tf + P.K);
        if (stamp[d] !== i) {
          stamp[d] = i;
          best[d] = s;
          hit.push(d);
        } else if (s > best[d]) best[d] = s;
      }
    }
    const prior = prior(q[i].term);
    for (const d of hit) {
      if (!seen[d]) {
        seen[d] = 1;
        touched.push(d);
      }
      acc[d] += prior * best[d];
    }
  }
  touched.sort((a, b) => acc[b] - acc[a]);
  const cand = touched.slice(0, P.TOPK).map(d => [d, acc[d]]);
  for (const d of touched) {
    acc[d] = 0;
    stamp[d] = -1;
  }

  // 2. Calibrated confidence for the candidates.
  const results = [];
  for (const [d, bm] of cand) {
    const detail = explain ? {} : null;
    const s = score(index, q, mass, d, detail);
    if (s > 0.01) results.push({ d, s, bm, detail });
  }
  results.sort((a, b) => b.s - a.s || b.bm - a.bm);
  return results.slice(0, Math.max(0, limit | 0)).map(r => {
    const row = index.rows[r.d];
    const out = { id: row.id, url: row.url, title: row.title, heading: row.heading, text: row.text, score: Math.round(r.s * 10000) / 10000 };
    Object.defineProperty(out, INDEX_REF, { value: { index, d: r.d } }); // for snippet(); not serialized
    if (explain) out.detail = { ...r.detail, bm25: r.bm, terms: q.map(x => `${x.term}:${x.w.toFixed(2)}`) };
    return out;
  });
}

// ================================================================ snippet

function trimWords(s, maxChars) {
  if (s.length <= maxChars) return s;
  let cut = s.lastIndexOf(' ', maxChars - 1);
  if (cut < maxChars * 0.5) cut = maxChars - 1;
  return s.slice(0, cut).replace(/[\s،,؛;:\-–]+$/, '') + '…';
}

function analyzeQueryLoose(ctx, query) {
  return [...new Set(A.contentTerms(normalizeTokens(String(query || '').slice(0, 500)), ctx))].map(t => {
    const keys = new Map([[t, 1]]);
    const groups = A.TERM_GROUPS.get(t);
    if (groups) for (const [g, mw] of groups) keys.set('~' + g, P.SYN * mw);
    const parts = A.phraseParts(t);
    if (parts) for (const p of parts) keys.set(p, P.PART_LO);
    return { term: t, w: prior(t), keys };
  });
}

// The 1–3 consecutive sentences of a passage that best answer the query, at
// most maxChars (cut on a word boundary, with «…»).
function snippet(passage, query, maxChars = 400) {
  const text = String((passage && passage.text) || '').trim();
  maxChars = Math.max(20, Math.floor(maxChars) || 400);
  if (!text) return '';
  const ref = passage[INDEX_REF];
  let sentences;
  let q = [];
  if (ref) {
    sentences = docInfo(ref.index, ref.d).sentences;
    q = analyzeQuery(ref.index, query);
  } else {
    // A passage that didn't come from search(): analyse against its own words.
    const ctx = A.createContext(new Set(normalizeTokens(`${passage.title || ''} ${passage.heading || ''} ${text}`)));
    sentences = splitSentences(text).map(s => ({ text: s, keys: new Set(keysOf(normalizeTokens(s), ctx).keys()) }));
    q = analyzeQueryLoose(ctx, query);
  }
  if (!sentences.length) return trimWords(text, maxChars);
  let start = 0;
  let end = 0;
  if (q.length) {
    const win = bestWindow(sentences, q, null);
    if (win.cov > 0) {
      start = win.start;
      end = win.end;
    }
  }
  // Add neighbouring sentences for context while they fit (up to three).
  const size = (a, b) => sentences.slice(a, b + 1).reduce((s, x) => s + x.text.length + 1, 0) - 1;
  while (end - start < 2) {
    if (end + 1 < sentences.length && size(start, end + 1) <= maxChars) end++;
    else if (start > 0 && size(start - 1, end) <= maxChars) start--;
    else break;
  }
  return trimWords(sentences.slice(start, end + 1).map(s => s.text).join(' '), maxChars);
}

module.exports = {
  THRESHOLDS, startCrawl, recrawl, deleteSource, listSources, search, snippet,
  // not part of the contract; used by the dashboard and tests
  pageBudget, friendlyError, ERRORS,
  _internal: {
    CRAWL, CHUNK, P, parseHtml, extractPage, chunkBlocks, buildPassages, splitSentences, parseRobots, robotsAllows,
    parseSitemap, normalizeUrl, urlKey, isJunkUrl, siteOf, cleanStartUrl, crawlSite, buildIndex, invalidate, active,
    // resolves when every crawl started so far has finished
    idle: () => Promise.all([...active.values()].map(a => a.promise)),
  },
};

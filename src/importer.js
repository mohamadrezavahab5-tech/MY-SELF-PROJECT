'use strict';
// Import an FAQ from a customer's existing website: they paste the URL of
// their FAQ page and we extract question/answer pairs from it.
//
// Extraction, in order of reliability:
//   1. schema.org FAQPage JSON-LD (Yoast / Rank Math / most SEO plugins)
//   2. <details><summary>question</summary>answer</details>
//   3. heading-like blocks ending in «؟» or «?» followed by answer text
//      (covers plain pages and accordion widgets such as Elementor's)
//
// The fetch is SSRF-guarded: every resolved address (including after
// redirects) must be public, checked at connect time so DNS rebinding can't
// slip a private address in between the check and the connection.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 12_000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(v);
  }
  return true;
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find(a => isPrivateIp(a.address));
    if (bad || !addresses.length) return callback(new Error('blocked_address'));
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function fetchPage(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(rawUrl); } catch { return reject(new Error('bad_url')); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new Error('bad_url'));
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
      if (isPrivateIp(url.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('blocked_address'));
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      lookup: guardedLookup,
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FAQImporter/1.0)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fa,en;q=0.5',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('too_many_redirects'));
        return resolve(fetchPage(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`http_${res.statusCode}`));
      }
      if (!/html|xml/i.test(res.headers['content-type'] || 'text/html')) {
        res.resume();
        return reject(new Error('not_html'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(new Error('too_large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ---- HTML -> text helpers (no DOM library; pages are messy, keep it tolerant)

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '‌', rlm: '', lrm: '' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(header|footer|nav)\b[\s\S]*?<\/\1>/gi, ' ');
}

// 1. JSON-LD FAQPage
function fromJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const node = stack.shift(); // FIFO keeps the page's question order
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { stack.push(...node); continue; }
      const type = [].concat(node['@type'] || []);
      if (type.includes('Question') && node.name) {
        const ans = [].concat(node.acceptedAnswer || node.suggestedAnswer || [])[0];
        const text = ans && (ans.text || ans.description);
        if (text) out.push({ question: htmlToText(node.name), answer: htmlToText(text) });
        continue;
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  return out;
}

// 2. <details><summary>
function fromDetails(html) {
  const out = [];
  const re = /<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ question: htmlToText(m[1]), answer: htmlToText(m[2]) });
  return out;
}

// 3. Question-looking blocks followed by answer text.
function fromBlocks(html) {
  const body = stripNoise(html);
  // Split into block-level chunks, remembering whether each was a heading.
  const blocks = [];
  const re = /<(h[1-6]|p|div|li|dt|dd|summary|button|a|span|strong|b|td)\b[^>]*>([\s\S]*?)(?=<\/?(?:h[1-6]|p|div|li|dt|dd|summary|button|section|article|ul|ol|table|tr|td)\b|$)/gi;
  let m;
  while ((m = re.exec(body))) {
    const text = htmlToText(m[2]);
    if (text) blocks.push({ tag: m[1].toLowerCase(), text });
  }
  const isQuestion = b => b.text.length >= 6 && b.text.length <= 220 && /[؟?]\s*$/.test(b.text) && !b.text.includes('\n\n');
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    if (!isQuestion(blocks[i])) continue;
    const parts = [];
    let j = i + 1;
    for (; j < blocks.length && !isQuestion(blocks[j]); j++) {
      if (blocks[j].text === blocks[i].text) continue;
      parts.push(blocks[j].text);
      if (parts.join('\n').length > 1500) break;
    }
    const answer = [...new Set(parts)].join('\n').trim();
    if (answer.length >= 3) out.push({ question: blocks[i].text, answer });
    i = j - 1;
  }
  return out;
}

function clean(list) {
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const question = f.question.replace(/\s+/g, ' ').replace(/^[\d۰-۹]+[-.)]\s*/, '').trim().slice(0, 300);
    const answer = f.answer.trim().slice(0, 3000);
    const key = question.replace(/[\s؟?]/g, '');
    if (question.length < 4 || answer.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push({ question, answer, alternates: [] });
  }
  return out.slice(0, 300);
}

function extractFaqs(html) {
  for (const strategy of [fromJsonLd, fromDetails, fromBlocks]) {
    const found = clean(strategy(html));
    if (found.length >= 2) return found;
  }
  return clean([...fromJsonLd(html), ...fromDetails(html), ...fromBlocks(html)]);
}

async function importFromUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  const html = await fetchPage(url);
  return extractFaqs(html);
}

module.exports = { importFromUrl, extractFaqs, isPrivateIp, fetchPage };

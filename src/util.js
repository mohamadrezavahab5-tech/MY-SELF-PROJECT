'use strict';
const crypto = require('crypto');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Short, unambiguous public ids (no 0/o/1/l/i).
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function shortId(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
function faDigits(value) {
  return String(value).replace(/[0-9]/g, d => FA_DIGITS[d]);
}

// Persian/Arabic-Indic digits -> ASCII, for parsing user input.
function enDigits(value) {
  return String(value ?? '')
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
}

function formatNumber(n) {
  return faDigits(Math.round(Number(n) || 0).toLocaleString('en-US')).replace(/,/g, '٬');
}

function formatToman(n) {
  return `${formatNumber(n)} تومان`;
}

// Iranian mobile: accepts 09xxxxxxxxx, 9xxxxxxxxx, +989xxxxxxxxx, 00989..., Persian digits.
function normalizeMobile(input) {
  let s = enDigits(input).replace(/[\s\-()]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
  else if (s.startsWith('9') && s.length === 10) s = '0' + s;
  return /^09\d{9}$/.test(s) ? s : null;
}

// IR + 24 digits, validated with the ISO 13616 mod-97 checksum.
function normalizeSheba(input) {
  let s = enDigits(input).replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{24}$/.test(s)) s = 'IR' + s;
  if (!/^IR\d{24}$/.test(s)) return null;
  const rearranged = s.slice(4) + '1827' + s.slice(2, 4); // I=18, R=27
  let rem = 0;
  for (const ch of rearranged) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1 ? s : null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

// Simple fixed-window in-memory rate limiter. Good enough for one instance.
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return function allow(key) {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    return entry.count <= max;
  };
}

// req.ip honours the app's 'trust proxy' setting (one hop: the host's load
// balancer), so a client can't dodge rate limits by sending its own
// X-Forwarded-For header.
function clientIp(req) {
  return req.ip || req.socket.remoteAddress || '';
}

module.exports = {
  esc, token, shortId, faDigits, enDigits, formatNumber, formatToman,
  normalizeMobile, normalizeSheba, hashPassword, verifyPassword,
  parseCookies, rateLimiter, clientIp,
};

'use strict';
// Character-level normalization for Persian (plus a little Latin) text.
//
// normalize(text) returns lowercase, single-spaced, punctuation-free text in
// one canonical alphabet, so that spelling variants a visitor might type
// compare equal:
//   - Arabic letters -> Persian (ي ى ئ -> ی, ك -> ک, ة ۀ -> ه, أ إ آ -> ا, ؤ -> و)
//   - diacritics (harakat), tatweel and invisible characters removed
//   - Persian / Arabic-Indic digits -> ASCII; digits split from letters
//   - half-space (ZWNJ) unified: «می‌خواهم» = «می خواهم» = «میخواهم»,
//     «کتاب‌ها» = «کتاب ها» = «کتابها»; other ZWNJ joins become spaces
//     («ثبت‌نام» -> «ثبت نام»), which is how most people type them
//   - elongation collapsed: «سلاااام» -> «سلام», «مرسیییی» -> «مرسی»
//
// آ is folded to ا on purpose: many visitors type «ادرس» for «آدرس». This is a
// matching key, not display text.
//
// Implementation: one pass over the UTF-16 code units with a lookup table
// (this runs on every FAQ text when an index is built, so it must be cheap).

const ZWNJ = '‌';
const ZWNJ_CODE = 0x200c;

// TABLE[code]: 0 = separator, 1 = drop, otherwise the (mapped) code to keep.
const SEP = 0;
const DROP = 1;
const TABLE = new Uint16Array(65536); // all separators by default

function keep(from, to) {
  for (let c = from; c <= to; c++) TABLE[c] = c;
}
keep(0x30, 0x39); // 0-9
keep(0x61, 0x7a); // a-z
for (let c = 0x41; c <= 0x5a; c++) TABLE[c] = c + 32; // A-Z -> a-z
// Latin-1 / Latin Extended / Cyrillic letters (lowercased)
for (let c = 0xc0; c <= 0x24f; c++) {
  if (c === 0xd7 || c === 0xf7) continue; // × ÷
  const lower = String.fromCharCode(c).toLowerCase();
  TABLE[c] = lower.length === 1 ? lower.charCodeAt(0) : c;
}
for (let c = 0x400; c <= 0x4ff; c++) {
  const lower = String.fromCharCode(c).toLowerCase();
  TABLE[c] = lower.length === 1 ? lower.charCodeAt(0) : c;
}
// Arabic-script letters
keep(0x621, 0x63a);
keep(0x641, 0x64a);
keep(0x66e, 0x6d3);
keep(0x6d5, 0x6d5);
keep(0x6fa, 0x6ff);

function map(chars, to) {
  for (const ch of chars) TABLE[ch.charCodeAt(0)] = to === '' ? DROP : to.charCodeAt(0);
}
map('يىئېۍێۑےۓ', 'ی');
map('كڪ', 'ک');
map('ګ', 'گ');
map('ةۀەھہۂۃ', 'ه');
map('أإآٱٲٳٵ', 'ا');
map('ؤۄۅۆۇۈۉۋٶ', 'و');
map('ء', '');
map('ٹ', 'ت');
map('ڈ', 'د');
map('ڑ', 'ر');
for (let i = 0; i < 10; i++) {
  TABLE[0x6f0 + i] = 0x30 + i; // ۰-۹
  TABLE[0x660 + i] = 0x30 + i; // ٠-٩
}
TABLE[ZWNJ_CODE] = ZWNJ_CODE;
TABLE[0x200d] = ZWNJ_CODE; // ZWJ, used as a half-space by some keyboards
// Dropped: harakat and hamza marks, superscript alef, Quranic marks, tatweel,
// zero-width space, LRM/RLM, bidi embeddings/isolates, BOM, soft hyphen.
function drop(from, to) {
  for (let c = from; c <= to; c++) TABLE[c] = DROP;
}
drop(0x64b, 0x65f);
drop(0x670, 0x670);
drop(0x610, 0x61a);
drop(0x6d6, 0x6ed);
drop(0x640, 0x640);
drop(0x200b, 0x200b);
drop(0x200e, 0x200f);
drop(0x202a, 0x202e);
drop(0x2066, 0x2069);
drop(0xfeff, 0xfeff);
drop(0xad, 0xad);

const isDigit = c => c >= 0x30 && c <= 0x39;
const ALEF = 'ا'.charCodeAt(0);
// Thousands separators: dropped between two digits («۱٬۰۰۰», «1,000»).
const THOUSANDS = new Set([0x2c, 0x66c, 0x60c]);
// Arabic presentation forms and full-width Latin need Unicode compatibility folding.
const NEEDS_NFKC = /[ﭐ-﷿ﹰ-﻿＀-￯]/;

// Split text into normalized raw tokens (ZWNJ still inside tokens).
// Fast path: while a token needs no change it is sliced from the input
// (`clean`); it is only rebuilt char by char once something is mapped/dropped.
let needJoin = false; // set by scan(): the tokens need joinParts()

function scan(s) {
  const tokens = [];
  needJoin = false;
  const n = s.length;
  let start = -1; // start of the current token in s, -1 = none
  let clean = true; // current token === s.slice(start, i)
  let cur = ''; // current token text when !clean
  let prevKind = 0; // 0 none, 1 letter, 2 digit
  let last = 0; // last kept code of the token
  let run = 0; // length of the current run of `last`
  const flush = i => {
    if (start >= 0) {
      const t = clean ? s.slice(start, i) : cur;
      if (t) {
        tokens.push(t);
        // tokens joinParts() may glue: «می», «نمی», «ها», «های», «تر», ...
        if (t.length <= 6 && GLUE_TOKENS.has(t)) needJoin = true;
      }
    }
    start = -1;
    clean = true;
    cur = '';
    prevKind = 0;
    last = 0;
    run = 0;
  };
  const dirty = i => {
    if (clean) {
      cur = s.slice(start, i);
      clean = false;
    }
  };
  for (let i = 0; i < n; i++) {
    const raw = s.charCodeAt(i);
    const m = TABLE[raw];
    if (m === DROP) {
      if (start >= 0) dirty(i);
      continue;
    }
    if (m === SEP) {
      // «۱٬۰۰۰» / «1,000»: drop the separator, keep one number
      if (prevKind === 2 && THOUSANDS.has(raw) && i + 1 < n && isDigit(TABLE[s.charCodeAt(i + 1)])) {
        dirty(i);
        continue;
      }
      flush(i);
      continue;
    }
    if (m === ZWNJ_CODE) {
      if (start < 0) continue; // leading half-space
      if (last === ZWNJ_CODE) {
        dirty(i); // repeated half-space
        continue;
      }
      if (raw !== m) dirty(i);
      if (!clean) cur += ZWNJ;
      needJoin = true;
      last = ZWNJ_CODE;
      run = 1;
      continue;
    }
    const kind = m >= 0x30 && m <= 0x39 ? 2 : 1;
    if (prevKind && prevKind !== kind && last !== ZWNJ_CODE) flush(i); // «۵۰۰هزار» -> «500 هزار»
    if (m === last && kind === 1) {
      run++;
      // elongation: keep a legit double letter, collapse 3+ to one;
      // a doubled alef never occurs in normalized Persian («سلاام»)
      if (m === ALEF || run > 3) {
        dirty(i);
        continue;
      }
      if (run === 3) {
        dirty(i);
        cur = cur.slice(0, -1);
        continue;
      }
    } else {
      last = m;
      run = 1;
    }
    if (start < 0) start = i;
    if (!clean) cur += String.fromCharCode(m);
    else if (m !== raw) {
      cur = s.slice(start, i) + String.fromCharCode(m);
      clean = false;
    }
    prevKind = kind;
  }
  flush(n);
  return tokens;
}

// After a ZWNJ these are attached to the previous word (suffixes); anything
// else after a ZWNJ starts a new word.
const ZWNJ_SUFFIXES = new Set([
  'ها', 'های', 'هایی', 'هایم', 'هایت', 'هایش', 'هایمان', 'هایتان', 'هایشان',
  'هام', 'هات', 'هاش', 'هامون', 'هاتون', 'هاشون',
  'ای', 'ام', 'ات', 'اش', 'اید', 'ایم', 'اند', 'ی', 'یی',
  'تر', 'ترین', 'مان', 'تان', 'شان', 'مون', 'تون', 'شون',
]);
// Standalone plural / comparative suffixes typed with a plain space.
const SPACE_SUFFIXES = new Set([
  'ها', 'های', 'هایی', 'هایم', 'هایت', 'هایش', 'هایمان', 'هایتان', 'هایشان',
  'هامون', 'هاتون', 'هاشون', 'تر', 'ترین',
]);
// «می» / «نمی», also after a preverb: «برمی‌گردد», «درنمی‌آید».
const VERB_PREFIXES = new Set(['می', 'نمی', 'برمی', 'برنمی', 'درمی', 'درنمی', 'ورمی']);
const GLUE_TOKENS = new Set([...VERB_PREFIXES, ...SPACE_SUFFIXES]);
const isPersian = w => w.charCodeAt(0) >= 0x600 && w.charCodeAt(0) <= 0x6ff;

// Re-join words split by ZWNJ/space around verb prefixes and plural suffixes.
function joinParts(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    if (tok.includes(ZWNJ)) {
      // Resolve each half-space: glue for prefixes/suffixes, space otherwise.
      const parts = tok.split(ZWNJ).filter(Boolean);
      if (!parts.length) continue;
      let cur = parts[0];
      for (let j = 1; j < parts.length; j++) {
        const p = parts[j];
        if (ZWNJ_SUFFIXES.has(p) || VERB_PREFIXES.has(parts[j - 1])) cur += p;
        else {
          out.push(cur);
          cur = p;
        }
      }
      tok = cur;
    }
    if (!tok) continue;
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && SPACE_SUFFIXES.has(tok) && prev.length >= 2 && isPersian(prev) && !VERB_PREFIXES.has(prev)) {
      out[out.length - 1] = prev + tok;
    } else if (prev && VERB_PREFIXES.has(prev) && tok.length >= 2 && isPersian(tok)) {
      out[out.length - 1] = prev + tok;
    } else {
      out.push(tok);
    }
  }
  return out;
}

// Normalized tokens of a text (what normalize() joins with spaces).
function normalizeTokens(text) {
  if (text === null || text === undefined) return [];
  let s = typeof text === 'string' ? text : String(text);
  if (!s) return [];
  if (NEEDS_NFKC.test(s)) s = s.normalize('NFKC');
  const tokens = scan(s);
  return needJoin ? joinParts(tokens) : tokens;
}

function normalize(text) {
  return normalizeTokens(text).join(' ');
}

module.exports = { normalize, normalizeTokens };

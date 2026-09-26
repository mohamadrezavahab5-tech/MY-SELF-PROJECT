'use strict';
// Persian analyzer: text -> list of terms for indexing and querying.
//
// Pipeline (same for FAQ text and visitor questions, so both sides agree):
//   normalize()              character-level cleanup (normalize.js)
//   per token                Finglish -> colloquial map -> stopword -> verb lemma
//                            -> vocabulary-aware light stemming
//   stop/colloquial phrases  «وقت بخیر», «خسته نباشید» dropped; «چه جوری» -> «چطور»
//   drop stopwords
//   synonym phrases          «ثبت نام» -> one term «ثبت_نام» (groups in synonyms.js)
//
// Stemming is "vocabulary-aware": most suffixes are stripped only when the
// remainder is a known word (the bot's own FAQ vocabulary + LEXICON). That is
// what lets «سفارشم» -> «سفارش» without turning «قیمت» into «قیم» or «کارت»
// into «کار».

const { normalize, normalizeTokens } = require('./normalize');
const L = require('./lexicon');
const GROUPS = require('./synonyms');

const LATIN = /^[a-z]+$/;
const DIGITS = /^\d+$/;

function normSet(list) {
  const out = new Set();
  for (const w of list) for (const t of normalize(w).split(' ')) if (t) out.add(t);
  return out;
}
function normMap(obj, mapKey = normalize) {
  const out = new Map();
  for (const [k, v] of Object.entries(obj)) out.set(mapKey(k), normalize(v));
  return out;
}

const STOP = normSet(L.STOPWORDS);
const NO_STEM = normSet(L.NO_STEM);
const NOT_VERBS = normSet(L.NOT_VERBS);
const LEXICON = normSet(L.LEXICON);
const STOP_LEMMAS = normSet(L.STOP_LEMMAS);
// Synonym-group words are common support vocabulary: count them as known.
for (const g of GROUPS) {
  for (const raw of g.terms) {
    for (const t of normalize(Array.isArray(raw) ? raw[0] : raw).split(' ')) if (t.length >= 3) LEXICON.add(t);
  }
}
const BARE_OK = normSet(L.BARE_PRESENT_OK);
const COLLOQ = normMap(L.COLLOQUIAL);
for (const [k, v] of COLLOQ) if (k === v) COLLOQ.delete(k); // guard against self-mappings
const IRREGULAR = normMap(L.IRREGULAR);
for (const [k, v] of IRREGULAR) {
  LEXICON.add(k);
  LEXICON.add(v);
}
const FINGLISH = normMap(L.FINGLISH, k => k.toLowerCase());

const PRIOR = new Map();
for (const [w, list] of Object.entries(L.PRIORS)) {
  for (const t of normSet(list.split(/\s+/))) PRIOR.set(t, Number(w));
}

// ---------------------------------------------------------------- verbs

const PRESENT = new Map(); // present stem -> lemma (past stem)
const PAST = new Map(); // past stem -> lemma
for (const [past, ...presents] of L.VERBS) {
  const lemma = normalize(past);
  PAST.set(lemma, lemma);
  for (const p of presents) {
    const s = normalize(p);
    PRESENT.set(s, lemma);
    // glide: «گو» -> «بگویید», «ا» -> «بیایید»
    if (/[او]$/.test(s) && s !== 'شو' && s !== 'رو') PRESENT.set(s + 'ی', lemma);
  }
}
for (const [k, v] of Object.entries(L.COLLOQUIAL_PAST)) PAST.set(normalize(k), normalize(v));

function combine(a, b) {
  const out = new Set();
  for (const x of a) for (const y of b) out.add(x + y);
  return out;
}
const CLITICS = ['', 'ش', 'تون', 'شون'];
const PRESENT_END = combine(['', 'م', 'ی', 'د', 'ه', 'یم', 'ید', 'ین', 'ند', 'ن'], CLITICS);
const PAST_END = combine(['', 'م', 'ی', 'یم', 'ید', 'ین', 'ند', 'ن', 'ه', 'هام', 'های', 'هایم',
  'هاید', 'هاند', 'هایی', 'هاست', 'هان'], CLITICS);
const MAX_END = Math.max(...[...PRESENT_END, ...PAST_END].map(e => e.length));

// Split `rem` into stem + ending, trying the longest ending first.
function tryVerbStem(rem, hasPrefix) {
  for (let k = Math.max(1, rem.length - MAX_END); k <= rem.length; k++) {
    const e = rem.slice(k);
    if (e && !PRESENT_END.has(e) && !PAST_END.has(e)) continue;
    const stem = rem.slice(0, k);
    const isPres = PRESENT_END.has(e);
    if (isPres && hasPrefix) {
      const l = PRESENT.get(stem);
      if (l) return l;
    }
    if (PAST_END.has(e)) {
      const l = PAST.get(stem);
      if (l) return l;
    }
    // «کنم», «دارید», «شود», «انجام دهید»: present stem without prefix
    if (isPres && !hasPrefix && e && BARE_OK.has(stem)) return PRESENT.get(stem);
  }
  return null;
}

const VERB_PREFIXES = ['نمی', 'می', 'بی', 'نی', 'ب', 'ن'];

// Returns the verb lemma (past stem) of a surface token, or null.
function verbLemma(w) {
  if (w.length < 2 || NOT_VERBS.has(w)) return null;
  // preverb before می: «برمیگرده» -> «برگرده» (+prefix)
  const pre = /^(بر|در|ور)(?:ن?می)(.+)$/.exec(w);
  if (pre) {
    const l = tryVerbStem(pre[1] + pre[2], true);
    if (l) return l;
  }
  for (const p of VERB_PREFIXES) {
    if (w.length <= p.length || !w.startsWith(p)) continue;
    const rem = w.slice(p.length);
    // «بی»/«نی» only before alef-initial stems (بیا، بیارم); «ب»/«ن» never before alef
    const alef = rem[0] === 'ا';
    if ((p === 'بی' || p === 'نی') !== alef && p !== 'می' && p !== 'نمی') continue;
    const l = tryVerbStem(rem, true);
    if (l) return l;
  }
  return tryVerbStem(w, false);
}

// ---------------------------------------------------------------- stemmer

// [suffix, min stem length, mode]
//   always: strip without checking the vocabulary (plural «ها» is unambiguous)
//   known:  strip only if the remainder (or remainder + «ه») is a known word
// The colloquial «است» clitic («تعطیله», «روزه») and object marker
// («سفارشمو») are 'known' rules; words where stripping would merge two
// different words («نامه»/«نام», «بازو»/«باز») are listed in NO_STEM.
const SUFFIX_RULES = [
  ['هایشان', 2, 'always'], ['هایتان', 2, 'always'], ['هایمان', 2, 'always'],
  ['هاشون', 2, 'always'], ['هاتون', 2, 'always'], ['هامون', 2, 'always'],
  ['هایی', 2, 'always'], ['هایم', 2, 'always'], ['هایت', 2, 'always'], ['هایش', 2, 'always'],
  ['های', 2, 'always'], ['ها', 3, 'always'],
  ['هام', 3, 'known'], ['هات', 3, 'known'], ['هاش', 3, 'known'],
  ['ترین', 3, 'known'], ['تر', 3, 'known'],
  ['یان', 3, 'known'], ['ان', 3, 'known'], ['ات', 3, 'known'],
  ['شان', 3, 'known'], ['تان', 3, 'known'], ['مان', 3, 'known'],
  ['شون', 3, 'known'], ['تون', 3, 'known'], ['مون', 3, 'known'],
  ['اش', 3, 'known'], ['ام', 3, 'known'], ['ای', 3, 'known'], ['یی', 3, 'known'],
  ['ش', 3, 'known'], ['م', 3, 'known'], ['ت', 3, 'known'], ['ی', 3, 'known'], ['ا', 3, 'known'],
  ['ه', 3, 'known'], ['و', 3, 'known'],
].sort((a, b) => b[0].length - a[0].length);

function stem(w, known, depth = 0) {
  if (w.length < 3 || NO_STEM.has(w) || depth > 3) return w;
  const irr = IRREGULAR.get(w);
  if (irr) return irr;
  const isKnown = known(w);
  // colloquial «ون» for «ان»: «دندون» -> «دندان», «خیابون» -> «خیابان»
  if (!isKnown && w.includes('ون')) {
    const alt = w.replace(/ون/g, 'ان');
    const s = stem(alt, known, depth + 1);
    if (known(s)) return s;
  }
  for (const [suf, min, mode] of SUFFIX_RULES) {
    if (!w.endsWith(suf) || w.length - suf.length < min) continue;
    const base = w.slice(0, w.length - suf.length);
    if (known(base)) return stem(base, known, depth + 1);
    // «هزینش» = «هزینه»+«ش», «شمارتون» = «شماره»+«تون», «جلسات» = «جلسه»+«ات»
    if (depth === 0 && known(base + 'ه')) return base + 'ه';
    if (suf === 'ات' && known(base + 'ت')) return base + 'ت'; // «خدمات» -> «خدمت»
    if (mode === 'always') return stem(base, known, depth + 1);
    // stacked suffixes: «سفارشمو» -> «سفارشم» -> «سفارش» (only for words that
    // are not known themselves: «کارواش» must not become «کار»)
    if (!isKnown && base.length >= 4) {
      const s2 = stem(base, known, depth + 1);
      if (s2 !== base && known(s2)) return s2;
    }
  }
  return w;
}

// ---------------------------------------------------------------- tokens

// Context: which words count as "known" for the vocabulary-aware stemmer, plus
// a per-context cache of token analyses.
function createContext(vocab) {
  const v = vocab || new Set();
  return {
    vocab: v,
    known: w => !STOP.has(w) && (v.has(w) || LEXICON.has(w)),
    cache: new Map(),
    cacheLimit: 200000,
  };
}

// After an index is built, let queries add only a bounded number of new
// tokens to its cache (one cache per bot; visitors type endless variants).
function sealContext(ctx) {
  ctx.cacheLimit = ctx.cache.size + 5000;
}

const item = (s, t, stop) => ({ s, t, stop });

// Analyze one normalized token -> array of items { s: surface, t: term, stop }.
function analyzeToken(tok, ctx, depth = 0) {
  let r = ctx.cache.get(tok);
  if (r) return r;
  r = analyzeTokenUncached(tok, ctx, depth);
  if (ctx.cache.size < ctx.cacheLimit) ctx.cache.set(tok, r);
  return r;
}

// Analyze a replacement text; the items keep `surface` as their surface form.
function expand(text, ctx, depth, surface) {
  const out = [];
  for (const t of text.split(' ')) {
    if (!t) continue;
    for (const it of analyzeToken(t, ctx, depth + 1)) out.push(surface ? item(surface, it.t, it.stop) : it);
  }
  return out;
}

function analyzeTokenUncached(tok, ctx, depth) {
  if (DIGITS.test(tok)) return [item(tok, tok, false)];
  if (STOP.has(tok)) return [item(tok, tok, true)];
  if (LATIN.test(tok)) {
    const rep = FINGLISH.get(tok);
    if (rep === '') return [item(tok, tok, true)];
    if (rep && depth < 2) return expand(rep, ctx, depth, tok);
    return [item(tok, tok, false)];
  }
  const col = COLLOQ.get(tok);
  if (col !== undefined) {
    if (col === '' || depth >= 2) return [item(tok, col || tok, true)];
    return expand(col, ctx, depth, tok);
  }
  const lemma = verbLemma(tok);
  if (lemma) return [item(tok, lemma, STOP_LEMMAS.has(lemma))];
  const st = stem(tok, ctx.known);
  if (st !== tok) {
    const c2 = COLLOQ.get(st);
    if (c2 !== undefined && depth < 2) return c2 ? expand(c2, ctx, depth, tok) : [item(tok, st, true)];
  }
  return [item(tok, st, STOP.has(st))];
}

// ---------------------------------------------------------------- phrases

// Phrase patterns are analyzed with the same pipeline as the text they are
// matched against (see matchAt for when an item matches a pattern element).
function buildPatternTable(entries, ctx) {
  const table = new Map(); // key (surface or term of first element) -> [{ els, value }]
  for (const [text, value] of entries) {
    const els = [];
    for (const t of normalizeTokens(text)) els.push(...analyzeToken(t, ctx));
    if (els.length < 2) continue;
    const entry = { els, value };
    for (const key of new Set([els[0].s, els[0].t])) {
      if (!table.has(key)) table.set(key, []);
      table.get(key).push(entry);
    }
  }
  for (const list of table.values()) list.sort((a, b) => b.els.length - a.els.length);
  return table;
}

// strict (stop/colloquial rewrites): same surface form, or two inflected forms
// of the same verb («میخوام» = «میخواهم»); loose (synonym phrases): same
// surface form or same term.
function matchAt(items, i, els, strict) {
  if (i + els.length > items.length) return false;
  for (let j = 0; j < els.length; j++) {
    const a = items[i + j];
    const e = els[j];
    if (a.s === e.s) continue;
    if (a.t !== e.t) return false;
    if (strict && (a.t === a.s || e.t === e.s)) return false;
  }
  return true;
}

function findPattern(table, items, i, strict) {
  const it = items[i];
  let best = null;
  const a = table.get(it.s);
  if (a) {
    for (const entry of a) {
      if ((!best || entry.els.length > best.els.length) && matchAt(items, i, entry.els, strict)) best = entry;
    }
  }
  const b = it.t !== it.s ? table.get(it.t) : undefined;
  if (b) {
    for (const entry of b) {
      if ((!best || entry.els.length > best.els.length) && matchAt(items, i, entry.els, strict)) best = entry;
    }
  }
  return best;
}

const loadCtx = createContext(null);

// Stop phrases (value null) and colloquial phrases (value = replacement text).
const REWRITES = buildPatternTable([
  ...L.STOP_PHRASES.map(p => [p, null]),
  ...Object.entries(L.COLLOQUIAL_PHRASES),
], loadCtx);

// Synonym groups: single terms -> groups; multi-word terms -> phrase terms.
const TERM_GROUPS = new Map(); // term -> [[groupId, weight]]
const phraseKeys = new Set();
function addGroup(term, id, w) {
  if (!TERM_GROUPS.has(term)) TERM_GROUPS.set(term, []);
  const list = TERM_GROUPS.get(term);
  const existing = list.find(x => x[0] === id);
  if (existing) existing[1] = Math.max(existing[1], w);
  else list.push([id, w]);
}
const pendingPhrases = [];
const PHRASES = new Map(); // filled below, after all group terms are analyzed
for (const g of GROUPS) {
  for (const raw of g.terms) {
    const [text, w] = Array.isArray(raw) ? raw : [raw, 1];
    const terms = contentTerms(normalizeTokens(text), loadCtx);
    if (!terms.length) continue;
    if (terms.length === 1) {
      addGroup(terms[0], g.id, w);
    } else {
      const key = terms.join('_');
      addGroup(key, g.id, w);
      if (!phraseKeys.has(key)) {
        phraseKeys.add(key);
        pendingPhrases.push([text, key]);
      }
    }
  }
}

// Build the synonym-phrase table over content items (stopwords removed).
for (const [text, key] of pendingPhrases) {
  const els = contentItems(normalizeTokens(text), loadCtx);
  if (els.length < 2) continue;
  const entry = { els, value: key };
  for (const k of new Set([els[0].s, els[0].t])) {
    if (!PHRASES.has(k)) PHRASES.set(k, []);
    PHRASES.get(k).push(entry);
  }
}

// Components of a phrase term («ثبت_نام» -> ['ثبت', 'نام']).
function phraseParts(term) {
  return term.includes('_') ? term.split('_') : null;
}

// ---------------------------------------------------------------- pipeline

// Tokens -> content items (after rewrites and stopword removal, before phrases).
function contentItems(tokens, ctx) {
  const items = [];
  let maybeRewrite = false;
  for (const t of tokens) {
    for (const it of analyzeToken(t, ctx)) {
      items.push(it);
      if (!maybeRewrite && (REWRITES.has(it.s) || REWRITES.has(it.t))) maybeRewrite = true;
    }
  }
  const out = [];
  if (!maybeRewrite) {
    for (const it of items) if (!it.stop && it.t) out.push(it);
    return out;
  }
  // stop / colloquial phrases
  for (let i = 0; i < items.length;) {
    const hit = findPattern(REWRITES, items, i, true);
    if (hit) {
      if (hit.value) for (const it of expand(hit.value, ctx, 0)) if (!it.stop && it.t) out.push(it);
      i += hit.els.length;
    } else {
      const it = items[i];
      if (!it.stop && it.t) out.push(it);
      i++;
    }
  }
  return out;
}

// Content items -> terms, joining synonym phrases.
function contentTerms(tokens, ctx) {
  const items = contentItems(tokens, ctx);
  return joinPhrases(items);
}

function joinPhrases(items) {
  const terms = [];
  for (let i = 0; i < items.length;) {
    const it = items[i];
    const hit = PHRASES.has(it.s) || PHRASES.has(it.t) ? findPattern(PHRASES, items, i, false) : null;
    if (hit) {
      terms.push(hit.value);
      i += hit.els.length;
    } else {
      terms.push(it.t);
      i++;
    }
  }
  return terms;
}

// Cheap bag-of-terms for long texts (FAQ answers): per-token analysis only,
// no phrase rules. Returns a Set of terms.
function bagOfTerms(tokens, ctx) {
  const out = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const items = analyzeToken(tokens[i], ctx);
    for (let j = 0; j < items.length; j++) if (!items[j].stop && items[j].t) out.add(items[j].t);
  }
  return out;
}

// Full analysis of a raw text. Returns terms in order (may repeat).
function analyze(text, ctx) {
  return contentTerms(normalizeTokens(text), ctx || loadCtx);
}

// Query-side spacing repair against the FAQ vocabulary: merge «دندان پزشکی»
// into «دندانپزشکی» and split «ثبتنام» into «ثبت نام» when that is how the
// FAQ wrote it.
function fixSpacing(tokens, ctx) {
  const vocab = ctx.vocab;
  const known = w => vocab.has(w) || LEXICON.has(w);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (b && !STOP.has(a) && vocab.has(a + b) && (a + b).length >= 5) {
      out.push(a + b);
      i++;
      continue;
    }
    if (a.length >= 5 && !vocab.has(a) && !STOP.has(a) && !COLLOQ.has(a) && !LATIN.test(a) && !verbLemma(a)) {
      const st = stem(a, ctx.known);
      if (!vocab.has(st)) {
        let best = null;
        for (let k = 2; k <= a.length - 2; k++) {
          const x = a.slice(0, k);
          const y = a.slice(k);
          if ((known(x) || STOP.has(x)) && known(y)) {
            const score = Math.min(x.length, y.length) + (vocab.has(x) ? 1 : 0) + (vocab.has(y) ? 1 : 0);
            if (!best || score > best.score) best = { x, y, score };
          }
        }
        if (best) {
          out.push(best.x, best.y);
          continue;
        }
      }
    }
    out.push(a);
  }
  return out;
}

// Prior importance of a term (multiplies its IDF): numbers and single letters
// say little; generic verbs and question words are listed in lexicon.PRIORS.
function prior(term) {
  if (DIGITS.test(term)) return 0.25;
  const p = PRIOR.get(term);
  if (p !== undefined) return p;
  return term.length === 1 ? 0.2 : 1;
}

module.exports = {
  analyze, contentTerms, bagOfTerms, fixSpacing, createContext, sealContext, verbLemma, stem, prior, phraseParts,
  TERM_GROUPS,
};

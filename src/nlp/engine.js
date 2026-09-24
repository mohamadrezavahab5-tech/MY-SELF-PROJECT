'use strict';
// Retrieval engine: matches a visitor's question against a bot's FAQ.
// Contract (docs/ARCHITECTURE.md): normalize, buildIndex, search, decide, THRESHOLDS.
//
// How a question is scored
// ------------------------
// Every FAQ contributes several "variants": its question and each alternate
// phrasing, indexed separately. Text goes through the Persian analyzer
// (analyzer.js: normalization, colloquial forms, verb lemmas, stopwords,
// vocabulary-aware light stemming, synonym phrases), giving a few terms per
// variant. Each term has a weight = prior (generic words like «چطور», «کرد» are
// low) x IDF over FAQs normalized to [0,1].
//
// For a query q and a variant v:
//
//   qCov = share of the query's weight explained by v
//   vCov = share of v's weight covered by the query
//   wordSim = qCov^QEXP * vCov^VEXP * (1 - unmatched)^UMPOW
//
// where `unmatched` is the weight share of the heaviest query word v says
// nothing about. A query word is explained with credit 1 by the same term,
// SYN by a synonym (synonyms.js), PART_HI/PART_LO by a phrase containing it
// («ساعت» vs «ساعت_کار»), FUZZ*similarity by a near-spelling (typos, Finglish),
// SIB when only another phrasing of the same FAQ has it, and ANS when only the
// FAQ's answer has it (answers are a weak signal). Words the bot has never seen
// keep a high weight (OOV_IDF), so an off-topic question that shares one word
// with an FAQ («قیمت دلار» vs «قیمت محصولات») still scores low.
//
// charSim is the cosine of TF-IDF character-trigram vectors (typos, morphology).
//
//   score(v)   = (LAMBDA * wordSim + (1 - LAMBDA) * charSim) * damp
//   score(FAQ) = best score over its variants, in [0,1]
//
// `damp` lowers queries with almost no information (only «چطور» or «سلام»).
// Coverage ratios mean the same thing for a 5-FAQ and a 5,000-FAQ bot, so one
// set of THRESHOLDS works for both. decide() answers only when the top score is
// high AND clearly ahead of the runner-up (margin); otherwise it suggests, or
// falls back.
//
// Speed: postings are flat typed arrays; answers are analyzed lazily for the
// top candidates only. buildIndex(5,000 FAQs) ~200 ms, search ~1 ms
// (npm run eval measures both).

const { normalize, normalizeTokens } = require('./normalize');
const A = require('./analyzer');

// Tuned on test/fixtures/engine-dev.json, including random 4- and 8-FAQ
// subsets of it (small bots, where most questions are about topics the FAQ
// does not cover). See scripts/eval-engine.js.
const P = {
  SYN: 0.95, // credit for a synonym match
  PART_HI: 0.7, // phrase <-> component: credit on the side of the single word
  PART_LO: 0.2, //   ...and on the side of the phrase (only part of it is covered)
  FUZZ: 1.0, // multiplier on fuzzy (typo) similarity
  FUZZ_MIN: 0.7, // minimum similarity for a fuzzy match
  ANS: 0.55, // credit for a query word found only in the answer text
  SIB: 0.8, // credit for a query word found only in another phrasing of the same FAQ
  OOV_IDF: 0.8, // normalized IDF of a query word the FAQ set has never seen
  IDF_FLOOR: 0.08,
  QEXP: 0.5, // wordSim = qCov^QEXP * vCov^VEXP * (1 - unmatched)^UMPOW
  VEXP: 0.6,
  UMPOW: 0.5, // unmatched = weight share of the heaviest query word left unexplained
  LAMBDA: 0.95, // weight of word-level vs character-level similarity
  MASS0: 0.3, // query information mass needed for full confidence
  MASS_POW: 0.8,
  TOPK: 200, // candidates scored exactly
};

// answer: top score needed for a direct answer, AND a lead of `margin` over the
// runner-up; suggest: minimum score of a suggestion. Chosen so that direct
// answers are >= 96% correct on every dev bot size (tiny bots are the hardest).
// answer: the bar for a direct answer. Tiny bots (< smallBot FAQs) use the
// stricter answerSmall: with few FAQs, a same-topic-but-different-aspect
// question ("هزینه پست" vs "هزینه ارسال مرجوعی") is the usual mistake.
const THRESHOLDS = { answer: 0.55, answerSmall: 0.6, smallBot: 10, suggest: 0.3, margin: 0.15 };

// ---------------------------------------------------------------- helpers

function charGrams(term, out) {
  for (const piece of term.split('_')) {
    if (!piece) continue;
    const s = '<' + piece + '>';
    if (piece.length <= 2) out.push(s);
    for (let i = 0; i + 3 <= s.length; i++) out.push(s.slice(i, i + 3));
  }
  return out;
}

// Letters that are commonly swapped when typing Persian (same sound).
const HOMOPHONE = new Map();
for (const group of ['تط', 'سصث', 'زذضظ', 'هح', 'قغ', 'اع', 'کگ']) {
  for (const a of group) for (const b of group) if (a !== b) HOMOPHONE.set(a + b, a === 'ک' || a === 'گ' ? 0.6 : 0.4);
}
const WEAK = new Set(['ا', 'و', 'ی']); // long-vowel letters, often dropped/added

// Weighted optimal-string-alignment distance with an early cut-off.
function editDistance(a, b, max) {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max + 1) return Infinity;
  let prev2 = null;
  let prev = new Float64Array(m + 1);
  let cur = new Float64Array(m + 1);
  for (let j = 1; j <= m; j++) prev[j] = prev[j - 1] + (WEAK.has(b[j - 1]) ? 0.6 : 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = prev[0] + (WEAK.has(a[i - 1]) ? 0.6 : 1);
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const ca = a[i - 1];
      const cb = b[j - 1];
      const sub = ca === cb ? 0 : (HOMOPHONE.get(ca + cb) || 1);
      let v = Math.min(
        prev[j - 1] + sub,
        prev[j] + (WEAK.has(ca) ? 0.6 : 1),
        cur[j - 1] + (WEAK.has(cb) ? 0.6 : 1),
      );
      if (prev2 && i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb) v = Math.min(v, prev2[j - 2] + 0.6);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return Infinity;
    const t = prev2 || new Float64Array(m + 1);
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[m];
}

function maxEdits(len) {
  if (len <= 3) return 0.4;
  if (len <= 5) return 1.0;
  if (len <= 8) return 1.6;
  return 2.2;
}

// Consonant skeleton, to match Finglish («hazine») with Persian («هزینه»).
const FA_SKEL = new Map(Object.entries({
  'ب': 'b', 'پ': 'p', 'ت': 't', 'ط': 't', 'ث': 's', 'س': 's', 'ص': 's', 'ج': 'j', 'چ': 'c', 'ح': 'h',
  'ه': 'h', 'خ': 'x', 'د': 'd', 'ذ': 'z', 'ز': 'z', 'ض': 'z', 'ظ': 'z', 'ر': 'r', 'ژ': 'Z', 'ش': 'S',
  'غ': 'q', 'ق': 'q', 'ف': 'f', 'ک': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm', 'ن': 'n',
}));
function skeletonFa(term) {
  let n = term.length;
  if (n > 2 && term.charCodeAt(n - 1) === 0x647) n--; // final «ه» is a vowel
  let out = '';
  let last;
  for (let i = 0; i < n; i++) {
    const c = FA_SKEL.get(term[i]);
    if (c !== undefined && c !== last) {
      out += c;
      last = c;
    }
  }
  return out;
}
function skeletonLatin(word) {
  let w = word.replace(/kh/g, 'x').replace(/sh/g, 'S').replace(/ch/g, 'c').replace(/gh/g, 'q')
    .replace(/zh/g, 'Z').replace(/ph/g, 'f');
  if (w.length > 2 && w.endsWith('h')) w = w.slice(0, -1);
  let out = '';
  for (const ch of w) {
    if ('aeiouywv\''.includes(ch)) continue;
    const c = ch === 'c' ? 'k' : ch;
    if (!/[a-zA-Z]/.test(c)) continue;
    if (out[out.length - 1] !== c) out += c;
  }
  return out;
}

// ---------------------------------------------------------------- build

// Posting lists are stored flat ("CSR"): list k is items[off[k] .. off[k+1]).
function offsets(counts) {
  const off = new Int32Array(counts.length + 1);
  for (let k = 0; k < counts.length; k++) off[k + 1] = off[k] + counts[k];
  return off;
}

// 1 + ln(tf) for small term frequencies.
const LOG_TF = Float64Array.from({ length: 64 }, (_, c) => (c ? 1 + Math.log(c) : 0));
const logTf = c => (c < 64 ? LOG_TF[c] : 1 + Math.log(c));

// Answers are a weak signal: only their start is used, and they are analyzed
// lazily (on the first query that needs them), which keeps buildIndex cheap.
const MAX_ANSWER_CHARS = 600;
const MAX_ANSWER_TOKENS = 60;
const ANSWER_FAQS = 12; // top candidate FAQs re-scored with answer credit

function buildIndex(faqs) {
  const list = Array.isArray(faqs) ? faqs : [];
  const nFaq = list.length;
  const faqIds = new Array(nFaq);

  // Pass 1: normalize everything and collect the surface vocabulary, which the
  // vocabulary-aware stemmer uses on both the FAQ and the query side.
  const rawVocab = new Set();
  const texts = new Array(nFaq);
  const answers = new Array(nFaq);
  for (let f = 0; f < nFaq; f++) {
    const faq = list[f] || {};
    faqIds[f] = faq.id;
    const alts = Array.isArray(faq.alternates) ? faq.alternates : [];
    const variants = [];
    for (let j = -1; j < alts.length; j++) {
      const toks = normalizeTokens(j < 0 ? faq.question : alts[j]);
      if (!toks.length) continue;
      variants.push(toks);
      for (const t of toks) rawVocab.add(t);
    }
    answers[f] = typeof faq.answer === 'string' ? faq.answer.slice(0, MAX_ANSWER_CHARS) : '';
    texts[f] = variants;
  }
  const ctx = A.createContext(rawVocab);

  // Pass 2: analyze variants into terms (with integer ids).
  const terms = []; // id -> { id, term, df, w, keys, keyW, grams }
  const termByText = new Map();
  const termOf = t => {
    let x = termByText.get(t);
    if (x === undefined) {
      x = { id: terms.length, term: t, df: 0, w: 0, lastFaq: -1, keys: null, keyW: null, grams: null };
      terms.push(x);
      termByText.set(t, x);
    }
    return x;
  };
  const vFaq = [];
  const vTerms = []; // per variant: its distinct terms
  for (let f = 0; f < nFaq; f++) {
    for (const toks of texts[f]) {
      const infos = [];
      for (const t of A.contentTerms(toks, ctx)) {
        const x = termOf(t);
        if (infos.includes(x)) continue;
        infos.push(x);
        if (x.lastFaq !== f) {
          x.lastFaq = f;
          x.df++;
        }
      }
      if (!infos.length) continue;
      vFaq.push(f);
      vTerms.push(infos);
    }
  }
  const nv = vTerms.length;

  // Term weights (prior x normalized IDF over FAQs), match keys (the term itself
  // + its synonym groups) and character trigrams.
  const idf1 = Math.log(1 + (nFaq - 1 + 0.5) / 1.5) || 1;
  const keyIds = new Map();
  const keyId = k => {
    let id = keyIds.get(k);
    if (id === undefined) keyIds.set(k, (id = keyIds.size));
    return id;
  };
  const gramIds = new Map();
  const compPhrases = new Map(); // component term -> phrase terms containing it
  for (const x of terms) {
    x.w = A.prior(x.term) * idfNorm(x.df, nFaq, idf1);
    const groups = A.TERM_GROUPS.get(x.term);
    const n = 1 + (groups ? groups.length : 0);
    x.keys = new Int32Array(n);
    x.keyW = new Float64Array(n);
    x.keys[0] = keyId(x.term);
    x.keyW[0] = 1;
    if (groups) {
      for (let j = 0; j < groups.length; j++) {
        x.keys[j + 1] = keyId('~' + groups[j][0]);
        x.keyW[j + 1] = groups[j][1];
      }
    }
    const grams = charGrams(x.term, []);
    x.grams = new Int32Array(grams.length);
    for (let j = 0; j < grams.length; j++) {
      let g = gramIds.get(grams[j]);
      if (g === undefined) gramIds.set(grams[j], (g = gramIds.size));
      x.grams[j] = g;
    }
    const parts = A.phraseParts(x.term);
    if (parts) {
      for (const p of parts) {
        if (!compPhrases.has(p)) compPhrases.set(p, []);
        compPhrases.get(p).push(x.term);
      }
    }
  }

  // Postings (key -> variants containing it) and character-trigram document
  // frequencies, counted in one pass; each variant is counted once per key/gram.
  const nKeys = keyIds.size;
  const nG = gramIds.size;
  const kCount = new Int32Array(nKeys);
  const kStamp = new Int32Array(nKeys).fill(-1);
  const gDf = new Int32Array(nG);
  const gStamp = new Int32Array(nG).fill(-1);
  const vWeight = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    const xs = vTerms[v];
    let sum = 0;
    for (let a = 0; a < xs.length; a++) {
      const x = xs[a];
      sum += x.w;
      const keys = x.keys;
      for (let j = 0; j < keys.length; j++) {
        const k = keys[j];
        if (kStamp[k] !== v) {
          kStamp[k] = v;
          kCount[k]++;
        }
      }
      const grams = x.grams;
      for (let j = 0; j < grams.length; j++) {
        const g = grams[j];
        if (gStamp[g] !== v) {
          gStamp[g] = v;
          gDf[g]++;
        }
      }
    }
    vWeight[v] = sum;
  }
  const kOff = offsets(kCount);
  const kItems = new Int32Array(kOff[nKeys]);
  const kFill = kOff.slice(0, nKeys);
  const gIdf = new Float64Array(nG);
  for (let g = 0; g < nG; g++) gIdf[g] = gDf[g] ? Math.log(1 + nv / gDf[g]) : 0;
  const gOff = offsets(gDf);
  const gV = new Int32Array(gOff[nG]);
  const gW = new Float32Array(gOff[nG]);
  const gFill = gOff.slice(0, nG);
  const gCnt = new Float64Array(nG);
  kStamp.fill(-1);
  gStamp.fill(-1);
  const touched = [];
  for (let v = 0; v < nv; v++) {
    const xs = vTerms[v];
    let nt = 0;
    for (let a = 0; a < xs.length; a++) {
      const x = xs[a];
      const keys = x.keys;
      for (let j = 0; j < keys.length; j++) {
        const k = keys[j];
        if (kStamp[k] !== v) {
          kStamp[k] = v;
          kItems[kFill[k]++] = v;
        }
      }
      const grams = x.grams;
      for (let j = 0; j < grams.length; j++) {
        const g = grams[j];
        if (gStamp[g] !== v) {
          gStamp[g] = v;
          gCnt[g] = 0;
          touched[nt++] = g;
        }
        gCnt[g]++;
      }
    }
    // TF-IDF weights of this variant's trigrams, cosine-normalized
    let norm = 0;
    for (let j = 0; j < nt; j++) {
      const g = touched[j];
      const w = logTf(gCnt[g]) * gIdf[g];
      gCnt[g] = w;
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < nt; j++) {
      const g = touched[j];
      const i = gFill[g]++;
      gV[i] = v;
      gW[i] = gCnt[g] / norm;
    }
  }

  // Per FAQ: all match keys of all its phrasings (question + alternates).
  const faqKeys = new Array(nFaq);
  for (let v = 0; v < nv; v++) {
    const f = vFaq[v];
    const set = faqKeys[f] || (faqKeys[f] = new Set());
    for (const x of vTerms[v]) for (let j = 0; j < x.keys.length; j++) set.add(x.keys[j]);
  }

  A.sealContext(ctx);

  // Fuzzy lookup: trigram -> single-word vocabulary terms.
  const fCount = new Int32Array(nG);
  gStamp.fill(-1);
  const fuzzyOk = x => x.term.length >= 3 && !x.term.includes('_') && !/^[\da-z]+$/.test(x.term);
  const fuzzyTerms = terms.filter(fuzzyOk);
  for (const x of fuzzyTerms) {
    const grams = x.grams;
    for (let j = 0; j < grams.length; j++) {
      const g = grams[j];
      if (gStamp[g] !== x.id) {
        gStamp[g] = x.id;
        fCount[g]++;
      }
    }
  }
  const fOff = offsets(fCount);
  const fItems = new Int32Array(fOff[nG]);
  const fFill = fOff.slice(0, nG);
  gStamp.fill(-1);
  for (const x of fuzzyTerms) {
    const grams = x.grams;
    for (let j = 0; j < grams.length; j++) {
      const g = grams[j];
      if (gStamp[g] !== x.id) {
        gStamp[g] = x.id;
        fItems[fFill[g]++] = x.id;
      }
    }
  }

  return {
    nFaq, faqIds, ctx, idf1, nv,
    terms, termByText, keyIds, compPhrases,
    vFaq: Int32Array.from(vFaq), vTerms, vWeight, kOff, kItems,
    answers, answerKeys: new Array(nFaq), // answerKeys[f]: lazily built Set of terms + '~group'
    faqKeys,
    gramIds, gIdf, gOff, gV, gW, fOff, fItems,
    skeletons: buildSkeletons(terms), // Finglish lookup
    // scratch buffers reused across searches (search is synchronous)
    buf: {
      acc: new Float64Array(nv), char: new Float64Array(nv), stamp: new Int32Array(nv).fill(-1),
      best: new Float64Array(nv), seen: new Uint8Array(nv),
    },
  };
}

// Consonant skeleton -> Persian terms, for matching Finglish query words.
function buildSkeletons(terms) {
  const map = new Map();
  for (const x of terms) {
    const c = x.term.charCodeAt(0);
    if (c < 0x600 || c > 0x6ff) continue;
    const s = skeletonFa(x.term);
    if (s.length < 2) continue;
    const l = map.get(s);
    if (l) l.push(x);
    else map.set(s, [x]);
  }
  return map;
}

// Terms (and '~group' keys) of an FAQ's answer, analyzed on first use.
function answerKeys(index, f) {
  let set = index.answerKeys[f];
  if (set === undefined) {
    set = new Set();
    const text = index.answers[f];
    if (text) {
      const tokens = normalizeTokens(text);
      if (tokens.length > MAX_ANSWER_TOKENS) tokens.length = MAX_ANSWER_TOKENS;
      for (const t of A.bagOfTerms(tokens, index.ctx)) {
        set.add(t);
        const groups = A.TERM_GROUPS.get(t);
        if (groups) for (const [g] of groups) set.add('~' + g);
      }
    }
    index.answerKeys[f] = set;
  }
  return set;
}

function idfNorm(df, n, idf1) {
  if (df <= 0) return P.OOV_IDF;
  const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
  return Math.max(P.IDF_FLOOR, Math.min(1, idf / idf1));
}

// ---------------------------------------------------------------- query

// Synonym-group words, so a typo of «هزینه» still reaches the «price» group
// even when the bot's FAQ only says «قیمت».
const GROUP_FUZZY = (() => {
  const list = [];
  const grams = new Map();
  for (const term of A.TERM_GROUPS.keys()) {
    if (term.length < 3 || term.includes('_') || /^[\da-z]+$/.test(term)) continue;
    const id = list.length;
    list.push({ term, w: 1, df: 0 });
    for (const g of new Set(charGrams(term, []))) {
      if (!grams.has(g)) grams.set(g, []);
      grams.get(g).push(id);
    }
  }
  return { list, candidates: (t, add) => {
    for (const g of new Set(charGrams(t, []))) {
      const l = grams.get(g);
      if (l) for (const id of l) add(id);
    }
  } };
})();

function indexFuzzy(index) {
  return {
    list: index.terms,
    candidates: (t, add) => {
      for (const s of new Set(charGrams(t, []))) {
        const g = index.gramIds.get(s);
        if (g === undefined) continue;
        for (let j = index.fOff[g]; j < index.fOff[g + 1]; j++) add(index.fItems[j]);
      }
    },
  };
}

// Near-spellings of an unknown query term within a fuzzy table.
function fuzzyIn(table, t) {
  const nGrams = new Set(charGrams(t, [])).size;
  const counts = new Map();
  table.candidates(t, id => counts.set(id, (counts.get(id) || 0) + 1));
  const minShared = Math.max(1, Math.floor(nGrams / 3));
  const cands = [];
  for (const [id, c] of counts) if (c >= minShared) cands.push([id, c]);
  cands.sort((a, b) => b[1] - a[1]);
  const out = [];
  for (let i = 0; i < cands.length && i < 40; i++) {
    const x = table.list[cands[i][0]];
    const f = x.term;
    const len = Math.max(t.length, f.length);
    let sim = 0;
    const d = editDistance(t, f, maxEdits(len));
    if (d !== Infinity) sim = 1 - d / len;
    // morphology the stemmer missed: «کاربران» vs «کاربر»
    const short = t.length < f.length ? t : f;
    const long = t.length < f.length ? f : t;
    if (short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3) sim = Math.max(sim, 0.85);
    if (sim >= P.FUZZ_MIN) out.push([x, sim]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out.slice(0, 3);
}

// Near-spellings of an unknown query term: FAQ vocabulary first, then the
// synonym lexicon; Latin-script words are matched by consonant skeleton.
function fuzzyMatches(index, t) {
  if (t.length < 3 || /\d/.test(t)) return [];
  if (/^[a-z]+$/.test(t)) {
    const sk = skeletonLatin(t);
    if (sk.length < 2) return [];
    const hits = index.skeletons.get(sk);
    return hits ? hits.slice(0, 3).map(x => [x, 0.8]) : [];
  }
  const local = fuzzyIn(indexFuzzy(index), t);
  if (local.length && local[0][1] >= 0.85) return local;
  const global = fuzzyIn(GROUP_FUZZY, t);
  return [...local, ...global].sort((a, b) => b[1] - a[1]).slice(0, 3);
}

// Query text -> [{ term, w, keys: Map(keyId -> credit), strKeys: [[key, credit]] }]
function analyzeQuery(index, query) {
  const ctx = index.ctx;
  let tokens = normalizeTokens(query);
  if (!tokens.length) return [];
  tokens = A.fixSpacing(tokens, ctx);
  const terms = [...new Set(A.contentTerms(tokens, ctx))];
  const out = [];
  for (const t of terms) {
    // Match keys with two credits: cq = how well a matching variant term
    // explains this query term, cv = how well this query term covers that
    // variant term. They differ only for phrase <-> component matches.
    const keys = new Map(); // key id -> cq (keys that occur in FAQ variants)
    const keysV = new Map(); // key id -> cv, when different from cq
    const strKeys = new Map(); // key text -> cq (all keys; used against answers)
    const put = (k, cq, cv = cq) => {
      if (cq > (strKeys.get(k) || 0)) strKeys.set(k, cq);
      const id = index.keyIds.get(k);
      if (id === undefined) return;
      const old = keys.get(id);
      if (old === undefined || cq > old) {
        keys.set(id, cq);
        if (cv !== cq) keysV.set(id, cv);
        else keysV.delete(id);
      }
    };
    const addTermKeys = (term, credit) => {
      put(term, credit);
      const groups = A.TERM_GROUPS.get(term);
      if (groups) for (const [g, mw] of groups) put('~' + g, credit * P.SYN * mw);
      // query phrase «ساعت_کار» vs variant word «ساعت»: the query is only partly explained
      const parts = A.phraseParts(term);
      if (parts) for (const p of parts) put(p, credit * P.PART_LO, credit * P.PART_HI);
      // query word «ساعت» vs variant phrase «ساعت_کار»: the variant is only partly covered
      const phrases = index.compPhrases.get(term);
      if (phrases) for (const ph of phrases) put(ph, credit * P.PART_HI, credit * P.PART_LO);
    };
    addTermKeys(t, 1);
    const x = index.termByText.get(t);
    let w;
    if (x) {
      w = x.w;
    } else {
      // Unknown word: full weight, unless it is a near-spelling of a known one.
      w = A.prior(t) * P.OOV_IDF;
      const fz = A.phraseParts(t) ? [] : fuzzyMatches(index, t);
      if (fz.length) {
        w = Math.min(w, Math.max(fz[0][0].w, 0.2));
        for (const [fx, sim] of fz) addTermKeys(fx.term, P.FUZZ * sim);
      }
    }
    out.push({ term: t, w, keys, keysV, strKeys: [...strKeys] });
  }
  return out;
}

function search(index, query, { limit = 5, explain = false } = {}) {
  if (!index || !index.nv || (typeof query !== 'string' && typeof query !== 'number')) return [];
  const q = analyzeQuery(index, String(query).slice(0, 1000));
  if (!q.length) return [];
  let mass = 0;
  for (const qt of q) mass += qt.w;
  if (mass <= 0) return [];
  const touched = [];
  try {
    return rank(index, q, mass, touched, limit, explain);
  } finally {
    // reset the shared scratch buffers, even if something threw
    const { acc, char, stamp, seen } = index.buf;
    for (const v of touched) {
      acc[v] = 0;
      char[v] = 0;
      stamp[v] = -1;
      seen[v] = 0;
    }
  }
}

// Candidate generation and scoring; `touched` collects every variant whose
// scratch-buffer entries were written.
function rank(index, q, mass, touched, limit, explain) {
  const { acc, char, stamp, best, seen } = index.buf;
  const { kOff, kItems } = index;
  const nq = q.length;

  // 1. Word-level candidates: per variant, sum over query terms of
  //    weight x best key credit (the numerator of query coverage).
  for (let i = 0; i < nq; i++) {
    const { w, keys } = q[i];
    const hit = [];
    for (const [k, c] of keys) {
      for (let j = kOff[k]; j < kOff[k + 1]; j++) {
        const v = kItems[j];
        if (stamp[v] !== i) {
          stamp[v] = i;
          best[v] = c;
          hit.push(v);
        } else if (c > best[v]) best[v] = c;
      }
    }
    for (const v of hit) {
      if (!seen[v]) {
        seen[v] = 1;
        touched.push(v);
      }
      acc[v] += w * best[v];
    }
  }

  // 2. Character-trigram cosine for every variant sharing a trigram.
  const qGrams = new Map();
  for (const qt of q) for (const g of charGrams(qt.term, [])) qGrams.set(g, (qGrams.get(g) || 0) + 1);
  const maxIdf = Math.log(1 + index.nv);
  let qNorm = 0;
  const qgw = [];
  for (const [s, c] of qGrams) {
    const g = index.gramIds.get(s);
    const known = g !== undefined && index.gIdf[g] > 0;
    const w = (1 + Math.log(c)) * (known ? index.gIdf[g] : maxIdf);
    qNorm += w * w;
    if (known) qgw.push(g, w);
  }
  qNorm = Math.sqrt(qNorm) || 1;
  const { gOff, gV, gW } = index;
  // Trigrams found in a large share of all variants carry almost no weight
  // (low IDF) but would make every variant a candidate: skip their postings.
  const maxDf = Math.max(300, 0.05 * index.nv);
  for (let n = 0; n < qgw.length; n += 2) {
    const g = qgw[n];
    const qw = qgw[n + 1] / qNorm;
    if (gOff[g + 1] - gOff[g] > maxDf) continue;
    for (let j = gOff[g]; j < gOff[g + 1]; j++) {
      const v = gV[j];
      if (!seen[v]) {
        seen[v] = 1;
        touched.push(v);
      }
      char[v] += qw * gW[j];
    }
  }

  // 3. Keep the most promising candidates (by a cheap pre-score), then score
  //    them exactly.
  let cand = touched;
  if (touched.length > P.TOPK) {
    const pre = new Float64Array(touched.length);
    for (let j = 0; j < touched.length; j++) {
      const v = touched[j];
      pre[j] = P.LAMBDA * (acc[v] / mass) + (1 - P.LAMBDA) * char[v];
    }
    const sorted = pre.slice().sort();
    const cut = sorted[sorted.length - P.TOPK];
    cand = [];
    for (let j = 0; j < touched.length; j++) if (pre[j] >= cut) cand.push(touched[j]);
  }
  const damp = mass >= P.MASS0 ? 1 : Math.pow(mass / P.MASS0, P.MASS_POW);
  const score = (v, f, withAnswer) =>
    (P.LAMBDA * wordSim(index, q, v, f, mass, withAnswer) + (1 - P.LAMBDA) * Math.min(1, char[v])) * damp;
  const byFaq = new Map(); // faq -> [best score, candidate variants]
  for (const v of cand) {
    const f = index.vFaq[v];
    const s = score(v, f, false);
    const e = byFaq.get(f);
    if (!e) byFaq.set(f, [s, [v]]);
    else {
      if (s > e[0]) e[0] = s;
      e[1].push(v);
    }
  }
  // Re-score the leading FAQs with credit for query words found in their answer.
  const ranked = [...byFaq].sort((a, b) => b[1][0] - a[1][0]);
  for (let r = 0; r < ranked.length && r < ANSWER_FAQS; r++) {
    const [f, e] = ranked[r];
    for (const v of e[1]) {
      const s = score(v, f, true);
      if (s > e[0]) e[0] = s;
    }
  }

  const results = [];
  for (const [f, [s]] of ranked) if (s > 0.01) results.push({ id: index.faqIds[f], score: round(s) });
  results.sort((a, b) => b.score - a.score);
  const out = results.slice(0, Math.max(0, limit | 0));
  if (explain) explainResults();
  return out;

  function explainResults() {
    // Debug details for the returned FAQs (not part of the contract).
    const fOf = new Map(ranked.map(([f]) => [index.faqIds[f], f]));
    for (const r of out) {
      const f = fOf.get(r.id);
      let bestInfo = null;
      for (const v of byFaq.get(f)[1]) {
        const info = {};
        const s = (P.LAMBDA * wordSim(index, q, v, f, mass, true, info) + (1 - P.LAMBDA) * Math.min(1, char[v])) * damp;
        if (!bestInfo || s > bestInfo.score) bestInfo = { score: s, variant: v, char: char[v], ...info };
      }
      r.detail = { ...bestInfo, damp, terms: q.map(x => x.term) };
    }
  }
}

// Exact word-level similarity of query q with variant v (of FAQ f).
function wordSim(index, q, v, f, mass, withAnswer, info) {
  const terms = index.vTerms[v];
  const nq = q.length;
  const bestQ = new Float64Array(nq);
  let matchedV = 0;
  for (const x of terms) {
    let cu = 0;
    for (let i = 0; i < nq; i++) {
      const { keys, keysV } = q[i];
      let cq = 0;
      let cv = 0;
      for (let j = 0; j < x.keys.length; j++) {
        const kc = keys.get(x.keys[j]);
        if (kc === undefined) continue;
        const mw = x.keyW[j];
        if (kc * mw > cq) cq = kc * mw;
        const kv = keysV.size ? keysV.get(x.keys[j]) : undefined;
        const v2 = (kv === undefined ? kc : kv) * mw;
        if (v2 > cv) cv = v2;
      }
      if (cq > bestQ[i]) bestQ[i] = cq;
      if (cv > cu) cu = cv;
    }
    matchedV += x.w * cu;
  }
  // Query words this phrasing lacks but another phrasing of the same FAQ, or
  // its answer, contains get partial credit (evidence spread over alternates).
  const ansKeys = withAnswer ? answerKeys(index, f) : null;
  const sibKeys = withAnswer ? index.faqKeys[f] : null;
  let matchedQ = 0;
  let unmatched = 0;
  for (let i = 0; i < nq; i++) {
    let c = bestQ[i];
    if (sibKeys && c < P.SIB) {
      for (const [k, kc] of q[i].keys) {
        if (kc * P.SIB > c && sibKeys.has(k)) c = kc * P.SIB;
      }
    }
    if (ansKeys && c < P.ANS && ansKeys.size) {
      for (const [k, kc] of q[i].strKeys) {
        if (kc * P.ANS > c && ansKeys.has(k)) c = kc * P.ANS;
      }
    }
    matchedQ += q[i].w * c;
    if (c < 0.3 && q[i].w / mass > unmatched) unmatched = q[i].w / mass;
  }
  const qCov = matchedQ / mass;
  const vCov = index.vWeight[v] > 0 ? matchedV / index.vWeight[v] : 0;
  if (qCov <= 0 || vCov <= 0) return 0;
  let sim = Math.pow(qCov, P.QEXP) * Math.pow(vCov, P.VEXP);
  // A heavy query word this FAQ says nothing about («قیمت سکه» vs «قیمت
  // محصولات», «پاسپورتم کی آماده میشه» vs «کارت ملی کی آماده میشه») is strong
  // evidence that the question is about something else.
  if (P.UMPOW) sim *= Math.pow(1 - unmatched, P.UMPOW);
  if (info) {
    info.qCov = qCov;
    info.vCov = vCov;
    info.unmatchedMax = unmatched;
  }
  return sim;
}

function round(x) {
  return Math.round(Math.min(1, Math.max(0, x)) * 10000) / 10000;
}

// ---------------------------------------------------------------- decide

// opts.faqCount (optional): number of FAQs in the bot, selects the answer bar.
function decide(results, opts = {}) {
  const list = Array.isArray(results) ? results : [];
  const top = list[0];
  const second = list[1];
  const small = Number.isFinite(opts.faqCount) && opts.faqCount < THRESHOLDS.smallBot;
  const answerMin = small ? THRESHOLDS.answerSmall : THRESHOLDS.answer;
  if (top && top.score >= answerMin && (!second || top.score - second.score >= THRESHOLDS.margin)) {
    return {
      type: 'answer',
      best: top,
      suggestions: list.slice(1, 4).filter(r => r.score >= THRESHOLDS.suggest),
    };
  }
  const suggestions = list.filter(r => r.score >= THRESHOLDS.suggest).slice(0, 3);
  if (suggestions.length) return { type: 'suggest', best: null, suggestions };
  return { type: 'fallback', best: null, suggestions: [] };
}

module.exports = {
  normalize, buildIndex, search, decide, THRESHOLDS,
  // not part of the contract; used by tests and scripts/eval-engine.js
  _internal: { analyzeQuery, params: P, editDistance, skeletonFa, skeletonLatin },
};

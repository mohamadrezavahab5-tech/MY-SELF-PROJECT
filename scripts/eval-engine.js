'use strict';
// Evaluates the question-matching engine (src/nlp/engine.js).
//
//   npm run eval              summary per dataset + timing
//   npm run eval -- -v        also list every miss / wrong answer
//
// Datasets:
//   dev   test/fixtures/engine-dev.json (thresholds are tuned on this)
//   size  robustness checks built from the dev set: tiny bots (random 4- and
//         8-FAQ subsets, where questions about the left-out FAQs become
//         realistic "topic not in the FAQ" negatives), each dev bot hidden
//         among 2,000 synthetic FAQs, and all dev businesses merged into one bot
//   test  src/content/industries.js starterFaqs + evalQueries, if present
//         (held out: never tune on it). Off-topic negatives for it come from
//         the dev set's oosGlobal list.
//
// Exits non-zero if, on the dev set, answer precision < 0.95 or the
// out-of-scope false-answer rate > 0.05.

const path = require('path');
const fs = require('fs');
const engine = require('../src/nlp/engine');

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const ROOT = path.join(__dirname, '..');
const dev = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/engine-dev.json'), 'utf8'));

function evaluate(name, faqs, queries, oos, prebuilt) {
  const index = prebuilt || engine.buildIndex(faqs.map((f, i) => ({ id: i, ...f })));
  const m = {
    name, faqs: faqs.length, inScope: 0, top1: 0, top3: 0, answered: 0, answeredCorrect: 0,
    suggest: 0, fallback: 0, oos: 0, oosAnswer: 0, oosSuggest: 0, misses: [],
  };
  const all = [...queries.map(q => ({ q: q.q, expected: q.expected })), ...oos.map(q => ({ q, expected: null }))];
  for (const { q, expected } of all) {
    const results = engine.search(index, q, { limit: 5 });
    const d = engine.decide(results, { faqCount: faqs.length });
    const ids = results.map(r => r.id);
    const fmt = () => results.slice(0, 3).map(r => `${r.id}:${r.score.toFixed(2)}`).join(' ');
    if (expected === null || expected === undefined) {
      m.oos++;
      if (d.type === 'answer') {
        m.oosAnswer++;
        m.answered++;
        m.misses.push(`OOS ANSWERED  "${q}" -> ${d.best.id} (${fmt()})`);
      } else if (d.type === 'suggest') m.oosSuggest++;
      continue;
    }
    m.inScope++;
    if (ids[0] === expected) m.top1++;
    if (ids.slice(0, 3).includes(expected)) m.top3++;
    if (d.type === 'answer') {
      m.answered++;
      if (d.best.id === expected) m.answeredCorrect++;
      else m.misses.push(`WRONG ANSWER  "${q}" expected ${expected}, got ${d.best.id} (${fmt()})`);
    } else {
      if (d.type === 'suggest') m.suggest++;
      else m.fallback++;
      if (!ids.slice(0, 3).includes(expected)) m.misses.push(`NOT IN TOP-3  "${q}" expected ${expected} (${fmt()}) [${d.type}]`);
      else if (VERBOSE) m.misses.push(`not answered  "${q}" expected ${expected} (${fmt()}) [${d.type}]`);
    }
  }
  return m;
}

function merge(name, list) {
  const out = { name, faqs: 0, misses: [] };
  for (const m of list) {
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'number') out[k] = (out[k] || 0) + v;
    }
  }
  return out;
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
function row(m) {
  return [
    m.name.padEnd(16),
    String(m.faqs).padStart(5),
    String(m.inScope).padStart(5),
    pct(m.top1, m.inScope).padStart(7),
    pct(m.top3, m.inScope).padStart(7),
    pct(m.answered - m.oosAnswer, m.inScope).padStart(7),
    pct(m.answeredCorrect, m.answered).padStart(7),
    pct(m.suggest, m.inScope).padStart(7),
    pct(m.fallback, m.inScope).padStart(7),
    String(m.oos).padStart(5),
    pct(m.oosAnswer, m.oos).padStart(7),
    pct(m.oosSuggest, m.oos).padStart(7),
  ].join(' ');
}
const HEADER = [
  'dataset'.padEnd(16), 'faqs'.padStart(5), 'qs'.padStart(5), 'top1'.padStart(7), 'top3'.padStart(7),
  'ansRt'.padStart(7), 'ansPrc'.padStart(7), 'sugRt'.padStart(7), 'fbRt'.padStart(7), 'oos'.padStart(5),
  'oosAns'.padStart(7), 'oosSug'.padStart(7),
].join(' ');

function printTable(title, rows, total) {
  console.log(`\n== ${title}`);
  console.log(HEADER);
  for (const m of rows) console.log(row(m));
  if (total) console.log(row(total));
  if (rows.some(m => m.misses.length)) {
    for (const m of rows) {
      if (!m.misses.length) continue;
      const shown = VERBOSE ? m.misses : m.misses.filter(s => !s.startsWith('NOT IN'));
      if (!shown.length) continue;
      console.log(`\n  [${m.name}]`);
      for (const s of shown) console.log('   ' + s);
    }
  }
}

console.log('top1/top3: correct FAQ ranked 1st / in top 3 (in-scope queries)');
console.log('ansRt: in-scope queries answered directly; ansPrc: answers that were correct (incl. off-topic answers as wrong)');
console.log('sugRt/fbRt: in-scope queries that got suggestions / fallback; oosAns/oosSug: off-topic queries answered / suggested');
console.log(`THRESHOLDS: ${JSON.stringify(engine.THRESHOLDS)}`);

// ---- dev set
const devRows = dev.datasets.map(ds => evaluate(ds.id, ds.faqs, ds.queries, dev.oosGlobal));
const devTotal = merge('DEV TOTAL', devRows);
printTable('dev set (test/fixtures/engine-dev.json)', devRows, devTotal);

// ---- size robustness (built from the dev set)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Random k-FAQ bots: queries whose FAQ was left out are expected to get no answer.
function smallBots(k, reps, seed) {
  const rand = rng(seed);
  const rows = [];
  for (const ds of dev.datasets) {
    for (let r = 0; r < reps; r++) {
      const keep = [...ds.faqs.keys()].sort(() => rand() - 0.5).slice(0, k);
      const pos = new Map(keep.map((f, i) => [f, i]));
      const qs = ds.queries.map(q => ({ q: q.q, expected: pos.has(q.expected) ? pos.get(q.expected) : null }));
      rows.push(evaluate(`${ds.id}`, keep.map(i => ds.faqs[i]), qs, dev.oosGlobal));
    }
  }
  return rows;
}
const mergedFaqs = [];
const mergedQs = [];
for (const ds of dev.datasets) {
  const off = mergedFaqs.length;
  mergedFaqs.push(...ds.faqs);
  for (const q of ds.queries) mergedQs.push({ q: q.q, expected: q.expected === null ? null : q.expected + off });
}
const sizeRows = [
  merge('bots of 4 FAQs', smallBots(4, 8, 101)),
  merge('bots of 8 FAQs', smallBots(8, 6, 202)),
];
{
  // each dev bot hidden among 2,000 synthetic FAQs (large-bot calibration)
  const distractors = syntheticFaqs(2000, rng(7));
  const rows = dev.datasets.map(ds => {
    const all = [...ds.faqs.map((f, i) => ({ id: i, ...f })), ...distractors.map((f, i) => ({ ...f, id: ds.faqs.length + i }))];
    return evaluate(ds.id, all, ds.queries, dev.oosGlobal, engine.buildIndex(all));
  });
  sizeRows.push(merge('bots + 2000 FAQs', rows));
}
// Stress test: all dev businesses in one bot. Several businesses share the
// same FAQ («پارکینگ دارید؟», «آدرس ... کجاست؟»), so some "errors" here are
// another business's identical answer.
sizeRows.push(evaluate('9 bots merged', mergedFaqs, mergedQs, dev.oosGlobal));
for (const m of sizeRows) m.misses = [];
printTable('size robustness (from the dev set; "faqs" = total over all bots)', sizeRows);

// ---- industries.js (held-out test set)
let industries = null;
const indPath = path.join(ROOT, 'src/content/industries.js');
if (fs.existsSync(indPath)) {
  try {
    industries = require(indPath);
  } catch (e) {
    console.log(`\n(industries.js could not be loaded: ${e.message})`);
  }
}
let testTotal = null;
if (Array.isArray(industries) && industries.length) {
  const rows = [];
  for (const ind of industries) {
    const faqs = (ind.starterFaqs || []).filter(f => f && f.question);
    const qs = (ind.evalQueries || [])
      .filter(q => q && typeof q.query === 'string' && Number.isInteger(q.expected) && q.expected < faqs.length)
      .map(q => ({ q: q.query, expected: q.expected }));
    if (!faqs.length || !qs.length) continue;
    rows.push(evaluate(String(ind.id || ind.name), faqs, qs, dev.oosGlobal));
  }
  if (rows.length) {
    testTotal = merge('TEST TOTAL', rows);
    printTable('held-out test set (src/content/industries.js)', rows, testTotal);
  }
} else {
  console.log('\n(src/content/industries.js not found or empty: skipping held-out test set)');
}

// ---- timing on a synthetic 5,000-FAQ bot
// Synthetic FAQs: real dev vocabulary plus random pseudo-words (large vocabulary).
function syntheticFaqs(n, rand) {
  const words = new Set();
  for (const ds of dev.datasets) {
    for (const f of ds.faqs) {
      for (const t of [f.question, ...f.alternates, f.answer]) for (const w of t.split(/[\s،؟?!.:؛]+/)) if (w) words.add(w);
    }
  }
  const letters = 'ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';
  for (let i = 0; i < 6000; i++) {
    const len = 3 + Math.floor(rand() * 5);
    let w = '';
    for (let j = 0; j < len; j++) w += letters[Math.floor(rand() * letters.length)];
    words.add(w);
  }
  const pool = [...words];
  const pick = () => pool[Math.floor(Math.pow(rand(), 1.6) * pool.length)];
  const sentence = k => Array.from({ length: k }, pick).join(' ');
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    question: sentence(4 + Math.floor(rand() * 6)) + '؟',
    alternates: Array.from({ length: 3 }, () => sentence(3 + Math.floor(rand() * 5))),
    answer: sentence(20 + Math.floor(rand() * 25)),
  }));
}

const rand = rng(42);
const big = syntheticFaqs(5000, rand);
// Add the dev FAQs too, so real questions have real matches in the big index.
for (const ds of dev.datasets) for (const f of ds.faqs) big.push({ id: big.length + 1, ...f });
engine.buildIndex(big.slice(0, 200)); // warm up the JIT
const builds = [];
let bigIndex = null;
for (let i = 0; i < 3; i++) {
  const t0 = process.hrtime.bigint();
  bigIndex = engine.buildIndex(big);
  builds.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
const queries = [];
for (const ds of dev.datasets) for (const q of ds.queries) queries.push(q.q);
queries.push(...dev.oosGlobal);
for (const q of queries.slice(0, 50)) engine.search(bigIndex, q); // warm up
const times = [];
for (let r = 0; r < 3; r++) {
  for (const q of queries) {
    const t0 = process.hrtime.bigint();
    engine.search(bigIndex, q, { limit: 5 });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
}
times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const p95 = times[Math.floor(times.length * 0.95)];
const buildMs = Math.min(...builds);
console.log(`\n== timing (synthetic bot with ${big.length} FAQs, ${bigIndex.nv} variants)`);
console.log(`buildIndex: ${buildMs.toFixed(0)} ms (best of 3; runs: ${builds.map(b => b.toFixed(0)).join(', ')})   budget < 300 ms`);
console.log(`search: avg ${avg.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${times[times.length - 1].toFixed(2)} ms over ${times.length} queries   budget < 10 ms`);

// ---- gate
const precision = devTotal.answered ? devTotal.answeredCorrect / devTotal.answered : 1;
const oosRate = devTotal.oos ? devTotal.oosAnswer / devTotal.oos : 0;
const failures = [];
if (precision < 0.95) failures.push(`dev answer precision ${(precision * 100).toFixed(1)}% < 95%`);
if (oosRate > 0.05) failures.push(`dev OOS false-answer rate ${(oosRate * 100).toFixed(1)}% > 5%`);
if (failures.length) {
  console.log(`\nFAIL: ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nOK: dev answer precision ${(precision * 100).toFixed(1)}%, OOS false-answer rate ${(oosRate * 100).toFixed(1)}%`);
}

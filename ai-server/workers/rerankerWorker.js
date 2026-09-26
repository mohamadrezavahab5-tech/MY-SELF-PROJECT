'use strict';
// Worker process for the bge-reranker-v2-m3 cross-encoder. Adapted from the
// owner's crm-companion/scripts/rerankerWorker.js: same model file, same
// tokenizer (bge-m3's sentencepiece model: one tokenizer, no drift), same
// XLM-R pair encoding <s> query </s></s> document </s>, same 512-token budget
// with the query getting at most a third.
//
// Pairs are scored one session.run at a time, as in the CRM. Measured here on
// the quantized model: 8 pairs sequentially ~0.6 s, the same 8 as one padded
// batch ~1.5 s (padding everything to the longest pair costs more than the
// batching saves), and dynamic quantization makes a batched pair's score
// depend on its batch-mates. One at a time is faster AND reproducible.
//
// Protocol (see common.js): {id, op:'rerank', query, documents:[string]}
//   -> {id, scores:[raw logit per document], tokens}
// Raw logits, higher = better match; the HTTP layer adds a sigmoid
// relevance_score in [0,1] (what Cohere/Jina-style clients expect).
const fs = require('node:fs');
const common = require('./common');
const paths = require('../lib/paths');

const MAX_TOTAL_TOKENS = Math.max(16, parseInt(process.env.RERANK_MAX_TOKENS, 10) || 512);
const FAKE = process.env.AI_SERVER_FAKE === '1';

let ort;
let session;
let tokenizer;
let outputName;

async function init() {
  if (FAKE) return { fake: true };
  ort = require('onnxruntime-node');
  if (!fs.existsSync(paths.embed.spm) && fs.existsSync(paths.embed.tokenizerOnnx)) {
    require('../lib/spmFromOnnx').extractTo(paths.embed.tokenizerOnnx, paths.embed.spm);
  }
  tokenizer = await common.loadTokenizer(paths.embed.spm);
  session = await ort.InferenceSession.create(paths.rerankerModelPath(), common.sessionOptions());
  outputName = session.outputNames.includes('logits') ? 'logits' : session.outputNames[0];
  await scorePair(tokenizer.encode('ok'), tokenizer.encode('ok'));
  return { maxTokens: MAX_TOTAL_TOKENS };
}

// XLM-R pair encoding: <s> A </s> </s> B </s>, truncated from the end of each side.
function buildPair(queryIds, docIds) {
  const budget = MAX_TOTAL_TOKENS - 4;
  const qMax = Math.min(queryIds.length, Math.floor(budget / 3));
  const dMax = Math.min(docIds.length, budget - qMax);
  return [common.BOS, ...queryIds.slice(0, qMax), common.EOS, common.EOS, ...docIds.slice(0, dMax), common.EOS];
}

async function scorePair(queryIds, docIds) {
  const ids = buildPair(queryIds, docIds);
  const out = await session.run(common.batchTensors(ort, [ids]));
  return { score: Number(out[outputName].data[0]), tokens: ids.length };
}

function fakeScore(query, doc) {
  const q = new Set(common.fakeTokens(query));
  const d = common.fakeTokens(doc);
  if (!q.size || !d.length) return -10;
  const hit = d.filter(t => q.has(t)).length;
  return -6 + 12 * (hit / Math.max(q.size, 1));
}

common.serve('reranker-worker', init, async req => {
  if (req.op !== 'rerank') throw new Error(`unknown op ${req.op}`);
  const docs = Array.isArray(req.documents) ? req.documents.map(d => String(d == null ? '' : d)) : [];
  if (FAKE) {
    if (process.env.AI_SERVER_FAKE_DELAY_MS) await new Promise(r => setTimeout(r, Number(process.env.AI_SERVER_FAKE_DELAY_MS)));
    return { scores: docs.map(d => fakeScore(req.query, d)), tokens: 0 };
  }
  const queryIds = tokenizer.encode(req.query || '');
  const scores = [];
  let tokens = 0;
  for (const d of docs) {
    const r = await scorePair(queryIds, tokenizer.encode(d));
    scores.push(r.score);
    tokens += r.tokens;
  }
  return { scores, tokens };
});

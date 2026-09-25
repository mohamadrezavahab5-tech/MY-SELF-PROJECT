'use strict';
// Worker process for the BGE-M3 embedding model. Adapted from the owner's
// crm-companion/scripts/embeddingWorker.js (same model files, same
// tokenization), plus: several texts per request run as ONE padded batch
// (measured ~3.5x faster than one session.run per text on a 4-core CPU), and
// texts are truncated to EMBED_MAX_TOKENS.
//
// Protocol (see common.js): {id, op:'embed', texts:[string]}
//   -> {id, dim, vectors: base64 of float32[texts.length * dim], tokens}
// Vectors are L2-normalized (the ONNX graph already normalizes dense output;
// normalizing again costs nothing and makes it a guarantee).
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const paths = require('../lib/paths');

const MAX_TOKENS = Math.max(8, parseInt(process.env.EMBED_MAX_TOKENS, 10) || 512);
const BATCH_SIZE = Math.max(1, parseInt(process.env.EMBED_BATCH_SIZE, 10) || 16);
// Padded tokens per session.run (batch x longest). Keeps one long text from
// turning a batch of short ones into a huge padded tensor.
const BATCH_TOKENS = Math.max(MAX_TOKENS, parseInt(process.env.EMBED_BATCH_TOKENS, 10) || 4096);
const FAKE = process.env.AI_SERVER_FAKE === '1';

let ort;
let session;
let tokenizer;

async function init() {
  if (FAKE) return { fake: true, dim: 64 };
  ort = require('onnxruntime-node');
  if (!fs.existsSync(paths.embed.spm) && fs.existsSync(paths.embed.tokenizerOnnx)) {
    require('../lib/spmFromOnnx').extractTo(paths.embed.tokenizerOnnx, paths.embed.spm);
  }
  tokenizer = await common.loadTokenizer(paths.embed.spm);
  session = await ort.InferenceSession.create(paths.embed.model, common.sessionOptions());
  if (!session.outputNames.includes('dense_embeddings')) {
    throw new Error(`${path.basename(paths.embed.model)} has no dense_embeddings output (outputs: ${session.outputNames.join(', ')})`);
  }
  const probe = await embedAll(['ok']);
  return { dim: probe.dim, maxTokens: MAX_TOKENS };
}

function encode(text) {
  const ids = tokenizer.encode(text);
  if (ids.length > MAX_TOKENS - 2) ids.length = MAX_TOKENS - 2;
  return [common.BOS, ...ids, common.EOS];
}

async function embedAll(texts) {
  if (FAKE) {
    // Test hooks for the process plumbing: a wedged or crashing model.
    if (texts.includes('__hang__')) await new Promise(() => {});
    if (texts.includes('__crash__')) process.exit(3);
    if (process.env.AI_SERVER_FAKE_DELAY_MS) await new Promise(r => setTimeout(r, Number(process.env.AI_SERVER_FAKE_DELAY_MS)));
    const dim = 64;
    const out = new Float32Array(texts.length * dim);
    texts.forEach((t, i) => out.set(normalize(common.fakeVector(t, dim)), i * dim));
    return { dim, data: out, tokens: texts.reduce((n, t) => n + common.fakeTokens(t).length, 0) };
  }
  const seqs = texts.map(encode);
  const tokens = seqs.reduce((n, s) => n + s.length, 0);
  // Shortest first, so each batch pads to a similar length.
  const order = seqs.map((s, i) => i).sort((a, b) => seqs[a].length - seqs[b].length);
  let dim = 0;
  let out = null;
  for (let start = 0; start < order.length;) {
    let end = start + 1;
    while (end < order.length && end - start < BATCH_SIZE && seqs[order[end]].length * (end - start + 1) <= BATCH_TOKENS) end++;
    const idx = order.slice(start, end);
    const result = await session.run(common.batchTensors(ort, idx.map(i => seqs[i])));
    const dense = result.dense_embeddings;
    dim = dense.dims[dense.dims.length - 1];
    if (!out) out = new Float32Array(texts.length * dim);
    idx.forEach((orig, b) => out.set(normalize(dense.data.subarray(b * dim, (b + 1) * dim)), orig * dim));
    start = end;
  }
  return { dim, data: out || new Float32Array(0), tokens };
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

common.serve('embedding-worker', init, async req => {
  if (req.op !== 'embed') throw new Error(`unknown op ${req.op}`);
  const texts = Array.isArray(req.texts) ? req.texts.map(t => String(t == null ? '' : t)) : [];
  const { dim, data, tokens } = await embedAll(texts);
  return { dim, tokens, vectors: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') };
});

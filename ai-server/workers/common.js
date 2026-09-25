'use strict';
// Shared plumbing for the two model worker processes (embeddingWorker.js,
// rerankerWorker.js). Same design as the owner's crm-companion workers
// (scripts/embeddingWorker.js / scripts/rerankerWorker.js): one long-lived
// process per model, one JSON object per line on stdin, one JSON object per
// line back on stdout. The model lives in its own process so a model that
// fails to load, runs out of memory or wedges can never take the HTTP server
// down with it; lib/modelPool.js kills and respawns it instead.
//
// Tokenization is the exact convention the CRM uses (see its
// scripts/embeddingWorker.js, "see test_bge_m3.js for why"): XLM-RoBERTa's
// sentencepiece.bpe.model, fairseq ids = sentencepiece id + 1, <s>=0, </s>=2.
// One deliberate fix on top: sentencepiece-js returns 0 for an unknown piece,
// which +1 would turn into 1 = <pad> (and the reranker graph treats <pad> as
// padding when it builds position ids). HF's tokenizer maps it to <unk>=3, so
// do we. bge-reranker-v2-m3 uses the very same tokenizer, so both workers
// share this one.
const readline = require('node:readline');
const util = require('node:util');

const BOS = 0;
const PAD = 1;
const EOS = 2;
const UNK = 3;
const FAIRSEQ_OFFSET = 1;
// Tokenizing a pathological multi-megabyte string would stall the worker
// before truncation ever happens; nothing useful lives past this anyway.
const MAX_CHARS = 20000;

// stdout carries the protocol and nothing else: a stray console.log from a
// dependency would otherwise corrupt a response line.
console.log = (...args) => process.stderr.write(util.format(...args) + '\n');
console.info = console.log;

async function loadTokenizer(spmPath) {
  const { SentencePieceProcessor } = require('sentencepiece-js');
  const spp = new SentencePieceProcessor();
  await spp.load(spmPath);
  return {
    encode(text) {
      const ids = spp.encodeIds(String(text == null ? '' : text).slice(0, MAX_CHARS));
      const out = new Array(ids.length);
      for (let i = 0; i < ids.length; i++) out[i] = ids[i] === 0 ? UNK : ids[i] + FAIRSEQ_OFFSET;
      return out;
    },
  };
}

// Packs token-id sequences into padded int64 input_ids/attention_mask tensors.
function batchTensors(ort, seqs) {
  const len = seqs.reduce((m, s) => Math.max(m, s.length), 0);
  const ids = new BigInt64Array(seqs.length * len).fill(BigInt(PAD));
  const mask = new BigInt64Array(seqs.length * len);
  for (let b = 0; b < seqs.length; b++) {
    const s = seqs[b];
    for (let j = 0; j < s.length; j++) {
      ids[b * len + j] = BigInt(s[j]);
      mask[b * len + j] = 1n;
    }
  }
  return {
    input_ids: new ort.Tensor('int64', ids, [seqs.length, len]),
    attention_mask: new ort.Tensor('int64', mask, [seqs.length, len]),
  };
}

function sessionOptions() {
  const threads = parseInt(process.env.ORT_THREADS, 10);
  const opts = { graphOptimizationLevel: 'all' };
  if (threads > 0) opts.intraOpNumThreads = threads;
  return opts;
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Runs `handle(request)` for each stdin line, strictly one at a time.
//
// The queue is load-bearing, not tidiness. readline fires 'line' for every
// line as it arrives without waiting for an async handler to finish, and the
// CRM learned the hard way (commit "serialize ONNX worker requests to stop
// concurrent-call hangs") that overlapping session.run() calls on one
// InferenceSession hang: a ~50 ms call never returns, the parent's timeout
// kills the worker, and the next burst hangs the fresh worker the same way.
// The parent (lib/modelPool.js) also sends only one job at a time per worker,
// so this is the second of two independent guards.
function serve(name, init, handle) {
  let queue = Promise.resolve();
  init().then(info => {
    send({ type: 'ready', info });
    process.stderr.write(`[${name}] model loaded, ready\n`);
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', line => {
      if (!line.trim()) return;
      let req;
      try {
        req = JSON.parse(line);
      } catch (e) {
        process.stderr.write(`[${name}] bad JSON line: ${e.message}\n`);
        return;
      }
      queue = queue.then(async () => {
        try {
          if (req.op === 'ping') return send({ id: req.id, ok: true });
          send({ id: req.id, ...(await handle(req)) });
        } catch (e) {
          send({ id: req.id, error: e.message || String(e) });
        }
      });
    });
    // Parent went away (closed our stdin): exit instead of lingering as an
    // orphan holding a gigabyte or two of model in RAM.
    rl.on('close', () => queue.then(() => process.exit(0)));
  }).catch(e => {
    process.stderr.write(`[${name}] fatal init error: ${e.message}\n`);
    process.exit(1);
  });
}

// Deterministic stand-ins used when AI_SERVER_FAKE=1 (tests of the HTTP and
// process plumbing on machines without the multi-GB model files).
function fakeTokens(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
function fakeVector(text, dim = 64) {
  const v = new Float32Array(dim);
  for (const tok of fakeTokens(text)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
    v[(h >>> 0) % dim] += 1;
  }
  return v;
}

module.exports = { BOS, PAD, EOS, UNK, loadTokenizer, batchTensors, sessionOptions, serve, send, fakeTokens, fakeVector };

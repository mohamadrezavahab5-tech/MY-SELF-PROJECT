'use strict';
// Pasokhyar AI server: the owner's own offline models behind a tiny HTTP API.
//
//   POST /v1/embeddings  OpenAI-compatible   { model, input: string|string[], encoding_format? }
//                        -> { object:'list', data:[{ object:'embedding', index, embedding }], model, usage }
//   POST /v1/rerank      Jina/Cohere-style   { query, documents: (string|{text})[], top_n?, return_documents? }
//                        -> { model, results:[{ index, relevance_score, logit }], usage }
//   GET  /health         { ok, embeddings: state, reranker: state }  (details with a valid key)
//
// Auth: "Authorization: Bearer <AI_SERVER_KEY>" on every /v1 call. The key is
// required; the only way to run without one is AI_SERVER_ALLOW_NO_KEY=1 while
// listening on 127.0.0.1 AND not exposing the port through a tunnel (a tunnel
// delivers internet traffic from localhost, so "localhost only" stops meaning
// anything the moment one points here).
//
// No dependencies beyond the two model runtimes: node:http, and the models run
// in worker processes (workers/*.js via lib/modelPool.js).
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const paths = require('./lib/paths');
const { ModelPool } = require('./lib/modelPool');

const env = process.env;
const int = (name, def) => {
  const v = parseInt(env[name], 10);
  return Number.isFinite(v) ? v : def;
};

const HOST = env.AI_SERVER_HOST || '127.0.0.1';
const PORT = int('AI_SERVER_PORT', 8787);
const KEY = env.AI_SERVER_KEY || '';
const ALLOW_NO_KEY = env.AI_SERVER_ALLOW_NO_KEY === '1';
const EMBED_MODEL = env.EMBED_MODEL_NAME || 'bge-m3';
const RERANK_MODEL = env.RERANK_MODEL_NAME || 'bge-reranker-v2-m3';
const MAX_INPUTS = int('MAX_INPUTS', 256);
const MAX_DOCUMENTS = int('MAX_DOCUMENTS', 100);
const MAX_BODY = int('MAX_BODY_BYTES', 4 * 1024 * 1024);
// Calls with at most this many texts count as interactive and jump the queue.
const INTERACTIVE_MAX = int('INTERACTIVE_MAX_INPUTS', 4);
const LOG_REQUESTS = env.LOG_REQUESTS === '1';

const isLoopback = h => ['127.0.0.1', '::1', 'localhost'].includes(h);

function createPools() {
  const common = {
    execTimeoutMs: int('JOB_TIMEOUT_MS', 60000),
    queueTimeoutMs: int('QUEUE_TIMEOUT_MS', 30000),
    maxQueue: int('MAX_QUEUE', 200),
  };
  const embed = new ModelPool({
    name: 'embeddings', script: path.join(__dirname, 'workers', 'embeddingWorker.js'),
    size: int('EMBED_WORKERS', 1), ...common,
  });
  const rerank = new ModelPool({
    name: 'reranker', script: path.join(__dirname, 'workers', 'rerankerWorker.js'),
    size: int('RERANK_WORKERS', 1), ...common,
  });
  return { embed, rerank };
}

function createServer({ pools, key = KEY, allowNoKey = ALLOW_NO_KEY } = {}) {
  const keyHash = key ? crypto.createHash('sha256').update(key).digest() : null;
  const fake = env.AI_SERVER_FAKE === '1';
  const missing = () => (fake ? { embeddings: [], reranker: [] } : paths.missing());
  const rerankEnabled = env.ENABLE_RERANKER !== '0';

  function authorized(req) {
    if (!keyHash) return allowNoKey;
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const given = m ? m[1].trim() : String(req.headers['x-api-key'] || '');
    if (!given) return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), keyHash);
  }

  function modelState(pool, missingFiles, enabled = true) {
    if (!enabled) return 'disabled';
    if (missingFiles.length) return 'missing';
    return pool.state;
  }

  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, 'http://x');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    let status = 200;
    const send = (code, body, headers = {}) => {
      status = code;
      const data = JSON.stringify(body);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(data);
    };
    const fail = (code, type, message, headers) => send(code, { error: { message, type, code: type } }, headers);
    try {
      if (req.method === 'GET' && (route === '/health' || route === '/')) {
        const miss = missing();
        const body = {
          ok: true,
          embeddings: modelState(pools.embed, miss.embeddings),
          reranker: modelState(pools.rerank, miss.reranker, rerankEnabled),
        };
        if (authorized(req)) {
          body.models = { embeddings: EMBED_MODEL, reranker: RERANK_MODEL };
          body.detail = { embeddings: pools.embed.status(), reranker: pools.rerank.status(), missing: miss, modelsDir: paths.MODELS_DIR };
        }
        return send(200, body);
      }
      if (!['/v1/embeddings', '/embeddings', '/v1/rerank', '/rerank'].includes(route)) return fail(404, 'not_found', 'unknown route');
      if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'use POST');
      if (!authorized(req)) return fail(401, 'unauthorized', 'missing or wrong API key (Authorization: Bearer ...)');

      let body;
      try {
        body = await readJson(req, MAX_BODY);
      } catch (e) {
        return fail(e.code === 'too_large' ? 413 : 400, 'invalid_request_error', e.message);
      }

      if (route.endsWith('/embeddings')) {
        const model = String(body.model || EMBED_MODEL);
        if (!/bge-?m3/i.test(model)) return fail(404, 'model_not_found', `this server serves ${EMBED_MODEL}, not ${model}`);
        const input = typeof body.input === 'string' ? [body.input] : body.input;
        if (!Array.isArray(input) || !input.length || input.some(x => typeof x !== 'string')) {
          return fail(400, 'invalid_request_error', 'input must be a non-empty string or array of strings');
        }
        if (input.length > MAX_INPUTS) return fail(400, 'invalid_request_error', `at most ${MAX_INPUTS} inputs per request`);
        const miss = missing().embeddings;
        if (miss.length) return fail(503, 'model_missing', `model files missing: ${miss.join(', ')}`);
        const interactive = input.length <= INTERACTIVE_MAX;
        if (interactive && pools.embed.state !== 'ready') return fail(503, 'model_loading', `embeddings model is ${pools.embed.state}`, { 'Retry-After': '5' });
        const reply = await pools.embed.run({ op: 'embed', texts: input }, { priority: interactive ? 'high' : 'low' });
        const buf = Buffer.from(reply.vectors, 'base64');
        const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        const dim = reply.dim;
        const base64 = body.encoding_format === 'base64';
        const data = input.map((_, i) => {
          const v = all.subarray(i * dim, (i + 1) * dim);
          return {
            object: 'embedding',
            index: i,
            embedding: base64 ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') : Array.from(v, x => Math.round(x * 1e7) / 1e7),
          };
        });
        return send(200, { object: 'list', data, model: EMBED_MODEL, usage: { prompt_tokens: reply.tokens || 0, total_tokens: reply.tokens || 0 } });
      }

      // rerank
      if (!rerankEnabled) return fail(503, 'model_disabled', 'reranker is disabled on this server (ENABLE_RERANKER=0)');
      const query = typeof body.query === 'string' ? body.query : '';
      const docs = Array.isArray(body.documents) ? body.documents.map(d => (typeof d === 'string' ? d : d && typeof d.text === 'string' ? d.text : null)) : null;
      if (!query.trim() || !docs || docs.some(d => d === null)) {
        return fail(400, 'invalid_request_error', 'query must be a string and documents an array of strings or {text}');
      }
      if (docs.length > MAX_DOCUMENTS) return fail(400, 'invalid_request_error', `at most ${MAX_DOCUMENTS} documents per request`);
      if (!docs.length) return send(200, { model: RERANK_MODEL, results: [], usage: { total_tokens: 0 } });
      const miss = missing().reranker;
      if (miss.length) return fail(503, 'model_missing', `model files missing: ${miss.join(', ')}`);
      if (pools.rerank.state !== 'ready') return fail(503, 'model_loading', `reranker is ${pools.rerank.state}`, { 'Retry-After': '5' });
      const reply = await pools.rerank.run({ op: 'rerank', query, documents: docs }, { priority: docs.length <= 16 ? 'high' : 'low' });
      let results = reply.scores.map((logit, index) => ({ index, relevance_score: sigmoid(logit), logit }));
      results.sort((a, b) => b.logit - a.logit);
      const topN = parseInt(body.top_n, 10);
      if (topN > 0) results = results.slice(0, topN);
      if (body.return_documents) results = results.map(r => ({ ...r, document: { text: docs[r.index] } }));
      return send(200, { model: RERANK_MODEL, results, usage: { total_tokens: reply.tokens || 0 } });
    } catch (e) {
      const map = { busy: 503, queue_timeout: 503, model_unavailable: 503, model_loading: 503, timeout: 504, worker_crashed: 502, model_error: 500 };
      const code = map[e.code] || 500;
      if (code === 500) console.error('[ai-server]', e);
      return fail(code, e.code || 'server_error', e.message, code === 503 ? { 'Retry-After': '5' } : {});
    } finally {
      if (LOG_REQUESTS) console.log(`${new Date().toISOString()} ${req.method} ${route} ${status} ${Date.now() - t0}ms`);
    }
  });
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        const e = new Error(`body larger than ${limit} bytes`);
        e.code = 'too_large';
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('body must be a JSON object');
        resolve(v);
      } catch (e) {
        reject(new Error(`invalid JSON: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sigmoid(x) {
  return Math.round((1 / (1 + Math.exp(-x))) * 1e6) / 1e6;
}

function main() {
  if (!KEY) {
    if (!ALLOW_NO_KEY) {
      console.error('AI_SERVER_KEY is not set. Pick a long random key (for example: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))")');
      console.error('and set it in the environment (start-ai-server.cmd reads it from ai-server.env). Refusing to start without one.');
      process.exit(1);
    }
    if (!isLoopback(HOST)) {
      console.error('AI_SERVER_ALLOW_NO_KEY=1 is only allowed with AI_SERVER_HOST=127.0.0.1. Set AI_SERVER_KEY instead.');
      process.exit(1);
    }
    console.warn('WARNING: running WITHOUT an API key. Never expose this port through a tunnel in this mode:');
    console.warn('         tunnel traffic arrives from localhost, so anyone on the internet could use it.');
  }
  const miss = env.AI_SERVER_FAKE === '1' ? { embeddings: [], reranker: [] } : paths.missing();
  const pools = createPools();
  if (!miss.embeddings.length) pools.embed.start();
  if (!miss.reranker.length && env.ENABLE_RERANKER !== '0') pools.rerank.start();
  const server = createServer({ pools });
  server.listen(PORT, HOST, () => {
    console.log(`Pasokhyar AI server on http://${HOST}:${PORT}  (models: ${paths.MODELS_DIR})`);
    if (miss.embeddings.length) console.warn(`  embeddings: MISSING ${miss.embeddings.join(', ')}  -> run: npm run download-models`);
    else console.log(`  embeddings: loading ${EMBED_MODEL} ...`);
    if (env.ENABLE_RERANKER === '0') console.log('  reranker: disabled');
    else if (miss.reranker.length) console.warn(`  reranker: MISSING ${miss.reranker.join(', ')}  (optional; see README)`);
    else console.log(`  reranker: loading ${RERANK_MODEL} ...`);
  });
  pools.embed.on('ready', () => console.log(`  embeddings: ready (${JSON.stringify(pools.embed.info)})`));
  pools.rerank.on('ready', () => console.log('  reranker: ready'));
  const shutdown = () => {
    pools.embed.stop();
    pools.rerank.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createServer, createPools };

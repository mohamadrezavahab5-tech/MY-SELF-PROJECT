'use strict';
// Parent side of the model workers (workers/*.js): spawns N copies of one
// worker script, feeds them jobs, and keeps them alive.
//
// Lessons carried over from the owner's crm-companion (server/bgeEmbeddings.js,
// server/reranker.js and their commit history), each one a real incident there:
//
// * One job in flight per worker. The CRM wrote every request straight to the
//   worker's stdin; overlapping session.run() calls then hung. Here jobs wait
//   in OUR queue and a worker only ever sees the next one after answering the
//   previous one (the worker also serializes internally, as a second guard).
//
// * A timeout must kill the worker. For a stuck-but-alive process 'exit' never
//   fires, so without a kill every later job queued behind the wedged one and
//   paid the full timeout, forever. Because only one job is in flight, the
//   execution timer measures the model's own run time, never time spent
//   waiting in the queue, so a burst of traffic cannot be mistaken for a hang
//   (which in the CRM turned into a self-sustaining kill/respawn loop).
//
// * Writing to a just-killed worker's stdin throws synchronously in the gap
//   before 'exit' fires; that is caught and treated like any other failure.
//
// * Respawn is eager (a warm model is the whole point of a dedicated server)
//   with exponential backoff when the model fails to even load, so a missing
//   or corrupt file does not turn into a CPU-burning crash loop.
//
// Two priorities: 'high' for interactive calls (a visitor's question, a
// handful of texts) and 'low' for bulk jobs (embedding a whole FAQ). A bulk
// batch can never make a visitor wait behind a queue of other bulk batches.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

class JobError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

class ModelPool extends EventEmitter {
  constructor({
    name, script, size = 1, env = {},
    execTimeoutMs = 60000, queueTimeoutMs = 30000, readyTimeoutMs = 300000, maxQueue = 200,
  }) {
    super();
    this.name = name;
    this.script = script;
    this.env = env;
    this.execTimeoutMs = execTimeoutMs;
    this.queueTimeoutMs = queueTimeoutMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.maxQueue = maxQueue;
    this.high = [];
    this.low = [];
    this.nextId = 1;
    this.stopped = false;
    this.info = null;
    this.lastError = '';
    this.stats = { done: 0, failed: 0, timeouts: 0, crashes: 0, busyMs: 0 };
    this.slots = Array.from({ length: Math.max(1, size) }, (_, i) => ({ index: i, proc: null, state: 'stopped', job: null, failures: 0, timer: null }));
  }

  start() {
    this.stopped = false;
    for (const slot of this.slots) this.spawn(slot);
    return this;
  }

  // 'ready' if any worker can take jobs, else 'loading' while one is (re)starting, else 'error'.
  get state() {
    if (this.slots.some(s => s.state === 'ready' || s.state === 'busy')) return 'ready';
    if (this.slots.some(s => s.state === 'loading' || s.state === 'backoff')) {
      return this.slots.every(s => s.failures >= 3) ? 'error' : 'loading';
    }
    return this.stopped ? 'stopped' : 'error';
  }

  get queued() {
    return this.high.length + this.low.length;
  }

  spawn(slot) {
    if (this.stopped) return;
    clearTimeout(slot.timer);
    slot.state = 'loading';
    let buf = '';
    let proc;
    try {
      proc = spawn(process.execPath, [this.script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.env },
        windowsHide: true,
      });
    } catch (e) {
      this.lastError = e.message;
      return this.scheduleRespawn(slot, true);
    }
    slot.proc = proc;
    // A model that never finishes loading (e.g. swapping on a machine without
    // enough RAM) is killed and retried with backoff like any other failure.
    slot.timer = setTimeout(() => {
      if (slot.proc === proc && slot.state === 'loading') {
        this.lastError = `model did not load within ${this.readyTimeoutMs} ms`;
        proc.kill('SIGKILL');
      }
    }, this.readyTimeoutMs);

    proc.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          console.error(`[${this.name}] bad line from worker: ${line.slice(0, 200)}`);
          continue;
        }
        this.onMessage(slot, proc, msg);
      }
    });
    proc.stderr.on('data', d => {
      const text = d.toString('utf8').trim();
      if (!text) return;
      console.error(`[${this.name}#${slot.index}] ${text}`);
      const fatal = text.match(/fatal init error: (.*)/);
      if (fatal) this.lastError = fatal[1];
    });
    proc.stdin.on('error', () => {}); // EPIPE after a crash; handled by 'exit'
    proc.on('error', err => {
      this.lastError = err.message;
    });
    proc.on('exit', (code, signal) => this.onExit(slot, proc, code, signal));
  }

  onMessage(slot, proc, msg) {
    if (slot.proc !== proc) return;
    if (msg.type === 'ready') {
      clearTimeout(slot.timer);
      slot.state = 'ready';
      slot.failures = 0;
      this.info = msg.info || {};
      this.emit('ready', slot.index);
      return this.pump();
    }
    const job = slot.job;
    if (!job || msg.id !== job.id) return;
    clearTimeout(slot.timer);
    slot.job = null;
    slot.state = 'ready';
    this.stats.busyMs += Date.now() - job.startedAt;
    if (msg.error) {
      this.stats.failed++;
      job.reject(new JobError('model_error', msg.error));
    } else {
      this.stats.done++;
      job.resolve(msg);
    }
    this.pump();
  }

  onExit(slot, proc, code, signal) {
    if (slot.proc !== proc) return;
    clearTimeout(slot.timer);
    const wasLoading = slot.state === 'loading';
    slot.proc = null;
    const job = slot.job;
    slot.job = null;
    if (job) {
      // Not retried: a job that crashed a worker may well crash the next one too.
      this.stats.failed++;
      job.reject(new JobError(job.timedOut ? 'timeout' : 'worker_crashed',
        job.timedOut ? `${this.name} timed out after ${this.execTimeoutMs} ms` : `${this.name} worker exited (code=${code}, signal=${signal})`));
    }
    if (this.stopped) {
      slot.state = 'stopped';
      return;
    }
    if (!job || !job.timedOut) this.stats.crashes++;
    if (wasLoading && !this.lastError) this.lastError = `worker exited while loading (code=${code}, signal=${signal})`;
    console.error(`[${this.name}#${slot.index}] worker exited (code=${code}, signal=${signal})${wasLoading ? ' while loading' : ''}, respawning`);
    this.scheduleRespawn(slot, wasLoading);
  }

  scheduleRespawn(slot, failedToLoad) {
    if (failedToLoad) slot.failures++;
    slot.state = 'backoff';
    const delay = failedToLoad ? Math.min(60000, 1000 * 2 ** Math.min(slot.failures - 1, 6)) : 300;
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => this.spawn(slot), delay);
    if (slot.timer.unref) slot.timer.unref();
    // Nobody can serve the queue any time soon: fail it now instead of letting
    // every caller wait out its own queue timeout.
    if (this.state === 'error') this.failQueued(new JobError('model_unavailable', this.lastError || `${this.name} is not available`));
  }

  failQueued(err) {
    for (const q of [this.high, this.low]) {
      for (const job of q.splice(0)) {
        clearTimeout(job.queueTimer);
        job.reject(err);
      }
    }
  }

  // payload: the worker request without id. Resolves with the worker's reply.
  run(payload, { priority = 'low', queueTimeoutMs = this.queueTimeoutMs } = {}) {
    if (this.stopped) return Promise.reject(new JobError('model_unavailable', `${this.name} is stopped`));
    if (this.state === 'error') return Promise.reject(new JobError('model_unavailable', this.lastError || `${this.name} failed to load`));
    if (this.queued >= this.maxQueue) return Promise.reject(new JobError('busy', `${this.name} queue is full`));
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, payload, resolve, reject, enqueuedAt: Date.now(), timedOut: false };
      const q = priority === 'high' ? this.high : this.low;
      job.queueTimer = setTimeout(() => {
        const i = q.indexOf(job);
        if (i >= 0) q.splice(i, 1);
        this.stats.timeouts++;
        reject(new JobError('queue_timeout', `${this.name} busy: waited ${queueTimeoutMs} ms in queue`));
      }, queueTimeoutMs);
      q.push(job);
      this.pump();
    });
  }

  pump() {
    for (const slot of this.slots) {
      if (slot.state !== 'ready' || slot.job) continue;
      const job = this.high.shift() || this.low.shift();
      if (!job) return;
      clearTimeout(job.queueTimer);
      slot.job = job;
      slot.state = 'busy';
      job.startedAt = Date.now();
      const proc = slot.proc;
      slot.timer = setTimeout(() => {
        if (slot.job !== job) return;
        job.timedOut = true;
        this.stats.timeouts++;
        this.lastError = `${this.name} job exceeded ${this.execTimeoutMs} ms; worker killed`;
        proc.kill('SIGKILL'); // 'exit' rejects the job and respawns
      }, this.execTimeoutMs);
      try {
        proc.stdin.write(JSON.stringify({ id: job.id, ...job.payload }) + '\n');
      } catch (e) {
        clearTimeout(slot.timer);
        slot.job = null;
        slot.state = 'loading';
        job.reject(new JobError('worker_crashed', e.message));
        proc.kill('SIGKILL');
      }
    }
  }

  stop() {
    this.stopped = true;
    this.failQueued(new JobError('model_unavailable', 'server shutting down'));
    for (const slot of this.slots) {
      clearTimeout(slot.timer);
      if (slot.proc) {
        try { slot.proc.stdin.end(); } catch {}
        slot.proc.kill();
      }
    }
  }

  status() {
    return {
      state: this.state,
      workers: this.slots.map(s => s.state),
      queued: this.queued,
      info: this.info,
      lastError: this.lastError || undefined,
      stats: this.stats,
    };
  }
}

module.exports = { ModelPool, JobError };

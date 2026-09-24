'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// Node's built-in SQLite (no native npm module to download or compile, which
// matters when deploying from inside Iran). This thin adapter gives it the
// small better-sqlite3-style surface the app uses: prepare().get/all/run,
// exec, pragma, transaction.
function bindable(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class Statement {
  constructor(stmt) { this.stmt = stmt; }
  get(...args) { return this.stmt.get(...args.map(bindable)); }
  all(...args) { return this.stmt.all(...args.map(bindable)); }
  run(...args) { return this.stmt.run(...args.map(bindable)); }
}

class Database {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.cache = new Map();
    this.depth = 0;
  }

  prepare(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = new Statement(this.db.prepare(sql));
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql) { this.db.exec(sql); }

  pragma(text, { simple = false } = {}) {
    const rows = this.db.prepare(`PRAGMA ${text}`).all();
    if (!simple) return rows;
    const first = rows[0];
    return first ? Object.values(first)[0] : undefined;
  }

  // Returns a function that runs fn atomically; nested calls use savepoints.
  transaction(fn) {
    return (...args) => {
      const sp = `sp${this.depth}`;
      this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        return result;
      } catch (e) {
        this.depth--;
        this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      }
    };
  }

  close() { this.db.close(); }
}

// Schema migrations, applied in order and tracked with PRAGMA user_version.
// Never edit a shipped migration; append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_expires_at INTEGER,
    ref_code TEXT NOT NULL UNIQUE,
    referred_by INTEGER REFERENCES users(id),
    sheba TEXT NOT NULL DEFAULT '',
    balance INTEGER NOT NULL DEFAULT 0,          -- Toman, unpaid commission
    total_earned INTEGER NOT NULL DEFAULT 0,     -- Toman, lifetime commission
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE bots (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    industry TEXT NOT NULL DEFAULT '',
    welcome TEXT NOT NULL DEFAULT '',
    fallback TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#4f46e5',
    position TEXT NOT NULL DEFAULT 'right',
    lead_form INTEGER NOT NULL DEFAULT 1,
    allowed_domains TEXT NOT NULL DEFAULT '',
    bale_token TEXT NOT NULL DEFAULT '',
    bale_secret TEXT NOT NULL DEFAULT '',
    telegram_token TEXT NOT NULL DEFAULT '',
    telegram_secret TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX bots_user ON bots(user_id);

  CREATE TABLE faqs (
    id INTEGER PRIMARY KEY,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    alternates TEXT NOT NULL DEFAULT '[]',       -- JSON array of other phrasings
    answer TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX faqs_bot ON faqs(bot_id);

  -- One row per visitor question, whatever the outcome.
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'web',         -- web | page | bale | telegram | test
    question TEXT NOT NULL,
    type TEXT NOT NULL,                          -- answer | suggest | fallback | limit
    faq_id INTEGER REFERENCES faqs(id) ON DELETE SET NULL,
    score REAL NOT NULL DEFAULT 0,
    helpful INTEGER,                             -- NULL unknown, 1 yes, 0 no
    resolved INTEGER NOT NULL DEFAULT 0,         -- owner handled this unanswered question
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_bot_time ON messages(bot_id, created_at);
  CREATE INDEX messages_bot_open ON messages(bot_id, type, resolved);

  CREATE TABLE leads (
    id INTEGER PRIMARY KEY,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',          -- new | done
    created_at INTEGER NOT NULL
  );
  CREATE INDEX leads_bot ON leads(bot_id, status);

  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    plan TEXT NOT NULL,
    months INTEGER NOT NULL,
    amount INTEGER NOT NULL,                     -- Toman actually charged
    discount INTEGER NOT NULL DEFAULT 0,         -- Toman
    referrer_id INTEGER REFERENCES users(id),
    authority TEXT UNIQUE,
    ref_id TEXT,
    card_pan TEXT,
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | paid | failed
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  CREATE INDEX orders_user ON orders(user_id);

  CREATE TABLE commissions (
    id INTEGER PRIMARY KEY,
    referrer_id INTEGER NOT NULL REFERENCES users(id),
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
    amount INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE payouts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL,
    sheba TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested',    -- requested | paid | rejected
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  `,
  `
  -- Sales enquiries (on-premise / enterprise) from the public site.
  CREATE TABLE contact_requests (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'enterprise',
    name TEXT NOT NULL,
    org TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',          -- new | done
    created_at INTEGER NOT NULL
  );
  `,
];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

let instance = null;
function get() {
  if (!instance) instance = open(process.env.DB_FILE || path.join(config.dataDir, 'app.db'));
  return instance;
}

// Tests call this to start from an empty database.
function reset(file = ':memory:') {
  if (instance) instance.close();
  instance = open(file);
  return instance;
}

module.exports = { get, reset };

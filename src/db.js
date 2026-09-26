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
  `
  -- Full transcript per visitor session (bot, visitor and human operator
  -- messages). Powers live operator chat and conversation memory for the AI.
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'web',
    visitor_name TEXT NOT NULL DEFAULT '',
    visitor_phone TEXT NOT NULL DEFAULT '',
    page_url TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'bot',            -- bot | human (visitor asked for an operator)
    operator_unread INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL,
    UNIQUE (bot_id, session_id)
  );
  CREATE INDEX conversations_bot ON conversations(bot_id, mode, last_message_at);

  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender TEXT NOT NULL,                        -- visitor | bot | operator | system
    text TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',             -- JSON, e.g. {"kind":"passage","sources":[...]}
    created_at INTEGER NOT NULL
  );
  CREATE INDEX chat_messages_conv ON chat_messages(conversation_id, id);

  -- Website knowledge: pages crawled from the customer's site, split into passages.
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | crawling | ready | error
    pages INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    crawled_at INTEGER
  );
  CREATE INDEX sources_bot ON sources(bot_id);

  CREATE TABLE passages (
    id INTEGER PRIMARY KEY,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    heading TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX passages_bot ON passages(bot_id);

  ALTER TABLE bots ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bots ADD COLUMN live_chat INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE bots ADD COLUMN operator_seen_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bots ADD COLUMN proactive_text TEXT NOT NULL DEFAULT '';
  ALTER TABLE bots ADD COLUMN proactive_delay INTEGER NOT NULL DEFAULT 0;  -- seconds; 0 = off
  ALTER TABLE bots ADD COLUMN proactive_path TEXT NOT NULL DEFAULT '';     -- only on URLs containing this
  `,
  `
  -- Quality control (QC) reviews of conversations: automatic metrics,
  -- AI rubric reviews and human reviewer scores.
  CREATE TABLE qc_reviews (
    id INTEGER PRIMARY KEY,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    reviewer TEXT NOT NULL,                      -- auto | ai | human
    reviewer_name TEXT NOT NULL DEFAULT '',
    score REAL,                                  -- 0..100, NULL = not scorable
    criteria TEXT NOT NULL DEFAULT '{}',         -- JSON { criterionId: { score, note } }
    flags TEXT NOT NULL DEFAULT '[]',            -- JSON array of issue codes
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX qc_reviews_bot ON qc_reviews(bot_id, created_at);
  CREATE INDEX qc_reviews_conv ON qc_reviews(conversation_id);

  ALTER TABLE bots ADD COLUMN qc_rubric TEXT NOT NULL DEFAULT '';        -- JSON; '' = default rubric
  ALTER TABLE bots ADD COLUMN lang TEXT NOT NULL DEFAULT 'fa';           -- widget + bot message language: fa | en | ar | tr
  ALTER TABLE conversations ADD COLUMN closed_at INTEGER;
  `,
  `
  -- Site-owner settings edited in /admin/settings (src/settings.js):
  -- key -> JSON value, overlaying env / code defaults. Absent key = default.
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Blog posts written or edited in the admin panel. A row whose slug matches a
  -- built-in post (src/content/blog.js) replaces it; deleted = 1 hides it.
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    meta_description TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,                          -- YYYY-MM-DD
    reading_minutes INTEGER NOT NULL DEFAULT 1,
    published INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- Integrations (src/integrations/): API keys, outgoing webhooks with a
  -- persisted delivery queue, the polling event feed, and per-account
  -- click-to-call / Asterisk AMI / screen-pop settings.
  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,   -- NULL = all of the account's bots
    name TEXT NOT NULL DEFAULT '',
    prefix TEXT NOT NULL,                        -- first characters, shown in the dashboard
    key_hash TEXT NOT NULL UNIQUE,               -- SHA-256 of the key; the key itself is never stored
    last_used_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX api_keys_user ON api_keys(user_id);

  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,   -- NULL = all bots
    url TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    events TEXT NOT NULL DEFAULT '[]',           -- JSON array of event names
    secret TEXT NOT NULL,                        -- HMAC-SHA256 signing key
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX webhooks_user ON webhooks(user_id);

  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    uid TEXT NOT NULL UNIQUE,                    -- X-Pasokhyar-Delivery
    event TEXT NOT NULL,
    body TEXT NOT NULL,                          -- the exact JSON that is signed and sent
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | success | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,                     -- due time while pending
    response_code INTEGER,
    response_body TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    last_attempt_at INTEGER
  );
  CREATE INDEX webhook_deliveries_hook ON webhook_deliveries(webhook_id, id);
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

  -- Events for GET /api/v1/events (recorded for accounts with an API key).
  CREATE TABLE integration_events (
    id INTEGER PRIMARY KEY,                      -- polling cursor (?since=)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id INTEGER,
    event TEXT NOT NULL,
    body TEXT NOT NULL,                          -- same JSON envelope webhooks receive
    created_at INTEGER NOT NULL
  );
  CREATE INDEX integration_events_user ON integration_events(user_id, id);
  CREATE INDEX integration_events_time ON integration_events(created_at);

  CREATE TABLE integration_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    dial_preset TEXT NOT NULL DEFAULT 'tel',     -- tel | sip | callto | zoiper | ciscotel | custom
    dial_template TEXT NOT NULL DEFAULT '',      -- custom template with {phone} / {e164} / {domain}
    sip_domain TEXT NOT NULL DEFAULT '',
    dial_prefix TEXT NOT NULL DEFAULT '',
    ami_enabled INTEGER NOT NULL DEFAULT 0,
    ami_host TEXT NOT NULL DEFAULT '',
    ami_port INTEGER NOT NULL DEFAULT 5038,
    ami_username TEXT NOT NULL DEFAULT '',
    ami_secret TEXT NOT NULL DEFAULT '',         -- never rendered back
    ami_tech TEXT NOT NULL DEFAULT 'PJSIP',      -- PJSIP | SIP | IAX2 | Local
    ami_context TEXT NOT NULL DEFAULT 'from-internal',
    ami_caller_id TEXT NOT NULL DEFAULT '',
    ami_prefix TEXT NOT NULL DEFAULT '',         -- e.g. 9 for an outside line
    ami_extensions TEXT NOT NULL DEFAULT '',     -- operator extensions, one per line: "101 مریم"
    pop_key TEXT NOT NULL DEFAULT '',            -- screen-pop link HMAC key; '' = link off
    pop_expires_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
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

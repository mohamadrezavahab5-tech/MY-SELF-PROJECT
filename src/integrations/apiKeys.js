'use strict';
// Per-account API keys for /api/v1. The full key is shown to the owner once;
// only its SHA-256 is stored (keys are 192-bit random, so a fast hash is fine).
const crypto = require('crypto');
const db = require('../db');
const { token } = require('../util');

const PREFIX = 'pky_';

function hash(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

// -> { key (plaintext, show once), row }
function create(userId, { name = '', botId = null } = {}) {
  const key = PREFIX + token(24);
  const now = Date.now();
  const info = db.get().prepare(`
    INSERT INTO api_keys (user_id, bot_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, botId || null, String(name).trim().slice(0, 60), key.slice(0, PREFIX.length + 6), hash(key), now);
  return { key, row: db.get().prepare('SELECT * FROM api_keys WHERE id = ?').get(info.lastInsertRowid) };
}

function list(userId) {
  return db.get().prepare(`
    SELECT k.*, b.name AS bot_name FROM api_keys k LEFT JOIN bots b ON b.id = k.bot_id
    WHERE k.user_id = ? ORDER BY k.revoked_at IS NOT NULL, k.id DESC
  `).all(userId);
}

function revoke(userId, id) {
  return db.get().prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), Number(id), userId).changes > 0;
}

// Returns the active key row (with its owner) or null.
function verify(raw) {
  const key = String(raw || '').trim();
  if (!key.startsWith(PREFIX) || key.length > 100) return null;
  const row = db.get().prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(hash(key));
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    db.get().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, row.id);
  }
  return row;
}

function hasActive(userId) {
  return !!db.get().prepare('SELECT 1 FROM api_keys WHERE user_id = ? AND revoked_at IS NULL LIMIT 1').get(userId);
}

module.exports = { create, list, revoke, verify, hasActive, PREFIX };

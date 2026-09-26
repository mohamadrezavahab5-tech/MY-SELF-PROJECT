'use strict';
// Per-account integration settings (one row per user in integration_settings):
// click-to-call dial link, Asterisk/Issabel AMI connection and the screen-pop
// link key. Secrets stored here (AMI secret, screen-pop key) never leave the
// server: views get masked values from publicView().
const db = require('../db');

const DEFAULTS = {
  dial_preset: 'tel',
  dial_template: '',
  sip_domain: '',
  dial_prefix: '',
  ami_enabled: 0,
  ami_host: '',
  ami_port: 5038,
  ami_username: '',
  ami_secret: '',
  ami_tech: 'PJSIP',
  ami_context: 'from-internal',
  ami_caller_id: '',
  ami_prefix: '',
  ami_extensions: '',
  pop_key: '',
  pop_expires_at: 0,
};

const COLUMNS = Object.keys(DEFAULTS);

function userIdOf(user) {
  return typeof user === 'object' && user ? Number(user.id) : Number(user);
}

function get(user) {
  const id = userIdOf(user);
  const row = id ? db.get().prepare('SELECT * FROM integration_settings WHERE user_id = ?').get(id) : null;
  return { ...DEFAULTS, ...(row || {}), user_id: id };
}

// Writes only the given columns; unknown keys are ignored.
function save(user, patch) {
  const id = userIdOf(user);
  const fields = Object.keys(patch).filter(k => COLUMNS.includes(k));
  if (!id || !fields.length) return get(id);
  const now = Date.now();
  const conn = db.get();
  conn.prepare('INSERT OR IGNORE INTO integration_settings (user_id, updated_at) VALUES (?, ?)').run(id, now);
  conn.prepare(`UPDATE integration_settings SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = ? WHERE user_id = ?`)
    .run(...fields.map(f => patch[f]), now, id);
  return get(id);
}

// Operator extensions, one per line: "101" or "101 مریم" or "101=مریم".
function parseExtensions(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z0-9_.-]{1,32})(?:\s*[=:\s]\s*(.{0,40}))?$/);
    if (m && !out.some(x => x.ext === m[1])) out.push({ ext: m[1], name: (m[2] || '').trim() });
  }
  return out.slice(0, 50);
}

module.exports = { get, save, parseExtensions, DEFAULTS };

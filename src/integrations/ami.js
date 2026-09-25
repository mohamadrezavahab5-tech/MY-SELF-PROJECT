'use strict';
// Minimal Asterisk Manager Interface (AMI) client over node:net, enough for
// click-to-call on Asterisk / Issabel / FreePBX: Login, Ping, Originate, Logoff.
//
// Wire format: the server greets with one line ("Asterisk Call Manager/x.y"),
// then every action and reply is a block of "Key: Value" lines ending in a
// blank line. Replies carry our ActionID; unsolicited "Event:" blocks are ignored.
//
// Where we connect: only the host/port saved in the account's settings (never
// per-request input). Private LAN addresses are legitimate here (a PBX usually
// lives on one); link-local / metadata addresses are always refused, and
// loopback only when AMI_ALLOW_LOOPBACK=1 (on-premise installs that run
// Asterisk on the same machine).
const net = require('net');
const dns = require('dns');

const CONNECT_TIMEOUT_MS = 6000;
const ACTION_TIMEOUT_MS = 8000;

const TECHS = ['PJSIP', 'SIP', 'IAX2', 'Local'];

function loopbackAllowed() {
  return process.env.AMI_ALLOW_LOOPBACK === '1';
}

function forbiddenIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 169 && b === 254) return true;           // link-local, cloud metadata
    if (a === 0 || a >= 224) return true;              // "this network", multicast, reserved
    if (a === 127) return !loopbackAllowed();
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return forbiddenIp(mapped[1]);
    if (v === '::1') return !loopbackAllowed();
    return v === '::' || /^(fe[89ab]|ff)/.test(v);
  }
  return true;
}

function lookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some(a => forbiddenIp(a.address))) return callback(new Error('blocked_address'));
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function validHost(host) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!h || h.length > 253) return false;
  if (net.isIP(h)) return !forbiddenIp(h);
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$/.test(h) && h.toLowerCase() !== 'localhost';
}

// AMI header values must never contain line breaks (they would inject actions).
function clean(v, max = 80) {
  return String(v ?? '').replace(/[\r\n\0]/g, '').trim().slice(0, max);
}

function block(fields) {
  return Object.entries(fields).map(([k, v]) => `${k}: ${clean(v, 200)}`).join('\r\n') + '\r\n\r\n';
}

function parseBlock(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// Opens a connection, waits for the banner. Resolves to a session with
// send(fields) -> reply object, and close().
function connect({ host, port }) {
  return new Promise((resolve, reject) => {
    const h = String(host || '').replace(/^\[|\]$/g, '');
    if (!validHost(h)) return reject(Object.assign(new Error('blocked_address'), { code: 'blocked' }));
    const socket = net.connect({ host: h, port: Number(port) || 5038, lookup });
    socket.setEncoding('utf8');
    let buf = '';
    let banner = null;
    let seq = 0;
    const pending = new Map();
    const fail = err => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
      pending.clear();
    };
    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
    }, CONNECT_TIMEOUT_MS);

    socket.on('data', chunk => {
      buf += chunk.replace(/\r\n/g, '\n');
      if (banner === null) {
        const nl = buf.indexOf('\n');
        if (nl < 0) { if (buf.length > 512) socket.destroy(); return; }
        banner = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        clearTimeout(connectTimer);
        if (!/Asterisk Call Manager|Call Manager/i.test(banner)) {
          socket.destroy();
          return reject(Object.assign(new Error('not_ami'), { code: 'not_ami' }));
        }
        resolve(session);
      }
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const msg = parseBlock(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        const id = msg.actionid;
        if (id && pending.has(id) && msg.response) {
          const p = pending.get(id);
          pending.delete(id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
      if (buf.length > 1_000_000) socket.destroy();
    });
    socket.on('error', err => {
      clearTimeout(connectTimer);
      const e = Object.assign(new Error(err.message === 'blocked_address' ? 'blocked_address' : 'connect_failed'), {
        code: err.message === 'blocked_address' ? 'blocked' : 'connect_failed', cause: err.code,
      });
      fail(e);
      reject(e);
    });
    socket.on('close', () => {
      clearTimeout(connectTimer);
      fail(Object.assign(new Error('closed'), { code: 'closed' }));
      if (banner === null) reject(Object.assign(new Error('connect_failed'), { code: 'connect_failed' }));
    });

    const session = {
      banner: () => banner,
      send(fields) {
        return new Promise((res, rej) => {
          const id = `pky-${++seq}`;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(Object.assign(new Error('timeout'), { code: 'timeout' }));
          }, ACTION_TIMEOUT_MS);
          pending.set(id, { resolve: res, reject: rej, timer });
          socket.write(block({ ...fields, ActionID: id }));
        });
      },
      async close() {
        try {
          if (!socket.destroyed) await Promise.race([session.send({ Action: 'Logoff' }), new Promise(r => setTimeout(r, 1000))]);
        } catch { /* ignore */ }
        socket.destroy();
      },
    };
  });
}

const MESSAGES = {
  ok: 'اتصال برقرار شد.',
  blocked: 'این آدرس برای اتصال مجاز نیست.',
  connect_failed: 'اتصال به سرور برقرار نشد. آدرس، پورت و فایروال را بررسی کنید.',
  timeout: 'سرور در زمان مناسب جواب نداد.',
  not_ami: 'روی این پورت سرویس AMI پیدا نشد.',
  auth_failed: 'نام کاربری یا رمز AMI درست نیست (یا IP سرور ما در permit نیست).',
  originate_failed: 'مرکز تماس درخواست تماس را نپذیرفت.',
  not_configured: 'اتصال Asterisk / Issabel هنوز تنظیم نشده است.',
  bad_number: 'شماره برای تماس معتبر نیست.',
  bad_extension: 'داخلی اپراتور تعریف نشده است.',
  closed: 'اتصال قطع شد.',
};

function result(code, extra = {}) {
  return { ok: code === 'ok', code, message: MESSAGES[code] || MESSAGES.connect_failed, ...extra };
}

async function withSession(cfg, fn) {
  let s;
  try {
    s = await connect({ host: cfg.ami_host, port: cfg.ami_port });
  } catch (e) {
    return result(e.code && MESSAGES[e.code] ? e.code : 'connect_failed');
  }
  try {
    const login = await s.send({ Action: 'Login', Username: cfg.ami_username, Secret: cfg.ami_secret, Events: 'off' });
    if (String(login.response).toLowerCase() !== 'success') return result('auth_failed', { detail: clean(login.message, 120) });
    return await fn(s);
  } catch (e) {
    return result(e.code && MESSAGES[e.code] ? e.code : 'connect_failed');
  } finally {
    s.close();
  }
}

function configured(cfg) {
  return !!(cfg && cfg.ami_enabled && cfg.ami_host && cfg.ami_username && cfg.ami_secret);
}

// Login + Ping.
function testConnection(cfg) {
  if (!(cfg && cfg.ami_host && cfg.ami_username && cfg.ami_secret)) return Promise.resolve(result('not_configured'));
  return withSession(cfg, async s => {
    const pong = await s.send({ Action: 'Ping' });
    if (String(pong.response).toLowerCase() !== 'success') return result('connect_failed', { detail: clean(pong.message, 120) });
    return result('ok', { banner: clean(s.banner(), 60) });
  });
}

function channelFor(cfg, ext) {
  const tech = TECHS.includes(cfg.ami_tech) ? cfg.ami_tech : 'PJSIP';
  return tech === 'Local' ? `Local/${ext}@${cfg.ami_context || 'from-internal'}` : `${tech}/${ext}`;
}

// Rings the operator's extension; when they answer, Asterisk dials `number`
// through `context` (the PBX's normal outbound routes).
function originate(cfg, { ext, number }) {
  if (!configured(cfg)) return Promise.resolve(result('not_configured'));
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(String(ext || ''))) return Promise.resolve(result('bad_extension'));
  const dial = `${cfg.ami_prefix || ''}${number || ''}`;
  if (!/^[0-9*#]{2,24}$/.test(dial)) return Promise.resolve(result('bad_number'));
  const fields = {
    Action: 'Originate',
    Channel: channelFor(cfg, ext),
    Exten: dial,
    Context: cfg.ami_context || 'from-internal',
    Priority: '1',
    Async: 'true',
    Timeout: '30000',
  };
  const callerId = clean(cfg.ami_caller_id, 60);
  if (callerId) fields.CallerID = callerId;
  return withSession(cfg, async s => {
    const r = await s.send(fields);
    if (String(r.response).toLowerCase() !== 'success') return result('originate_failed', { detail: clean(r.message, 120) });
    return result('ok', { message: 'در حال برقراری تماس… اول تلفن داخلی شما زنگ می‌خورد.', channel: fields.Channel, exten: dial });
  });
}

module.exports = { testConnection, originate, configured, validHost, channelFor, TECHS, MESSAGES, clean };

'use strict';
const path = require('path');
const express = require('express');
const compression = require('compression');
const config = require('./config');
const { esc } = require('./util');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// The widget script is loaded by customers' sites: short cache so fixes roll out fast.
app.get('/widget.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Access-Control-Allow-Origin', '*');
  res.sendFile(path.join(__dirname, '..', 'public', 'widget.js'));
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: config.isProd ? '7d' : 0,
  setHeaders(res, file) {
    if (file.endsWith('.woff2')) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      // The widget loads these fonts from customers' sites; fonts are always fetched in CORS mode.
      res.set('Access-Control-Allow-Origin', '*');
    }
  },
}));

app.use('/api/w', require('./routes/widgetApi'));

// Hosted full-page chat: a shareable link for bios, Bale/Instagram, QR codes.
app.get('/c/:key', (req, res, next) => {
  const bot = require('./bots').getBotByKey(req.params.key);
  if (!bot) return next();
  res.set('X-Robots-Tag', 'noindex');
  res.send(`<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${esc(bot.color)}">
<title>${esc(bot.name)} | گفتگو</title>
<link rel="stylesheet" href="/css/fonts.css">
<style>html,body{margin:0;height:100%;background:#f4f5f8;font-family:Vazirmatn,Tahoma,sans-serif}</style>
</head>
<body>
<script src="/widget.js" data-bot="${esc(bot.public_key)}" data-mode="page" async></script>
</body>
</html>`);
});

const siteRoutes = safeRequire('./routes/site');
if (siteRoutes) app.use(siteRoutes);

app.use((req, res) => {
  res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>یافت نشد</title><p style="font-family:Tahoma;text-align:center;margin-top:20vh" dir="rtl">صفحه‌ای که دنبالش بودید پیدا نشد. <a href="/">صفحه‌ی اصلی</a></p>');
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).type('html').send('<!doctype html><meta charset="utf-8"><p dir="rtl" style="font-family:Tahoma;text-align:center;margin-top:20vh">خطایی رخ داد. لطفاً دوباره تلاش کنید.</p>');
});

// Route modules land incrementally; missing ones are skipped rather than crashing.
function safeRequire(p) {
  try {
    return require(p);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(p.replace('./', ''))) return null;
    throw e;
  }
}

module.exports = app;

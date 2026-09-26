'use strict';
// Reference material rendered on /app/integrations: API endpoints, webhook
// payload samples (built with the real shaping code, so they never drift),
// and copy-paste snippets.
const config = require('../config');
const dispatch = require('./dispatch');

const ENDPOINTS = [
  ['GET', '/api/v1/me', 'حساب، کلید و فهرست بات‌ها'],
  ['GET', '/api/v1/bots', 'فهرست بات‌ها'],
  ['GET', '/api/v1/contacts?phone=', 'همه‌چیز درباره‌ی یک شماره: درخواست‌های تماس و گفتگوها (transcripts=1 متن گفتگو را هم می‌دهد)'],
  ['GET', '/api/v1/leads', 'درخواست‌های تماس؛ فیلتر با status=new|done، since، until، phone، bot_id'],
  ['GET', '/api/v1/leads/:id', 'یک درخواست تماس'],
  ['PATCH', '/api/v1/leads/:id', 'تغییر وضعیت: {"status":"done"}'],
  ['POST', '/api/v1/leads/:id/done', 'علامت «تماس گرفته شد» (برای سیستم‌هایی که فقط POST دارند)'],
  ['GET', '/api/v1/conversations', 'گفتگوها؛ فیلتر با session_id، phone، since، until، channel، mode، messages=1'],
  ['GET', '/api/v1/conversations/:id', 'یک گفتگو با همه‌ی پیام‌ها و آخرین نمره‌ی QC'],
  ['GET', '/api/v1/conversations/:id/messages?after_id=', 'پیام‌های تازه‌ی یک گفتگو'],
  ['POST', '/api/v1/conversations/:id/notes', 'یادداشت روی گفتگو: {"text":"…","visibility":"internal|visitor","author":"…"}'],
  ['GET', '/api/v1/bots/:botId/faqs', 'سؤال و جواب‌های یک بات'],
  ['POST', '/api/v1/bots/:botId/faqs', 'افزودن: {"question","answer","alternates":[],"enabled"}'],
  ['GET', '/api/v1/bots/:botId/faqs/:id', 'یک سؤال و جواب'],
  ['PATCH', '/api/v1/bots/:botId/faqs/:id', 'ویرایش بخشی از فیلدها (PUT: همه‌ی فیلدها)'],
  ['DELETE', '/api/v1/bots/:botId/faqs/:id', 'حذف'],
  ['GET', '/api/v1/events?since=', 'رویدادهای تازه برای سیستم‌هایی که وب‌هوک نمی‌گیرند (seq آخرین رویداد را در since بعدی بفرستید)'],
];

function samples() {
  const now = Date.now();
  const bot = { id: 3, name: 'پشتیبانی فروشگاه' };
  const conversation = { id: 902, sessionId: 'w_8f2k1qz', channel: 'web' };
  const raw = {
    'lead.created': { lead: { id: 481, name: 'مریم رضایی', phone: '09121234567', message: 'لطفاً درباره‌ی ارسال به شیراز تماس بگیرید', sessionId: 'w_8f2k1qz', createdAt: now } },
    'conversation.handoff': { online: true, conversation: { ...conversation, visitorName: 'مریم رضایی', visitorPhone: '09121234567', pageUrl: 'https://example.ir/product/12' } },
    'conversation.closed': { conversation },
    'message.created': { conversation, message: { id: 7731, sender: 'visitor', text: 'هزینه‌ی ارسال به شیراز چقدر است؟', createdAt: now } },
    'question.unanswered': { question: 'هزینه‌ی ارسال به شیراز چقدر است؟', sessionId: 'w_8f2k1qz', channel: 'web', type: 'fallback' },
  };
  const out = {};
  for (const [name, p] of Object.entries(raw)) {
    const env = dispatch.envelope(name, { userId: 12, bot, data: dispatch.shape(name, p, bot.id), id: 'evt_k3m9x2p7q4r8s6t5' });
    out[name] = JSON.stringify(env, null, 2);
  }
  return out;
}

function curl(apiKeyHint = 'pky_…') {
  const s = config.siteUrl;
  const monthStart = `${new Date().toISOString().slice(0, 8)}01`;
  return [
    ['جست‌وجوی یک شماره (مثلاً وقتی تماس ورودی دارید)', `curl -H "Authorization: Bearer ${apiKeyHint}" \\\n  "${s}/api/v1/contacts?phone=09121234567"`],
    ['درخواست‌های تماس جدید از اول ماه', `curl -H "Authorization: Bearer ${apiKeyHint}" \\\n  "${s}/api/v1/leads?status=new&since=${monthStart}"`],
    ['علامت‌زدن یک درخواست به‌عنوان انجام‌شده', `curl -X PATCH -H "Authorization: Bearer ${apiKeyHint}" \\\n  -H "Content-Type: application/json" -d '{"status":"done"}' \\\n  "${s}/api/v1/leads/481"`],
    ['افزودن سؤال و جواب به بات', `curl -X POST -H "Authorization: Bearer ${apiKeyHint}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"question":"هزینه ارسال چقدر است؟","answer":"ارسال بالای ۵۰۰ هزار تومان رایگان است."}' \\\n  "${s}/api/v1/bots/3/faqs"`],
    ['یادداشت داخلی روی گفتگو (از CRM یا مرکز تماس)', `curl -X POST -H "Authorization: Bearer ${apiKeyHint}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"text":"مشتری تلفنی پیگیری شد","author":"CRM"}' \\\n  "${s}/api/v1/conversations/902/notes"`],
    ['خواندن رویدادهای تازه (بدون وب‌هوک)', `curl -H "Authorization: Bearer ${apiKeyHint}" \\\n  "${s}/api/v1/events?since=0&types=lead.created,conversation.handoff"`],
  ];
}

const VERIFY_NODE = `// Node.js (Express): verify X-Pasokhyar-Signature on the RAW body
const crypto = require('crypto');
const express = require('express');
const app = express();

app.post('/pasokhyar-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.PASOKHYAR_WEBHOOK_SECRET)
    .update(req.body)                       // Buffer, exactly as received
    .digest('hex');
  const given = String(req.get('X-Pasokhyar-Signature') || '');
  const ok = given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.sendStatus(401);

  const evt = JSON.parse(req.body);         // { id, event, createdAt, bot, data }
  if (evt.event === 'lead.created') {
    const lead = evt.data.lead;             // { name, phone, phoneE164, message, ... }
    // create the contact / task in your CRM here
  }
  res.sendStatus(200);                      // any 2xx = delivered; otherwise we retry
});`;

const VERIFY_PHP = `<?php
// PHP: verify X-Pasokhyar-Signature on the RAW body
$secret = getenv('PASOKHYAR_WEBHOOK_SECRET');
$raw = file_get_contents('php://input');
$expected = 'sha256=' . hash_hmac('sha256', $raw, $secret);
$given = $_SERVER['HTTP_X_PASOKHYAR_SIGNATURE'] ?? '';
if (!hash_equals($expected, $given)) {
    http_response_code(401);
    exit;
}
$evt = json_decode($raw, true);   // ['id', 'event', 'createdAt', 'bot', 'data']
if ($evt['event'] === 'lead.created') {
    $lead = $evt['data']['lead'];  // name, phone, phoneE164, message, ...
    // create the contact / task in your CRM here
}
http_response_code(200);`;

const MANAGER_CONF = `; /etc/asterisk/manager_custom.conf  (Issabel / FreePBX)
[pasokhyar]
secret = a-long-random-password
deny = 0.0.0.0/0.0.0.0
permit = SERVER_IP/255.255.255.255   ; only our server
read = call
write = originate,call`;

module.exports = { ENDPOINTS, samples, curl, VERIFY_NODE, VERIFY_PHP, MANAGER_CONF };

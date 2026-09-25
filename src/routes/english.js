'use strict';
// English landing page for customers outside Iran, with a live English demo
// bot. The dashboard is Persian for now, so foreign leads go to a sales form
// and the team onboards them.
const express = require('express');
const db = require('../db');
const bots = require('../bots');
const config = require('../config');
const demo = require('../demoBot');
const { logoMark } = require('../views/layout');
const { esc, rateLimiter, clientIp } = require('../util');

const router = express.Router();
const contactLimit = rateLimiter({ windowMs: 60 * 60_000, max: 5 });
const DEMO_KEY = 'sitedemo-en';

function demoFaqs() {
  const n = config.siteNameEn;
  return [
    { question: 'What is this?', alternates: ['how does it work', 'what does it do', 'who are you', 'what is Pasokhyar'], answer: `I'm a live demo of ${n}. You add your FAQ or point me at your website, paste one line of code, and I answer your customers 24/7 using only your approved answers.` },
    { question: 'Does it make up answers?', alternates: ['hallucinate', 'is it accurate', 'can it give wrong answers'], answer: "No. It only answers from your own FAQ and website content. When it isn't sure, it suggests close questions or hands the chat to your team." },
    { question: 'Which languages are supported?', alternates: ['languages', 'arabic', 'turkish', 'english', 'persian'], answer: 'The chat widget speaks English, Arabic, Turkish and Persian, with right-to-left layouts for Arabic and Persian.' },
    { question: 'Can I talk to a human?', alternates: ['live chat', 'human agent', 'operator', 'handoff'], answer: 'Yes. Visitors can ask for a person at any time, and your team replies from the live chat inbox. When nobody is online, the bot takes their contact details.' },
    { question: 'Can it learn from my website?', alternates: ['crawl my site', 'import', 'knowledge base', 'train on my site'], answer: 'Yes. Give it your website address and it reads your pages, then answers with a link to the page it used. It can also import your FAQ page automatically.' },
    { question: 'Can we host it ourselves?', alternates: ['on premise', 'self hosted', 'private cloud', 'data privacy', 'can we host it on our own servers', 'install on our server', 'where is our data stored'], answer: 'Yes. The whole system, including the optional AI models, can run on your own servers, so conversations never leave your company.' },
    { question: 'Does it integrate with our CRM or call center?', alternates: ['crm', 'api', 'webhooks', 'call center', 'asterisk', 'cisco', 'zoiper'], answer: 'Yes: webhooks and a REST API for any CRM, click-to-call for softphones and Asterisk/Issabel, and a screen-pop page for call-center software.' },
    { question: 'How much does it cost?', alternates: ['pricing', 'price', 'plans', 'is it free'], answer: 'There is a free plan to try it. For paid plans and on-premise licences, send us a message with the form on this page.' },
  ];
}

let ready = false;
function ensureDemo() {
  if (ready) return DEMO_KEY;
  try {
    demo.key(); // creates the system account
    const system = db.get().prepare('SELECT * FROM users WHERE phone = ?').get(demo.SYSTEM_PHONE);
    let bot = bots.getBotByKey(DEMO_KEY);
    if (!bot) {
      bot = bots.createBot(system.id, { name: `${config.siteNameEn} Assistant`, lang: 'en' });
      db.get().prepare('UPDATE bots SET public_key = ?, welcome = ?, color = ? WHERE id = ?').run(
        DEMO_KEY, `Hi! 👋 I'm a live demo of ${config.siteNameEn}. Ask me anything about the product.`, '#4f46e5', bot.id,
      );
    }
    db.get().transaction(() => {
      db.get().prepare('DELETE FROM faqs WHERE bot_id = ?').run(bot.id);
      for (const f of demoFaqs()) bots.addFaq(bot.id, f);
    })();
    ready = true;
    return DEMO_KEY;
  } catch (e) {
    console.error('english demo bot setup failed:', e.message);
    return null;
  }
}

function page({ body, title, description }) {
  const url = `${config.siteUrl}/en`;
  const key = ensureDemo();
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<link rel="alternate" hreflang="en" href="${esc(url)}">
<link rel="alternate" hreflang="fa" href="${esc(config.siteUrl + '/')}">
<link rel="alternate" hreflang="x-default" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(config.siteUrl + '/img/og.png')}">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#4f46e5">
<link rel="icon" href="/img/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/fonts.css">
<link rel="stylesheet" href="/css/site.css">
<style>
  body.en { font-family: 'Vazirmatn', 'Segoe UI', system-ui, sans-serif; }
  .en .hero h1 { letter-spacing: -.02em; }
  .en .lang-switch { font-weight: 700; }
  .en .langs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .en .langs span { border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: .2em .8em; font-size: .88rem; }
</style>
</head>
<body class="en">
<header class="site-header">
  <div class="container header-row">
    <a class="logo" href="/en">${logoMark()}<span>${esc(config.siteNameEn)}</span></a>
    <nav class="main-nav" aria-label="Main" style="display:flex">
      <a class="nav-link hide-sm" href="#features">Features</a>
      <a class="nav-link hide-sm" href="#enterprise">Enterprise</a>
      <a class="nav-link lang-switch" href="/" hreflang="fa" lang="fa">فارسی</a>
      <a class="btn btn-sm btn-primary" href="#contact">Talk to sales</a>
    </nav>
  </div>
</header>
<main id="main">${body}</main>
<footer class="site-footer"><div class="container copyright muted">© ${new Date().getFullYear()} ${esc(config.siteNameEn)}</div></footer>
${key ? `<script src="/widget.js" data-bot="${esc(key)}" async></script>` : ''}
</body>
</html>`;
}

function landing({ sent = false, error = '', values = {} } = {}) {
  const n = esc(config.siteNameEn);
  return page({
    title: `${config.siteNameEn} — multilingual AI support chatbot that never makes things up`,
    description: `${config.siteNameEn} answers your customers 24/7 in English, Arabic, Turkish and Persian using only your approved answers and website. Live handoff, analytics, QC, CRM and call-center integrations. Cloud or on-premise.`,
    body: `<section class="hero"><div class="container hero-grid">
  <div>
    <span class="eyebrow">AI customer support · cloud or on-premise</span>
    <h1>Answer every customer, 24/7, <span class="grad">in their language</span></h1>
    <p class="lead">${n} answers questions on your website and messengers using only your approved answers and your own site content. It never invents facts, hands tricky chats to your team, and shows you what customers keep asking.</p>
    <div class="hero-cta"><button type="button" class="btn btn-primary btn-lg" data-pasokhyar-open>Try the live demo 💬</button><a class="btn btn-outline btn-lg" href="#contact">Talk to sales</a></div>
    <div class="langs" aria-label="Widget languages"><span>English</span><span>العربية</span><span>Türkçe</span><span>فارسی</span></div>
  </div>
  <div class="mock" aria-hidden="true" dir="ltr">
    <div class="mock-head"><div class="mock-avatar">A</div><div><div class="mock-title">Acme Support</div><div class="mock-sub">Automated · replies instantly</div></div></div>
    <div class="mock-body">
      <div class="bubble bot">Hi! 👋 How can I help?</div>
      <div class="bubble user">Do you ship to Dubai? How long does it take?</div>
      <div class="bubble bot">Yes, we ship to the UAE. Orders arrive in 3–5 business days.<div class="chips" style="margin-top:8px"><span class="chip">Shipping costs</span><span class="chip">Talk to a person</span></div></div>
      <div class="bubble user">Great, thanks!</div>
    </div>
  </div>
</div></section>

<section class="section" id="features"><div class="container">
  <div class="section-head"><h2>Everything a support team needs</h2><p>Set it up in minutes. Keep full control of what it says.</p></div>
  <div class="grid grid-3">
    <div class="card"><div class="feature-icon">🎯</div><h3>Never makes things up</h3><p>Answers come only from your FAQ and website. Unsure? It suggests close questions or hands over to a person.</p></div>
    <div class="card"><div class="feature-icon">🌐</div><h3>Learns from your website</h3><p>Point it at your site or FAQ page. It reads the pages and cites the source in every answer.</p></div>
    <div class="card"><div class="feature-icon">🙋</div><h3>Live handoff to your team</h3><p>Visitors can ask for a human anytime. Your team replies from a shared live chat inbox.</p></div>
    <div class="card"><div class="feature-icon">🧠</div><h3>Private AI, your servers</h3><p>Optional generative answers with open-weight models you host yourself. Conversations never leave your company.</p></div>
    <div class="card"><div class="feature-icon">🔗</div><h3>CRM & call-center ready</h3><p>Webhooks and REST API for any CRM, click-to-call for softphones and Asterisk, and screen-pop for Cisco and others.</p></div>
    <div class="card"><div class="feature-icon">✅</div><h3>Analytics & quality control</h3><p>See busy hours and unanswered questions, and score every conversation, bot or human, against your own QC rubric.</p></div>
  </div>
</div></section>

<section class="section section-soft" id="enterprise"><div class="container narrow center">
  <h2>On-premise for regulated organisations</h2>
  <p class="lead" style="margin-inline:auto">Banks, insurers, hospitals and public bodies can run the entire platform, AI models included, inside their own network, with no data leaving the building.</p>
</div></section>

<section class="section" id="contact"><div class="container narrow">
  <div class="card">
    <h2>Talk to sales</h2>
    <p class="muted">Tell us about your website and team. We'll set up your bot with you.</p>
    ${sent ? '<div class="success">Thanks! We received your message and will reply within one business day.</div>' : `
    ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
    <form class="form" method="post" action="/en#contact">
      <div class="grid grid-2">
        <div class="field"><label for="c-name">Your name</label><input id="c-name" name="name" type="text" required maxlength="80" autocomplete="name" value="${esc(values.name || '')}"></div>
        <div class="field"><label for="c-org">Company</label><input id="c-org" name="org" type="text" required maxlength="120" autocomplete="organization" value="${esc(values.org || '')}"></div>
        <div class="field"><label for="c-contact">Email or phone</label><input id="c-contact" name="contact" type="text" required maxlength="120" autocomplete="email" value="${esc(values.contact || '')}"></div>
        <div class="field"><label for="c-country">Country</label><input id="c-country" name="country" type="text" maxlength="60" autocomplete="country-name" value="${esc(values.country || '')}"></div>
      </div>
      <div class="field"><label for="c-msg">Website and what you need (optional)</label><textarea id="c-msg" name="message" maxlength="1000" rows="3">${esc(values.message || '')}</textarea></div>
      <div><button class="btn btn-primary btn-lg">Send</button></div>
    </form>`}
  </div>
</div></section>`,
  });
}

router.get('/en', (req, res) => res.send(landing()));

router.post('/en', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
  const values = {
    name: String(req.body.name || '').trim().slice(0, 80),
    org: String(req.body.org || '').trim().slice(0, 120),
    contact: String(req.body.contact || '').trim().slice(0, 120),
    country: String(req.body.country || '').trim().slice(0, 60),
    message: String(req.body.message || '').trim().slice(0, 1000),
  };
  if (!contactLimit(clientIp(req))) return res.status(429).send(landing({ error: 'Too many messages. Please try again later.', values }));
  if (!values.name || !values.org) return res.status(400).send(landing({ error: 'Please enter your name and company.', values }));
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contact);
  const phone = /^[+0-9()\-\s]{7,20}$/.test(values.contact);
  if (!email && !phone) return res.status(400).send(landing({ error: 'Please enter a valid email address or phone number.', values }));
  const message = [values.country && `Country: ${values.country}`, values.message].filter(Boolean).join('\n');
  db.get().prepare(`INSERT INTO contact_requests (kind, name, org, phone, message, created_at) VALUES ('international', ?, ?, ?, ?, ?)`)
    .run(values.name, values.org, values.contact, message, Date.now());
  res.send(landing({ sent: true }));
});

module.exports = router;

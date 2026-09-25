# Pasokhyar (پاسخ‌یار) — architecture & contracts

A Persian customer-support chatbot SaaS for Iranian businesses/organizations.
A business signs up, enters its FAQ (question → answer pairs, or starts from an
industry starter pack), pastes one `<script>` tag on its site, and a chat widget
answers visitors 24/7. Unanswered questions are collected so the owner can add
answers (the bot improves over time); when the bot can't answer it offers a
lead form (name + phone) so a human can call back.

**No external AI APIs.** Claude/OpenAI/HF are not reliably available in Iran;
answering is retrieval over the owner's own approved answers (a selling point:
the bot never invents answers). Everything runs on the server itself.

Stack: Node 22.13+, Express 4, built-in node:sqlite (no native modules), server-rendered HTML (template
literals), vanilla JS, no build step, no CDNs (self-hosted Vazirmatn font in
`public/fonts`, `public/css/fonts.css`). Target host: Liara (Iranian PaaS).
Do NOT add npm dependencies without the lead's approval.

## Layout

```
server.js                 entry
src/app.js                express app, mounts routers
src/config.js             env config (SITE_NAME, SITE_URL, payments, referral %)
src/plans.js              free / pro / business plans + prepaid durations
src/db.js                 SQLite schema (migrations) — db.get(), db.reset()
src/bots.js               bot service: ask(), pick(), feedback(), addLead(), FAQ CRUD, index cache
src/nlp/                  Persian retrieval engine: normalize, analyzer, lexicon, synonyms, engine (contract below)
src/routes/widgetApi.js   public widget API  (/api/w/:key/...)
src/routes/site.js        marketing site, SEO pages, auth, dashboard (lead)
src/content/*.js          content data (contracts below)
public/widget.js          embeddable chat widget (contract below)
scripts/seed-demo.js      creates demo user 09120000000/demo1234 + a bot; prints bot key
```

Brand name placeholder in any content text: `{{site}}` (replaced at render time
with config.siteName, default «پاسخ‌یار»). Never hard-code the brand.

## Engine contract — `src/nlp/engine.js`

```js
normalize(text) -> string
buildIndex(faqs: [{ id, question, alternates: string[], answer }]) -> index   // opaque
search(index, query, { limit = 5 }) -> [{ id, score }]   // score in [0,1], desc
decide(results, { faqCount }?) -> { type: 'answer'|'suggest'|'fallback', best: result|null, suggestions: result[] }
THRESHOLDS = { answer, answerSmall, smallBot, suggest, margin }   // bots under smallBot FAQs use answerSmall
```

`bots.js` calls buildIndex once per bot (cached, rebuilt when FAQs change) and
search+decide per question. Budgets: buildIndex(5000 FAQs) < 300 ms; search < 10 ms.

## Widget API — `/api/w/:key/*` (CORS-open, JSON, no cookies)

```
GET  /api/w/:key/config
  -> { ok, bot: { name, welcome, color, position: 'right'|'left', leadForm: bool,
                  placeholder, suggestions: string[],         // starter chips
                  badge: { show: bool, text, url } } }
POST /api/w/:key/ask       { q, sid, channel?: 'page' }
  -> { ok, type: 'answer'|'suggest'|'fallback'|'limit', messageId, answer: string,
       faqId?, suggestions: [{ id, question }], offerLead: bool }
POST /api/w/:key/pick      { faqId, sid, messageId?, channel? }   // visitor tapped a suggestion
  -> same shape as ask (type 'answer')
POST /api/w/:key/feedback  { messageId, helpful: bool } -> { ok }
POST /api/w/:key/lead      { sid, name, phone, message } -> { ok, message } | 400 { error: 'bad_phone' }
429 { ok:false, error:'rate_limited', answer? } when throttled
```

`answer` is plain text (may contain newlines, URLs, phone numbers). Render as text,
never as HTML.

## Widget — `public/widget.js`

Embed: `<script src="https://SITE/widget.js" data-bot="KEY" async></script>`
Hosted page: `/c/:key` loads the same script with `data-mode="page"` (full-screen chat, no launcher).

## Content contracts — `src/content/`

`industries.js` — array of:
```js
{
  id: 'shop',                       // stable id, [a-z-]
  name: 'فروشگاه اینترنتی',
  icon: '🛒',
  seo: { slug: 'online-shop', metaTitle, metaDescription, h1, introHtml, benefits: [string], faq: [{ q, a }] },
  starterFaqs: [{ question, alternates: [string], answer }],   // placeholders in [brackets]
  evalQueries: [{ query, expected: <index into starterFaqs> }]
}
```
`blog.js` — array of `{ slug, title, metaDescription, date: 'YYYY-MM-DD', readingMinutes, bodyHtml, related: [industryId] }`
`siteFaq.js` — array of `{ q, a }` (plain text) for home/pricing FAQ.
`pages.js` — `{ terms: { title, bodyHtml }, privacy: { title, bodyHtml }, about: { title, bodyHtml } }`

## v2 additions (live chat, website knowledge, AI answers, analytics)

### Answer pipeline (`src/bots.js` → `ask()`, async)
1. FAQ engine (`src/nlp/engine.js`) — confident match → FAQ answer (`kind: 'faq'`).
2. Website knowledge (`src/knowledge.js`) — confident passage → snippet + source link (`kind: 'passage'`).
3. Generative AI (`src/llm.js`, optional, per bot + plan) — only when steps 1–2 found
   *some* relevant context; the model must answer from that context or reply NO_ANSWER
   (`kind: 'ai'`). Never called for off-topic questions.
4. Otherwise suggestions / fallback / lead form, as before.

Every visitor/bot/operator message is also written to the transcript
(`conversations` + `chat_messages`); `messages` stays the per-question analytics log.
`messages.type` values: `answer` (FAQ) | `passage` | `ai` | `suggest` | `fallback` | `limit`.
Answer-type rows (`answer`, `passage`, `ai`) count toward the monthly plan limit.

### Knowledge contract — `src/knowledge.js`
```js
startCrawl(bot, url, { maxPages })   -> source row; crawl runs in the background
recrawl(bot, sourceId)               -> source row
deleteSource(bot, sourceId)
listSources(botId)                   -> rows
search(botId, query, { limit = 3 })  -> [{ id, url, title, heading, text, score }]  // score in [0,1]
snippet(passage, query, maxChars = 400) -> string   // the most relevant sentences
THRESHOLDS = { answer, context }     // answer: show passage directly; context: good enough to ground the AI
```
Crawling reuses `importer.fetchPage` (SSRF-guarded). Same-host pages only, sitemap.xml
first, then links; plan limit `plans[x].pages`.

### Widget API additions (`/api/w/:key/…`)
```
GET  config -> bot adds: lang: 'fa'|'en'|'ar'|'tr', liveChat: bool, operatorOnline: bool, ai: bool,
               proactive: { text, delay, path } | null   (config.placeholder was removed: UI strings are the widget's, per lang)
POST ask    -> reply adds: kind: 'faq'|'passage'|'ai', sources: [{ url, title }]
POST ask-stream { q, sid, channel?, page? }  (text/event-stream)
     event: delta  data: { text }            (append to the bubble; FAQ/passage answers arrive as one delta)
     event: done   data: { ok, ...same object as POST ask returns }   (final: messageId, type, kind, sources…)
     event: error  data: { message }         (widget falls back to POST ask)
     reply.type 'human' = an operator is handling this chat; nothing to show (operator messages arrive via poll)
POST handoff { sid, name?, phone? } -> { ok, online, message }   visitor asks for a human
POST send    { sid, text }          -> { ok, id }                visitor message while mode = human
GET  poll?sid=&after=<lastId>       -> { ok, mode, operatorOnline,
                                          messages: [{ id, sender: 'operator'|'system', text, at }] }
POST end     { sid }                -> { ok }                     back to the bot
```

### Dashboard pages (all under `/app/bots/:botId/…`, owner-checked)
`live` (live chat inbox, me), `knowledge` (website sources), `reports` (analytics charts).

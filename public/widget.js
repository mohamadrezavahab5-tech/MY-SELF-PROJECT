/*! پاسخ‌یار chat widget — <script src="https://HOST/widget.js" data-bot="KEY" async></script>
 * data-mode="page": full-viewport chat for the hosted page /c/:key (no launcher).
 * No dependencies; talks only to its own origin; renders in a Shadow DOM so host
 * CSS can't break it. Server/user text is only ever inserted as text nodes.
 * Streams AI answers (SSE over fetch), hands chats to a live operator (polling),
 * shows a proactive greeting, and speaks fa / en / ar / tr. */
(() => {
'use strict';
if (window.Pasokhyar && window.Pasokhyar.version) return; // included twice

// currentScript is null when executed from a loader callback, so fall back.
const script = document.currentScript || document.querySelector('script[data-bot][src*="widget.js"]');
const KEY = script && (script.getAttribute('data-bot') || '').trim();
if (!KEY) { console.warn('[pasokhyar] data-bot attribute is missing'); return; }
let ORIGIN;
try { ORIGIN = new URL(script.src, location.href).origin; } catch (e) { return; }
const PAGE = script.getAttribute('data-mode') === 'page';
const API = ORIGIN + '/api/w/' + encodeURIComponent(KEY);
const MAX_LOG = 60;
const MOBILE = matchMedia('(max-width: 480px)');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const TOUCH = matchMedia('(pointer: coarse)');
const STREAMS = !!(window.ReadableStream && window.TextDecoder && window.AbortController);

// --- strings: [fa, en, ar, tr]; %s = argument
const LANGS = ['fa', 'en', 'ar', 'tr'];
const STR = {
  welcome: ['سلام! 👋 چطور می‌توانم کمکتان کنم؟', 'Hi there! 👋 How can I help?', 'مرحباً! 👋 كيف يمكنني مساعدتك؟', 'Merhaba! 👋 Nasıl yardımcı olabilirim?'],
  support: ['پشتیبانی', 'Support', 'الدعم', 'Destek'],
  stBot: ['دستیار خودکار · پاسخ فوری', 'Assistant · replies instantly', 'مساعد آلي · يرد فوراً', 'Asistan · anında yanıt'],
  stAi: ['دستیار هوشمند · پاسخ فوری', 'AI assistant · replies instantly', 'مساعد ذكي · يرد فوراً', 'Yapay zekâ asistanı · anında yanıt'],
  stTeam: ['پاسخ فوری · پشتیبان آنلاین است', 'Instant answers · team online', 'إجابات فورية · الفريق متصل', 'Anında yanıt · ekip çevrimiçi'],
  stWait: ['در انتظار پشتیبان…', 'Waiting for an agent…', 'بانتظار موظف الدعم…', 'Temsilci bekleniyor…'],
  stLive: ['پشتیبان در گفتگوست', 'An agent is in the chat', 'موظف الدعم في المحادثة', 'Temsilci sohbette'],
  stOff: ['پشتیبان آفلاین · پیام بگذارید', 'Team offline · leave a message', 'الفريق غير متصل · اترك رسالة', 'Ekip çevrimdışı · mesaj bırakın'],
  waitSub: ['به‌محض پیوستن، همین‌جا جواب می‌دهد.', "They'll reply right here.", 'سيرد عليك هنا مباشرة.', 'Yanıt burada görünecek.'],
  barLive: ['در حال گفتگو با پشتیبان', 'Chatting with an agent', 'تتحدث الآن مع موظف الدعم', 'Bir temsilciyle sohbettesiniz'],
  barOff: ['پشتیبان الان آفلاین است', 'Our team is offline', 'فريقنا غير متصل الآن', 'Ekibimiz şu an çevrimdışı'],
  offSub: ['پیامتان می‌ماند و همین‌جا جواب می‌گیرید.', "Leave a message — we'll reply here.", 'اترك رسالتك وسنرد هنا.', 'Mesajınızı bırakın, buradan yanıtlarız.'],
  placeholder: ['سؤالتان را بنویسید…', 'Ask a question…', 'اكتب سؤالك…', 'Sorunuzu yazın…'],
  phHuman: ['پیامتان را بنویسید…', 'Write a message…', 'اكتب رسالتك…', 'Mesajınızı yazın…'],
  related: ['سؤال‌های مرتبط', 'Related questions', 'أسئلة ذات صلة', 'İlgili sorular'],
  none: ['هیچ‌کدام', 'None of these', 'لا شيء مما سبق', 'Hiçbiri'],
  noneReply: ['باشه 🙂 اگر شماره‌تان را بگذارید، همکاران ما تماس می‌گیرند و جواب سؤالتان را می‌دهند.', 'No problem 🙂 Leave your number and our team will call you with an answer.', 'لا بأس 🙂 اترك رقمك وسيتصل بك فريقنا للإجابة عن سؤالك.', 'Sorun değil 🙂 Numaranızı bırakın, ekibimiz sizi arayıp yanıtlasın.'],
  helpful: ['مفید بود؟', 'Was this helpful?', 'هل كان هذا مفيداً؟', 'Yardımcı oldu mu?'],
  yes: ['مفید بود', 'Helpful', 'مفيد', 'Yardımcı oldu'],
  no: ['مفید نبود', 'Not helpful', 'غير مفيد', 'Yardımcı olmadı'],
  thanks: ['ممنون از بازخوردتان', 'Thanks for the feedback', 'شكراً على ملاحظتك', 'Geri bildiriminiz için teşekkürler'],
  unhelpful: ['متأسفیم که این پاسخ کمکی نکرد. اگر مایلید شماره‌تان را بگذارید تا همکاران ما با شما تماس بگیرند.', "Sorry that didn't help. Leave your number if you like and our team will call you back.", 'نأسف لأن هذه الإجابة لم تساعدك. اترك رقمك إن شئت وسيتصل بك فريقنا.', 'Bu yanıt yardımcı olmadığı için üzgünüz. İsterseniz numaranızı bırakın, ekibimiz sizi arasın.'],
  unhelpfulHuman: ['متأسفیم که این پاسخ کمکی نکرد. می‌توانید با همکاران پشتیبانی ما صحبت کنید.', "Sorry that didn't help. You can talk to our support team.", 'نأسف لأن هذه الإجابة لم تساعدك. يمكنك التحدث مع فريق الدعم.', 'Bu yanıt yardımcı olmadığı için üzgünüz. Destek ekibimizle konuşabilirsiniz.'],
  slowDown: ['کمی آهسته‌تر 🙂 چند ثانیه دیگر دوباره امتحان کنید.', 'A little slower 🙂 please try again in a few seconds.', 'مهلاً 🙂 حاول مجدداً بعد ثوانٍ.', 'Biraz yavaş 🙂 birkaç saniye sonra tekrar deneyin.'],
  offline: ['پیام ارسال نشد؛ اتصال اینترنت را بررسی کنید.', 'Message not sent. Check your internet connection.', 'لم تُرسل الرسالة. تحقق من اتصالك بالإنترنت.', 'Mesaj gönderilemedi. İnternet bağlantınızı kontrol edin.'],
  failed: ['مشکلی پیش آمد و پاسخی دریافت نشد.', 'Something went wrong and no reply came back.', 'حدث خطأ ولم يصل أي رد.', 'Bir sorun oluştu, yanıt alınamadı.'],
  gone: ['این پاسخ دیگر در دسترس نیست. لطفاً سؤالتان را بنویسید.', 'That answer is no longer available. Please type your question.', 'هذه الإجابة لم تعد متاحة. يرجى كتابة سؤالك.', 'Bu yanıt artık mevcut değil. Lütfen sorunuzu yazın.'],
  retry: ['تلاش دوباره', 'Try again', 'أعد المحاولة', 'Tekrar dene'],
  leadTitle: ['درخواست تماس', 'Request a callback', 'طلب اتصال', 'Geri arama talebi'],
  leadSend: ['ثبت درخواست تماس', 'Request callback', 'أرسل الطلب', 'Talebi gönder'],
  leadDone: ['درخواست شما ثبت شد.', 'Your request has been received.', 'تم تسجيل طلبك.', 'Talebiniz alındı.'],
  sending: ['در حال ارسال…', 'Sending…', 'جارٍ الإرسال…', 'Gönderiliyor…'],
  name: ['نام', 'Name', 'الاسم', 'Adınız'],
  phone: ['شماره موبایل', 'Phone number', 'رقم الهاتف', 'Telefon numarası'],
  note: ['توضیح', 'Message', 'ملاحظة', 'Not'],
  optional: ['(اختیاری)', '(optional)', '(اختياري)', '(isteğe bağlı)'],
  phoneHint: ['۰۹۱۲ ۳۴۵ ۶۷۸۹', '+1 555 123 4567', '+971 50 123 4567', '+90 532 123 45 67'],
  errName: ['لطفاً نامتان را بنویسید.', 'Please enter your name.', 'يرجى كتابة اسمك.', 'Lütfen adınızı yazın.'],
  errPhone: ['شماره موبایل را درست وارد کنید؛ مثلاً ۰۹۱۲۳۴۵۶۷۸۹', 'Please enter a valid phone number.', 'يرجى إدخال رقم هاتف صحيح.', 'Lütfen geçerli bir telefon numarası girin.'],
  badPhone: ['این شماره معتبر نیست؛ لطفاً شماره موبایل را بررسی کنید.', "That number doesn't look valid. Please check it.", 'هذا الرقم غير صالح، يرجى التحقق منه.', 'Bu numara geçerli görünmüyor, lütfen kontrol edin.'],
  leadLimited: ['درخواست‌های زیادی ثبت شده؛ کمی بعد دوباره امتحان کنید.', 'Too many requests. Please try again a little later.', 'طلبات كثيرة جداً، حاول بعد قليل.', 'Çok fazla talep var, biraz sonra tekrar deneyin.'],
  leadFailed: ['ثبت درخواست ممکن نشد؛ لطفاً دوباره امتحان کنید.', "Couldn't send your request. Please try again.", 'تعذّر إرسال الطلب، حاول مرة أخرى.', 'Talep gönderilemedi, lütfen tekrar deneyin.'],
  leadOffline: ['ارسال نشد؛ اتصال اینترنت را بررسی کنید و دوباره بزنید.', 'Not sent. Check your connection and try again.', 'لم يُرسل. تحقق من الاتصال وحاول مجدداً.', 'Gönderilmedi. Bağlantınızı kontrol edip tekrar deneyin.'],
  unavailable: ['این گفتگو در حال حاضر در دسترس نیست.', 'This chat is not available right now.', 'هذه المحادثة غير متاحة حالياً.', 'Bu sohbet şu anda kullanılamıyor.'],
  chatWith: ['گفتگو با %s', 'Chat with %s', 'محادثة مع %s', '%s ile sohbet'],
  newCount: ['%s پیام تازه', '%s new', '%s جديدة', '%s yeni'],
  newChat: ['گفتگوی تازه', 'New conversation', 'محادثة جديدة', 'Yeni sohbet'],
  close: ['بستن گفتگو', 'Close chat', 'إغلاق المحادثة', 'Sohbeti kapat'],
  menu: ['گزینه‌ها', 'Options', 'خيارات', 'Seçenekler'],
  send: ['ارسال', 'Send', 'إرسال', 'Gönder'],
  yourMsg: ['پیام شما', 'Your message', 'رسالتك', 'Mesajınız'],
  messages: ['پیام‌های گفتگو', 'Conversation', 'الرسائل', 'Mesajlar'],
  talkHuman: ['صحبت با پشتیبان', 'Talk to a person', 'تحدث مع موظف', 'Bir temsilciyle konuş'],
  talkMsg: ['می‌خواهم با پشتیبان صحبت کنم', "I'd like to talk to a person", 'أريد التحدث مع موظف', 'Bir temsilciyle konuşmak istiyorum'],
  endHuman: ['پایان گفتگو با پشتیبان', 'End chat with agent', 'إنهاء المحادثة مع الموظف', 'Temsilciyle sohbeti bitir'],
  end: ['پایان گفتگو', 'End chat', 'إنهاء', 'Bitir'],
  operator: ['پشتیبان', 'Support', 'الدعم', 'Destek'],
  joined: ['پشتیبان به گفتگو پیوست', 'An agent joined the chat', 'انضم موظف الدعم إلى المحادثة', 'Bir temsilci sohbete katıldı'],
  ended: ['گفتگو با پشتیبان پایان یافت', 'Chat with the agent ended', 'انتهت المحادثة مع الموظف', 'Temsilciyle sohbet sona erdi'],
  humanOff: ['گفتگو با پشتیبان الان ممکن نیست.', 'Live chat is not available right now.', 'المحادثة المباشرة غير متاحة الآن.', 'Canlı sohbet şu anda kullanılamıyor.'],
  sources: ['منبع', 'Source', 'المصدر', 'Kaynak'],
  dismiss: ['بستن', 'Dismiss', 'إغلاق', 'Kapat'],
};
let LANG = 'fa';
const T = {};
function setLang(l) {
  LANG = LANGS.indexOf(l) >= 0 ? l : 'fa';
  const i = LANGS.indexOf(LANG);
  for (const k in STR) T[k] = STR[k][i] || STR[k][1];
}
setLang(String(document.documentElement.lang || '').slice(0, 2).toLowerCase()); // until the config says otherwise
const RTL = () => LANG === 'fa' || LANG === 'ar';
const fmt = (s, a) => s.replace('%s', a);
// Persian digits only for Persian; everything else keeps Latin digits.
const num = n => (LANG === 'fa' ? String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]) : String(n));
function clock(at) {
  const d = new Date(Number(at) || 0);
  if (!at || isNaN(d)) return '';
  try {
    return new Intl.DateTimeFormat({ fa: 'fa-IR', en: 'en-US', ar: 'ar-u-nu-latn', tr: 'tr-TR' }[LANG], { hour: 'numeric', minute: '2-digit' }).format(d);
  } catch (e) { return ''; }
}

// --- utils
const wait = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const DIGIT = /[0-9۰-۹٠-٩]/;
const toEn = s => String(s).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x6F0).replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660);
const httpUrl = u => { try { return /^https?:$/.test(new URL(u).protocol); } catch (e) { return false; } };

// Storage can throw (private mode, blocked site data): always guarded.
const PREFIX = 'pasokhyar:' + KEY + ':', LS = 'localStorage', SS = 'sessionStorage';
const sget = (area, k) => { try { return window[area].getItem(PREFIX + k); } catch (e) { return null; } };
const sset = (area, k, v) => { try { window[area].setItem(PREFIX + k, v); } catch (e) { /* ignore */ } };

// One visitor id per browser per bot.
let sid = sget(LS, 'sid');
if (!sid || !/^[\w-]{8,64}$/.test(sid)) {
  try { sid = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join(''); }
  catch (e) { sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
  sset(LS, 'sid', sid);
}

// History, short keys. r: 'u' visitor | 'b' bot | 'o' operator | 's' system note; t: text;
// bot: k reply type, id messageId, s [{id, question}], o "none of these" chip, hc "talk to a
// person" chip, src [{u, t}] sources, fb 1|0, lead 'open'|'done', lm thank-you;
// operator/system: id chat message id, at time, j 'join'|'end' (client notes).
let log = [];
try {
  const v = JSON.parse(sget(LS, 'log') || '[]');
  if (Array.isArray(v)) log = v.filter(m => m && /^[ubos]$/.test(m.r) && typeof m.t === 'string');
} catch (e) { /* corrupt → start fresh */ }
function save() {
  if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
  sset(LS, 'log', JSON.stringify(log));
}

// Live chat state survives reloads: '' bot | 'wait' operator requested | 'live' operator
// joined | 'off' requested while nobody was online. lastId = newest operator/system message seen.
let hm = sget(LS, 'hm');
if (!/^(wait|live|off)$/.test(hm || '')) hm = '';
let lastId = Number(sget(LS, 'last')) || 0;

// Always resolves to { status, data }; status 0 = network error or timeout.
async function api(path, body) {
  const ctrl = window.AbortController ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      signal: ctrl ? ctrl.signal : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
    return { status: res.status, data: data || {} };
  } catch (e) {
    return { status: 0, data: {} };
  } finally {
    clearTimeout(timer);
  }
}

// POST /ask-stream: server-sent events read from a fetch body. onDelta(text) per
// `delta`; resolves like api() with the `done` payload, or status 0 when the stream
// errored or broke (the caller then falls back to POST /ask).
async function askStream(body, onDelta) {
  const ctrl = new AbortController();
  let timer = 0;
  const arm = ms => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), ms); };
  arm(40000); // the server may wait on the language model before the first byte
  try {
    const res = await fetch(API + '/ask-stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      credentials: 'omit', signal: ctrl.signal,
    });
    if (!res.ok || !res.body || !/event-stream/.test(res.headers.get('content-type') || '')) {
      let data = null;
      try { data = await res.json(); } catch (e) { /* ignore */ }
      return { status: res.ok ? 0 : res.status, data: data || {} };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      arm(25000);
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true }).replace(/\r/g, '');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let ev = 'message', raw = '';
        for (const line of block.split('\n')) {
          if (line.slice(0, 6) === 'event:') ev = line.slice(6).trim();
          else if (line.slice(0, 5) === 'data:') raw += line.slice(5).trim();
        }
        let data;
        try { data = JSON.parse(raw); } catch (e) { continue; }
        if (ev === 'delta' && data && typeof data.text === 'string') onDelta(data.text);
        else if (ev === 'done' || ev === 'error') {
          const drain = () => reader.read().then(c => c.done || drain(), () => {}); // the server ends it right away
          drain();
          return ev === 'done' ? { status: 200, data } : { status: 0, data: {} };
        }
      }
    }
    return { status: 0, data: {} };
  } catch (e) {
    return { status: 0, data: {} };
  } finally {
    clearTimeout(timer);
  }
}

// Tiny DOM builder; string children become text nodes.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false && c !== '') el.append(c);
  return el;
}
const button = (props, ...kids) => h('button', Object.assign({ type: 'button' }, props), ...kids);
const replay = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

// Icons (Lucide-style strokes); several paths separated by "|".
const ICONS = {
  // Solid bubble with three dots punched out (evenodd).
  chat: 'M12 3.5c-5.1 0-9.2 3.6-9.2 8 0 2.4 1.2 4.6 3.1 6.1-.2 1.4-.9 2.6-1.9 3.6 2.1.1 4-.6 5.4-1.8.8.2 1.7.3 2.6.3 5.1 0 9.2-3.6 9.2-8.1S17.1 3.5 12 3.5zM6.9 11.6a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0zm3.8 0a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0zm3.8 0a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0z',
  close: 'M18 6 6 18|m6 6 12 12',
  down: 'm6 9 6 6 6-6',
  more: 'M5 12h.01|M12 12h.01|M19 12h.01',
  send: 'M3.4 20.4 20.9 12.9a1 1 0 0 0 0-1.8L3.4 3.6a.9.9 0 0 0-1.3 1l1.8 6.1L13 12l-9.1 1.3-1.8 6.1a.9.9 0 0 0 1.3 1z',
  up: 'M7 10v12|M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 8a2 2 0 0 1-1.9 1.4H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9z',
  dn: 'M17 14V2|M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9z',
  restart: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8|M3 3v5h5',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  check: 'M21.8 10A10 10 0 1 1 17 3.3|m9 11 3 3L22 4',
  alert: 'M12 8v4|M12 16h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  headset: 'M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z|M21 16v2a4 4 0 0 1-4 4h-5',
  end: 'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20z|m15 9-6 6|m9 9 6 6',
  user: 'M12 3.5a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5zM3.8 20.2c0-3.7 3.7-6.4 8.2-6.4s8.2 2.7 8.2 6.4c0 .6-.5 1.1-1.1 1.1H4.9c-.6 0-1.1-.5-1.1-1.1z',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71|M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
};
function icon(name, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', (/^(chat|send|user)$/.test(name) ? 'solid ' : name === 'more' ? 'dots ' : '') + (cls || ''));
  for (const d of ICONS[name].split('|')) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill-rule', 'evenodd');
    svg.appendChild(p);
  }
  return svg;
}

// --- colors
function parseHex(c) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
  if (!m) return null;
  const n = parseInt(m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1], 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function lum(rgb) {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const mix = (rgb, to, t) => rgb.map((v, i) => Math.round(v + (to[i] - v) * t));
const rgba = (rgb, a) => 'rgba(' + rgb.join(',') + ',' + a + ')';

// Brand color → text color on it (black/white, whichever contrasts more), a
// gradient stop, and an "ink" shade readable on white (≥ 4.5:1).
function palette(rgb) {
  const L = lum(rgb);
  const white = contrast(L, 1) >= contrast(L, 0);
  let ink = rgb;
  for (let i = 0; i < 12 && contrast(lum(ink), 1) < 4.5; i++) ink = mix(ink, [0, 0, 0], 0.12);
  return {
    '--c': rgba(rgb, 1),
    '--c2': rgba(white ? mix(rgb, [0, 0, 0], 0.2) : mix(rgb, [255, 255, 255], 0.22), 1),
    '--on': white ? '#fff' : '#111827',
    '--on-1': white ? 'rgba(255,255,255,.14)' : 'rgba(17,24,39,.07)',
    '--on-2': white ? 'rgba(255,255,255,.22)' : 'rgba(17,24,39,.1)',
    '--ink': rgba(ink, 1),
    '--ink-1': rgba(ink, 0.07),
    '--ink-2': rgba(ink, 0.16),
    '--ink-3': rgba(ink, 0.3),
  };
}

// --- rich text
// Plain text → DOM: newlines kept via pre-wrap; http(s) URLs and Iranian phone
// numbers (mobile/landline, Latin or Persian digits) become links.
const LINK_RE = new RegExp('https?://[^\\s<>"«»]+|(?:\\+98|0098|[0۰٠])[ -]?[1-9۱-۹١-٩](?:[ -]?[0-9۰-۹٠-٩]){9}', 'gi');
function richText(el, text) {
  let last = 0, m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    const i = m.index;
    let s = m[0], a = null;
    if (/^http/i.test(s)) {
      s = s.replace(/[.,;:!?)\]}'"،؛؟…]+$/, ''); // trailing punctuation belongs to the sentence
      if (httpUrl(s)) a = h('a', { href: s, target: '_blank', rel: 'noopener', dir: 'ltr' }, s);
    } else if (!DIGIT.test(text[i - 1] || '') && !DIGIT.test(text[i + s.length] || '')) {
      a = h('a', { href: 'tel:' + toEn(s).replace(/[^\d+]/g, ''), dir: 'ltr' }, s);
    }
    if (!a) continue;
    if (i > last) el.append(text.slice(last, i));
    el.append(a);
    LINK_RE.lastIndex = last = i + s.length;
  }
  if (last < text.length) el.append(text.slice(last));
  return el;
}

// --- stylesheets
// Constructable stylesheets (unaffected by a host's style-src CSP), else <style>.
function addCss(target, text) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    target.adoptedStyleSheets = target.adoptedStyleSheets.concat(sheet);
  } catch (e) {
    const st = document.createElement('style');
    st.textContent = text;
    (target === document ? document.head || document.documentElement : target).appendChild(st);
  }
}

// @font-face doesn't work inside shadow roots: add it to the host document
// under a private family name so it can't clash with the site's fonts.
function injectFonts() {
  if (window.__pasokhyarFonts) return;
  window.__pasokhyarFonts = true;
  const ranges = {
    arabic: 'U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC',
    latin: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  };
  let css = '';
  for (const f in ranges) {
    css += "@font-face{font-family:'PasokhyarVazirmatn';font-weight:100 900;font-display:swap;src:url(" + ORIGIN +
      '/fonts/vazirmatn-' + f + "-wght-normal.woff2) format('woff2');unicode-range:" + ranges[f] + '}';
  }
  addCss(document, css);
}

// Motion: a soft spring (tiny overshoot) for things that arrive, quick ease-in for
// things that leave. Only transform and opacity are animated.
const STYLE = `
:host{all:initial!important}
*,::before,::after{box-sizing:border-box}
.root{--g:linear-gradient(135deg,var(--c),var(--c2));--e:cubic-bezier(.2,.8,.2,1);--sp:cubic-bezier(.3,1.25,.45,1);
 --line:#e6e8ee;--text:#1a2130;--muted:#6b7280;--soft:#f5f6f8;--k:15,23,42;--f:PasokhyarVazirmatn,Vazirmatn,Tahoma,sans-serif;
 --sh:0 0 0 1px rgba(var(--k),.05),0 12px 28px -8px rgba(var(--k),.2),0 32px 72px -16px rgba(var(--k),.32);
 font:400 14.5px/1.8 var(--f);color:var(--text);text-align:start;letter-spacing:normal;word-spacing:normal;text-transform:none;
 color-scheme:light;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
.latin{--f:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,PasokhyarVazirmatn,sans-serif;font-size:14px;line-height:1.6}
.rtl{--s0:100%;--s1:0%}.ltr{--s0:0%;--s1:100%}
@supports (transition-timing-function:linear(0,1)){.root{--sp:linear(0,.063 2.5%,.235 5.4%,.49 9%,.764 13.5%,.915 17.3%,1.002 21.3%,1.035 25%,1.043 28.5%,1.036 32.4%,1.014 39%,1.001 46%,.997 55%,1)}}
button,input,textarea{font:inherit;color:inherit;letter-spacing:inherit;margin:0}
button{cursor:pointer;background:none;border:0;padding:0;text-align:inherit;-webkit-tap-highlight-color:transparent}
svg{display:block;width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.solid{fill:currentColor;stroke:none}
.dots{stroke-width:3.2}
a{color:var(--ink);text-underline-offset:3px}
[hidden]{display:none!important}
:focus:not(:focus-visible){outline:none}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.z{z-index:2147483000}
.c{display:grid;place-items:center}
.launcher,.send,.btn{background:var(--g);color:var(--on)}
.bot .bubble,.op .bubble,.lead{background:#fff;border:1px solid var(--line);box-shadow:0 1px 2px rgba(var(--k),.04)}
.launcher,.panel,.teaser{position:fixed;right:20px}
.left .launcher,.left .panel,.left .teaser{right:auto;left:20px}

.launcher{bottom:calc(20px + env(safe-area-inset-bottom,0px));width:60px;height:60px;border-radius:50%;
 box-shadow:0 2px 6px rgba(var(--k),.14),0 12px 30px -8px rgba(var(--k),.38);transition:transform .45s var(--sp),opacity .2s;animation:pop .7s var(--sp) both}
.launcher:hover{transform:scale(1.07)}
.launcher:active{transform:scale(.93);transition-duration:.1s}
.launcher::before,.launcher::after{content:'';position:absolute;inset:0;border-radius:50%;background:var(--c);opacity:0;pointer-events:none;z-index:-1}
.hello::before{animation:ring 2s var(--e) 2}
.hello::after{animation:ring 2s var(--e) .7s 2}
.hello .i-chat{animation:breathe 2s ease-in-out 2}
.ping::before{animation:ring 1.5s var(--e) 3}
.ping .i-chat{animation:nudge .9s var(--sp) 2}
.launcher svg{position:absolute;width:30px;height:30px;transition:transform .5s var(--sp),opacity .2s}
.launcher .i-close{width:28px;height:28px;opacity:0;transform:rotate(-90deg) scale(.4)}
.open .launcher .i-chat{opacity:0;transform:rotate(90deg) scale(.4)}
.open .launcher .i-close{opacity:1;transform:none}
.count{position:absolute;top:-4px;right:-4px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#ef4444;color:#fff;
 font:700 11.5px/22px var(--f);text-align:center;box-shadow:0 0 0 2.5px #fff;transform:scale(0);transition:transform .4s var(--sp)}
.left .count{right:auto;left:-4px}
.unread .count{transform:scale(1)}

.panel{bottom:calc(92px + env(safe-area-inset-bottom,0px));width:392px;height:600px;height:min(680px,calc(100vh - 116px));min-height:380px;
 background:#fff;border-radius:22px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--sh);transform-origin:100% 100%;
 opacity:0;visibility:hidden;pointer-events:none;transform:translateY(18px) scale(.94);transition:opacity .16s ease-in,transform .2s ease-in,visibility 0s .2s}
.left .panel{transform-origin:0 100%}
.open .panel{opacity:1;visibility:visible;pointer-events:auto;transform:none;transition:opacity .2s ease-out,transform .6s var(--sp),visibility 0s}

.head{position:relative;flex:none;display:flex;align-items:center;gap:11px;padding-block:12px;padding-inline:16px 10px;color:var(--on);
 background-image:radial-gradient(120% 160% at var(--s0) 0,rgba(255,255,255,.18),transparent 55%),var(--g)}
.hav{position:relative;flex:none;width:40px;height:40px;border-radius:50%;background:var(--on-2);font-size:17px;font-weight:700}
.hav .fc{position:absolute;inset:0;display:grid;place-items:center;transition:opacity .25s,transform .55s var(--sp)}
.hav .fc svg{width:20px;height:20px}
.hav .f2,.hm-live .hav .f1{opacity:0;transform:scale(.4) rotate(-40deg)}
.hm-live .hav .f2{opacity:1;transform:none}
.hav::after{content:'';position:absolute;bottom:-1px;inset-inline-end:-1px;width:12px;height:12px;border-radius:50%;background:#22c55e;
 box-shadow:0 0 0 2.5px var(--c2);transform:scale(0);transition:transform .45s var(--sp),background-color .3s}
.on .hav::after,.hm .hav::after{transform:scale(1)}
.hm-wait .hav::after{background:#f59e0b;animation:blink2 1.4s ease-in-out infinite}
.hm-off .hav::after{background:#a3aab6}
.htxt{flex:1;min-width:0}
.hname{margin:0;font-size:15.5px;font-weight:700;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hsub{font-size:12.5px;line-height:1.55;opacity:.86;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sw{animation:subin .5s var(--sp)}
.hbtn{flex:none;width:36px;height:36px;border-radius:11px;opacity:.88;transition:background-color .15s,opacity .15s,transform .2s var(--sp)}
.hbtn:hover,.hbtn[aria-expanded=true]{background:var(--on-1);opacity:1}
.hbtn:active{transform:scale(.9)}
.hbtn:focus-visible{outline-color:var(--on);outline-offset:-2px}
.hbtn .i-x{display:none}
.menu{position:absolute;top:calc(100% - 4px);inset-inline-end:10px;z-index:5;min-width:224px;padding:6px;background:#fff;color:var(--text);border-radius:14px;
 box-shadow:0 0 0 1px rgba(var(--k),.06),0 14px 36px -10px rgba(var(--k),.35);transform-origin:var(--s1) 0;animation:menuin .35s var(--sp)}
.mi{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border-radius:9px;font-size:13.5px;line-height:1.5;transition:background-color .12s}
.mi:hover,.mi:focus-visible{background:var(--soft);outline:none}
.mi svg{width:17px;height:17px;color:var(--muted)}
.mi.danger,.mi.danger svg{color:#b91c1c}

.log{position:relative;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:18px 14px 12px;background:var(--soft);scrollbar-width:thin;scrollbar-color:#d4d7de transparent}
.row{display:flex;align-items:flex-start;gap:8px;margin-top:14px}
.row:first-child{margin-top:0}
.bot+.bot,.user+.user,.op+.op{margin-top:6px}
.bot,.op{transform-origin:var(--s0) 0}
.user{justify-content:flex-end;transform-origin:var(--s1) 100%}
.anim{animation:in .5s var(--sp) both}
.av{flex:none;width:28px;height:28px;border-radius:50%;margin-top:2px;font-size:12.5px;font-weight:700;line-height:1;background:var(--g);color:var(--on)}
.bot+.bot .av,.op+.op .av{visibility:hidden}
.av.opa{background:#1f2937;color:#fff}
.av svg{width:15px;height:15px}
.col{min-width:0;max-width:calc(100% - 44px);display:flex;flex-direction:column;align-items:flex-start}
.col.wide{width:calc(100% - 36px);max-width:none}
.bubble{max-width:100%;padding:9px 14px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.rtl .bot .bubble,.rtl .op .bubble{border-top-right-radius:6px}
.ltr .bot .bubble,.ltr .op .bubble{border-top-left-radius:6px}
.user .bubble{max-width:82%;background:var(--g);color:var(--on);box-shadow:0 1px 2px rgba(var(--k),.08)}
.rtl .user .bubble{border-top-left-radius:6px}
.ltr .user .bubble{border-top-right-radius:6px}
.user a{color:inherit}
.who{display:flex;gap:6px;margin:0 4px 3px;font-size:11.5px;line-height:1.5;font-weight:600;color:#4b5563}
.who time{font-weight:400;color:#9aa1ad}
.op+.op .who{display:none}
.sys{justify-content:center}
.note{max-width:88%;padding:7px 14px;border-radius:14px;background:rgba(var(--k),.05);color:#566070;font-size:12.5px;line-height:1.75;text-align:center;white-space:pre-wrap}
.note.j{display:inline-flex;align-items:center;gap:7px;padding-block:5px;padding-inline:12px 14px;border-radius:16px;background:#e9f8ef;color:#166534;font-weight:500}
.note.j svg{width:15px;height:15px}
.note.x{background:rgba(var(--k),.05);color:#566070}
.label{font-size:12px;color:var(--muted);margin:10px 4px 0}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip,.retry{background:#fff;color:var(--ink);border:1px solid var(--ink-3);border-radius:99px;
 transition:background-color .15s,border-color .15s,box-shadow .2s,transform .35s var(--sp)}
.chip{padding:6px 14px;font-size:13.5px;line-height:1.6;text-align:start}
.chip:hover,.retry:hover{background:var(--ink-1);border-color:var(--ink);transform:translateY(-1px);box-shadow:0 4px 10px -4px var(--ink-3)}
.chip:active,.retry:active{transform:scale(.95);transition-duration:.08s}
.chip.ghost{color:var(--muted);border:1px dashed #d0d4db}
.chip.ghost:hover{background:#eef0f3;box-shadow:none}
.hchip{display:inline-flex;align-items:center;gap:7px;background:var(--ink-1);border-color:transparent}
.hchip svg{width:16px;height:16px}
.hm .hchip,.nolive .hchip{display:none}
.hm .chips .chip{opacity:.5;pointer-events:none}
.busy .chip,.busy .retry,.busy .hbend{opacity:.55;cursor:default}
.srcs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:7px;font-size:12px;color:var(--muted)}
.src{display:inline-flex;align-items:center;gap:5px;max-width:240px;padding-block:3px;padding-inline:8px 10px;border:1px solid var(--line);border-radius:9px;
 background:#fff;color:#374151;text-decoration:none;line-height:1.6;transition:background-color .15s,border-color .15s,transform .3s var(--sp)}
.src span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.src svg{width:13px;height:13px;color:var(--ink)}
.src:hover{border-color:var(--ink-3);background:var(--ink-1);transform:translateY(-1px)}
.fx{animation:in .5s var(--sp) .06s both}
.fx .chip,.fx .src{animation:in .5s var(--sp) both}
.fx>:nth-child(2){animation-delay:.05s}.fx>:nth-child(3){animation-delay:.1s}.fx>:nth-child(4){animation-delay:.15s}.fx>:nth-child(n+5){animation-delay:.2s}

.fb{display:flex;align-items:center;gap:2px;min-height:30px;margin-top:3px;padding:0 4px;font-size:12px;color:var(--muted)}
.fb span{margin-inline-end:4px}
.fb button{width:30px;height:30px;border-radius:9px;color:#9aa1ad;transition:background-color .15s,color .15s,transform .3s var(--sp)}
.fb button:hover{background:#eceef2;color:var(--text)}
.fb button:active{transform:scale(.85)}
.fb svg{width:15px;height:15px}
.fb .done{color:var(--ink);width:14px;height:14px;margin-inline-end:6px;animation:pop .5s var(--sp)}

.typing .bubble{display:flex;align-items:center;gap:4px;padding:14px 15px;min-height:42px}
.typing i{width:6.5px;height:6.5px;border-radius:50%;background:#9aa1ad;animation:bob 1.2s infinite ease-in-out}
.typing i:nth-child(2){animation-delay:.16s}
.typing i:nth-child(3){animation-delay:.32s}
.caret{display:inline-block;width:2px;height:1.05em;margin-inline-start:2px;vertical-align:-.17em;border-radius:2px;background:var(--ink);animation:caret 1s ease-in-out infinite}
.w{animation:fade .45s ease-out both}
.live .bubble{cursor:pointer}
.err .bubble{display:flex;gap:8px;background:#fff6f6;border-color:#f6d2d2;color:#9b1c1c}
.err .bubble svg{width:17px;height:17px;margin-top:4px}
.retry{display:inline-flex;align-items:center;gap:6px;margin-top:6px;padding:5px 12px;font-size:13px}
.retry svg{width:14px;height:14px}

.lead{width:100%;margin-top:8px;padding:14px 14px 12px;border-radius:16px}
.lead-h{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-weight:700;font-size:14px}
.lead-h span{width:28px;height:28px;border-radius:9px;background:var(--ink-1);color:var(--ink)}
.lead-h svg{width:15px;height:15px}
.fld{display:block;margin-bottom:10px}
.lbl{display:block;margin-bottom:4px;font-size:12.5px;font-weight:500;color:#475063}
.lbl small{color:#9aa1ad;font-weight:400}
.fld input,.fld textarea{display:block;width:100%;padding:8px 12px;border:1px solid #d9dde4;border-radius:11px;background:#fff;font-size:14px;line-height:1.6;resize:none;transition:border-color .15s,box-shadow .15s}
.fld ::placeholder{color:#a8aeb9}
.fld input:focus,.fld textarea:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px var(--ink-2)}
.fld [aria-invalid=true],.fld [aria-invalid=true]:focus{border-color:#dc2626}
.fld [aria-invalid=true]:focus{box-shadow:0 0 0 3px rgba(220,38,38,.15)}
.ltrf{direction:ltr;text-align:left}
.ferr{display:block;margin-top:4px;font-size:12px;color:#b91c1c}
.ferr:empty{display:none}
.btn{display:block;width:100%;padding:10px;border-radius:11px;font-weight:700;font-size:14px;line-height:1.5;transition:filter .15s,transform .3s var(--sp)}
.btn:hover{filter:brightness(1.06)}
.btn:active{transform:scale(.98)}
.btn[disabled]{opacity:.65;cursor:default;filter:none}
.ok{display:flex;gap:10px;width:100%;margin-top:8px;padding:12px 14px;border-radius:16px;background:#effcf5;border:1px solid #c5ecd6;color:#0f5132;font-size:13.5px;animation:in .5s var(--sp)}
.ok svg{color:#16a34a;margin-top:2px}

.composer{flex:none;padding:10px 12px 12px;background:#fff;border-top:1px solid var(--line)}
.hbar{display:flex;align-items:center;gap:10px;margin-bottom:9px;padding:7px 8px;padding-inline-start:9px;border-radius:14px;background:var(--soft);line-height:1.45}
.hbar.sw{animation:in .55s var(--sp)}
.hbi{position:relative;flex:none;width:30px;height:30px;border-radius:50%;background:#1f2937;color:#fff}
.hbi svg{width:15px;height:15px}
.hbi::before{content:'';position:absolute;inset:0;border-radius:50%;border:2px solid #f59e0b;opacity:0}
.hm-wait .hbi::before{animation:ring2 1.8s var(--e) infinite}
.hbi::after{content:'';position:absolute;bottom:-1px;inset-inline-end:-2px;width:10px;height:10px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px var(--soft)}
.hm-wait .hbi::after{background:#f59e0b}
.hm-off .hbi{background:#9ca3af}
.hm-off .hbi::after{background:#cbd0d8}
.hbt{flex:1;min-width:0}
.hbt b{display:block;font-size:13px;font-weight:600}
.hbt small{display:block;font-size:11.5px;color:var(--muted)}
.hbend{flex:none;padding:4px 12px;border-radius:99px;border:1px solid #dfe2e8;background:#fff;font-size:12.5px;line-height:1.6;color:#4b5563;transition:background-color .15s,color .15s,border-color .15s,transform .3s var(--sp)}
.hbend:hover{border-color:#fca5a5;color:#b91c1c;background:#fff5f5}
.hbend:active{transform:scale(.94)}
.field{display:flex;align-items:flex-end;gap:8px;padding-block:5px;padding-inline:16px 5px;background:#f3f4f7;border:1px solid transparent;border-radius:24px;transition:background-color .15s,border-color .15s,box-shadow .15s}
.field:focus-within{background:#fff;border-color:var(--ink-3);box-shadow:0 0 0 3px var(--ink-1)}
.input{flex:1;min-width:0;height:38px;max-height:132px;padding:7px 0;border:0;background:none;resize:none;font-size:14.5px;line-height:1.65;outline:none!important}
.input::placeholder{color:#9aa1ad}
.send{flex:none;width:38px;height:38px;border-radius:50%;transition:transform .4s var(--sp),background .2s}
.send svg{width:18px;height:18px;transform:translateX(1px)}
.rtl .send svg{transform:scaleX(-1) translateX(1px)}
.send:not(:disabled):hover{transform:scale(1.07)}
.send:not(:disabled):active{transform:scale(.9);transition-duration:.08s}
.send:disabled{background:#dfe2e8;color:#fff;cursor:default;transform:scale(.92)}
.badge{flex:none;display:flex;justify-content:center;align-items:center;gap:5px;margin-top:-3px;padding:0 0 9px;background:#fff;font-size:11.5px;color:#a0a6b1;text-decoration:none}
.badge:hover{color:#5f6673}
.badge i{width:6px;height:6px;border-radius:50%;background:var(--c)}

.teaser{bottom:calc(92px + env(safe-area-inset-bottom,0px));max-width:300px;transform-origin:100% 100%;animation:tin .65s var(--sp) both}
.left .teaser{transform-origin:0 100%}
.teaser.bye{opacity:0;transform:translateY(8px) scale(.96);transition:opacity .2s ease-in,transform .2s ease-in}
.tcard{display:block;width:100%;padding:11px 16px 12px;border-radius:18px;border-bottom-right-radius:6px;background:#fff;color:var(--text);box-shadow:var(--sh);
 font-size:14px;line-height:1.7;transition:transform .35s var(--sp)}
.left .tcard{border-bottom-right-radius:18px;border-bottom-left-radius:6px}
.tcard:hover{transform:translateY(-2px)}
.tfrom{display:flex;align-items:center;gap:7px;margin-bottom:3px;font-size:12px;font-weight:600;color:var(--muted)}
.tfrom .av{width:22px;height:22px;margin:0;font-size:11px}
.tfrom .av svg{width:12px;height:12px}
.ttext{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line;overflow-wrap:anywhere}
.tx{position:absolute;top:-9px;right:-9px;width:26px;height:26px;border-radius:50%;background:#fff;color:#6b7280;box-shadow:0 0 0 1px rgba(var(--k),.08),0 4px 10px -3px rgba(var(--k),.3);
 opacity:0;transform:scale(.7);transition:opacity .15s,transform .3s var(--sp)}
.left .tx{right:auto;left:-9px}
.tx svg{width:14px;height:14px}
.teaser:hover .tx,.tx:focus-visible,.touch .tx{opacity:1;transform:none}

.page{position:fixed;top:0;right:0;bottom:0;left:0;display:flex;justify-content:center;background:#eef0f4}
.page::before{content:'';position:absolute;top:0;right:0;left:0;height:230px;background:var(--g)}
.page .panel{position:relative;right:auto;left:auto;bottom:auto;width:100%;max-width:720px;height:auto;min-height:0;margin:32px 16px;
 opacity:1;visibility:visible;pointer-events:auto;transform:none;transition:none}
.page .head{padding-block:16px;padding-inline:24px 16px}
.page .log{padding:24px 24px 16px}
.page .col{max-width:min(540px,calc(100% - 44px))}
.page .col.wide{width:min(440px,calc(100% - 36px))}
.page .user .bubble{max-width:540px}
.page .composer{padding:12px 20px 14px}
.fail{position:relative;align-self:center;margin:16px;padding:28px 32px;border-radius:18px;background:#fff;color:var(--muted);text-align:center;box-shadow:var(--sh)}
.fail p{margin:0 0 14px}

@media (max-width:760px){
 .page{background:#fff}
 .page::before{display:none}
 .page .panel{margin:0;border-radius:0;max-width:none;box-shadow:none}
 .page .log{padding:18px 14px 12px}
 .page .head{padding-top:calc(14px + env(safe-area-inset-top,0px))}
 .page .composer{padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px))}
 .badge{padding-bottom:calc(8px + env(safe-area-inset-bottom,0px))}
 .composer:has(+.badge){padding-bottom:10px}
}
@media (max-width:480px){
 .float .panel{top:0;right:0;bottom:0;left:0;width:auto;height:auto;min-height:0;border-radius:0;transform:translateY(32px);transform-origin:50% 100%}
 .float.open .panel{transform:none}
 .float.open .launcher{opacity:0;visibility:hidden;transition:none}
 .float .head{padding-top:calc(12px + env(safe-area-inset-top,0px))}
 .float .composer{padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px))}
 .float .composer:has(+.badge){padding-bottom:10px}
 .hbtn .i-x{display:block}
 .hbtn .i-down{display:none}
 .launcher{right:16px}
 .left .launcher{left:16px}
 .input,.fld input,.fld textarea{font-size:16px}
 .teaser{bottom:calc(24px + env(safe-area-inset-bottom,0px));right:86px;max-width:calc(100vw - 102px)}
 .left .teaser{right:auto;left:86px}
 .tcard{padding:8px 13px;font-size:13px;line-height:1.65;border-radius:16px;border-bottom-right-radius:6px}
 .tfrom{display:none}
 .ttext{-webkit-line-clamp:2}
 .tx{opacity:1;transform:none;width:24px;height:24px;top:-10px}
}
@keyframes in{from{opacity:0;transform:translateY(10px) scale(.96)}}
@keyframes pop{from{opacity:0;transform:scale(.5)}}
@keyframes fade{from{opacity:0}}
@keyframes subin{from{opacity:0;transform:translateY(7px)}}
@keyframes menuin{from{opacity:0;transform:translateY(-6px) scale(.95)}}
@keyframes tin{from{opacity:0;transform:translateY(14px) scale(.9)}}
@keyframes ring{0%{transform:scale(1);opacity:.38}100%{transform:scale(1.75);opacity:0}}
@keyframes ring2{0%{transform:scale(1);opacity:.9}100%{transform:scale(1.9);opacity:0}}
@keyframes breathe{50%{transform:scale(1.09)}}
@keyframes nudge{30%{transform:rotate(-12deg) scale(1.08)}60%{transform:rotate(8deg)}}
@keyframes blink2{50%{opacity:.45}}
@keyframes bob{0%,60%,100%{transform:none;opacity:.4}30%{transform:translateY(-4px);opacity:1}}
@keyframes caret{50%{opacity:.12}}
.instant *{transition:none!important;animation:none!important}
@media (prefers-reduced-motion:reduce){*,::before,::after{animation-duration:1ms!important;animation-iteration-count:1!important;animation-delay:0s!important;transition-duration:1ms!important}}
@media print{.root{display:none}}
`;

// --- state
let cfg = null, ready = false, isOpen = false, pendingOpen = false, busy = false, uid = 0, online = false;
let shadow, rootEl, launcher, countEl, panel, logEl, input, sendBtn, subEl, menuBtn, menu, bar, tzone, teaserEl = null;
let unread = Number(sget(SS, 'unread')) || 0, activeTyper = null, pingTimer = 0;
let pollTimer = 0, polling = false, pollFails = 0, hmGen = 0;
const leadEls = new WeakMap(); // message → its open lead form (to drop stale ones)
const visible = () => PAGE || isOpen;

function normalize(b) {
  const s = x => (typeof x === 'string' ? x.trim() : '');
  const badge = b.badge || {};
  const p = b.proactive || null;
  return {
    name: s(b.name).slice(0, 60) || T.support,
    welcome: s(b.welcome) || T.welcome,
    rgb: parseHex(b.color) || [79, 70, 229],
    left: b.position === 'left',
    leadForm: !!b.leadForm,
    liveChat: !!b.liveChat,
    ai: !!b.ai,
    suggestions: (Array.isArray(b.suggestions) ? b.suggestions : []).map(s).filter(Boolean).slice(0, 4),
    badge: badge.show && /^https?:\/\//i.test(badge.url || '') ? { text: s(badge.text), url: badge.url } : null,
    proactive: p && s(p.text) && Number(p.delay) >= 0
      ? { text: s(p.text).slice(0, 280), delay: Math.min(600, Number(p.delay) || 0), path: s(p.path) } : null,
  };
}

const initial = () => Array.from(cfg.name.replace(/\s+/g, ''))[0] || '؟';
const avatar = () => h('div', { class: 'av c', 'aria-hidden': 'true' }, initial());
const opAvatar = () => h('div', { class: 'av opa c', 'aria-hidden': 'true' }, icon('user'));
const newHost = () => {
  const host = document.createElement('pasokhyar-widget'); // custom tag: host `div {}` rules don't match
  const root = host.attachShadow({ mode: 'open' });
  addCss(root, STYLE);
  document.body.appendChild(host);
  return root;
};
const themed = (el, rgb) => { const p = palette(rgb); for (const k in p) el.style.setProperty(k, p[k]); return el; };
const rootClass = extra => 'root ' + (RTL() ? 'rtl' : 'ltr latin') + ' ' + extra;

// --- build
function build() {
  injectFonts();
  shadow = newHost();
  rootEl = themed(h('div', {
    class: rootClass((PAGE ? 'page z' : 'float') + (cfg.left ? ' left' : '') + (TOUCH.matches ? ' touch' : '') + (cfg.liveChat ? '' : ' nolive')),
    dir: RTL() ? 'rtl' : 'ltr', lang: LANG,
  }), cfg.rgb);
  const label = fmt(T.chatWith, cfg.name);

  if (!PAGE) {
    countEl = h('span', { class: 'count', 'aria-hidden': 'true' });
    launcher = button({ class: 'launcher z c', 'aria-expanded': 'false', 'aria-controls': 'pk-panel', 'aria-label': label, onclick: () => setOpen(!isOpen) },
      icon('chat', 'i-chat'), icon('down', 'i-close'), countEl);
  }

  subEl = h('div', { class: 'hsub' });
  menuBtn = button({ class: 'hbtn c', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'pk-menu', 'aria-label': T.menu, title: T.menu,
    onclick: () => (menu.hidden ? openMenu() : closeMenu(true)) }, icon('more'));
  menu = h('div', { class: 'menu', id: 'pk-menu', role: 'menu', 'aria-label': T.menu, hidden: true, onkeydown: menuKeys });
  const head = h('div', { class: 'head' },
    h('div', { class: 'hav', 'aria-hidden': 'true' }, h('span', { class: 'fc f1' }, initial()), h('span', { class: 'fc f2' }, icon('user'))),
    h('div', { class: 'htxt' }, h(PAGE ? 'h1' : 'h2', { class: 'hname' }, cfg.name), subEl),
    menuBtn,
    PAGE ? null : button({ class: 'hbtn c', 'aria-label': T.close, title: T.close, onclick: () => setOpen(false, true) },
      icon('down', 'i-down'), icon('close', 'i-x')),
    menu);

  logEl = h('div', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-label': T.messages, tabindex: '-1' });
  input = h('textarea', {
    class: 'input', rows: '1', maxlength: '500', dir: 'auto', enterkeyhint: 'send', placeholder: T.placeholder, 'aria-label': T.yourMsg,
    oninput: () => { autosize(); updateSend(); },
    // Enter sends, Shift+Enter = newline; ignore Enter that confirms an IME composition.
    onkeydown: e => {
      if (activeTyper) activeTyper.skip(); // typing again: finish the animated answer now
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
    },
  });
  sendBtn = h('button', { type: 'submit', class: 'send c', 'aria-label': T.send, disabled: true }, icon('send'));
  bar = h('div', { class: 'hbar', hidden: true });

  panel = h('section', { id: 'pk-panel', class: 'panel z', tabindex: '-1', role: PAGE ? 'main' : 'dialog', 'aria-label': label },
    head, logEl,
    h('form', { class: 'composer', onsubmit: e => { e.preventDefault(); submit(); } }, bar, h('div', { class: 'field' }, input, sendBtn)),
    cfg.badge && h('a', { class: 'badge', href: cfg.badge.url, target: '_blank', rel: 'noopener', dir: 'auto' }, h('i'), cfg.badge.text));

  rootEl.append(panel);
  if (!PAGE) {
    tzone = h('div', { role: 'status', 'aria-live': 'polite' });
    rootEl.append(tzone, launcher);
  }
  shadow.appendChild(rootEl);

  // Esc closes the menu, then the panel. Keys typed into our fields must not trigger host-site shortcuts.
  const inField = e => /^(INPUT|TEXTAREA)$/.test(e.target && e.target.tagName);
  shadow.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'Escape' && isOpen) { e.stopPropagation(); setOpen(false, true); }
    else if (inField(e)) e.stopPropagation();
  });
  for (const t of ['keyup', 'keypress']) shadow.addEventListener(t, e => { if (inField(e)) e.stopPropagation(); });
  // A click anywhere outside the menu closes it (inside our shadow root or on the page).
  document.addEventListener('pointerdown', e => {
    if (!menu.hidden && e.composedPath().indexOf(menu) < 0 && e.composedPath().indexOf(menuBtn) < 0) closeMenu();
  }, true);

  applyMode(false);
  renderAll();
  drawUnread();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
}
function updateSend() { sendBtn.disabled = busy || !input.value.trim(); }
function setBusy(b) {
  busy = b;
  rootEl.classList.toggle('busy', b);
  logEl.setAttribute('aria-busy', String(b));
  updateSend();
}
const focusInput = () => { if (!TOUCH.matches) input.focus({ preventScroll: true }); };

// --- header status, live-chat bar, menu
function drawStatus(anim) {
  rootEl.classList.toggle('on', online);
  const text = hm === 'wait' ? T.stWait : hm === 'live' ? T.stLive : hm === 'off' ? T.stOff
    : online && cfg.liveChat ? T.stTeam : cfg.ai ? T.stAi : T.stBot;
  if (subEl.textContent === text) return;
  subEl.textContent = text;
  if (anim) replay(subEl, 'sw');
}

function drawBar(anim) {
  bar.textContent = '';
  bar.hidden = !hm;
  if (!hm) return;
  const [title, sub] = hm === 'wait' ? [T.stWait, T.waitSub] : hm === 'live' ? [T.barLive, ''] : [T.barOff, T.offSub];
  bar.append(
    h('span', { class: 'hbi c', 'aria-hidden': 'true' }, icon('headset')),
    h('span', { class: 'hbt', role: 'status' }, h('b', null, title), sub && h('small', null, sub)),
    button({ class: 'hbend', onclick: endHuman }, T.end));
  if (anim) replay(bar, 'sw');
}

// Reflect the live-chat state everywhere (classes drive the animated transitions).
function applyMode(anim) {
  rootEl.classList.toggle('hm', !!hm);
  for (const s of ['wait', 'live', 'off']) rootEl.classList.toggle('hm-' + s, hm === s);
  input.placeholder = hm ? T.phHuman : T.placeholder;
  input.maxLength = hm ? 2000 : 500;
  drawStatus(anim);
  drawBar(anim);
  updateMenu();
}

function setHuman(state) {
  if (state === hm) return;
  hm = state;
  hmGen++;
  sset(LS, 'hm', hm);
  applyMode(true);
  for (const el of logEl.querySelectorAll('.starters')) el.remove();
  schedule();
}

function menuItems() {
  const items = [];
  if (cfg.liveChat && !hm) items.push([T.talkHuman, 'headset', handoff]);
  if (hm) items.push([T.endHuman, 'end', endHuman, 'danger']);
  if (!hm && log.length) items.push([T.newChat, 'restart', restart]);
  return items;
}
function updateMenu() { menuBtn.hidden = !menuItems().length; if (menuBtn.hidden) closeMenu(); }
function openMenu() {
  const items = menuItems();
  if (!items.length) return;
  menu.textContent = '';
  for (const [text, ic, fn, cls] of items) {
    menu.append(button({ class: 'mi' + (cls ? ' ' + cls : ''), role: 'menuitem', tabindex: '-1',
      onclick: () => { closeMenu(true); if (!busy) fn(); } }, icon(ic), h('span', null, text)));
  }
  menu.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
  menu.firstChild.focus();
}
function closeMenu(focusBtn) {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
  if (focusBtn) menuBtn.focus();
}
function menuKeys(e) {
  const items = Array.from(menu.children);
  const i = items.indexOf(shadow.activeElement);
  const go = j => { e.preventDefault(); items[(j + items.length) % items.length].focus(); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === 'Tab') closeMenu();
}

// --- rendering
function renderAll() {
  logEl.textContent = '';
  const col = h('div', { class: 'col' }, richText(h('div', { class: 'bubble', dir: 'auto' }), cfg.welcome));
  logEl.append(h('div', { class: 'row bot' }, avatar(), col));
  // Starter chips only until the visitor has said something.
  if (cfg.suggestions.length && !hm && !log.some(m => m.r === 'u')) {
    col.append(h('div', { class: 'chips starters' },
      cfg.suggestions.map(q => button({ class: 'chip', onclick: () => { if (!busy) ask(q); } }, q))));
  }
  for (const m of log) logEl.append(renderMsg(m));
  rootEl.classList.toggle('empty', !log.length);
  scrollEnd(false);
}

const humanChip = () => button({ class: 'chip hchip', onclick: handoff }, icon('headset'), T.talkHuman);

// fx: animate the extras (feedback, chips, sources, form) in after the text.
function renderMsg(m, fx) {
  const x = fx ? ' fx' : '';
  if (m.r === 'u') return h('div', { class: 'row user' }, h('div', { class: 'bubble', dir: 'auto' }, m.t));
  if (m.r === 's') {
    return h('div', { class: 'row sys' }, m.j
      ? h('div', { class: 'note j' + (m.j === 'end' ? ' x' : '') }, icon(m.j === 'end' ? 'check' : 'headset'), m.t)
      : richText(h('div', { class: 'note', dir: 'auto' }, ''), m.t));
  }
  if (m.r === 'o') {
    const at = clock(m.at);
    return h('div', { class: 'row op' }, opAvatar(), h('div', { class: 'col' },
      h('div', { class: 'who' }, T.operator, at && h('time', null, at)),
      richText(h('div', { class: 'bubble', dir: 'auto' }), m.t)));
  }
  const col = h('div', { class: 'col' });
  if (m.t) col.append(richText(h('div', { class: 'bubble', dir: 'auto' }), m.t));
  const src = Array.isArray(m.src) ? m.src.filter(s => s && typeof s.u === 'string' && httpUrl(s.u)).slice(0, 3) : [];
  if (src.length) {
    col.append(h('div', { class: 'srcs' + x }, h('span', null, T.sources + ':'),
      src.map(s => h('a', { class: 'src', href: s.u, target: '_blank', rel: 'noopener', title: s.u, dir: 'auto' },
        icon('link'), h('span', null, String(s.t || s.u).slice(0, 80))))));
  }
  if (m.k === 'answer' && m.id) col.append(feedback(m, x));
  const sugg = Array.isArray(m.s) ? m.s.filter(s => s && s.id != null && typeof s.question === 'string') : [];
  const hc = m.hc && cfg.liveChat;
  if (sugg.length || hc) {
    if (sugg.length && m.k === 'answer') col.append(h('div', { class: 'label' + x }, T.related));
    const fromId = m.k === 'suggest' ? m.id : null; // server learns what the visitor meant
    col.append(h('div', { class: 'chips' + x },
      sugg.map(s => button({ class: 'chip', onclick: () => pickFaq(s, fromId) }, s.question)),
      m.o && button({ class: 'chip ghost', onclick: noneOfThese }, T.none),
      hc && humanChip()));
  }
  if (m.lead) { col.classList.add('wide'); col.append(leadBlock(m)); }
  return h('div', { class: 'row bot' }, avatar(), col);
}

// Add a message to the history; `replace` is the live row it takes over from.
function commit(m, replace) {
  if (m.lead === 'open') dropOpenLeadForms();
  log.push(m);
  save();
  rootEl.classList.remove('empty');
  const row = renderMsg(m, !!replace);
  if (replace && replace.isConnected) replace.replaceWith(row);
  else { row.classList.add('anim'); logEl.append(row); }
  reveal(row);
  updateMenu();
}
const push = m => commit(m, null);

function scrollTo(top, smooth) {
  try { logEl.scrollTo({ top, behavior: smooth && !REDUCED.matches ? 'smooth' : 'auto' }); } catch (e) { logEl.scrollTop = top; }
}
const scrollEnd = smooth => requestAnimationFrame(() => scrollTo(logEl.scrollHeight, smooth));
// Scroll to the end — or to the row's top if it's taller than the view.
const reveal = row => requestAnimationFrame(() =>
  scrollTo(row.offsetHeight > logEl.clientHeight - 40 ? row.offsetTop - 12 : logEl.scrollHeight, true));
const nearEnd = () => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
// While text grows: stay pinned to the end, but never past the top of the growing row.
function follow(row, wasNear) {
  if (!wasNear) return;
  const max = logEl.scrollHeight - logEl.clientHeight;
  logEl.scrollTop = Math.max(logEl.scrollTop, Math.min(max, row.offsetTop - 12));
}

function showTyping() {
  const row = h('div', { class: 'row bot typing anim', 'aria-hidden': 'true' }, avatar(),
    h('div', { class: 'col' }, h('div', { class: 'bubble' }, h('i'), h('i'), h('i'))));
  logEl.append(row);
  scrollEnd(true);
  return row;
}

// A short, length-aware beat so replies feel typed rather than instant.
const typingDelay = text => 380 + Math.min(320, (text || '').length * 1.5);

// Reveals a bot answer word by word: streamed deltas as they arrive, a whole answer
// as a quick typewriter. Takes the typing row's place at `startAt`; click (or typing
// in the composer) skips to the end; instant with reduced motion or when unseen.
// The row is aria-hidden while it grows; the finished row replaces it and is announced.
function Typer(typing, startAt) {
  const caret = h('span', { class: 'caret' });
  const bubble = h('div', { class: 'bubble', dir: 'auto' }, caret);
  const row = h('div', { class: 'row bot live anim', 'aria-hidden': 'true' }, avatar(), h('div', { class: 'col' }, bubble));
  let target = '', shown = 0, timer = 0, started = false, fast = REDUCED.matches, done = null, dead = false;
  const words = from => (target.slice(from).match(/\S+/g) || []).length;
  const advance = n => {
    const re = /\s*\S+/g;
    re.lastIndex = shown;
    let i = shown;
    while (n-- > 0) { if (!re.exec(target)) return target.length; i = re.lastIndex; }
    return i;
  };
  const kick = () => { if (started && !timer && !dead) timer = setTimeout(tick, 0); };
  function tick() {
    timer = 0;
    if (shown < target.length) {
      const near = nearEnd();
      const all = fast || document.hidden || !visible();
      const end = all ? target.length : advance(1 + Math.floor(words(shown) / 10));
      const piece = target.slice(shown, end);
      shown = end;
      bubble.insertBefore(all ? document.createTextNode(piece) : h('span', { class: 'w' }, piece), caret);
      follow(row, near);
    }
    if (shown < target.length) timer = setTimeout(tick, 32);
    else if (done) { caret.remove(); const d = done; done = null; d(); }
  }
  const t = {
    row,
    add(s) { if (!target) s = s.replace(/^\s+/, ''); target += s; kick(); },
    // Resolves once the final text is fully on screen.
    finish(text) {
      return new Promise(res => {
        text = text.trim();
        if (text !== target) {
          const same = Math.min(shown, text.length);
          if (text.slice(0, same) !== target.slice(0, same)) { // server's final text differs: redraw
            for (const n of Array.from(bubble.childNodes)) if (n !== caret) n.remove();
            shown = 0;
          } else shown = same;
          target = text;
        }
        done = res;
        kick();
      });
    },
    skip() { fast = true; if (timer) { clearTimeout(timer); timer = 0; } kick(); },
    abort() { dead = true; clearTimeout(timer); row.remove(); if (activeTyper === t) activeTyper = null; },
  };
  bubble.addEventListener('click', t.skip);
  activeTyper = t;
  setTimeout(() => {
    if (dead) return;
    started = true;
    if (typing.isConnected) typing.replaceWith(row); else logEl.append(row);
    follow(row, true);
    kick();
  }, Math.max(0, startAt - Date.now()));
  return t;
}

// Client-side bot line (no round-trip), same typing beat and reveal.
async function botSay(m) {
  if (!m.t) return push(m);
  setBusy(true);
  const ty = Typer(showTyping(), Date.now() + typingDelay(m.t));
  ty.add(m.t);
  await ty.finish(m.t);
  if (activeTyper === ty) activeTyper = null;
  setBusy(false);
  commit(m, ty.row);
}

function errorRow(status, retry) {
  const row = h('div', { class: 'row bot err anim', role: 'alert' }, avatar(), h('div', { class: 'col' },
    h('div', { class: 'bubble' }, icon('alert'), h('span', null, status ? T.failed : T.offline)),
    button({ class: 'retry', onclick: () => { if (!busy) { row.remove(); retry(); } } }, icon('restart'), T.retry)));
  logEl.append(row);
  reveal(row);
}
const clearTransient = () => { for (const el of logEl.querySelectorAll('.starters,.err')) el.remove(); };

// --- conversation
function submit() {
  const q = input.value.trim();
  if (!q || busy) return;
  input.value = '';
  autosize();
  updateSend();
  if (hm) { push({ r: 'u', t: q }); deliver(q); } else ask(q);
}
function ask(q) {
  push({ r: 'u', t: q });
  converse('/ask', { q });
}
function pickFaq(s, fromId) {
  if (busy || hm) return;
  push({ r: 'u', t: s.question });
  converse('/pick', { faqId: s.id, messageId: fromId || undefined });
}
function noneOfThese() {
  if (busy) return;
  push({ r: 'u', t: T.none });
  botSay({ r: 'b', k: 'info', t: T.noneReply, lead: 'open', hc: cfg.liveChat ? 1 : undefined });
}

async function converse(path, payload) {
  if (busy) return;
  setBusy(true);
  clearTransient();
  const typing = showTyping();
  const t0 = Date.now();
  const body = Object.assign({ sid, channel: PAGE ? 'page' : undefined }, payload);
  if (path === '/ask') body.page = location.href;
  let ty = null;
  let r;
  if (path === '/ask' && cfg.ai && STREAMS) {
    r = await askStream(body, text => {
      if (!ty) ty = Typer(typing, t0 + typingDelay(text));
      ty.add(text);
    });
    if (!r.status) { // the stream broke or errored: ask again the plain way
      if (ty) { ty.abort(); ty = null; if (!typing.isConnected) logEl.append(typing); }
      r = await api('/ask', body);
    }
  } else {
    r = await api(path, body);
  }
  const { status, data } = r;
  const text = typeof data.answer === 'string' ? data.answer.trim() : '';

  if (status === 200 && data.ok && data.type === 'human') {
    // A person is handling this chat: the message went to them; replies arrive by polling.
    if (ty) ty.abort();
    typing.remove();
    setBusy(false);
    if (!hm) setHuman('wait');
    schedule(1500);
    return;
  }
  if (status === 200 && data.ok && text) {
    const m = { r: 'b', k: data.type, t: text };
    if (data.messageId) m.id = data.messageId;
    if (Array.isArray(data.suggestions) && data.suggestions.length) {
      m.s = data.suggestions.slice(0, 5).map(s => ({ id: s.id, question: String(s.question || '') }));
    }
    if (Array.isArray(data.sources) && (data.kind === 'passage' || data.kind === 'ai')) {
      const src = data.sources.filter(s => s && httpUrl(String(s.url || ''))).slice(0, 3)
        .map(s => ({ u: String(s.url), t: String(s.title || '').trim().slice(0, 120) }));
      if (src.length) m.src = src;
    }
    if (data.type === 'suggest') { if (data.offerLead && cfg.leadForm) m.o = 1; } else if (data.offerLead) m.lead = 'open';
    if (cfg.liveChat && /^(fallback|suggest|limit)$/.test(data.type)) m.hc = 1;
    if (!ty) { ty = Typer(typing, t0 + typingDelay(text)); ty.add(text); }
    await ty.finish(text);
    if (activeTyper === ty) activeTyper = null;
    typing.remove();
    setBusy(false);
    commit(m, ty.row);
  } else {
    if (ty) ty.abort();
    await wait(typingDelay('') - (Date.now() - t0));
    typing.remove();
    setBusy(false);
    if (status === 429) push({ r: 'b', k: 'info', t: text || T.slowDown });
    else if (status === 404 && path === '/pick') push({ r: 'b', k: 'info', t: T.gone });
    else errorRow(status, () => converse(path, payload));
  }
  if (!visible()) bump(1);
  schedule();
}

function feedback(m, x) {
  const wrap = h('div', { class: 'fb' + (x || '') });
  const btn = good => button({ class: 'c', 'aria-label': good ? T.yes : T.no, title: good ? T.yes : T.no, onclick: () => rate(good) }, icon(good ? 'up' : 'dn'));
  const draw = () => {
    wrap.textContent = '';
    if (m.fb == null) wrap.append(h('span', null, T.helpful), btn(true), btn(false));
    else wrap.append(icon(m.fb ? 'up' : 'dn', 'done'), h('span', { role: 'status' }, T.thanks));
  };
  const rate = good => {
    const hadFocus = wrap.contains(shadow.activeElement);
    m.fb = good ? 1 : 0;
    save();
    draw();
    if (hadFocus) focusInput(); // the pressed button is gone
    api('/feedback', { messageId: m.id, helpful: good });
    if (!good && !busy && (cfg.leadForm || (cfg.liveChat && !hm))) {
      botSay({ r: 'b', k: 'info', t: cfg.leadForm ? T.unhelpful : T.unhelpfulHuman,
        lead: cfg.leadForm ? 'open' : undefined, hc: cfg.liveChat && !hm ? 1 : undefined });
    }
  };
  draw();
  return wrap;
}

// Only one unsubmitted lead form at a time: a newer offer replaces older ones.
function dropOpenLeadForms() {
  for (const m of log) {
    if (m.lead !== 'open') continue;
    delete m.lead;
    const el = leadEls.get(m);
    if (el && el.parentNode) {
      el.parentNode.classList.remove('wide');
      const row = el.parentNode.parentNode;
      el.remove();
      if (!m.t && row && !row.querySelector('.bubble,.chips')) row.remove(); // form-only message
    }
  }
  log = log.filter(m => m.r !== 'b' || m.t || m.lead || m.s || m.hc);
}

function leadBlock(m) {
  if (m.lead === 'done') return h('div', { class: 'ok', role: 'status' }, icon('check'), h('span', null, m.lm || T.leadDone));
  const n = ++uid;
  const errs = new Map(); // control → its error line
  const field = (label, ctl) => {
    let err = null;
    if (ctl.required) {
      err = h('span', { class: 'ferr', id: 'pk-e' + n + ctl.name, 'aria-live': 'polite' });
      ctl.setAttribute('aria-describedby', err.id);
      errs.set(ctl, err);
      ctl.addEventListener('input', () => setErr(ctl, ''));
    }
    return h('label', { class: 'fld' }, h('span', { class: 'lbl' }, label), ctl, err);
  };
  const setErr = (ctl, text) => {
    ctl.setAttribute('aria-invalid', String(!!text));
    errs.get(ctl).textContent = text;
  };
  const name = h('input', { type: 'text', name: 'name', autocomplete: 'name', maxlength: '100', required: true, dir: 'auto' });
  const phone = h('input', { type: 'tel', name: 'phone', class: 'ltrf', autocomplete: 'tel', inputmode: 'tel', maxlength: '20', required: true, placeholder: T.phoneHint });
  const msg = h('textarea', { name: 'message', rows: '2', maxlength: '1000', dir: 'auto' });
  const btn = h('button', { type: 'submit', class: 'btn' }, T.leadSend);
  const formErr = h('span', { class: 'ferr', role: 'alert' });
  const form = h('form', { class: 'lead', novalidate: true, 'aria-label': T.leadTitle },
    h('div', { class: 'lead-h' }, h('span', { class: 'c' }, icon('phone')), T.leadTitle),
    field(T.name, name), field(T.phone, phone), field([T.note + ' ', h('small', null, T.optional)], msg),
    btn, formErr);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (btn.disabled) return;
    formErr.textContent = '';
    const nm = name.value.trim();
    // Loose check; the server has the final say.
    const ph = toEn(phone.value).replace(/[\s\-().]/g, '');
    let bad = null;
    if (!/^\+?\d{7,15}$/.test(ph)) { setErr(phone, T.errPhone); bad = phone; }
    if (!nm) { setErr(name, T.errName); bad = name; }
    if (bad) return bad.focus();

    btn.disabled = true;
    btn.textContent = T.sending;
    const { status, data } = await api('/lead', { sid, name: nm, phone: ph, message: msg.value.trim() });
    btn.disabled = false;
    btn.textContent = T.leadSend;
    if (status === 200 && data.ok) {
      m.lead = 'done';
      m.lm = typeof data.message === 'string' && data.message ? data.message : T.leadDone;
      save();
      const done = leadBlock(m);
      form.replaceWith(done);
      leadEls.delete(m);
      focusInput();
      reveal(done.parentNode.parentNode);
    } else if (status === 400 && data.error === 'bad_phone') {
      setErr(phone, T.badPhone);
      phone.focus();
    } else {
      formErr.textContent = status === 429 ? T.leadLimited : status ? T.leadFailed : T.leadOffline;
    }
  });
  leadEls.set(m, form);
  return form;
}

function restart() {
  if (busy || hm) return;
  log = [];
  save();
  renderAll();
  updateMenu();
  focusInput();
}

// --- live operator chat
async function handoff() {
  if (busy || hm || !cfg.liveChat) return;
  closeMenu();
  push({ r: 'u', t: T.talkMsg });
  requestHuman();
}
async function requestHuman() {
  setBusy(true);
  clearTransient();
  const typing = showTyping();
  const t0 = Date.now();
  const { status, data } = await api('/handoff', { sid, channel: PAGE ? 'page' : undefined });
  await wait(600 - (Date.now() - t0));
  typing.remove();
  setBusy(false);
  if (status === 200 && data.ok) {
    online = !!data.online;
    // The same note comes back from /poll as a system message; claimSys() skips it there.
    push({ r: 's', t: typeof data.message === 'string' && data.message ? data.message : online ? T.waitSub : T.offSub });
    setHuman(online ? 'wait' : 'off');
    if (!online && data.offerLead && cfg.leadForm) push({ r: 'b', k: 'info', t: '', lead: 'open' });
    schedule(700);
  } else if (status === 429) {
    push({ r: 'b', k: 'info', t: T.slowDown });
  } else if (status === 403) {
    cfg.liveChat = false;
    rootEl.classList.add('nolive');
    updateMenu();
    push({ r: 'b', k: 'info', t: T.humanOff, lead: cfg.leadForm ? 'open' : undefined });
  } else {
    errorRow(status, requestHuman);
  }
  focusInput();
}

// Visitor message while an operator handles the chat.
async function deliver(text) {
  setBusy(true);
  const { status, data } = await api('/send', { sid, text, channel: PAGE ? 'page' : undefined });
  setBusy(false);
  if (status === 200 && data.ok) return schedule(2000);
  if (status === 409) { // the chat went back to the bot meanwhile: let the bot answer it
    setHuman('');
    push({ r: 's', t: T.ended, j: 'end' });
    return converse('/ask', { q: text });
  }
  if (status === 429) push({ r: 'b', k: 'info', t: T.slowDown });
  else errorRow(status, () => deliver(text));
}

async function endHuman() {
  if (!hm || busy) return;
  closeMenu();
  setBusy(true);
  const { status } = await api('/end', { sid });
  setBusy(false);
  if (status !== 200) return errorRow(status, endHuman);
  setHuman('');
  push({ r: 's', t: T.ended, j: 'end' });
  focusInput();
}

// The handoff note we already showed comes back from /poll: adopt its id instead of repeating it.
function claimSys(text, id) {
  for (let i = log.length - 1; i >= Math.max(0, log.length - 8); i--) {
    const m = log[i];
    if (m.r === 's' && !m.id && !m.j && m.t === text) { m.id = id; save(); return true; }
  }
  return false;
}

async function poll() {
  clearTimeout(pollTimer);
  pollTimer = 0;
  if (polling || !ready) return;
  polling = true;
  const gen = hmGen;
  const { status, data } = await api('/poll?sid=' + encodeURIComponent(sid) + '&after=' + lastId);
  polling = false;
  if (status === 404) return; // bot deleted: stop
  if (status !== 200 || !data.ok) { pollFails++; return schedule(); }
  pollFails = 0;
  if (typeof data.operatorOnline === 'boolean' && data.operatorOnline !== online) {
    online = data.operatorOnline;
    if (hm === 'off' && online) setHuman('wait'); else drawStatus(true);
  }
  let fresh = 0, lastOp = '';
  for (const x of Array.isArray(data.messages) ? data.messages : []) {
    const id = Number(x && x.id) || 0;
    if (id <= lastId || typeof x.text !== 'string' || !x.text.trim()) continue;
    lastId = id;
    if (x.sender === 'operator') {
      if (hm !== 'live') { setHuman('live'); push({ r: 's', t: T.joined, j: 'join' }); }
      push({ r: 'o', t: x.text, id, at: Number(x.at) || Date.now() });
      fresh++;
      lastOp = x.text;
    } else if (x.sender === 'system' && !claimSys(x.text, id)) {
      push({ r: 's', t: x.text, id });
    }
  }
  sset(LS, 'last', String(lastId));
  if (gen === hmGen) { // ignore a mode that predates a change made while this request was out
    if (data.mode === 'bot' && hm) { setHuman(''); push({ r: 's', t: T.ended, j: 'end' }); }
    else if (data.mode === 'human' && !hm) setHuman('wait');
  }
  if (fresh && !visible()) { bump(fresh); ping(); showTeaser(lastOp, true); }
  schedule();
}

// Human mode: every ~3 s while the chat is open, ~15 s while closed. Bot mode: a slow
// check while open (an operator may take over). Never while the tab is hidden.
function schedule(ms) {
  clearTimeout(pollTimer);
  pollTimer = 0;
  if (!ready || document.hidden) return;
  let d = ms;
  if (d == null) {
    if (hm) d = visible() ? 3000 : 15000;
    else if (cfg.liveChat && visible() && log.some(m => m.r === 'u')) d = 20000;
    else return;
    d = Math.min(60000, d * Math.pow(2, Math.min(pollFails, 4)));
  }
  pollTimer = setTimeout(poll, d);
}

// --- launcher: unread count, pings, teaser
function bump(n) {
  if (PAGE) return;
  unread += n;
  drawUnread();
}
function drawUnread() {
  if (PAGE) return;
  countEl.textContent = unread ? num(Math.min(unread, 9)) + (unread > 9 ? '+' : '') : '';
  rootEl.classList.toggle('unread', unread > 0);
  launcher.setAttribute('aria-label', isOpen ? T.close : fmt(T.chatWith, cfg.name) + (unread ? ' (' + fmt(T.newCount, num(unread)) + ')' : ''));
  sset(SS, 'unread', unread ? String(unread) : '');
}
function ping() {
  if (PAGE) return;
  replay(launcher, 'ping');
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => launcher.classList.remove('ping'), 4600);
}

// A bubble next to the closed launcher: the proactive greeting, or an operator's new message.
function showTeaser(text, fromOp) {
  if (PAGE || isOpen || !text) return;
  hideTeaser(true);
  const el = h('div', { class: 'teaser z' + (MOBILE.matches ? ' compact' : '') },
    button({ class: 'tcard', onclick: () => {
      if (!fromOp) push({ r: 'b', k: 'info', t: text });
      setOpen(true);
    } },
    h('span', { class: 'tfrom' }, fromOp ? opAvatar() : avatar(), fromOp ? T.operator : cfg.name),
    h('span', { class: 'ttext', dir: 'auto' }, text)),
    button({ class: 'tx c', 'aria-label': T.dismiss, title: T.dismiss, onclick: () => {
      hideTeaser();
      if (!fromOp) { unread = 0; drawUnread(); }
      launcher.focus({ preventScroll: true });
    } }, icon('close')));
  teaserEl = el;
  tzone.append(el);
}
function hideTeaser(now) {
  const el = teaserEl;
  if (!el) return;
  teaserEl = null;
  if (now || REDUCED.matches) el.remove();
  else { el.classList.add('bye'); setTimeout(() => el.remove(), 220); }
}

function scheduleProactive() {
  const p = cfg.proactive;
  const skip = () => isOpen || hm || sget(SS, 'seen') || sget(SS, 'pro');
  if (!p || PAGE || skip() || (p.path && location.href.indexOf(p.path) < 0)) return;
  setTimeout(() => {
    if (skip()) return;
    sset(SS, 'pro', '1');
    showTeaser(p.text, false);
    bump(1);
    ping();
  }, p.delay * 1000);
}

// --- open/close
function setOpen(v, focusLauncher) {
  if (!ready) { pendingOpen = v; return; }
  if (PAGE || v === isOpen) return;
  isOpen = v;
  rootEl.classList.toggle('open', v);
  launcher.setAttribute('aria-expanded', String(v));
  sset(SS, 'open', v ? '1' : '');
  closeMenu();
  if (v) {
    sset(SS, 'seen', '1');
    launcher.classList.remove('hello', 'ping');
    hideTeaser();
    unread = 0;
    scrollEnd(false);
    // Touch: focus the dialog, not the input (the keyboard would cover the chat).
    setTimeout(() => (TOUCH.matches ? panel : input).focus({ preventScroll: true }), 60);
    if (hm) poll(); else schedule();
  } else {
    if (activeTyper) activeTyper.skip();
    if (focusLauncher || panel.contains(shadow.activeElement)) launcher.focus({ preventScroll: true });
    schedule();
  }
  drawUnread();
}

// --- boot
window.Pasokhyar = {
  version: '2.0',
  open: () => setOpen(true),
  close: () => setOpen(false),
  toggle: () => setOpen(!(ready ? isOpen : pendingOpen)),
};
// Any host element with a data-pasokhyar-open attribute opens the chat.
document.addEventListener('click', e => {
  const t = e.target && e.target.closest && e.target.closest('[data-pasokhyar-open]');
  if (t) { e.preventDefault(); setOpen(true); }
});
document.addEventListener('visibilitychange', () => {
  if (!ready) return;
  if (document.hidden) { clearTimeout(pollTimer); pollTimer = 0; } else if (hm) poll(); else schedule();
});
window.addEventListener('online', () => { if (ready && hm) { pollFails = 0; poll(); } });

(async () => {
  const [res] = await Promise.all([
    api('/config'),
    new Promise(r => (document.body ? r() : document.addEventListener('DOMContentLoaded', r, { once: true }))),
  ]);
  if (res.status !== 200 || !res.data.ok || !res.data.bot) {
    console.warn('[pasokhyar] widget disabled:', res.data.error || res.status || 'network error');
    if (PAGE) { // hosted page: a friendly message instead of a blank screen
      injectFonts();
      newHost().append(themed(h('div', { class: rootClass('page z'), dir: RTL() ? 'rtl' : 'ltr', lang: LANG }, h('div', { class: 'fail' }, h('p', null, T.unavailable),
        button({ class: 'retry', onclick: () => location.reload() }, icon('restart'), T.retry))), [107, 114, 128]));
    }
    return;
  }
  setLang(res.data.bot.lang);
  cfg = normalize(res.data.bot);
  online = !!res.data.bot.operatorOnline;
  build();
  ready = true;
  if (hm) poll(); // resume a live chat after a reload
  // Stay open across navigations in this tab — not on phones, where the panel
  // is full-screen and would cover every page.
  const restore = !PAGE && sget(SS, 'open') === '1' && !MOBILE.matches;
  if (pendingOpen || restore) {
    if (!pendingOpen) rootEl.classList.add('instant'); // no animation on restore
    setOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => rootEl.classList.remove('instant')));
  } else if (PAGE) {
    focusInput();
    schedule();
  } else {
    scheduleProactive();
    // A brief "hello" (two soft ripples) once the page settles; then the launcher stays still.
    if (!sget(SS, 'seen')) {
      setTimeout(() => { if (!isOpen) launcher.classList.add('hello'); }, 1400);
      setTimeout(() => launcher.classList.remove('hello'), 1400 + 4800);
    }
  }
})();
})();

'use strict';
// Visitor-facing strings the server sends, in each bot language.
// (Dashboard and marketing site are Persian; the widget and bot replies
// follow the bot's `lang` so the product can serve foreign sites.)
const LANGS = {
  fa: { name: 'فارسی', dir: 'rtl' },
  en: { name: 'English', dir: 'ltr' },
  ar: { name: 'العربية', dir: 'rtl' },
  tr: { name: 'Türkçe', dir: 'ltr' },
};

const S = {
  suggest: {
    fa: 'منظورتان یکی از این‌هاست؟',
    en: 'Did you mean one of these?',
    ar: 'هل تقصد أحد هذه الأسئلة؟',
    tr: 'Bunlardan birini mi demek istediniz?',
  },
  limit: {
    fa: 'در حال حاضر پاسخگوی خودکار در دسترس نیست. لطفاً شماره‌تان را بگذارید تا با شما تماس بگیریم.',
    en: 'The automatic assistant is unavailable right now. Leave your number and we will call you back.',
    ar: 'المساعد الآلي غير متاح حالياً. اترك رقمك وسنتصل بك.',
    tr: 'Otomatik asistan şu anda kullanılamıyor. Numaranızı bırakın, sizi arayalım.',
  },
  rateLimited: {
    fa: 'کمی آهسته‌تر 🙂 چند ثانیه دیگر دوباره بپرسید.',
    en: 'A little slower 🙂 please ask again in a few seconds.',
    ar: 'مهلاً 🙂 أعد السؤال بعد ثوانٍ.',
    tr: 'Biraz yavaş 🙂 birkaç saniye sonra tekrar sorun.',
  },
  leadThanks: {
    fa: 'ممنون! همکاران ما به‌زودی با شما تماس می‌گیرند.',
    en: 'Thanks! Our team will contact you soon.',
    ar: 'شكراً! سيتواصل معك فريقنا قريباً.',
    tr: 'Teşekkürler! Ekibimiz yakında sizinle iletişime geçecek.',
  },
  humanOnline: {
    fa: 'درخواست شما به همکاران ما رسید. چند لحظه صبر کنید، الان به گفتگو می‌پیوندند. 🙋',
    en: 'We have let our team know. Someone will join this chat in a moment. 🙋',
    ar: 'وصل طلبك إلى فريقنا. سينضم أحدهم إلى المحادثة خلال لحظات. 🙋',
    tr: 'Talebiniz ekibimize iletildi. Birazdan biri sohbete katılacak. 🙋',
  },
  humanOffline: {
    fa: 'همکاران ما الان آنلاین نیستند. پیام‌تان را بنویسید؛ به محض آنلاین شدن جواب می‌دهند. اگر شماره‌تان را هم بگذارید، تماس می‌گیرند.',
    en: 'Our team is offline right now. Write your message and we will reply as soon as we are back, or leave your number for a call.',
    ar: 'فريقنا غير متصل الآن. اكتب رسالتك وسنرد فور عودتنا، أو اترك رقمك لنتصل بك.',
    tr: 'Ekibimiz şu anda çevrimdışı. Mesajınızı yazın, döner dönmez yanıtlayalım ya da aranmak için numaranızı bırakın.',
  },
  defaultWelcome: {
    fa: name => `سلام! 👋 من دستیار ${name} هستم. سؤالتان را بپرسید.`,
    en: name => `Hi there! 👋 I'm the ${name} assistant. How can I help?`,
    ar: name => `مرحباً! 👋 أنا مساعد ${name}. كيف أساعدك؟`,
    tr: name => `Merhaba! 👋 Ben ${name} asistanıyım. Nasıl yardımcı olabilirim?`,
  },
  defaultFallback: {
    fa: 'متأسفانه جواب این سؤال را پیدا نکردم. اگر شماره‌تان را بگذارید، همکاران ما با شما تماس می‌گیرند.',
    en: "Sorry, I couldn't find an answer to that. Leave your number and our team will get back to you.",
    ar: 'عذراً، لم أجد إجابة لهذا السؤال. اترك رقمك وسيتواصل معك فريقنا.',
    tr: 'Üzgünüm, bunun cevabını bulamadım. Numaranızı bırakın, ekibimiz size dönüş yapsın.',
  },
  aiStyle: {
    fa: 'به فارسی روان، مؤدبانه و کوتاه (حداکثر سه جمله) جواب بده.',
    en: 'Answer in clear, polite English, briefly (at most three sentences).',
    ar: 'أجب بالعربية الفصحى بأدب وباختصار (ثلاث جمل على الأكثر).',
    tr: 'Kibar ve kısa bir Türkçe ile yanıt ver (en fazla üç cümle).',
  },
};

function lang(bot) {
  return bot && LANGS[bot.lang] ? bot.lang : 'fa';
}

function t(key, botOrLang, ...args) {
  const l = typeof botOrLang === 'string' ? (LANGS[botOrLang] ? botOrLang : 'fa') : lang(botOrLang);
  const v = S[key][l] ?? S[key].fa;
  return typeof v === 'function' ? v(...args) : v;
}

module.exports = { LANGS, t, lang };

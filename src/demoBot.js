'use strict';
// The chatbot on our own home page: a live demo that answers questions about
// the product itself, built from the site FAQ. Owned by a system account on
// a non-expiring business plan so it shows no badge and has no usage cap.
const db = require('./db');
const bots = require('./bots');
const content = require('./content');
const config = require('./config');
const settings = require('./settings');
const { hashPassword, token } = require('./util');

const SYSTEM_PHONE = 'system';
const DEMO_KEY = 'sitedemo';

let cachedKey = null;
// What the demo bot was last synced from; the site owner can change the site
// name or the site FAQ at runtime (/admin/settings), so key() re-checks it.
let syncedConn = null;
let syncedStamp = null;
let syncedFaqJson = null;

function stamp() {
  return `${config.siteName}\u0000${config.siteUrl}\u0000${settings.version()}`;
}

function extraFaqs() {
  return [
    {
      question: 'این چت‌بات چطور کار می‌کند؟',
      alternates: ['چطوری کار میکنه', 'این چیه', 'شما چی هستید'],
      answer: `من یک نمونه‌ی زنده از ${config.siteName} هستم! شما سؤال و جواب‌های کسب‌وکارتان را وارد می‌کنید و من ۲۴ ساعته از بین همان جواب‌ها به مشتری‌ها پاسخ می‌دهم. همین الان می‌توانید رایگان بات خودتان را بسازید: ${config.siteUrl}/signup`,
    },
    {
      question: 'قیمت اشتراک چقدر است؟',
      alternates: ['قیمتش چنده', 'هزینه ماهانه', 'تعرفه ها', 'پلن ها'],
      answer: `پلن رایگان برای همیشه رایگان است. پلن‌های حرفه‌ای و سازمانی ماهانه هستند و برای پرداخت سه‌ماهه و سالانه تخفیف دارند. جزئیات: ${config.siteUrl}/pricing`,
    },
    {
      question: 'آیا می‌شود سؤال‌ها را از سایت خودمان وارد کرد؟',
      alternates: ['از سایتم وارد کنم', 'سوالات متداول سایتم رو بیاره', 'ورود خودکار سوالات'],
      answer: 'بله. موقع ساخت بات، آدرس صفحه‌ی «سؤالات متداول» سایت‌تان را بدهید تا همه‌ی سؤال و جواب‌ها خودکار وارد شوند. فایل اکسل و بسته‌های آماده‌ی هر صنف هم هست.',
    },
    {
      question: 'نسخه‌ی سازمانی و نصب روی سرور خودمان دارید؟',
      alternates: ['نصب روی سرور سازمان', 'نسخه اختصاصی', 'برای اداره', 'آن پرمیس'],
      answer: `بله. برای سازمان‌ها، ادارات، بانک‌ها و بیمه‌ها نسخه‌ی اختصاصی روی سرور خودتان نصب می‌شود و هیچ داده‌ای از سازمان بیرون نمی‌رود. درخواست مشاوره: ${config.siteUrl}/enterprise`,
    },
    {
      question: 'چطور ثبت‌نام کنم؟',
      alternates: ['ثبت نام', 'میخوام شروع کنم', 'عضویت'],
      answer: `فقط با شماره موبایل و یک رمز عبور، در کمتر از یک دقیقه: ${config.siteUrl}/signup`,
    },
  ];
}

function ensure() {
  const conn = db.get();
  let user = conn.prepare('SELECT * FROM users WHERE phone = ?').get(SYSTEM_PHONE);
  if (!user) {
    conn.prepare(`
      INSERT INTO users (phone, name, company, password_hash, plan, plan_expires_at, ref_code, created_at)
      VALUES (?, ?, ?, ?, 'business', ?, ?, ?)
    `).run(SYSTEM_PHONE, config.siteName, config.siteName, hashPassword(token(32)), Date.UTC(2100, 0, 1), 'system00', Date.now());
    user = conn.prepare('SELECT * FROM users WHERE phone = ?').get(SYSTEM_PHONE);
  }
  let bot = bots.getBotByKey(DEMO_KEY);
  if (!bot) bot = bots.createBot(user.id, { name: `دستیار ${config.siteName}` });
  // Name and welcome carry the brand name, which the admin can change.
  const name = `دستیار ${config.siteName}`;
  const welcome = `سلام! 👋 من نمونه‌ی زنده‌ی ${config.siteName} هستم. هر سؤالی درباره‌ی چت‌بات، قیمت یا نصب دارید بپرسید.`;
  if (bot.public_key !== DEMO_KEY || bot.name !== name || bot.welcome !== welcome) {
    conn.prepare('UPDATE bots SET public_key = ?, name = ?, welcome = ?, updated_at = ? WHERE id = ?').run(DEMO_KEY, name, welcome, Date.now(), bot.id);
  }
  if (user.name !== config.siteName) {
    conn.prepare('UPDATE users SET name = ?, company = ? WHERE id = ?').run(config.siteName, config.siteName, user.id);
  }
  // Re-sync the FAQ from the (admin-editable) site FAQ on boot and whenever it changes.
  const faqs = [...extraFaqs(), ...content.siteFaq.map(f => ({ question: f.q, alternates: [], answer: f.a }))];
  const faqJson = JSON.stringify(faqs);
  if (syncedConn !== conn || faqJson !== syncedFaqJson) {
    conn.transaction(() => {
      conn.prepare('DELETE FROM faqs WHERE bot_id = ?').run(bot.id);
      for (const f of faqs) bots.addFaq(bot.id, f);
    })();
    syncedFaqJson = faqJson;
  }
  syncedConn = conn;
  syncedStamp = stamp();
  cachedKey = DEMO_KEY;
  return DEMO_KEY;
}

function key() {
  try {
    if (cachedKey && syncedConn === db.get() && syncedStamp === stamp()) return cachedKey;
    return ensure();
  } catch (e) {
    console.error('demo bot setup failed:', e.message);
    return cachedKey;
  }
}

module.exports = { ensure, key, SYSTEM_PHONE };

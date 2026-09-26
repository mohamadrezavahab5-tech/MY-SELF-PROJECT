'use strict';
// Creates a demo account + bot with sample FAQs for local development.
// Usage: node scripts/seed-demo.js   (prints the bot's public key)
const db = require('../src/db');
const bots = require('../src/bots');
const { hashPassword, shortId } = require('../src/util');

const PHONE = '09120000000';
const conn = db.get();
let user = conn.prepare('SELECT * FROM users WHERE phone = ?').get(PHONE);
if (!user) {
  conn.prepare(`INSERT INTO users (phone, name, company, password_hash, ref_code, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(PHONE, 'کاربر نمونه', 'فروشگاه نمونه', hashPassword('demo1234'), shortId(8), Date.now());
  user = conn.prepare('SELECT * FROM users WHERE phone = ?').get(PHONE);
}

let bot = conn.prepare('SELECT * FROM bots WHERE user_id = ?').get(user.id);
if (!bot) {
  bot = bots.createBot(user.id, { name: 'فروشگاه نمونه', industry: 'shop' });
  const faqs = [
    ['هزینه ارسال چقدر است؟', ['هزینه پست چنده', 'ارسال رایگان دارید؟'], 'ارسال برای خریدهای بالای ۵۰۰ هزار تومان رایگان است. برای بقیه‌ی سفارش‌ها هزینه‌ی ارسال ۴۵ هزار تومان است.'],
    ['سفارشم کی می‌رسد؟', ['زمان تحویل چقدره', 'چند روزه میرسه'], 'سفارش‌های تهران ۱ تا ۲ روز کاری و شهرستان‌ها ۲ تا ۴ روز کاری بعد از ثبت به دستتان می‌رسد.'],
    ['چطور سفارشم را پیگیری کنم؟', ['کد رهگیری', 'سفارشم کجاست'], 'بعد از ارسال، کد رهگیری پیامک می‌شود. از بخش «سفارش‌های من» در سایت هم می‌توانید وضعیت را ببینید.'],
    ['امکان مرجوع کردن کالا هست؟', ['مرجوعی', 'پس دادن کالا', 'تعویض کالا'], 'تا ۷ روز بعد از دریافت، اگر کالا استفاده نشده باشد، می‌توانید آن را مرجوع یا تعویض کنید.'],
    ['روش‌های پرداخت چیست؟', ['پرداخت در محل دارید؟', 'قسطی میشه خرید کرد'], 'پرداخت آنلاین با همه‌ی کارت‌های شتاب و پرداخت در محل (فقط تهران) امکان‌پذیر است.'],
    ['ساعت کاری پشتیبانی چیست؟', ['کی جواب میدید', 'شماره تماس'], 'پشتیبانی شنبه تا پنجشنبه از ساعت ۹ تا ۱۸ پاسخگوی شماست. شماره تماس: ۰۲۱۱۲۳۴۵۶۷۸'],
    ['آیا کالاها اصل هستند؟', ['اصالت کالا', 'فیک نیست؟'], 'همه‌ی کالاها اصل و دارای گارانتی معتبر هستند.'],
    ['کد تخفیف چطور استفاده کنم؟', ['کد تخفیف کار نمیکنه'], 'در مرحله‌ی پرداخت، کد را در کادر «کد تخفیف» وارد کنید و دکمه‌ی اعمال را بزنید.'],
  ];
  for (const [question, alternates, answer] of faqs) bots.addFaq(bot.id, { question, alternates, answer });
}

console.log(`demo login: ${PHONE} / demo1234`);
console.log(`bot key: ${bot.public_key}`);

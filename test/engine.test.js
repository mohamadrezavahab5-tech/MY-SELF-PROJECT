'use strict';
// Unit tests for the Persian question-matching engine (src/nlp/*).
// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/nlp/engine');
const { normalize } = require('../src/nlp/normalize');
const A = require('../src/nlp/analyzer');

const ctx = A.createContext(new Set());
const terms = text => A.analyze(text, ctx);

// The demo shop from scripts/seed-demo.js (ids are database ids).
const SHOP = [
  ['هزینه ارسال چقدر است؟', ['هزینه پست چنده', 'ارسال رایگان دارید؟'], 'ارسال برای خریدهای بالای ۵۰۰ هزار تومان رایگان است. برای بقیه‌ی سفارش‌ها هزینه‌ی ارسال ۴۵ هزار تومان است.'],
  ['سفارشم کی می‌رسد؟', ['زمان تحویل چقدره', 'چند روزه میرسه'], 'سفارش‌های تهران ۱ تا ۲ روز کاری و شهرستان‌ها ۲ تا ۴ روز کاری بعد از ثبت به دستتان می‌رسد.'],
  ['چطور سفارشم را پیگیری کنم؟', ['کد رهگیری', 'سفارشم کجاست'], 'بعد از ارسال، کد رهگیری پیامک می‌شود. از بخش «سفارش‌های من» در سایت هم می‌توانید وضعیت را ببینید.'],
  ['امکان مرجوع کردن کالا هست؟', ['مرجوعی', 'پس دادن کالا', 'تعویض کالا'], 'تا ۷ روز بعد از دریافت، اگر کالا استفاده نشده باشد، می‌توانید آن را مرجوع یا تعویض کنید.'],
  ['روش‌های پرداخت چیست؟', ['پرداخت در محل دارید؟', 'قسطی میشه خرید کرد'], 'پرداخت آنلاین با همه‌ی کارت‌های شتاب و پرداخت در محل (فقط تهران) امکان‌پذیر است.'],
  ['ساعت کاری پشتیبانی چیست؟', ['کی جواب میدید', 'شماره تماس'], 'پشتیبانی شنبه تا پنجشنبه از ساعت ۹ تا ۱۸ پاسخگوی شماست. شماره تماس: ۰۲۱۱۲۳۴۵۶۷۸'],
  ['آیا کالاها اصل هستند؟', ['اصالت کالا', 'فیک نیست؟'], 'همه‌ی کالاها اصل و دارای گارانتی معتبر هستند.'],
  ['کد تخفیف چطور استفاده کنم؟', ['کد تخفیف کار نمیکنه'], 'در مرحله‌ی پرداخت، کد را در کادر «کد تخفیف» وارد کنید و دکمه‌ی اعمال را بزنید.'],
].map(([question, alternates, answer], i) => ({ id: 101 + i, question, alternates, answer }));

const shopIndex = engine.buildIndex(SHOP);
const ask = q => engine.decide(engine.search(shopIndex, q, { limit: 5 }));

// ------------------------------------------------------------ normalization

test('normalize: Arabic letters become Persian', () => {
  assert.equal(normalize('كيك'), 'کیک');
  assert.equal(normalize('ي ى ئ'), 'ی ی ی');
  assert.equal(normalize('مدرسة'), 'مدرسه');
  assert.equal(normalize('خانۀ'), 'خانه');
  assert.equal(normalize('سؤال'), 'سوال');
  assert.equal(normalize('أحمد إبراهيم'), 'احمد ابراهیم');
  assert.equal(normalize('آدرس'), 'ادرس');
});

test('normalize: half-space (ZWNJ) variants compare equal', () => {
  const a = normalize('می‌خواهم');
  assert.equal(a, 'میخواهم');
  assert.equal(normalize('می خواهم'), a);
  assert.equal(normalize('میخواهم'), a);
  assert.equal(normalize('نمی‌شه'), normalize('نمی شه'));
  assert.equal(normalize('کتاب‌ها'), normalize('کتاب ها'));
  assert.equal(normalize('کتاب‌ها'), 'کتابها');
  assert.equal(normalize('بزرگ‌ترین'), 'بزرگترین');
  assert.equal(normalize('ثبت‌نام'), 'ثبت نام'); // compounds: typed with a space
  assert.equal(normalize('می‍خوام'), 'میخوام'); // ZWJ
});

test('normalize: digits, diacritics, tatweel, punctuation, case', () => {
  assert.equal(normalize('۱۲۳ و ١٢٣'), '123 و 123');
  assert.equal(normalize('۵۰۰هزار'), '500 هزار');
  assert.equal(normalize('۱٬۰۰۰٬۰۰۰ تومان'), '1000000 تومان');
  assert.equal(normalize('مَدرِسه'), 'مدرسه');
  assert.equal(normalize('ســـلام'), 'سلام');
  assert.equal(normalize('قیمت؟! (فوری)، لطفاً...'), 'قیمت فوری لطفا');
  assert.equal(normalize('Hello SALAM'), 'hello salam');
  assert.equal(normalize('ﻻزم'), 'لازم'); // Arabic presentation form
  assert.equal(normalize('سلام 😀👍\nخوبی'), 'سلام خوبی');
});

test('normalize: elongation is collapsed, real double letters kept', () => {
  assert.equal(normalize('سلاااااام'), 'سلام');
  assert.equal(normalize('سلاام'), 'سلام');
  assert.equal(normalize('مرسییییی'), 'مرسی');
  assert.equal(normalize('ممنون'), 'ممنون');
  assert.equal(normalize('پاییز'), 'پاییز');
});

test('normalize: empty and non-string input', () => {
  assert.equal(normalize(''), '');
  assert.equal(normalize('   '), '');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(42), '42');
  assert.equal(normalize('؟؟؟ !!!'), '');
});

// ------------------------------------------------------------ analyzer

test('colloquial forms map to the same terms as standard Persian', () => {
  assert.deepEqual(terms('قیمت چنده'), terms('قیمت چند است'));
  assert.deepEqual(terms('قیمتش چقدره؟'), terms('قیمت چقدر است؟'));
  assert.deepEqual(terms('میخوام'), terms('می‌خواهم'));
  assert.deepEqual(terms('میشه'), terms('می‌شود'));
  assert.deepEqual(terms('نمیشه'), terms('نمی‌شود'));
  assert.deepEqual(terms('دارین'), terms('دارید'));
  assert.deepEqual(terms('بدین'), terms('بدهید'));
  assert.deepEqual(terms('بگین'), terms('بگویید'));
  assert.deepEqual(terms('میتونم'), terms('می‌توانم'));
  assert.deepEqual(terms('آدرس کجاس'), terms('آدرس کجاست'));
  assert.deepEqual(terms('چجوری'), ['چطور']);
  assert.deepEqual(terms('چطوری'), ['چطور']);
  assert.deepEqual(terms('چگونه'), ['چطور']);
  assert.deepEqual(terms('اینو بفرستین'), terms('این را بفرستید'));
  assert.deepEqual(terms('هزینه ارسال هستش'), terms('هزینه ارسال'));
  assert.deepEqual(terms('سفارشمو'), ['سفارش']);
  assert.deepEqual(terms('دندون'), terms('دندان'));
});

test('verb prefixes and endings are reduced to one lemma', () => {
  const lemma = w => A.verbLemma(normalize(w));
  assert.equal(lemma('می‌رسد'), 'رسید');
  assert.equal(lemma('میرسه'), 'رسید');
  assert.equal(lemma('نرسیده'), 'رسید');
  assert.equal(lemma('برسونید'), 'رساند');
  assert.equal(lemma('بپردازم'), 'پرداخت');
  assert.equal(lemma('برمی‌گرده'), 'برگشت');
  // nouns that look like verb forms are left alone
  assert.equal(lemma('بدون'), null);
  assert.equal(lemma('بدن'), null);
  assert.equal(lemma('نمونه'), null);
});

test('light stemmer is conservative', () => {
  assert.deepEqual(terms('کتاب‌ها'), ['کتاب']);
  assert.deepEqual(terms('محصولات'), ['محصول']);
  assert.deepEqual(terms('ارزان‌ترین'), ['ارزان']);
  // short words and look-alikes are not over-stemmed
  assert.deepEqual(terms('قیمت'), ['قیمت']);
  assert.deepEqual(terms('کارت'), ['کارت']);
  assert.deepEqual(terms('درست'), ['درست']);
  assert.deepEqual(terms('ساختمان'), ['ساختمان']);
});

test('greetings, politeness and fillers are stopwords', () => {
  assert.deepEqual(terms('سلام وقت بخیر، خسته نباشید. ممنون'), []);
  assert.deepEqual(terms('سلاااام عزیزم لطفا'), []);
  assert.deepEqual(terms('سلام، ببخشید میخواستم بدونم هزینه ارسال چنده؟ مرسی'), ['هزینه', 'ارسال', 'چند']);
});

test('synonym groups link support vocabulary', () => {
  const groupsOf = w => (A.TERM_GROUPS.get(terms(w)[0]) || []).map(g => g[0]);
  assert.ok(groupsOf('هزینه').includes('price'));
  assert.ok(groupsOf('قیمت').includes('price'));
  assert.ok(groupsOf('عضویت').includes('signup'));
  assert.ok(groupsOf('ثبت نام').includes('signup'));
  assert.ok(groupsOf('پس دادن').includes('return'));
  assert.ok(groupsOf('کنسل').includes('cancel'));
  assert.ok(groupsOf('نشانی').includes('address'));
});

// ------------------------------------------------------------ end to end

test('direct answers for common paraphrases', () => {
  const cases = [
    ['هزینه پست چنده؟', 101],
    ['سلام وقت بخیر، هزینه ارسال به شیراز چقدر میشه؟', 101],
    ['سفارشمو کی میرسونید', 102],
    ['چجوری میتونم کالا رو پس بدم', 104],
    ['ساعت کاری پشتیبانی چیه', 106],
    ['شماره تلفنتون', 106],
    ['کد تخفیفم کار نمیکنه', 108],
    ['جنساتون اورجیناله؟', 107],
    ['hazine ersal chande', 101], // Finglish
  ];
  for (const [q, id] of cases) {
    const d = ask(q);
    assert.equal(d.type, 'answer', `"${q}" should be answered, got ${d.type}`);
    assert.equal(d.best.id, id, `"${q}" matched the wrong FAQ`);
  }
});

test('robust to Arabic letters, missing half-spaces and typos', () => {
  const top = q => engine.search(shopIndex, q)[0];
  assert.equal(top('كد تخفيف كار نمي‌كنه').id, 108);
  assert.equal(top('روشهای پرداخت چیه').id, 105);
  assert.equal(top('هزنیه ارسال چقدره').id, 101); // swapped letters
  assert.equal(top('قیمط پست').id, 101); // ط for ت
  assert.equal(top('ارسل رایگان').id, 101); // dropped alef
});

test('off-topic questions do not get a direct answer', () => {
  for (const q of ['هوا امروز چطوره', 'یه جوک بگو', 'قیمت دلار امروز چنده', 'ساعت چنده؟',
    'بهترین رستوران تهران کجاست', 'اسمت چیه؟', 'فوتبال دیشب کی برد', 'what is your name']) {
    const d = ask(q);
    assert.notEqual(d.type, 'answer', `"${q}" must not be answered (got FAQ ${d.best && d.best.id})`);
  }
  assert.equal(ask('یه جوک بگو').type, 'fallback');
  assert.equal(ask('هوا امروز چطوره').type, 'fallback');
});

test('ambiguous short questions get suggestions, not a guess', () => {
  const d = ask('کالا');
  assert.equal(d.type, 'suggest');
  assert.ok(d.suggestions.length >= 2);
});

test('empty and garbage input falls back', () => {
  for (const q of ['', '   ', '؟؟؟', '!!!', '😀😀', 'سلام', 'ممنون', 'asdfgh qwerty', null, undefined, {}, [], 12]) {
    const results = engine.search(shopIndex, q);
    assert.ok(Array.isArray(results));
    const d = engine.decide(results);
    assert.notEqual(d.type, 'answer', `input ${JSON.stringify(q)} must not be answered`);
  }
  const long = 'هزینه ارسال '.repeat(2000);
  assert.ok(Array.isArray(engine.search(shopIndex, long)));
});

// ------------------------------------------------------------ contract

test('exports the documented contract', () => {
  for (const fn of ['normalize', 'buildIndex', 'search', 'decide']) assert.equal(typeof engine[fn], 'function');
  assert.equal(typeof engine.THRESHOLDS.answer, 'number');
  assert.equal(typeof engine.THRESHOLDS.suggest, 'number');
  assert.ok(engine.THRESHOLDS.answer > engine.THRESHOLDS.suggest);
  assert.equal(engine.normalize('كتاب‌ها'), 'کتابها');
});

test('search returns [{ id, score }] with scores in [0,1], sorted, limited', () => {
  const results = engine.search(shopIndex, 'هزینه ارسال و پرداخت', { limit: 3 });
  assert.ok(results.length > 0 && results.length <= 3);
  for (const r of results) {
    assert.deepEqual(Object.keys(r).sort(), ['id', 'score']);
    assert.ok(SHOP.some(f => f.id === r.id));
    assert.ok(r.score >= 0 && r.score <= 1);
  }
  for (let i = 1; i < results.length; i++) assert.ok(results[i - 1].score >= results[i].score);
  assert.equal(engine.search(shopIndex, 'هزینه ارسال', { limit: 0 }).length, 0);
  assert.ok(engine.search(shopIndex, 'هزینه ارسال').length <= 5); // default limit
  // an exact FAQ question scores (close to) 1
  assert.ok(engine.search(shopIndex, 'هزینه ارسال چقدر است؟')[0].score > 0.95);
});

test('decide returns the documented shape', () => {
  const answer = ask('هزینه پست چنده');
  assert.equal(answer.type, 'answer');
  assert.equal(typeof answer.best.id, 'number');
  assert.ok(Array.isArray(answer.suggestions));
  assert.ok(!answer.suggestions.some(s => s.id === answer.best.id));

  const fallback = engine.decide([]);
  assert.deepEqual(fallback, { type: 'fallback', best: null, suggestions: [] });

  const suggest = engine.decide([{ id: 1, score: 0.45 }, { id: 2, score: 0.4 }, { id: 3, score: 0.1 }]);
  assert.equal(suggest.type, 'suggest');
  assert.equal(suggest.best, null);
  assert.deepEqual(suggest.suggestions.map(s => s.id), [1, 2]);

  // a high score that is not clearly ahead of the runner-up is not answered
  const close = engine.decide([{ id: 1, score: 0.9 }, { id: 2, score: 0.85 }]);
  assert.equal(close.type, 'suggest');
  assert.equal(engine.decide([{ id: 1, score: 0.9 }, { id: 2, score: 0.2 }]).type, 'answer');
  assert.equal(engine.decide(undefined).type, 'fallback');
});

test('buildIndex handles empty, odd and string-id FAQ lists', () => {
  const empty = engine.buildIndex([]);
  assert.deepEqual(engine.search(empty, 'هزینه ارسال'), []);
  assert.deepEqual(engine.search(engine.buildIndex(undefined), 'سلام'), []);

  const odd = engine.buildIndex([
    { id: 'a', question: 'ساعت کاری فروشگاه چیست؟', alternates: null, answer: null },
    { id: 'b', question: '', alternates: ['', '  ', 'آدرس فروشگاه'], answer: 'تهران' },
    { id: 'c', question: '???', alternates: [], answer: '' },
    { id: 'd' },
  ]);
  assert.equal(engine.search(odd, 'ساعت کاریتون چیه')[0].id, 'a');
  assert.equal(engine.search(odd, 'آدرستون کجاست')[0].id, 'b');
});

test('a single-FAQ bot still refuses unrelated questions', () => {
  const one = engine.buildIndex([{ id: 1, question: 'ساعت کاری کلینیک چیست؟', alternates: ['کی باز هستید'], answer: '۸ تا ۲۰' }]);
  assert.equal(engine.decide(engine.search(one, 'ساعت کاری کلینیک')).type, 'answer');
  assert.notEqual(engine.decide(engine.search(one, 'هزینه ویزیت چقدره')).type, 'answer');
  assert.notEqual(engine.decide(engine.search(one, 'آدرس کلینیک کجاست')).type, 'answer');
});

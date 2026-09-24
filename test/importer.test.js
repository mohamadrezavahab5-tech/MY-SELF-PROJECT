'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractFaqs, isPrivateIp, fetchPage } = require('../src/importer');

test('extracts FAQPage JSON-LD in page order', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'WebPage' }, {
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'هزینه ارسال چقدر است؟', acceptedAnswer: { '@type': 'Answer', text: '<p>رایگان &amp; سریع</p>' } },
        { '@type': 'Question', name: 'مرجوعی دارید؟', acceptedAnswer: { '@type': 'Answer', text: 'بله تا ۷ روز' } },
      ],
    }],
  })}</script>`;
  assert.deepStrictEqual(extractFaqs(html).map(f => [f.question, f.answer]), [
    ['هزینه ارسال چقدر است؟', 'رایگان & سریع'],
    ['مرجوعی دارید؟', 'بله تا ۷ روز'],
  ]);
});

test('extracts <details> accordions', () => {
  const faqs = extractFaqs('<details><summary>ساعت کاری؟</summary><p>۹ تا ۱۷</p></details><details><summary>آدرس کجاست؟</summary>تهران</details>');
  assert.strictEqual(faqs.length, 2);
  assert.strictEqual(faqs[1].answer, 'تهران');
});

test('extracts heading questions and skips header/nav noise', () => {
  const faqs = extractFaqs('<header><h2>منو؟</h2><p>x</p></header><h3>۱. چطور ثبت نام کنم؟</h3><p>با دکمه ثبت‌نام.</p><p>با موبایل.</p><h3>هزینه‌ها چقدر است؟</h3><ul><li>پایه: رایگان</li></ul>');
  assert.deepStrictEqual(faqs.map(f => f.question), ['چطور ثبت نام کنم؟', 'هزینه‌ها چقدر است؟']);
  assert.match(faqs[0].answer, /با موبایل/);
});

test('extracts Elementor-style accordions', () => {
  const faqs = extractFaqs('<div class="elementor-tab-title"><a href="">گارانتی دارید؟</a></div><div class="elementor-tab-content"><p>بله ۱۸ ماه.</p></div><div class="elementor-tab-title"><a href="">ارسال به شهرستان؟</a></div><div class="elementor-tab-content"><p>با پست</p></div>');
  assert.deepStrictEqual(faqs.map(f => [f.question, f.answer]), [['گارانتی دارید؟', 'بله ۱۸ ماه.'], ['ارسال به شهرستان؟', 'با پست']]);
});

test('private and special addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.3.4', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.strictEqual(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '185.143.233.1', '2001:4860:4860::8888']) assert.strictEqual(isPrivateIp(ip), false, ip);
});

test('fetchPage refuses internal targets (SSRF guard)', async () => {
  await assert.rejects(fetchPage('http://127.0.0.1:1/'), /blocked_address/);
  await assert.rejects(fetchPage('http://localhost:1/'), /blocked_address/);
  await assert.rejects(fetchPage('http://[::1]:1/'), /blocked_address/);
  await assert.rejects(fetchPage('file:///etc/passwd'), /bad_url/);
});

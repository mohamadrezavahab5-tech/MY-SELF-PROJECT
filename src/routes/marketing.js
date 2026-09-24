'use strict';
// Public marketing site + SEO surfaces (sitemap, robots, structured data).
const express = require('express');
const config = require('../config');
const content = require('../content');
const { PLANS, DURATIONS, priceToman } = require('../plans');
const { page, abs } = require('../views/layout');
const { esc, formatNumber, faDigits } = require('../util');
const demo = require('../demoBot');

const router = express.Router();

function orgLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: config.siteName,
    url: config.siteUrl,
    logo: abs('/img/icon.svg'),
  };
}

function faqLd(items) {
  if (!items || !items.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
}

function breadcrumbLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: abs(it.path) })),
  };
}

function softwareLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: config.siteName,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: config.siteUrl,
    offers: Object.values(PLANS).map(p => ({
      '@type': 'Offer',
      name: p.name,
      price: String(p.priceMonthly * 10), // schema.org wants the ISO currency; IRR = Rial
      priceCurrency: 'IRR',
    })),
  };
}

function faqSection(items, title = 'سؤال‌های پرتکرار') {
  if (!items.length) return '';
  return `<section class="section section-soft" id="faq">
  <div class="container narrow">
    <div class="section-head"><h2>${esc(title)}</h2></div>
    <div class="faq">
      ${items.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}
    </div>
  </div>
</section>`;
}

function ctaBand(title = 'همین امروز چت‌بات‌تان را بسازید', text = 'ثبت‌نام رایگان است و نصبش چند دقیقه طول می‌کشد. نیازی به برنامه‌نویسی یا کارت بانکی نیست.') {
  return `<section class="section"><div class="container"><div class="cta-band">
  <h2>${esc(title)}</h2>
  <p>${esc(text)}</p>
  <a class="btn btn-primary btn-lg" href="/signup">ساخت چت‌بات رایگان</a>
</div></div></section>`;
}

function chatMock() {
  return `<div class="mock" aria-hidden="true">
  <div class="mock-head"><div class="mock-avatar">ف</div><div><div class="mock-title">پشتیبانی فروشگاه</div><div class="mock-sub">پاسخگوی خودکار · همیشه آنلاین</div></div></div>
  <div class="mock-body">
    <div class="bubble bot">سلام! 👋 سؤالتان را بپرسید، همین الان جواب می‌دهم.</div>
    <div class="bubble user">سلام، ارسال به شیراز چند روز طول میکشه؟</div>
    <div class="bubble bot">سفارش‌های شهرستان ۲ تا ۴ روز کاری بعد از ثبت به دستتان می‌رسد. کد رهگیری هم پیامک می‌شود. 📦</div>
    <div class="bubble user">مرسی 🙏 مرجوعی هم دارین؟</div>
    <div class="bubble bot">بله، تا ۷ روز بعد از دریافت می‌توانید کالا را مرجوع کنید.<div class="chips" style="margin-top:8px"><span class="chip">هزینه ارسال</span><span class="chip">روش‌های پرداخت</span></div></div>
  </div>
</div>`;
}

router.get('/', (req, res) => {
  const inds = content.industries.slice(0, 8);
  const body = `
<section class="hero">
  <div class="container hero-grid">
    <div>
      <span class="eyebrow">🤖 چت‌بات فارسی · بدون اپراتور</span>
      <h1>به سؤال‌های تکراری مشتری‌ها <span class="grad">۲۴ ساعته</span> جواب بدهید، بدون استخدام اپراتور</h1>
      <p class="lead">سؤال و جواب‌هایتان را وارد کنید، یک خط کد در سایتتان بگذارید و تمام. ${esc(config.siteName)} هر روز و هر ساعت، فقط با پاسخ‌های تأییدشده‌ی خودتان جواب مشتری‌ها را می‌دهد و هر سؤالی را که بلد نیست برایتان جمع می‌کند.</p>
      <div class="hero-cta">
        <a class="btn btn-primary btn-lg" href="/signup">ساخت چت‌بات رایگان</a>
        <button type="button" class="btn btn-outline btn-lg" data-pasokhyar-open>همین الان امتحانش کنید 💬</button>
      </div>
      <ul class="hero-notes"><li>پلن رایگان همیشگی</li><li>نصب در ۵ دقیقه</li><li>بدون نیاز به برنامه‌نویسی</li></ul>
    </div>
    ${chatMock()}
  </div>
</section>

<section class="section" id="how">
  <div class="container">
    <div class="section-head"><h2>سه قدم تا پشتیبانی خودکار</h2><p>بدون قرارداد، بدون نصب نرم‌افزار و بدون نیاز به تیم فنی.</p></div>
    <div class="grid grid-3 steps">
      <div class="card step"><h3>سؤال و جواب‌ها را وارد کنید</h3><p>از بسته‌ی آماده‌ی صنف خودتان شروع کنید، فایل اکسل بدهید یا خودتان بنویسید.</p></div>
      <div class="card step"><h3>یک خط کد در سایت بگذارید</h3><p>روی وردپرس، سایت اختصاصی یا هر سایتی کار می‌کند. لینک اختصاصی و ربات بله هم دارد.</p></div>
      <div class="card step"><h3>بات هر روز بهتر می‌شود</h3><p>سؤال‌هایی که جوابشان نبوده برایتان جمع می‌شود. جواب بدهید تا دفعه‌ی بعد خودش جواب بدهد.</p></div>
    </div>
  </div>
</section>

<section class="section section-soft">
  <div class="container">
    <div class="section-head"><h2>چرا ${esc(config.siteName)}؟</h2><p>ساخته‌شده برای زبان فارسی و کسب‌وکارهای ایرانی.</p></div>
    <div class="grid grid-3">
      <div class="card"><div class="feature-icon">🎯</div><h3>هیچ‌وقت جواب اشتباه از خودش نمی‌سازد</h3><p>فقط از بین جواب‌هایی که خودتان تأیید کرده‌اید پاسخ می‌دهد. اگر مطمئن نباشد، گزینه‌های نزدیک را پیشنهاد می‌دهد.</p></div>
      <div class="card"><div class="feature-icon">🗣️</div><h3>فارسیِ محاوره‌ای را می‌فهمد</h3><p>«چنده؟»، «ارسال رایگان دارین؟»، غلط تایپی و نیم‌فاصله‌ی جاافتاده، همه را درست تشخیص می‌دهد.</p></div>
      <div class="card"><div class="feature-icon">📞</div><h3>هیچ مشتری‌ای از دست نمی‌رود</h3><p>وقتی جواب را نمی‌داند، نام و شماره‌ی مشتری را می‌گیرد تا خودتان تماس بگیرید.</p></div>
      <div class="card"><div class="feature-icon">📈</div><h3>خودش یاد می‌گیرد</h3><p>هر سؤال بی‌جواب با یک کلیک به جواب درست وصل می‌شود و بات دفعه‌ی بعد آن را بلد است.</p></div>
      <div class="card"><div class="feature-icon">🇮🇷</div><h3>بدون تحریم و قطعی</h3><p>به سرویس‌های هوش مصنوعی خارجی وابسته نیست. سرعتش بالاست و اطلاعاتتان داخل کشور می‌ماند.</p></div>
      <div class="card"><div class="feature-icon">💬</div><h3>سایت، لینک اختصاصی و بله</h3><p>ویجت سایت، صفحه‌ی گفتگوی اختصاصی برای بیو و QR کد، و اتصال به ربات بله.</p></div>
    </div>
  </div>
</section>

${inds.length ? `<section class="section">
  <div class="container">
    <div class="section-head"><h2>برای هر کسب‌وکاری که سؤال تکراری دارد</h2><p>با بسته‌ی سؤال و جواب آماده‌ی صنف خودتان در چند دقیقه شروع کنید.</p></div>
    <div class="grid grid-4">
      ${inds.map(i => `<a class="card industry-card" href="/industries/${esc(i.seo.slug)}"><span class="emoji">${esc(i.icon)}</span><strong>${esc(i.name)}</strong><span class="muted">${faDigits(i.starterFaqs.length)} سؤال آماده</span></a>`).join('')}
    </div>
    <p class="center" style="margin-top:22px"><a href="/industries">همه‌ی کاربردها ←</a></p>
  </div>
</section>` : ''}

${pricingCards()}
${faqSection(content.siteFaq)}
${ctaBand()}`;

  res.send(page({
    title: `${config.siteName} | چت بات پاسخگوی خودکار فارسی برای سایت و بله`,
    description: 'چت بات فارسی که ۲۴ ساعته و بدون اپراتور به سؤال‌های تکراری مشتری‌های سایت شما جواب می‌دهد. نصب در ۵ دقیقه، پلن رایگان، مخصوص کسب‌وکارهای ایرانی.',
    path: '/',
    user: req.user,
    body,
    demoWidget: demo.key(),
    jsonLd: [orgLd(), softwareLd(), { '@context': 'https://schema.org', '@type': 'WebSite', name: config.siteName, url: config.siteUrl }, faqLd(content.siteFaq)].filter(Boolean),
  }));
});

function planFeatures(p) {
  const li = (ok, text) => `<li${ok ? '' : ' class="no"'}>${text}</li>`;
  return [
    li(true, p.bots > 1 ? `${faDigits(p.bots)} بات جداگانه` : 'یک بات'),
    li(true, `تا ${formatNumber(p.faqs)} سؤال و جواب`),
    li(true, `${formatNumber(p.answersPerMonth)} پاسخ خودکار در ماه`),
    li(true, 'جمع‌آوری سؤال‌های بی‌جواب و درخواست تماس'),
    li(p.channels, 'اتصال به ربات بله'),
    li(p.export, 'خروجی اکسل'),
    li(!p.badge, 'بدون نشان «قدرت‌گرفته از»'),
  ].join('');
}

function pricingCards() {
  const plans = Object.values(PLANS);
  const durInputs = DURATIONS.map((d, i) => `<input type="radio" name="dur" id="dur-${d.months}" value="${d.months}"${i === 0 ? ' checked' : ''}><label for="dur-${d.months}">${d.label}${d.discountPercent ? ` <span class="badge ok">${faDigits(d.discountPercent)}٪ تخفیف</span>` : ''}</label>`).join('');
  const cards = plans.map(p => {
    const prices = DURATIONS.map(d => {
      const total = p.priceMonthly ? priceToman(p.id, d.months) : 0;
      const perMonth = p.priceMonthly ? Math.round(total / d.months / 1000) * 1000 : 0;
      return `<div class="price-opt" data-months="${d.months}"${d.months === 1 ? '' : ' hidden'}>
        <div class="price">${p.priceMonthly ? formatNumber(perMonth) : '۰'} <small>تومان / ماه</small></div>
        <div class="price-per">${p.priceMonthly && d.months > 1 ? `پرداخت یک‌جا: ${formatNumber(total)} تومان` : (p.priceMonthly ? 'پرداخت ماهانه' : 'برای همیشه رایگان')}</div>
      </div>`;
    }).join('');
    const featured = p.id === 'pro';
    return `<div class="card price-card${featured ? ' featured' : ''}">
      ${featured ? '<span class="tag">پیشنهاد ما</span>' : ''}
      <h3>${esc(p.name)}</h3>
      ${prices}
      <ul class="feature-list">${planFeatures(p)}</ul>
      <a class="btn ${featured ? 'btn-primary' : 'btn-outline'} btn-block" href="${p.priceMonthly ? `/app/billing?plan=${p.id}` : '/signup'}">${p.priceMonthly ? `انتخاب پلن ${esc(p.name)}` : 'شروع رایگان'}</a>
    </div>`;
  }).join('');
  return `<section class="section section-soft" id="pricing">
  <div class="container">
    <div class="section-head"><h2>قیمت‌های شفاف، بدون هزینه‌ی پنهان</h2><p>با پلن رایگان شروع کنید و هر وقت مشتری‌هایتان بیشتر شدند، ارتقا بدهید.</p>
      <div class="pricing-toggle" role="radiogroup" aria-label="مدت اشتراک">${durInputs}</div>
    </div>
    <div class="grid grid-3">${cards}</div>
  </div>
</section>
<script>
(function(){var s=document.currentScript.previousElementSibling;s.querySelectorAll('input[name=dur]').forEach(function(r){r.addEventListener('change',function(){s.querySelectorAll('.price-opt').forEach(function(o){o.hidden=o.getAttribute('data-months')!==r.value;});});});})();
</script>`;
}

router.get('/pricing', (req, res) => {
  res.send(page({
    title: `قیمت چت بات و پلن‌ها | ${config.siteName}`,
    description: `قیمت پلن‌های ${config.siteName}: پلن رایگان همیشگی، پلن حرفه‌ای و سازمانی با پرداخت ماهانه، سه‌ماهه یا سالانه. بدون قرارداد و هزینه‌ی راه‌اندازی.`,
    path: '/pricing',
    user: req.user,
    body: `<div class="page-head"><div class="container center"><h1>قیمت‌ها و پلن‌ها</h1><p class="muted">هر وقت خواستید ارتقا بدهید یا تمدید نکنید. قرارداد و هزینه‌ی راه‌اندازی ندارد.</p></div></div>
${pricingCards()}
${faqSection(content.siteFaq)}
${ctaBand()}`,
    jsonLd: [softwareLd(), faqLd(content.siteFaq), breadcrumbLd([{ name: 'خانه', path: '/' }, { name: 'قیمت‌ها', path: '/pricing' }])].filter(Boolean),
  }));
});

router.get('/industries', (req, res) => {
  res.send(page({
    title: `کاربردهای چت بات برای کسب‌وکارها | ${config.siteName}`,
    description: 'چت بات پاسخگوی خودکار برای فروشگاه اینترنتی، کلینیک، آموزشگاه، هتل، املاک، سازمان‌ها و ده‌ها کسب‌وکار دیگر، با بسته‌ی سؤال و جواب آماده.',
    path: '/industries',
    user: req.user,
    body: `<div class="page-head"><div class="container center"><h1>چت‌بات برای هر کسب‌وکار</h1><p class="muted">صنف خودتان را انتخاب کنید و با سؤال و جواب‌های آماده شروع کنید.</p></div></div>
<section class="section" style="padding-top:20px"><div class="container"><div class="grid grid-3">
${content.industries.map(i => `<a class="card industry-card" href="/industries/${esc(i.seo.slug)}"><span class="emoji">${esc(i.icon)}</span><h3>${esc(i.name)}</h3><span class="muted">${esc(i.seo.metaDescription)}</span></a>`).join('')}
</div></div></section>${ctaBand()}`,
    jsonLd: breadcrumbLd([{ name: 'خانه', path: '/' }, { name: 'کاربردها', path: '/industries' }]),
  }));
});

router.get('/industries/:slug', (req, res, next) => {
  const ind = content.industryBySlug(req.params.slug);
  if (!ind) return next();
  const sample = ind.starterFaqs.slice(0, 6);
  const body = `<div class="page-head"><div class="container narrow">
  <nav class="breadcrumbs"><a href="/">خانه</a> / <a href="/industries">کاربردها</a> / ${esc(ind.name)}</nav>
  <h1>${esc(ind.seo.h1)}</h1>
  <div class="hero-cta"><a class="btn btn-primary btn-lg" href="/signup?industry=${esc(ind.id)}">ساخت چت‌بات ${esc(ind.name)}</a></div>
</div></div>
<section class="section" style="padding-top:20px"><div class="container narrow">
  <div class="prose">${ind.seo.introHtml}</div>
  ${ind.seo.benefits && ind.seo.benefits.length ? `<h2>مزایا برای ${esc(ind.name)}</h2><ul class="feature-list">${ind.seo.benefits.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
  <h2>نمونه‌ای از ${faDigits(ind.starterFaqs.length)} سؤال آماده</h2>
  <p class="muted">این سؤال‌ها بعد از ثبت‌نام با یک کلیک به بات شما اضافه می‌شوند و فقط جاهای خالی را با اطلاعات خودتان پر می‌کنید.</p>
  <div class="faq">${sample.map(f => `<details><summary>${esc(f.question)}</summary><p>${esc(f.answer)}</p></details>`).join('')}</div>
</div></section>
${faqSection(ind.seo.faq || [], `سؤال‌های پرتکرار درباره‌ی چت‌بات ${ind.name}`)}
${ctaBand(`چت‌بات ${ind.name} را همین حالا بسازید`)}`;
  res.send(page({
    title: ind.seo.metaTitle,
    description: ind.seo.metaDescription,
    path: `/industries/${ind.seo.slug}`,
    user: req.user,
    body,
    jsonLd: [faqLd(ind.seo.faq), breadcrumbLd([{ name: 'خانه', path: '/' }, { name: 'کاربردها', path: '/industries' }, { name: ind.name, path: `/industries/${ind.seo.slug}` }])].filter(Boolean),
  }));
});

function faDate(iso) {
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${iso}T12:00:00Z`));
  } catch {
    return faDigits(iso);
  }
}

router.get('/blog', (req, res) => {
  res.send(page({
    title: `مجله‌ی ${config.siteName} | آموزش چت بات و پشتیبانی مشتری`,
    description: 'مقاله‌های کاربردی درباره‌ی چت بات، پاسخگوی خودکار سایت، ربات بله و راه‌های کم کردن هزینه‌ی پشتیبانی مشتری.',
    path: '/blog',
    user: req.user,
    body: `<div class="page-head"><div class="container center"><h1>مجله</h1><p class="muted">راهنماهای کاربردی پشتیبانی مشتری و چت‌بات برای کسب‌وکارهای ایرانی</p></div></div>
<section class="section" style="padding-top:20px"><div class="container"><div class="grid grid-3">
${content.blog.map(p => `<a class="card post-card" href="/blog/${esc(p.slug)}"><span class="post-meta">${esc(faDate(p.date))} · ${faDigits(p.readingMinutes)} دقیقه مطالعه</span><h3>${esc(p.title)}</h3><p class="muted">${esc(p.metaDescription)}</p></a>`).join('') || '<p class="muted">به‌زودی…</p>'}
</div></div></section>`,
    jsonLd: breadcrumbLd([{ name: 'خانه', path: '/' }, { name: 'مجله', path: '/blog' }]),
  }));
});

router.get('/blog/:slug', (req, res, next) => {
  const post = content.postBySlug(req.params.slug);
  if (!post) return next();
  const related = content.blog.filter(p => p.slug !== post.slug).slice(0, 3);
  res.send(page({
    title: `${post.title} | ${config.siteName}`,
    description: post.metaDescription,
    path: `/blog/${post.slug}`,
    ogType: 'article',
    user: req.user,
    body: `<div class="page-head"><div class="container narrow">
  <nav class="breadcrumbs"><a href="/">خانه</a> / <a href="/blog">مجله</a></nav>
  <h1>${esc(post.title)}</h1>
  <div class="post-meta">${esc(faDate(post.date))} · ${faDigits(post.readingMinutes)} دقیقه مطالعه</div>
</div></div>
<article class="section" style="padding-top:20px"><div class="container narrow prose">${post.bodyHtml}</div></article>
${related.length ? `<section class="section section-soft"><div class="container"><h2 class="center">مطالب بیشتر</h2><div class="grid grid-3">${related.map(p => `<a class="card post-card" href="/blog/${esc(p.slug)}"><h3>${esc(p.title)}</h3><p class="muted">${esc(p.metaDescription)}</p></a>`).join('')}</div></div></section>` : ''}
${ctaBand()}`,
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: post.title,
      description: post.metaDescription,
      datePublished: post.date,
      dateModified: post.date,
      inLanguage: 'fa-IR',
      mainEntityOfPage: abs(`/blog/${post.slug}`),
      author: { '@type': 'Organization', name: config.siteName },
      publisher: orgLd(),
    }, breadcrumbLd([{ name: 'خانه', path: '/' }, { name: 'مجله', path: '/blog' }, { name: post.title, path: `/blog/${post.slug}` }])],
  }));
});

router.get('/affiliate', (req, res) => {
  const r = config.referral;
  res.send(page({
    title: `همکاری در فروش و کسب درآمد | ${config.siteName}`,
    description: `با معرفی ${config.siteName} به کسب‌وکارها، از هر پرداخت مشتری‌هایتان ${r.commissionPercent} درصد پورسانت بگیرید؛ هر ماه، تا وقتی مشتری تمدید می‌کند.`,
    path: '/affiliate',
    user: req.user,
    body: `<section class="hero"><div class="container narrow center">
  <span class="eyebrow">🎁 همکاری در فروش</span>
  <h1>هر ماه از مشتری‌هایی که معرفی می‌کنید <span class="grad">${faDigits(r.commissionPercent)}٪</span> درآمد بگیرید</h1>
  <p class="lead" style="margin-inline:auto">طراح سایت، سئوکار، آژانس دیجیتال مارکتینگ یا ادمین پیج هستید؟ لینک اختصاصی‌تان را به کسب‌وکارها بدهید. تا وقتی مشتری اشتراکش را تمدید کند، از <strong>هر پرداخت</strong> او پورسانت می‌گیرید.</p>
  <div class="hero-cta" style="justify-content:center"><a class="btn btn-primary btn-lg" href="${req.user ? '/app/referral' : '/signup?next=/app/referral'}">دریافت لینک اختصاصی</a></div>
</div></section>
<section class="section"><div class="container"><div class="grid grid-3 steps">
  <div class="card step"><h3>ثبت‌نام رایگان</h3><p>بعد از ثبت‌نام، لینک معرفی اختصاصی‌تان در بخش «کسب درآمد» داشبورد آماده است.</p></div>
  <div class="card step"><h3>معرفی به کسب‌وکارها</h3><p>لینک را برای مشتری‌هایتان بفرستید یا خودتان بات را روی سایتشان نصب کنید. مشتری‌ها ${faDigits(r.buyerDiscountPercent)}٪ تخفیف اولین خرید هم می‌گیرند.</p></div>
  <div class="card step"><h3>دریافت پورسانت</h3><p>${faDigits(r.commissionPercent)}٪ هر پرداخت به موجودی‌تان اضافه می‌شود. با وارد کردن شماره‌ی شبا، درخواست تسویه ثبت کنید.</p></div>
</div></div></section>
${ctaBand('از همین امروز درآمد داشته باشید', 'ثبت‌نام رایگان است و هیچ حداقل فروشی ندارد.')}`,
  }));
});

function staticPage(key, pathName) {
  router.get(pathName, (req, res, next) => {
    const p = content.pages[key];
    if (!p) return next();
    res.send(page({
      title: `${p.title} | ${config.siteName}`,
      description: `${p.title} ${config.siteName}`,
      path: pathName,
      user: req.user,
      body: `<div class="page-head"><div class="container narrow"><h1>${esc(p.title)}</h1></div></div><section class="section" style="padding-top:10px"><div class="container narrow prose">${p.bodyHtml}</div></section>`,
    }));
  });
}
staticPage('terms', '/terms');
staticPage('privacy', '/privacy');
staticPage('about', '/about');

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /
Disallow: /app
Disallow: /admin
Disallow: /pay
Disallow: /api/
Disallow: /c/
Disallow: /hooks/

Sitemap: ${abs('/sitemap.xml')}
`);
});

router.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: '/', priority: '1.0', lastmod: today },
    { loc: '/pricing', priority: '0.9', lastmod: today },
    { loc: '/industries', priority: '0.8', lastmod: today },
    ...content.industries.map(i => ({ loc: `/industries/${i.seo.slug}`, priority: '0.8', lastmod: today })),
    { loc: '/blog', priority: '0.7', lastmod: today },
    ...content.blog.map(p => ({ loc: `/blog/${p.slug}`, priority: '0.7', lastmod: p.date })),
    { loc: '/affiliate', priority: '0.6', lastmod: today },
    ...['about', 'terms', 'privacy'].filter(k => content.pages[k]).map(k => ({ loc: `/${k}`, priority: '0.3', lastmod: today })),
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${esc(abs(u.loc))}</loc><lastmod>${esc(u.lastmod)}</lastmod><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`);
});

module.exports = router;

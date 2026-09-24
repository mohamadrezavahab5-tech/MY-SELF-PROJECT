'use strict';
// All runtime configuration comes from environment variables so the same code
// runs locally, on Liara, or anywhere else. Defaults are safe for local dev.
const path = require('path');

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function int(name, def) {
  const v = parseInt(env[name], 10);
  return Number.isFinite(v) ? v : def;
}

const siteUrl = (env.SITE_URL || `http://localhost:${int('PORT', 3000)}`).replace(/\/+$/, '');

// Payment mode:
//   zarinpal - live gateway (needs ZARINPAL_MERCHANT)
//   sandbox  - Zarinpal sandbox (any 36-char merchant id works there)
//   mock     - fake local gateway page for development; never allowed in production
//   disabled - checkout shows "coming soon"
function paymentMode() {
  const wanted = (env.PAYMENT_MODE || '').toLowerCase();
  if (wanted === 'zarinpal' || wanted === 'sandbox') return wanted;
  if (wanted === 'mock' && !isProd) return 'mock';
  if (wanted === 'disabled') return 'disabled';
  if (env.ZARINPAL_MERCHANT) return 'zarinpal';
  return isProd ? 'disabled' : 'mock';
}

module.exports = {
  isProd,
  port: int('PORT', 3000),
  siteUrl,
  siteName: env.SITE_NAME || 'پاسخ‌یار',
  siteNameEn: env.SITE_NAME_EN || 'Pasokhyar',
  dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
  adminPhones: (env.ADMIN_PHONES || '').split(',').map(s => s.trim()).filter(Boolean),

  supportPhone: env.SUPPORT_PHONE || '',
  supportEmail: env.SUPPORT_EMAIL || '',
  supportTelegram: env.SUPPORT_TELEGRAM || '',
  // Raw HTML for the eNamad / Zarinpal trust badges. Only the site owner sets this.
  trustBadgesHtml: env.TRUST_BADGES_HTML || '',

  payment: {
    mode: paymentMode(),
    merchant: env.ZARINPAL_MERCHANT || '',
  },

  referral: {
    commissionPercent: int('REFERRAL_COMMISSION_PERCENT', 25),
    buyerDiscountPercent: int('REFERRAL_DISCOUNT_PERCENT', 10),
    minPayoutToman: int('MIN_PAYOUT_TOMAN', 200000),
    cookieDays: 60,
  },
};

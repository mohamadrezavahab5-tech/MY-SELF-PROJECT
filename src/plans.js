'use strict';
// Subscription plans. Prices are in Toman (what Iranian users read);
// the gateway is charged in Rial (x10). Change prices here.
const PLANS = {
  free: {
    id: 'free',
    name: 'رایگان',
    priceMonthly: 0,
    bots: 1,
    faqs: 30,
    answersPerMonth: 150,
    pages: 20,          // website pages the bot learns from
    ai: false,          // generative answers (needs an LLM server)
    badge: true,
    channels: false,
    export: false,
  },
  pro: {
    id: 'pro',
    name: 'حرفه‌ای',
    priceMonthly: 290000,
    bots: 1,
    faqs: 600,
    answersPerMonth: 5000,
    pages: 300,
    ai: true,
    badge: false,
    channels: true,
    export: true,
  },
  business: {
    id: 'business',
    name: 'سازمانی',
    priceMonthly: 790000,
    bots: 5,
    faqs: 5000,
    answersPerMonth: 40000,
    pages: 3000,
    ai: true,
    badge: false,
    channels: true,
    export: true,
  },
};

// Longer prepaid periods get a discount (Iranian gateways have no card-on-file
// recurring billing, so "subscription" = prepaid months that extend expiry).
const DURATIONS = [
  { months: 1, discountPercent: 0, label: 'یک ماهه' },
  { months: 3, discountPercent: 10, label: 'سه ماهه' },
  { months: 12, discountPercent: 20, label: 'یک ساله' },
];

function getPlan(id) {
  return PLANS[id] || PLANS.free;
}

// The plan a user is effectively on right now (paid plans lapse to free).
function effectivePlan(user) {
  if (!user) return PLANS.free;
  if (user.plan && user.plan !== 'free' && user.plan_expires_at && user.plan_expires_at > Date.now()) {
    return getPlan(user.plan);
  }
  return PLANS.free;
}

function priceToman(planId, months) {
  const plan = PLANS[planId];
  const dur = DURATIONS.find(d => d.months === months);
  if (!plan || !dur || plan.priceMonthly <= 0) return null;
  const full = plan.priceMonthly * months;
  // Round to the nearest 1,000 Toman so prices read cleanly.
  return Math.round((full * (100 - dur.discountPercent)) / 100 / 1000) * 1000;
}

module.exports = { PLANS, DURATIONS, getPlan, effectivePlan, priceToman };

'use strict';
// Zarinpal payment gateway, REST API v4. Amounts are in Rial.
// Docs: https://www.zarinpal.com/docs/paymentGateway/
const config = require('../config');
const { token } = require('../util');

const HOSTS = {
  zarinpal: { api: 'https://payment.zarinpal.com', start: 'https://payment.zarinpal.com/pg/StartPay/' },
  sandbox: { api: 'https://sandbox.zarinpal.com', start: 'https://sandbox.zarinpal.com/pg/StartPay/' },
};

async function post(path, body) {
  const host = HOSTS[config.payment.mode];
  const res = await fetch(host.api + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json().catch(() => ({}));
}

function merchantId() {
  // Zarinpal's sandbox accepts any well-formed merchant id.
  return config.payment.merchant || (config.payment.mode === 'sandbox' ? '00000000-0000-0000-0000-000000000000' : '');
}

// -> { authority, url }
async function request({ amountRial, description, callbackUrl, mobile }) {
  const mode = config.payment.mode;
  if (mode === 'mock') {
    const authority = `MOCK${token(12)}`;
    return { authority, url: `/pay/mock/${authority}` };
  }
  if (mode !== 'zarinpal' && mode !== 'sandbox') throw new Error('payments disabled');
  const data = await post('/pg/v4/payment/request.json', {
    merchant_id: merchantId(),
    amount: amountRial,
    description,
    callback_url: callbackUrl,
    metadata: mobile ? { mobile } : undefined,
  });
  if (!data.data || data.data.code !== 100) {
    throw new Error(`zarinpal request failed: ${JSON.stringify(data.errors || data)}`);
  }
  return { authority: data.data.authority, url: HOSTS[mode].start + data.data.authority };
}

// -> { ok, refId, cardPan } ; 101 = already verified (idempotent success)
async function verify({ authority, amountRial }) {
  const mode = config.payment.mode;
  if (mode === 'mock') {
    return authority.startsWith('MOCK') ? { ok: true, refId: `MOCK-${Date.now()}`, cardPan: '6037********0000' } : { ok: false };
  }
  const data = await post('/pg/v4/payment/verify.json', { merchant_id: merchantId(), amount: amountRial, authority });
  const code = data.data && data.data.code;
  if (code === 100 || code === 101) return { ok: true, refId: String(data.data.ref_id), cardPan: data.data.card_pan || '' };
  return { ok: false, error: data.errors || data };
}

module.exports = { request, verify };

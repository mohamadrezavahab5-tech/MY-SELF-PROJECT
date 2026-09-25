'use strict';
// Phone number helpers shared by the API, lookup / screen-pop pages, the
// dial-link helper and AMI click-to-call. Numbers arrive in every shape:
// 09121234567, +98 912 123 4567, 0098..., ۰۹۱۲..., 021-8888 1234, 101.
const { enDigits, normalizeMobile } = require('../util');

// Local dialable form: Iranian numbers as 0XXXXXXXXXX, other international
// numbers as 00<country><number>, short internal numbers as-is. Digits only.
function local(input) {
  const mobile = normalizeMobile(input);
  if (mobile) return mobile;
  let s = enDigits(input).replace(/[^\d+]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (s.startsWith('+')) s = '00' + s.slice(1);
  s = s.replace(/\+/g, '');
  return s.slice(0, 20);
}

// +98... form for CRMs that store E.164; '' when it can't be derived.
function e164(input) {
  const s = local(input);
  if (/^0[1-9]\d{9}$/.test(s)) return '+98' + s.slice(1);
  if (/^00[1-9]\d{6,14}$/.test(s)) return '+' + s.slice(2);
  return '';
}

// Comparison key: the national significant number (no leading zeros, last
// 10 digits), so 09121234567, +989121234567 and ۰۹۱۲۱۲۳۴۵۶۷ all match.
function key(input) {
  const s = local(input);
  if (s.startsWith('00') && !s.startsWith('0098')) return s.replace(/^0+/, '');
  return s.replace(/^0+/, '').slice(-10);
}

module.exports = { local, e164, key };

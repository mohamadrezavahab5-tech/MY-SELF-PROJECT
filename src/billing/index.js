'use strict';
// Orders, plan activation and referral commissions.
const db = require('../db');
const config = require('../config');
const { PLANS, priceToman } = require('../plans');

// Referred users get a discount on their first paid order only.
function quote(user, planId, months) {
  const base = priceToman(planId, months);
  if (!base) return null;
  const hasPaid = db.get().prepare(`SELECT 1 FROM orders WHERE user_id = ? AND status = 'paid' LIMIT 1`).get(user.id);
  const discount = user.referred_by && !hasPaid
    ? Math.round((base * config.referral.buyerDiscountPercent) / 100 / 1000) * 1000
    : 0;
  return { plan: PLANS[planId], months, base, discount, amount: base - discount };
}

function createOrder(user, planId, months) {
  const q = quote(user, planId, months);
  if (!q) return null;
  const info = db.get().prepare(`
    INSERT INTO orders (user_id, plan, months, amount, discount, referrer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(user.id, planId, months, q.amount, q.discount, user.referred_by || null, Date.now());
  return db.get().prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
}

function setAuthority(orderId, authority) {
  db.get().prepare('UPDATE orders SET authority = ? WHERE id = ?').run(authority, orderId);
}

function orderByAuthority(authority) {
  return db.get().prepare('SELECT * FROM orders WHERE authority = ?').get(String(authority || ''));
}

const MONTH_MS = 30 * 86400_000;

// Idempotent: a second call for an already-paid order does nothing.
function markPaid(orderId, { refId, cardPan }) {
  const conn = db.get();
  return conn.transaction(() => {
    const order = conn.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order || order.status === 'paid') return false;
    const now = Date.now();
    conn.prepare(`UPDATE orders SET status = 'paid', ref_id = ?, card_pan = ?, paid_at = ? WHERE id = ?`).run(refId, cardPan || '', now, orderId);

    // Same plan still active -> extend from its expiry; otherwise start now.
    const user = conn.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
    const active = user.plan_expires_at && user.plan_expires_at > now;
    const from = active && user.plan === order.plan ? user.plan_expires_at : now;
    conn.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?').run(order.plan, from + order.months * MONTH_MS, user.id);

    if (order.referrer_id && order.referrer_id !== order.user_id) {
      const commission = Math.floor((order.amount * config.referral.commissionPercent) / 100);
      if (commission > 0) {
        conn.prepare('INSERT INTO commissions (referrer_id, order_id, amount, created_at) VALUES (?, ?, ?, ?)').run(order.referrer_id, order.id, commission, now);
        conn.prepare('UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?').run(commission, commission, order.referrer_id);
      }
    }
    return true;
  })();
}

function markFailed(orderId) {
  db.get().prepare(`UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'`).run(orderId);
}

module.exports = { quote, createOrder, setAuthority, orderByAuthority, markPaid, markFailed };

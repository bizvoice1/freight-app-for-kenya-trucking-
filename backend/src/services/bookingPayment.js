/**
 * backend/src/services/bookingPayment.js
 * -------------------------------------------
 * Phase 5D-4 — the booking-facing view of the existing 4K payment/escrow
 * engine: a derived payment summary, the funding gate, phone validation, and
 * STK expiry. Nothing here creates a new payment system; payments and escrows
 * stay separate tables, and the summary is only a read-time projection.
 */

import { eq, and, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { payments, escrows } from "../db/schema.js";
import { PAYMENT_STATUS } from "../domain/payment.js";
import { ESCROW_STATUS } from "../domain/escrow.js";
import { logPaymentEventSync } from "./ledger.js";
import { failAdjustmentPaymentSync } from "./adjustments.js";
import { notifyUser } from "./notifications.js";
import { NOTIFICATION_TYPE } from "../domain/notification.js";

export const CANONICAL_MSISDN = /^254[17]\d{8}$/;

export function isCanonicalKenyanMobile(value) {
  return typeof value === "string" && CANONICAL_MSISDN.test(value);
}

export function stkTimeoutSeconds() {
  const n = Number(process.env.PAYMENT_STK_TIMEOUT_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 120;
}

const byNewest = (a, b) => (b.createdAt === a.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt));

/**
 * Summary of the booking's agreed-price (INITIAL) payment. Never includes a phone number.
 * @returns {{status:string, paymentId:string|null, amount:number|null, paidAt:string|null, escrowStatus:string|null, resultDesc:string|null}}
 */
export function summarizeBookingPayment(booking, bookingPayments, escrow) {
  const initial = bookingPayments.filter(p => p.purpose === "INITIAL").sort(byNewest);
  const paid = initial.find(p => p.status === PAYMENT_STATUS.PAID);
  const latest = paid || initial[0] || null;
  return {
    status: latest ? latest.status : "None",
    paymentId: latest ? latest.id : null,
    amount: typeof booking.agreedAmount === "number" ? booking.agreedAmount : null,
    paidAt: paid ? paid.updatedAt : null,
    escrowStatus: escrow ? escrow.status : null,
    escrowId: escrow ? escrow.id : null,
    resultDesc: latest && latest.status !== PAYMENT_STATUS.PAID ? latest.resultDesc ?? null : null,
  };
}

/** Attach `payment` to each booking row (one payments + one escrows read for the whole list). */
export async function withPaymentSummaries(bookingRows) {
  if (!bookingRows.length) return bookingRows;
  const [allPayments, allEscrows] = await Promise.all([db.select().from(payments), db.select().from(escrows)]);
  const payBy = new Map();
  for (const p of allPayments) (payBy.get(p.bookingId) || payBy.set(p.bookingId, []).get(p.bookingId)).push(p);
  const escBy = new Map(allEscrows.map(e => [e.bookingId, e]));
  return bookingRows.map(b => ({ ...b, payment: summarizeBookingPayment(b, payBy.get(b.id) || [], escBy.get(b.id)) }));
}

/** The funding gate: no real freight movement from an unfunded booking. */
export async function isBookingFunded(bookingId) {
  const [escrow] = await db.select().from(escrows).where(eq(escrows.bookingId, bookingId));
  return !!escrow && escrow.status === ESCROW_STATUS.HELD;
}

/**
 * StkSent -> Timeout for attempts older than the configured window. Adjustment
 * attempts also return their adjustment to APPROVED so it can be paid again.
 * Optionally scoped to one booking (used lazily before a retry).
 * @returns {object[]} the payment rows that were expired
 */
export function expireStalePayments({ bookingId, requestId } = {}) {
  const cutoff = new Date(Date.now() - stkTimeoutSeconds() * 1000).toISOString();
  return db.transaction((tx) => {
    const conds = [eq(payments.status, PAYMENT_STATUS.STK_SENT), lt(payments.updatedAt, cutoff)];
    if (bookingId) conds.push(eq(payments.bookingId, bookingId));
    const stale = tx.select().from(payments).where(and(...conds)).all();
    for (const p of stale) {
      if (p.purpose === "ADJUSTMENT") {
        failAdjustmentPaymentSync(tx, p, PAYMENT_STATUS.TIMEOUT, { resultCode: null, resultDesc: "No M-Pesa confirmation before the payment window closed." }, requestId);
      } else {
        tx.update(payments).set({ status: PAYMENT_STATUS.TIMEOUT, resultDesc: "No M-Pesa confirmation before the payment window closed.", updatedAt: new Date().toISOString() })
          .where(and(eq(payments.id, p.id), eq(payments.status, PAYMENT_STATUS.STK_SENT))).run();
      }
      logPaymentEventSync(tx, "payment", p.id, "stk_timeout", PAYMENT_STATUS.STK_SENT, PAYMENT_STATUS.TIMEOUT, { timeoutSeconds: stkTimeoutSeconds() }, requestId ?? null);
    }
    return stale;
  });
}

/** Tell each shipper their attempt timed out (after the expiry transaction has committed). */
export async function notifyExpired(expired) {
  for (const p of expired) {
    await notifyUser(p.shipperId, NOTIFICATION_TYPE.PAYMENT_FAILED, "Payment unsuccessful",
      `We did not receive M-Pesa confirmation for booking ${p.bookingId}. You can retry.`, "payment", p.id);
  }
}

/** Production must never run the M-Pesa simulator. Returns an error string, or null when config is safe. */
export function paymentConfigProblem(env = process.env) {
  if (env.NODE_ENV !== "production") return null;
  if (!env.DARAJA_ENV || env.DARAJA_ENV === "simulate") {
    return "NODE_ENV=production but DARAJA_ENV is unset or 'simulate': the M-Pesa simulator must never run in production. Set DARAJA_ENV=sandbox or production with real Daraja credentials.";
  }
  return null;
}

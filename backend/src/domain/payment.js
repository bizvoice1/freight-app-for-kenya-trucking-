/**
 * backend/src/domain/payment.js
 * ---------------------------------
 * Phase 4K-A — a shipper payment ATTEMPT (docs/4K-DARAJA-SPEC.md Section 2).
 * A booking can have more than one of these if the first attempt fails and
 * the shipper retries — this table is attempt-scoped, not booking-scoped;
 * `escrows` (one row per booking) is what's booking-scoped.
 *
 * amount is never accepted from a caller here — every route that creates a
 * Payment must compute it server-side from the booking's load price first
 * (non-negotiable #2 of the spec) and pass the already-decided number in.
 */

export const PAYMENT_STATUS = {
  PENDING:   "Pending",   // row exists, Daraja not yet called
  STK_SENT:  "StkSent",   // synchronous Daraja response received — NOT proof of payment
  PAID:      "Paid",
  FAILED:    "Failed",
  CANCELLED: "Cancelled", // specifically ResultCode 1032, "cancelled by user"
  TIMEOUT:   "Timeout",   // reserved for a future reconciliation/expiry job — not set by any code path yet
};

/** Statuses a booking may not have more than one of at once (Section 2.5's "STK request duplicated" guard). */
export const NON_TERMINAL_PAYMENT_STATUSES = new Set([
  PAYMENT_STATUS.PENDING,
  PAYMENT_STATUS.STK_SENT,
]);

export function generatePaymentId(existingCount) {
  return `PAY-${1000 + existingCount}`;
}

/** @param {{bookingId:string, shipperId:string, amount:number, phoneNumber:string}} data */
export function createPayment({ bookingId, shipperId, amount, phoneNumber }, existingCount) {
  const now = new Date().toISOString();
  return {
    id:                 generatePaymentId(existingCount),
    bookingId,
    shipperId,
    amount,
    phoneNumber,
    status:             PAYMENT_STATUS.PENDING,
    merchantRequestId:  null,
    checkoutRequestId:  null, // set once Daraja's synchronous response arrives
    mpesaReceiptNumber: null, // set exactly once, on first successful callback — never overwritten
    resultCode:         null,
    resultDesc:         null,
    createdAt:          now,
    updatedAt:          now,
  };
}

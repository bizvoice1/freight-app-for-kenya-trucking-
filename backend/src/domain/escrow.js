/**
 * backend/src/domain/escrow.js
 * --------------------------------
 * Phase 4K-C/D — the escrow state machine and release-eligibility rule, per
 * docs/4K-DARAJA-SPEC.md (Revision 3, approved) Sections 4 and 5.
 *
 * Mirrors models/trip.js's canTransitionTrip() exactly: structural legality
 * (this file) is one question, authorization (who may request a given
 * transition) is a separate one answered in routes/escrows.js — same split
 * Phase 4J established for trips.
 *
 * Three states carry the eligibility/instruction/settlement distinction the
 * spec review asked for explicitly:
 *   RELEASE_PENDING      - eligible; nothing sent to Daraja yet
 *   RELEASE_IN_PROGRESS  - a B2C request is in flight; not yet confirmed
 *   SETTLED              - Daraja confirmed the payout; money has moved
 *
 * PAYOUT_FAILED is deliberately NOT one of these statuses — a failed payout
 * attempt is `payouts.status = 'Failed'` (see domain/payout.js), and the
 * escrow itself drops back to RELEASE_PENDING so it can be retried. Giving
 * the escrow its own terminal "payout failed" status would reintroduce the
 * exact retry-blocking bug the spec's `payouts.escrowId` correction fixed.
 */

export const ESCROW_STATUS = {
  PENDING:             "Pending",
  PAYMENT_PROCESSING:  "PaymentProcessing",
  PAID:                "Paid",
  HELD:                "Held",
  RELEASE_PENDING:     "ReleasePending",
  RELEASE_IN_PROGRESS: "ReleaseInProgress",
  SETTLED:             "Settled",
  PAYMENT_FAILED:      "PaymentFailed",
  PAYMENT_REVERSED:    "PaymentReversed",
  PAYOUT_REVERSED:     "PayoutReversed",
  CANCELLED:           "Cancelled",
  REFUNDED:            "Refunded",
};

export const TERMINAL_ESCROW_STATUSES = new Set([
  ESCROW_STATUS.SETTLED,
  ESCROW_STATUS.PAYMENT_FAILED,
  ESCROW_STATUS.PAYMENT_REVERSED,
  ESCROW_STATUS.PAYOUT_REVERSED,
  ESCROW_STATUS.CANCELLED,
  ESCROW_STATUS.REFUNDED,
]);

/**
 * Explicit adjacency list, not a linear sequence (trip.js can use one
 * sequence because a trip's happy path never branches; an escrow's does).
 * The one edge that must NOT exist anywhere below is a direct HELD or
 * RELEASE_PENDING -> SETTLED transition — SETTLED is reachable only via
 * RELEASE_IN_PROGRESS.
 */
const TRANSITIONS = {
  [ESCROW_STATUS.PENDING]:             [ESCROW_STATUS.PAYMENT_PROCESSING, ESCROW_STATUS.PAYMENT_FAILED],
  [ESCROW_STATUS.PAYMENT_PROCESSING]:  [ESCROW_STATUS.PAID, ESCROW_STATUS.PAYMENT_FAILED],
  [ESCROW_STATUS.PAID]:                [ESCROW_STATUS.HELD],
  [ESCROW_STATUS.HELD]:                [
    ESCROW_STATUS.CANCELLED,
    ESCROW_STATUS.REFUNDED,
    ESCROW_STATUS.PAYMENT_REVERSED,
    ESCROW_STATUS.RELEASE_PENDING,
  ],
  [ESCROW_STATUS.RELEASE_PENDING]:     [ESCROW_STATUS.RELEASE_IN_PROGRESS],
  [ESCROW_STATUS.RELEASE_IN_PROGRESS]: [ESCROW_STATUS.SETTLED, ESCROW_STATUS.RELEASE_PENDING],
  [ESCROW_STATUS.SETTLED]:             [ESCROW_STATUS.PAYOUT_REVERSED],
};

/**
 * Whether `from` -> `to` is a legal escrow transition. In practice, live
 * code today never creates a row at PENDING/PAYMENT_PROCESSING (a payment
 * that hasn't succeeded yet has no escrow row at all — see routes for the
 * STK callback) — those two states and PAYMENT_FAILED exist for a future
 * phase (recurring/partial payments) and so the acceptance tests can
 * exercise the transition function directly, per the spec's own note.
 */
export function canTransitionEscrow(from, to) {
  if (TERMINAL_ESCROW_STATUSES.has(from)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

export function generateEscrowId(existingCount) {
  return `ESC-${1000 + existingCount}`;
}

/** @param {{bookingId:string, paymentId:string, amount:number}} data */
export function createEscrow({ bookingId, paymentId, amount }, existingCount) {
  const now = new Date().toISOString();
  return {
    id:                  generateEscrowId(existingCount),
    bookingId,
    paymentId,
    amount,
    status:              ESCROW_STATUS.HELD, // created only once payment has actually succeeded
    heldAt:              now,
    releasePendingAt:    null,
    releaseInProgressAt: null,
    settledAt:           null,
    createdAt:           now,
    updatedAt:           now,
  };
}

/**
 * Phase 4K-D / 5D-1 — the "don't blindly send money" rule. Pure: takes the
 * trip, booking, escrow and the booking's ledger (domain/ledger.js
 * computeLedger) as plain data and returns a decision; never calls Daraja,
 * never touches the database itself. Callers (routes/trips.js's Delivered
 * hook) act on the result.
 *
 * 5D-1 replaces the old `loads.price === escrow.amount` comparison: a load's
 * posted price is not financial truth once a booking exists. The escrow must
 * equal what is owed (I7) and what was actually confirmed paid (I6), and no
 * adjustment may be unresolved. `mismatch` is true only for an I6 violation so
 * the caller can raise a reconciliation flag.
 *
 * @param {{trip:Object, booking:Object, escrow:Object|null, ledger:Object}} args
 */
export function evaluateReleaseEligibility({ trip, booking, escrow, ledger }) {
  if (trip.status !== "Delivered") {
    return { eligible: false, mismatch: false, reason: "Trip is not yet Delivered." };
  }
  if (!escrow) {
    return { eligible: false, mismatch: false, reason: "No escrow exists for this booking (payment not completed)." };
  }
  if (escrow.status !== ESCROW_STATUS.HELD) {
    return { eligible: false, mismatch: false, reason: `Escrow is ${escrow.status}, not Held.` };
  }
  if (escrow.bookingId !== booking.id) {
    return { eligible: false, mismatch: false, reason: "Escrow/booking mismatch." };
  }
  if (ledger.totalObligation === null) {
    return { eligible: false, mismatch: false, reason: "Booking has no agreed amount." };
  }
  if (ledger.escrowMatchesFunding === false) {
    return { eligible: false, mismatch: true, reason: `Escrow amount (${escrow.amount}) does not equal confirmed funding (${ledger.confirmedFunding}).` };
  }
  if (ledger.blockingAdjustments > 0) {
    return { eligible: false, mismatch: false, reason: "An adjustment is still unresolved." };
  }
  if (escrow.amount !== ledger.totalObligation) {
    return { eligible: false, mismatch: false, reason: `Escrow amount (${escrow.amount}) does not equal the total obligation (${ledger.totalObligation}).` };
  }
  return { eligible: true, mismatch: false, reason: null };
}

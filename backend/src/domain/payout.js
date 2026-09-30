/**
 * backend/src/domain/payout.js
 * --------------------------------
 * Phase 4K-A — a B2C payout ATTEMPT (docs/4K-DARAJA-SPEC.md Section 2). One
 * escrow can have multiple payout rows over time if earlier attempts fail —
 * that's the whole point of the schema's two partial unique indexes (see
 * db/schema.js): unlimited attempts, at most one ever Confirmed, at most one
 * ever in flight at once.
 */

export const PAYOUT_STATUS = {
  PENDING:   "Pending",   // row exists, Daraja not yet called
  REQUESTED: "Requested", // synchronous Daraja response received — NOT proof of payout
  CONFIRMED: "Confirmed",
  FAILED:    "Failed",
};

/** The statuses the two partial unique indexes in db/schema.js key off of. */
export const NON_TERMINAL_PAYOUT_STATUSES = new Set([
  PAYOUT_STATUS.PENDING,
  PAYOUT_STATUS.REQUESTED,
]);

export function generatePayoutId(existingCount) {
  return `PO-${1000 + existingCount}`;
}

/** @param {{escrowId:string, transporterId:string, amount:number, phoneNumber:string}} data */
export function createPayout({ escrowId, transporterId, amount, phoneNumber }, existingCount) {
  const now = new Date().toISOString();
  return {
    id:                       generatePayoutId(existingCount),
    escrowId,
    transporterId,
    amount,
    phoneNumber,
    status:                   PAYOUT_STATUS.PENDING,
    conversationId:           null, // set once Daraja's synchronous response arrives
    originatorConversationId: null,
    transactionId:            null, // set exactly once, on first successful callback — never overwritten
    resultCode:               null,
    resultDesc:               null,
    createdAt:                now,
    updatedAt:                now,
  };
}

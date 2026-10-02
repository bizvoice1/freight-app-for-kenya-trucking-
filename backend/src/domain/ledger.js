/**
 * backend/src/domain/ledger.js
 * --------------------------------
 * Phase 5D-1 — the ONLY definition of a booking's money totals
 * (docs/5D-PRICING-SPEC.md invariants I4–I7, I18). Pure: takes plain rows,
 * returns numbers. `loads.price` and any frontend value are never an input;
 * financial truth is the booking's `agreedAmount` plus adjustment and payment
 * rows. The adjustments table lands in 5D-2; its rows plug into the
 * `adjustments` argument without changing any caller.
 */

/** Adjustment statuses that count toward what the shipper owes (I4). */
export const OBLIGATING_ADJUSTMENT_STATUSES = new Set(["APPROVED", "FUNDING", "FUNDED"]);
/** Adjustment statuses that block release while unresolved (I7). */
export const BLOCKING_ADJUSTMENT_STATUSES = new Set(["PROPOSED", "APPROVED", "FUNDING", "DISPUTED"]);

/**
 * @param {{booking:{agreedAmount:number|null}, payments:Array<{status:string, amount:number}>, escrow:{amount:number|null}|null, adjustments?:Array<{status:string, amount:number}>}} args
 */
export function computeLedger({ booking, payments, escrow, adjustments = [] }) {
  const agreedAmount = typeof booking.agreedAmount === "number" ? booking.agreedAmount : null;
  const approvedAdjustments = adjustments
    .filter(a => OBLIGATING_ADJUSTMENT_STATUSES.has(a.status))
    .reduce((sum, a) => sum + a.amount, 0);
  const totalObligation = agreedAmount === null ? null : agreedAmount + approvedAdjustments;
  const confirmedFunding = payments.filter(p => p.status === "Paid").reduce((sum, p) => sum + p.amount, 0);
  const blockingAdjustments = adjustments.filter(a => BLOCKING_ADJUSTMENT_STATUSES.has(a.status)).length;
  const escrowAmount = escrow && typeof escrow.amount === "number" ? escrow.amount : null;
  return {
    agreedAmount,
    approvedAdjustments,
    totalObligation,
    confirmedFunding,
    outstanding: totalObligation === null ? null : totalObligation - confirmedFunding,
    escrowAmount,
    // I6: escrows.amount == confirmedFunding. null when there is no escrow yet.
    escrowMatchesFunding: escrow ? escrowAmount === confirmedFunding : null,
    blockingAdjustments,
  };
}

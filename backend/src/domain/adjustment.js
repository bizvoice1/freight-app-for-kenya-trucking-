/**
 * backend/src/domain/adjustment.js
 * ------------------------------------
 * Phase 5D-2 — pure rules for commercial adjustments (docs/5D-PRICING-SPEC.md
 * 4.2, 5.3, 5.5, 5.7). No database, no clock beyond what callers pass in.
 */

/** capSnapshotPct is a PERCENT (25 means 25%), never a fraction (0.25). */
export const ADJUSTMENT_STATUS = {
  PROPOSED:  "PROPOSED",
  APPROVED:  "APPROVED",
  FUNDING:   "FUNDING",
  FUNDED:    "FUNDED",
  REJECTED:  "REJECTED",
  WITHDRAWN: "WITHDRAWN",
  EXPIRED:   "EXPIRED",
};

export const TERMINAL_ADJUSTMENT_STATUSES = new Set(["FUNDED", "REJECTED", "WITHDRAWN", "EXPIRED"]);

export const REASON_CODE = {
  EXTRA_DISTANCE:   "EXTRA_DISTANCE", // reserved for the 5J rule; not accepted from the manual API
  WAITING_TIME:     "WAITING_TIME",
  ROUTE_CHANGE:     "ROUTE_CHANGE",
  ADDITIONAL_CARGO: "ADDITIONAL_CARGO",
  TOLLS_FEES:       "TOLLS_FEES",
  OTHER:            "OTHER",
};

export const ADJUSTMENT_SOURCE = { MANUAL: "MANUAL", RULE: "RULE" };

export const MAX_ADJUSTMENT_AMOUNT = 100_000_000;
export const REASON_MIN = 10;
export const REASON_MAX = 500;

/** Effective configuration; read per call so a restart (not a code change) alters FUTURE adjustments only. */
export function adjustmentConfig(env = process.env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    maxPct:        num(env.ADJUSTMENT_MAX_PCT, 25),   // percent of agreedAmount
    approvalHours: num(env.ADJUSTMENT_APPROVAL_HOURS, 48),
    fundingHours:  num(env.ADJUSTMENT_FUNDING_HOURS, 48),
  };
}

export function generateAdjustmentId(existingCount) {
  return `ADJ-${1000 + existingCount}`;
}

/** @returns {{ok:true, amount:number}|{ok:false, code:string, error:string}} */
export function validateAdjustmentAmount(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount)) {
    return { ok: false, code: "INVALID_AMOUNT", error: "amount must be a whole number of KSh." };
  }
  if (amount <= 0) return { ok: false, code: "INVALID_AMOUNT", error: "amount must be greater than zero." };
  if (amount > MAX_ADJUSTMENT_AMOUNT) return { ok: false, code: "INVALID_AMOUNT", error: "amount exceeds the absolute limit." };
  return { ok: true, amount };
}

/** @returns {{ok:true, reason:string}|{ok:false, code:string, error:string}} */
export function validateReason(reason) {
  if (typeof reason !== "string") return { ok: false, code: "INVALID_REASON", error: "reason is required." };
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
    return { ok: false, code: "INVALID_REASON", error: `reason must be ${REASON_MIN}-${REASON_MAX} characters.` };
  }
  return { ok: true, reason: trimmed };
}

/** Maximum cumulative positive adjustments for a booking, from the booking snapshot (never loads.price). */
export function maxAdjustmentTotal(agreedAmount, capPct) {
  return (agreedAmount * capPct) / 100;
}

/**
 * @param {{agreedAmount:number, capPct:number, obligatingTotal:number, amount:number}} args
 * obligatingTotal = Σ amount of the booking's APPROVED/FUNDING/FUNDED adjustments.
 */
export function checkCap({ agreedAmount, capPct, obligatingTotal, amount }) {
  const max = maxAdjustmentTotal(agreedAmount, capPct);
  return { ok: obligatingTotal + amount <= max + 1e-6, max, remaining: Math.max(0, max - obligatingTotal) };
}

export function buildAdjustment(data, existingCount, now = new Date()) {
  const cfg = adjustmentConfig();
  const iso = now.toISOString();
  return {
    id:                   generateAdjustmentId(existingCount),
    bookingId:            data.bookingId,
    requestedById:        data.requestedById,
    amount:               data.amount,
    agreedAmountSnapshot: data.agreedAmountSnapshot,
    capSnapshotPct:       data.capSnapshotPct,
    reasonCode:           data.reasonCode,
    reason:               data.reason,
    status:               ADJUSTMENT_STATUS.PROPOSED,
    closeReason:          null,
    source:               data.source ?? ADJUSTMENT_SOURCE.MANUAL,
    sourceRef:            data.sourceRef ?? null,
    approvalExpiresAt:    new Date(now.getTime() + cfg.approvalHours * 3600_000).toISOString(),
    fundingDueAt:         null,
    approvedById:         null,
    approvedAt:           null,
    rejectedById:         null,
    rejectedAt:           null,
    rejectReason:         null,
    withdrawnAt:          null,
    expiredAt:            null,
    paidAt:               null,
    createdAt:            iso,
    updatedAt:            iso,
  };
}

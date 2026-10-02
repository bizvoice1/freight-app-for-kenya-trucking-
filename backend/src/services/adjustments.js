/**
 * backend/src/services/adjustments.js
 * ---------------------------------------
 * Phase 5D-2 — commercial adjustments (docs/5D-PRICING-SPEC.md 4.2, 5.3-5.7).
 *
 * An adjustment layers a transporter-requested increase ON TOP of the
 * booking's immutable agreedAmount; it never rewrites loads.price or
 * bookings.agreedAmount. Same discipline as services/offers.js: every state
 * change is ONE synchronous better-sqlite3 transaction, audit rows are written
 * inside it, notifications go out after commit. The migration-0009 triggers
 * (cap, one-open index, no-adjustment-after-Delivered, immutability) are the
 * backstop; the service checks first so callers get precise error codes.
 *
 * Check order: existence (404) -> authorization (403) -> input (400) -> state (409) -> cap (422).
 *
 * 5J hand-off: extra-distance charges call proposeAdjustment() with
 * source "RULE" — same approval, cap, one-open and post-Delivered rules. There
 * is deliberately no other way to create an adjustment.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../db/client.js";
import { adjustments, bookings, loads, trips, escrows, payments } from "../db/schema.js";
import {
  ADJUSTMENT_STATUS as S, ADJUSTMENT_SOURCE, REASON_CODE, adjustmentConfig, buildAdjustment,
  checkCap, validateAdjustmentAmount, validateReason,
} from "../domain/adjustment.js";
import { createPayment, PAYMENT_STATUS } from "../domain/payment.js";
import { ESCROW_STATUS } from "../domain/escrow.js";
import { NOTIFICATION_TYPE } from "../domain/notification.js";
import { notifyUser } from "./notifications.js";
import { logPaymentEventSync, loadLedgerSync } from "./ledger.js";

export class AdjustmentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new AdjustmentError(status, code, message); };
const nowIso = () => new Date().toISOString();
const ksh = (n) => `KSh ${Number(n).toLocaleString("en-US")}`;

const OBLIGATING = ["APPROVED", "FUNDING", "FUNDED"];

/** Maps a trigger/unique-index abort to the API error it represents; rethrows anything else. */
function mapDbError(err) {
  const msg = String(err?.message || "");
  if (msg.includes("ADJ_CAP_EXCEEDED")) fail(422, "ADJUSTMENT_CAP_EXCEEDED", "Cumulative adjustments would exceed the allowed cap.");
  if (msg.includes("ADJ_AFTER_DELIVERY")) fail(409, "ADJUSTMENT_AFTER_DELIVERY", "The trip has been delivered; no new adjustments or approvals are possible.");
  if (msg.includes("ADJ_BOOKING_NOT_FOUND")) fail(404, "BOOKING_NOT_FOUND", "Booking not found.");
  if (msg.includes("ADJ_SNAPSHOT_MISMATCH")) fail(409, "ADJUSTMENT_SNAPSHOT_MISMATCH", "Adjustment basis does not match the booking's agreed amount.");
  if (msg.includes("ADJ_IMMUTABLE")) fail(409, "ADJUSTMENT_IMMUTABLE", "An adjustment's commercial fields cannot be changed.");
  if (msg.includes("ADJ_TERMINAL")) fail(409, "ADJUSTMENT_CLOSED", "This adjustment is already closed.");
  if (msg.includes("PAY_ADJUSTMENT_INVALID") || msg.includes("PAY_PURPOSE")) fail(409, "PAYMENT_ADJUSTMENT_INVALID", "Invalid adjustment payment.");
  if (isUniqueConstraintError(err)) {
    if (msg.includes("adjustments_one_open_per_booking") || msg.includes("adjustments.booking_id")) {
      fail(409, "ADJUSTMENT_ALREADY_OPEN", "This booking already has an open adjustment.");
    }
    if (msg.includes("source_ref")) fail(409, "ADJUSTMENT_DUPLICATE_SOURCE", "This adjustment was already created.");
    if (msg.includes("payments_one_inflight")) fail(409, "PAYMENT_IN_PROGRESS", "A payment is already in progress for this booking.");
    if (msg.includes("payments_one_paid")) fail(409, "ALREADY_PAID", "This has already been paid.");
  }
  throw err;
}
async function run(fn) {
  try { return await fn(); } catch (err) { if (err instanceof AdjustmentError) throw err; return mapDbError(err); }
}

const getAdj = (tx, id) => tx.select().from(adjustments).where(eq(adjustments.id, id)).get();
const getBooking = (tx, id) => tx.select().from(bookings).where(eq(bookings.id, id)).get();
const getLoad = (tx, id) => tx.select().from(loads).where(eq(loads.id, id)).get();
const getEscrow = (tx, bookingId) => tx.select().from(escrows).where(eq(escrows.bookingId, bookingId)).get();
const tripsOf = (tx, bookingId) => tx.select().from(trips).where(eq(trips.bookingId, bookingId)).all();

function isShipperOf(user, load) { return user.role === "shipper" && !!load && load.shipperId === user.id; }
function canView(user, booking, load) {
  return user.role === "admin" || (user.role === "fleet_owner" && booking.transporterId === user.id) || isShipperOf(user, load);
}

function transition(tx, adj, to, extra, eventType, requestId, payload) {
  const now = nowIso();
  tx.update(adjustments).set({ status: to, updatedAt: now, ...extra })
    .where(and(eq(adjustments.id, adj.id), eq(adjustments.status, adj.status))).run();
  logPaymentEventSync(tx, "adjustment", adj.id, eventType, adj.status, to, payload ?? { amount: adj.amount }, requestId);
}

/** Lazily lapses unanswered proposals for a booking so an old PROPOSED row can never block a new request. */
function expireStaleSync(tx, bookingId, requestId) {
  const now = nowIso();
  const stale = tx.select().from(adjustments)
    .where(and(eq(adjustments.bookingId, bookingId), eq(adjustments.status, S.PROPOSED))).all()
    .filter(a => a.approvalExpiresAt <= now);
  for (const a of stale) transition(tx, a, S.EXPIRED, { expiredAt: now, closeReason: "APPROVAL_TIMEOUT" }, "adjustment_expired", requestId, { closeReason: "APPROVAL_TIMEOUT", amount: a.amount });
  return stale.length;
}

/** Delivered hook (called inside the trip-status transaction in routes/trips.js). */
export function expireProposedAdjustmentsSync(tx, bookingId, requestId) {
  const now = nowIso();
  const open = tx.select().from(adjustments)
    .where(and(eq(adjustments.bookingId, bookingId), eq(adjustments.status, S.PROPOSED))).all();
  for (const a of open) transition(tx, a, S.EXPIRED, { expiredAt: now, closeReason: "TRIP_DELIVERED" }, "adjustment_expired", requestId, { closeReason: "TRIP_DELIVERED", amount: a.amount });
  return open.length;
}

/**
 * Creates an adjustment. `actor` is the authorizing principal: the booking's
 * transporter for MANUAL, or the RULE source's system context (5J) which must
 * still name the booking's transporter as requestedById.
 */
export async function proposeAdjustment(input, requestId) {
  const { bookingId, requestedById, reasonCode, source = ADJUSTMENT_SOURCE.MANUAL, sourceRef = null } = input;
  const a = validateAdjustmentAmount(input.amount);
  if (!a.ok) fail(400, a.code, a.error);
  const r = validateReason(input.reason);
  if (!r.ok) fail(400, r.code, r.error);
  if (!Object.values(REASON_CODE).includes(reasonCode)) fail(400, "INVALID_REASON_CODE", `reasonCode must be one of ${Object.values(REASON_CODE).join(", ")}.`);
  if (source === ADJUSTMENT_SOURCE.MANUAL && reasonCode === REASON_CODE.EXTRA_DISTANCE) {
    fail(400, "INVALID_REASON_CODE", "EXTRA_DISTANCE is reserved for the automatic extra-distance rule.");
  }

  const cfg = adjustmentConfig();
  const created = await run(() => db.transaction((tx) => {
    const booking = getBooking(tx, bookingId);
    if (!booking) fail(404, "BOOKING_NOT_FOUND", `No booking found with id ${bookingId}.`);
    if (booking.transporterId !== requestedById) fail(403, "FORBIDDEN", "This booking does not belong to the authenticated transporter.");
    if (typeof booking.agreedAmount !== "number" || !(booking.agreedAmount > 0)) fail(409, "NO_AGREED_AMOUNT", "Booking has no agreed amount to adjust.");

    const bTrips = tripsOf(tx, bookingId);
    if (bTrips.some(t => t.status === "Delivered")) fail(409, "ADJUSTMENT_AFTER_DELIVERY", "The trip has been delivered; no new adjustments are possible.");
    if (bTrips.some(t => t.status === "Cancelled") || booking.status === "Cancelled") fail(409, "BOOKING_NOT_ACTIVE", "The booking or its trip is cancelled.");
    if (booking.status !== "Assigned" && booking.status !== "Trip Created") fail(409, "BOOKING_NOT_ACTIVE", `Adjustments need an assigned booking (status: ${booking.status}).`);
    const escrow = getEscrow(tx, bookingId);
    if (!escrow || escrow.status !== ESCROW_STATUS.HELD) fail(409, "ESCROW_NOT_HELD", "The agreed price must be funded and held in escrow before it can be adjusted.");

    expireStaleSync(tx, bookingId, requestId);
    const obligatingTotal = tx.select().from(adjustments)
      .where(and(eq(adjustments.bookingId, bookingId), inArray(adjustments.status, OBLIGATING))).all()
      .reduce((sum, x) => sum + x.amount, 0);
    // Cap is computed from the booking's snapshot, never loads.price.
    const cap = checkCap({ agreedAmount: booking.agreedAmount, capPct: cfg.maxPct, obligatingTotal, amount: a.amount });
    if (!cap.ok) fail(422, "ADJUSTMENT_CAP_EXCEEDED", `Cumulative adjustments would exceed ${cfg.maxPct}% of the agreed amount (${ksh(cap.max)}); ${ksh(cap.remaining)} remains.`);

    const count = tx.select().from(adjustments).all().length;
    const row = buildAdjustment({
      bookingId, requestedById, amount: a.amount, agreedAmountSnapshot: booking.agreedAmount, capSnapshotPct: cfg.maxPct,
      reasonCode, reason: r.reason, source, sourceRef,
    }, count);
    tx.insert(adjustments).values(row).run();
    logPaymentEventSync(tx, "adjustment", row.id, "adjustment_proposed", null, S.PROPOSED,
      { bookingId, amount: row.amount, reasonCode, agreedAmountSnapshot: row.agreedAmountSnapshot, capSnapshotPct: row.capSnapshotPct, source }, requestId);
    return { row, shipperId: getLoad(tx, booking.loadId)?.shipperId };
  }));

  if (created.shipperId) {
    await notifyUser(created.shipperId, NOTIFICATION_TYPE.ADJUSTMENT_PROPOSED, "Price adjustment requested",
      `The transporter requested +${ksh(created.row.amount)} on booking ${bookingId}: ${created.row.reason}`, "adjustment", created.row.id).catch(() => {});
  }
  return created.row;
}

/** Route-facing entry: only the booking's transporter may request. */
export function requestAdjustment(user, bookingId, body, requestId) {
  if (user.role !== "fleet_owner") fail(403, "FORBIDDEN", "Only the booking's transporter may request an adjustment.");
  const b = body || {};
  return proposeAdjustment({
    bookingId, requestedById: user.id, amount: b.amount, reason: b.reason, reasonCode: b.reasonCode ?? REASON_CODE.OTHER,
    source: ADJUSTMENT_SOURCE.MANUAL, sourceRef: null,
  }, requestId);
}

function guardNoCommercialEdit(body) {
  for (const k of ["amount", "reason", "reasonCode", "agreedAmountSnapshot", "capSnapshotPct", "bookingId"]) {
    if (body && body[k] !== undefined) fail(400, "ADJUSTMENT_IMMUTABLE", `${k} cannot be supplied or changed; an adjustment's commercial terms are fixed at creation.`);
  }
}

/** Loads adjustment + booking + load or throws 404; enforces who may act. */
function loadForAction(tx, id) {
  const adj = getAdj(tx, id);
  if (!adj) fail(404, "ADJUSTMENT_NOT_FOUND", `No adjustment found with id ${id}.`);
  const booking = getBooking(tx, adj.bookingId);
  const load = booking ? getLoad(tx, booking.loadId) : null;
  return { adj, booking, load };
}

export async function approveAdjustment(user, id, body, requestId) {
  guardNoCommercialEdit(body);
  let lapsed = false;
  const out = await run(() => db.transaction((tx) => {
    const { adj, booking, load } = loadForAction(tx, id);
    if (!isShipperOf(user, load)) fail(403, "FORBIDDEN", "Only the shipper who posted this load may approve its adjustments.");
    if (adj.status !== S.PROPOSED) fail(409, "ADJUSTMENT_NOT_PROPOSED", `Adjustment is ${adj.status}, not awaiting approval.`);
    if (tripsOf(tx, adj.bookingId).some(t => t.status === "Delivered")) fail(409, "ADJUSTMENT_AFTER_DELIVERY", "The trip has been delivered; this adjustment can no longer be approved.");
    const now = nowIso();
    if (adj.approvalExpiresAt <= now) {
      transition(tx, adj, S.EXPIRED, { expiredAt: now, closeReason: "APPROVAL_TIMEOUT" }, "adjustment_expired", requestId, { closeReason: "APPROVAL_TIMEOUT", amount: adj.amount });
      lapsed = true;
      return null;
    }
    const cfg = adjustmentConfig();
    transition(tx, adj, S.APPROVED, {
      approvedById: user.id, approvedAt: now,
      fundingDueAt: new Date(Date.now() + cfg.fundingHours * 3600_000).toISOString(),
    }, "adjustment_approved", requestId, { amount: adj.amount, approvedById: user.id });
    return { adj: getAdj(tx, id), transporterId: booking.transporterId };
  }));
  if (lapsed) fail(409, "ADJUSTMENT_EXPIRED", "This adjustment request lapsed before it was answered.");
  await notifyUser(out.transporterId, NOTIFICATION_TYPE.ADJUSTMENT_DECIDED, "Adjustment approved",
    `Your +${ksh(out.adj.amount)} adjustment on booking ${out.adj.bookingId} was approved and awaits payment.`, "adjustment", id).catch(() => {});
  return out.adj;
}

export async function rejectAdjustment(user, id, body, requestId) {
  guardNoCommercialEdit(body);
  const note = typeof body?.rejectReason === "string" ? body.rejectReason : null;
  let lapsed = false;
  const out = await run(() => db.transaction((tx) => {
    const { adj, booking, load } = loadForAction(tx, id);
    if (!isShipperOf(user, load)) fail(403, "FORBIDDEN", "Only the shipper who posted this load may reject its adjustments.");
    if (adj.status !== S.PROPOSED) fail(409, "ADJUSTMENT_NOT_PROPOSED", `Adjustment is ${adj.status}, not awaiting a decision.`);
    const now = nowIso();
    if (adj.approvalExpiresAt <= now) {
      transition(tx, adj, S.EXPIRED, { expiredAt: now, closeReason: "APPROVAL_TIMEOUT" }, "adjustment_expired", requestId, { closeReason: "APPROVAL_TIMEOUT", amount: adj.amount });
      lapsed = true;
      return null;
    }
    transition(tx, adj, S.REJECTED, { rejectedById: user.id, rejectedAt: now, rejectReason: note?.trim().slice(0, 500) || null, closeReason: "REJECTED_BY_SHIPPER" },
      "adjustment_rejected", requestId, { amount: adj.amount });
    return { adj: getAdj(tx, id), transporterId: booking.transporterId };
  }));
  if (lapsed) fail(409, "ADJUSTMENT_EXPIRED", "This adjustment request lapsed before it was answered.");
  await notifyUser(out.transporterId, NOTIFICATION_TYPE.ADJUSTMENT_DECIDED, "Adjustment rejected",
    `Your +${ksh(out.adj.amount)} adjustment on booking ${out.adj.bookingId} was rejected.`, "adjustment", id).catch(() => {});
  return out.adj;
}

/** Transporter-controlled only while PROPOSED; once the shipper approves, it is a committed obligation. */
export async function withdrawAdjustment(user, id, requestId) {
  return run(() => db.transaction((tx) => {
    const { adj, booking } = loadForAction(tx, id);
    if (user.role !== "fleet_owner" || !booking || booking.transporterId !== user.id) fail(403, "FORBIDDEN", "Only the requesting transporter may withdraw an adjustment.");
    if (adj.status !== S.PROPOSED) fail(409, "ADJUSTMENT_NOT_WITHDRAWABLE", `Adjustment is ${adj.status}; only a PROPOSED adjustment can be withdrawn. An approved adjustment is a committed obligation.`);
    transition(tx, adj, S.WITHDRAWN, { withdrawnAt: nowIso(), closeReason: "WITHDRAWN_BY_TRANSPORTER" }, "adjustment_withdrawn", requestId);
    return getAdj(tx, id);
  }));
}

export async function getAdjustmentFor(user, id) {
  return run(() => db.transaction((tx) => {
    const { adj, booking, load } = loadForAction(tx, id);
    if (!canView(user, booking, load)) fail(403, "FORBIDDEN", "You are not authorized to view this adjustment.");
    expireStaleSync(tx, adj.bookingId, undefined);
    return getAdj(tx, id);
  }));
}

export async function listAdjustmentsFor(user, bookingId) {
  return run(() => db.transaction((tx) => {
    const booking = getBooking(tx, bookingId);
    if (!booking) fail(404, "BOOKING_NOT_FOUND", `No booking found with id ${bookingId}.`);
    if (!canView(user, booking, getLoad(tx, booking.loadId))) fail(403, "FORBIDDEN", "You are not authorized to view this booking.");
    expireStaleSync(tx, bookingId, undefined);
    return tx.select().from(adjustments).where(eq(adjustments.bookingId, bookingId)).all();
  }));
}

/** Persisted-rows-only money summary for a booking (same viewers as the booking itself). */
export async function getBookingLedgerFor(user, bookingId) {
  return run(() => db.transaction((tx) => {
    const booking = getBooking(tx, bookingId);
    if (!booking) fail(404, "BOOKING_NOT_FOUND", `No booking found with id ${bookingId}.`);
    if (!canView(user, booking, getLoad(tx, booking.loadId))) fail(403, "FORBIDDEN", "You are not authorized to view this booking.");
    expireStaleSync(tx, bookingId, undefined);
    return { bookingId, ...loadLedgerSync(tx, bookingId) };
  }));
}

/**
 * Starts funding an APPROVED adjustment: ONE transaction inserts the
 * ADJUSTMENT payment row (amount = adjustment.amount, never from the client)
 * and moves the adjustment to FUNDING. The caller then calls Daraja.
 */
export async function beginAdjustmentPayment(user, id, phoneNumber, requestId) {
  if (!phoneNumber) fail(400, "PHONE_REQUIRED", "phoneNumber is required.");
  return run(() => db.transaction((tx) => {
    const { adj, booking, load } = loadForAction(tx, id);
    if (!isShipperOf(user, load)) fail(403, "FORBIDDEN", "Only the shipper who posted this load may pay its adjustments.");
    if (adj.status !== S.APPROVED) fail(409, "ADJUSTMENT_NOT_APPROVED", `Adjustment is ${adj.status}; only an APPROVED adjustment can be paid.`);
    const escrow = getEscrow(tx, booking.id);
    if (!escrow || escrow.status !== ESCROW_STATUS.HELD) fail(409, "ESCROW_NOT_HELD", "The booking's escrow is not held; this adjustment cannot be added to it.");
    const count = tx.select().from(payments).all().length;
    const payment = createPayment({ bookingId: booking.id, shipperId: user.id, amount: adj.amount, phoneNumber, purpose: "ADJUSTMENT", adjustmentId: adj.id }, count);
    tx.insert(payments).values(payment).run();
    transition(tx, adj, S.FUNDING, {}, "adjustment_funding_started", requestId, { paymentId: payment.id, amount: adj.amount });
    return { payment, adjustment: getAdj(tx, id), booking };
  }));
}

/** Daraja rejected the STK push itself: undo the FUNDING attempt so the adjustment stays payable. */
export function abortAdjustmentPayment(paymentId, reason, requestId) {
  return db.transaction((tx) => {
    const payment = tx.select().from(payments).where(eq(payments.id, paymentId)).get();
    if (!payment?.adjustmentId) return;
    tx.update(payments).set({ status: PAYMENT_STATUS.FAILED, resultDesc: reason, updatedAt: nowIso() }).where(eq(payments.id, paymentId)).run();
    const adj = getAdj(tx, payment.adjustmentId);
    if (adj?.status === S.FUNDING) transition(tx, adj, S.APPROVED, {}, "adjustment_funding_failed", requestId, { paymentId, reason });
  });
}

/**
 * Callback, success path, INSIDE the webhook's transaction: payment Paid +
 * adjustment FUNDED + escrow.amount raised, atomically (spec I11). Returns
 * { raised } — false only if the escrow was no longer HELD, in which case the
 * payment is still recorded Paid (the money arrived) and the caller raises a
 * reconciliation flag; I6 then blocks release until ops resolve it.
 */
export function settleAdjustmentPaymentSync(tx, payment, { receipt, resultCode, resultDesc }, requestId) {
  const now = nowIso();
  tx.update(payments).set({ status: PAYMENT_STATUS.PAID, mpesaReceiptNumber: receipt, resultCode, resultDesc, updatedAt: now })
    .where(eq(payments.id, payment.id)).run();
  const adj = getAdj(tx, payment.adjustmentId);
  if (adj && adj.status === S.FUNDING) {
    transition(tx, adj, S.FUNDED, { paidAt: now }, "adjustment_funded", requestId, { paymentId: payment.id, amount: adj.amount });
  }
  const escrow = getEscrow(tx, payment.bookingId);
  if (!escrow || escrow.status !== ESCROW_STATUS.HELD) return { raised: false, escrow };
  const before = escrow.amount ?? 0;
  tx.update(escrows).set({ amount: before + payment.amount, updatedAt: now })
    .where(and(eq(escrows.id, escrow.id), eq(escrows.status, ESCROW_STATUS.HELD))).run();
  logPaymentEventSync(tx, "escrow", escrow.id, "amount_raised", null, null, { adjustmentId: payment.adjustmentId, paymentId: payment.id, from: before, to: before + payment.amount }, requestId);
  return { raised: true, escrow };
}

/** Callback, failure path, inside the webhook's transaction: payment Failed/Cancelled, adjustment back to APPROVED. */
export function failAdjustmentPaymentSync(tx, payment, failStatus, { resultCode, resultDesc }, requestId) {
  const now = nowIso();
  tx.update(payments).set({ status: failStatus, resultCode, resultDesc, updatedAt: now }).where(eq(payments.id, payment.id)).run();
  const adj = getAdj(tx, payment.adjustmentId);
  if (adj && adj.status === S.FUNDING) transition(tx, adj, S.APPROVED, {}, "adjustment_funding_failed", requestId, { paymentId: payment.id, resultDesc });
}

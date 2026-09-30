/**
 * backend/src/routes/escrows.js
 * ----------------------------------
 * Phase 4K-D/E (docs/4K-DARAJA-SPEC.md Sections 5-6). Release is admin-only
 * for v1 — a deliberate human checkpoint between "the system thinks this is
 * eligible" and "money actually leaves escrow" (Section 5).
 *
 * The two "mark-*-reversed" endpoints exist because the spec flagged both
 * reversal directions as unverified against real Daraja webhooks (Section
 * 8/Approval checklist's two open items) — rather than fabricate a callback
 * shape nobody can confirm is real, reversal is an explicit admin action,
 * exactly the fallback the spec itself proposed.
 */

import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../db/client.js";
import { escrows, bookings, loads, payouts, users } from "../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { ESCROW_STATUS } from "../domain/escrow.js";
import { createPayout, NON_TERMINAL_PAYOUT_STATUSES, PAYOUT_STATUS } from "../domain/payout.js";
import { logPaymentEvent } from "../services/ledger.js";
import { b2cPayment, callbackUrl } from "../services/daraja.js";

const router = Router();
router.use(requireAuth);

async function getEscrowOr404(req, res) {
  const [escrow] = await db.select().from(escrows).where(eq(escrows.id, req.params.escrowId));
  if (!escrow) {
    res.status(404).json({ error: `No escrow found with id ${req.params.escrowId}.` });
    return null;
  }
  return escrow;
}

/** Same ownership chain as canViewBooking (Phase 4I) — escrow is reached via its booking. */
async function canViewEscrow(req, escrow) {
  if (req.user.role === "admin") return true;
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, escrow.bookingId));
  if (!booking) return false;
  if (req.user.role === "fleet_owner") return booking.transporterId === req.user.id;
  if (req.user.role === "shipper") {
    const [load] = await db.select().from(loads).where(eq(loads.id, booking.loadId));
    return !!load && load.shipperId === req.user.id;
  }
  return false;
}

router.get("/:escrowId", async (req, res) => {
  const escrow = await getEscrowOr404(req, res);
  if (!escrow) return;
  if (!(await canViewEscrow(req, escrow))) {
    return res.status(403).json({ error: "You are not authorized to view this escrow." });
  }
  res.json(escrow);
});

router.get("/", async (req, res) => {
  const { bookingId } = req.query;
  let rows = bookingId
    ? await db.select().from(escrows).where(eq(escrows.bookingId, bookingId))
    : await db.select().from(escrows);

  if (req.user.role === "fleet_owner") {
    const own = await db.select().from(bookings).where(eq(bookings.transporterId, req.user.id));
    const ownIds = new Set(own.map(b => b.id));
    rows = rows.filter(e => ownIds.has(e.bookingId));
  } else if (req.user.role === "shipper") {
    const ownLoads = await db.select().from(loads).where(eq(loads.shipperId, req.user.id));
    const ownLoadIds = new Set(ownLoads.map(l => l.id));
    const ownBookings = await db.select().from(bookings);
    const ownBookingIds = new Set(ownBookings.filter(b => ownLoadIds.has(b.loadId)).map(b => b.id));
    rows = rows.filter(e => ownBookingIds.has(e.bookingId));
  } else if (req.user.role === "driver") {
    rows = [];
  }
  res.json(rows);
});

/**
 * POST /api/escrows/:escrowId/release (admin)
 *
 * Step 1 below is a fast, cheap application-level rejection — NOT the real
 * concurrency guard. The real guard is the payouts_one_inflight_per_escrow
 * partial unique index (db/schema.js): two genuinely concurrent calls can
 * both pass this SELECT before either commits its INSERT (a classic
 * check-then-act race under Node's cooperative concurrency — an `await`
 * yields, and a second in-flight request's handler can run in that gap).
 * The INSERT itself is what the database enforces atomically; whichever
 * request's INSERT is rejected by the constraint gets 409. This is exactly
 * what Section 9's concurrency acceptance test proves — deliberately NOT
 * wrapping this in a single JS-level transaction, since better-sqlite3
 * transactions run synchronously and would just serialize the two requests,
 * hiding the very race this route needs to survive.
 */
router.post("/:escrowId/release", requireRole("admin"), async (req, res) => {
  const escrow = await getEscrowOr404(req, res);
  if (!escrow) return;

  if (escrow.status !== ESCROW_STATUS.RELEASE_PENDING) {
    return res.status(409).json({ error: `Escrow ${escrow.id} is not awaiting release (status: ${escrow.status}).` });
  }

  const inflight = await db.select().from(payouts).where(
    and(eq(payouts.escrowId, escrow.id), inArray(payouts.status, [...NON_TERMINAL_PAYOUT_STATUSES]))
  );
  if (inflight.length > 0) {
    return res.status(409).json({ error: `A payout is already in flight for escrow ${escrow.id}.` });
  }

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, escrow.bookingId));
  if (!booking) return res.status(409).json({ error: "Escrow has no associated booking." });
  const [transporter] = await db.select().from(users).where(eq(users.id, booking.transporterId));
  if (!transporter) return res.status(409).json({ error: "Escrow's transporter no longer exists." });

  const count = (await db.select().from(payouts)).length;
  const payout = createPayout(
    { escrowId: escrow.id, transporterId: transporter.id, amount: escrow.amount, phoneNumber: transporter.phone },
    count
  );

  try {
    await db.insert(payouts).values(payout);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: `A payout is already in flight for escrow ${escrow.id} (concurrent request detected).` });
    }
    throw err;
  }

  const now = new Date().toISOString();
  await db.update(escrows).set({ status: ESCROW_STATUS.RELEASE_IN_PROGRESS, releaseInProgressAt: now, updatedAt: now }).where(eq(escrows.id, escrow.id));
  await logPaymentEvent("payout", payout.id, "payout_requested", null, PAYOUT_STATUS.PENDING, { requestedBy: req.user.id });
  await logPaymentEvent("escrow", escrow.id, "status_changed", ESCROW_STATUS.RELEASE_PENDING, ESCROW_STATUS.RELEASE_IN_PROGRESS);

  const { testOutcome, testForceReceipt, testDelayMs } = req.body || {};
  const daraja = await b2cPayment({
    amount: payout.amount,
    receiverName: transporter.name,
    phoneNumber: payout.phoneNumber,
    callbackUrl: callbackUrl("/api/payouts/callback/b2c"),
    testOutcome, testForceReceipt, testDelayMs,
  });

  await db.update(payouts).set({
    conversationId: daraja.conversationId,
    originatorConversationId: daraja.originatorConversationId,
    status: PAYOUT_STATUS.REQUESTED,
    updatedAt: new Date().toISOString(),
  }).where(eq(payouts.id, payout.id));
  await logPaymentEvent("payout", payout.id, "b2c_sent", PAYOUT_STATUS.PENDING, PAYOUT_STATUS.REQUESTED, { daraja });

  const [updatedEscrow] = await db.select().from(escrows).where(eq(escrows.id, escrow.id));
  const [updatedPayout] = await db.select().from(payouts).where(eq(payouts.id, payout.id));
  res.status(201).json({ escrow: updatedEscrow, payout: updatedPayout });
});

/**
 * POST /api/escrows/:escrowId/mark-payment-reversed (admin)
 * The HELD -> PAYMENT_REVERSED edge (Section 4) — a manual transition, per
 * this implementation's resolution of the spec's open "unverified webhook"
 * item. Only legal while funds are still held, before any release.
 */
router.post("/:escrowId/mark-payment-reversed", requireRole("admin"), async (req, res) => {
  const escrow = await getEscrowOr404(req, res);
  if (!escrow) return;
  if (escrow.status !== ESCROW_STATUS.HELD) {
    return res.status(409).json({ error: `Escrow ${escrow.id} is not Held (status: ${escrow.status}) — cannot mark the original payment reversed.` });
  }
  const now = new Date().toISOString();
  await db.update(escrows).set({ status: ESCROW_STATUS.PAYMENT_REVERSED, updatedAt: now }).where(eq(escrows.id, escrow.id));
  await logPaymentEvent("escrow", escrow.id, "payment_reversed", ESCROW_STATUS.HELD, ESCROW_STATUS.PAYMENT_REVERSED, { markedBy: req.user.id });
  const [updated] = await db.select().from(escrows).where(eq(escrows.id, escrow.id));
  res.json(updated);
});

/**
 * POST /api/escrows/:escrowId/mark-payout-reversed (admin)
 * The SETTLED -> PAYOUT_REVERSED edge — same reasoning, opposite leg.
 */
router.post("/:escrowId/mark-payout-reversed", requireRole("admin"), async (req, res) => {
  const escrow = await getEscrowOr404(req, res);
  if (!escrow) return;
  if (escrow.status !== ESCROW_STATUS.SETTLED) {
    return res.status(409).json({ error: `Escrow ${escrow.id} is not Settled (status: ${escrow.status}) — cannot mark the payout reversed.` });
  }
  const now = new Date().toISOString();
  await db.update(escrows).set({ status: ESCROW_STATUS.PAYOUT_REVERSED, updatedAt: now }).where(eq(escrows.id, escrow.id));
  await logPaymentEvent("escrow", escrow.id, "payout_reversed", ESCROW_STATUS.SETTLED, ESCROW_STATUS.PAYOUT_REVERSED, { markedBy: req.user.id });
  const [updated] = await db.select().from(escrows).where(eq(escrows.id, escrow.id));
  res.json(updated);
});

export default router;

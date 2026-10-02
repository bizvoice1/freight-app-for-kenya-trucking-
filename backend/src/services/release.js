/**
 * backend/src/services/release.js
 * -----------------------------------
 * Phase 4K-D / 5D-2 — decides whether a Delivered trip's escrow may move to
 * RELEASE_PENDING. Extracted from routes/trips.js so that every event that can
 * clear a blocker (trip Delivered, an adjustment funded, an approved
 * adjustment withdrawn after delivery) re-runs the same single decision.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { trips, bookings, escrows } from "../db/schema.js";
import { ESCROW_STATUS, evaluateReleaseEligibility } from "../domain/escrow.js";
import { logPaymentEvent, flagReconciliation, loadLedgerSync } from "./ledger.js";
import { NOTIFICATION_TYPE } from "../domain/notification.js";
import { notifyUser, notifyUsers, allAdminUserIds } from "./notifications.js";

/**
 * Phase 4K-D (docs/4K-DARAJA-SPEC.md Section 5) — the moment a trip reaches
 * Delivered, check whether its escrow may move to RELEASE_PENDING. This is
 * ONLY a status flip + audit log if eligible; it never touches Daraja. No
 * booking (a trip without one) or no escrow (payment never completed) are
 * both legitimate "not eligible" outcomes, not errors.
 */
export async function maybeMakeEscrowEligibleForRelease(trip, requestId) {
  if (!trip.bookingId) return;
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, trip.bookingId));
  if (!booking) return;
  const [escrow] = await db.select().from(escrows).where(eq(escrows.bookingId, booking.id));
  const ledger = loadLedgerSync(db, booking.id);

  const decision = evaluateReleaseEligibility({ trip, booking, escrow: escrow || null, ledger });
  if (!decision.eligible) {
    if (decision.mismatch) {
      await flagReconciliation("escrow_ledger_mismatch", "escrow", escrow.id, { tripId: trip.id, bookingId: booking.id, ledger });
    }
    return;
  }

  const now = new Date().toISOString();
  await db.update(escrows).set({ status: ESCROW_STATUS.RELEASE_PENDING, releasePendingAt: now, updatedAt: now }).where(eq(escrows.id, escrow.id));
  await logPaymentEvent("escrow", escrow.id, "status_changed", ESCROW_STATUS.HELD, ESCROW_STATUS.RELEASE_PENDING, { tripId: trip.id }, requestId);

  await notifyUser(booking.transporterId, NOTIFICATION_TYPE.RELEASE_PENDING,
    "Delivery confirmed — payout pending", `Escrow ${escrow.id} for booking ${booking.id} is ready for release.`,
    "escrow", escrow.id);
  const adminIds = await allAdminUserIds();
  await notifyUsers(adminIds, NOTIFICATION_TYPE.RELEASE_PENDING,
    "Escrow ready for release", `Escrow ${escrow.id} (booking ${booking.id}) is awaiting admin release.`,
    "escrow", escrow.id);
}

/** Re-evaluates release for a booking whose trip is already Delivered (no-op otherwise). */
export async function reevaluateReleaseForBooking(bookingId, requestId) {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking?.tripId) return;
  const [trip] = await db.select().from(trips).where(eq(trips.id, booking.tripId));
  if (trip?.status === "Delivered") await maybeMakeEscrowEligibleForRelease(trip, requestId);
}

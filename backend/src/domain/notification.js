/**
 * backend/src/domain/notification.js
 * ---------------------------------------
 * Phase 4L — narrow, in-app only, on purpose: a `notifications` table plus a
 * GET/poll endpoint (routes/notifications.js), the same low-risk pattern
 * already used everywhere else in this backend (no WebSockets, no real
 * SMS/email/push provider, no new external dependency or credential). A
 * real delivery channel is a natural later increment on top of this same
 * table — the event -> recipient decisions below don't change either way.
 */

export const NOTIFICATION_TYPE = {
  LOAD_POSTED:       "load_posted",        // -> every fleet_owner (marketplace-wide; no matching engine to target yet)
  PAYMENT_CONFIRMED: "payment_confirmed",  // -> the shipper
  PAYMENT_FAILED:    "payment_failed",     // -> the shipper (covers both Failed and Cancelled)
  ESCROW_HELD:       "escrow_held",        // -> the transporter
  RELEASE_PENDING:   "release_pending",    // -> the transporter + every admin (admin must act)
  PAYOUT_CONFIRMED:  "payout_confirmed",   // -> the transporter
  PAYOUT_FAILED:     "payout_failed",      // -> the transporter + every admin (a retry needs admin action)
  TRIP_STATUS:       "trip_status",        // -> the shipper + the transporter
};

export function generateNotificationId(existingCount) {
  return `NOT-${1000 + existingCount}`;
}

/** @param {{userId:string, type:string, title:string, body:string, relatedEntityType?:string, relatedEntityId?:string}} data */
export function createNotification({ userId, type, title, body, relatedEntityType, relatedEntityId }, existingCount) {
  return {
    id:                generateNotificationId(existingCount),
    userId,
    type,
    title,
    body,
    relatedEntityType: relatedEntityType ?? null,
    relatedEntityId:   relatedEntityId ?? null,
    read:              false,
    createdAt:         new Date().toISOString(),
  };
}

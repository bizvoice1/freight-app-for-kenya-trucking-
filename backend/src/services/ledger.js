/**
 * backend/src/services/ledger.js
 * ----------------------------------
 * Phase 4K — the two append-only tables every payment/escrow/payout route
 * writes through: payment_events (what happened) and reconciliation_flags
 * (what didn't cleanly match). Centralised here so every call site logs the
 * same shape, not because it's complex — it's two inserts.
 */

import { db } from "../db/client.js";
import { paymentEvents, reconciliationFlags, payments, escrows, bookings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { computeLedger } from "../domain/ledger.js";

/**
 * @param {"payment"|"escrow"|"payout"} entityType
 * @param {string} entityId
 * @param {string} eventType
 * @param {string|null} fromStatus
 * @param {string|null} toStatus
 * @param {any} [payload] - the raw callback/request body, or any other JSON-serialisable context
 * @param {string} [requestId] - Phase 4M — the triggering request's req.id (app.js), for correlating a payment_events row back to a specific inbound request/response pair in the server logs. Optional and backward compatible — callers that don't have one (or aren't inside a request at all) omit it.
 */
export async function logPaymentEvent(entityType, entityId, eventType, fromStatus, toStatus, payload, requestId) {
  const count = (await db.select().from(paymentEvents)).length;
  await db.insert(paymentEvents).values({
    id:         `EVT-${1000 + count}`,
    entityType,
    entityId,
    eventType,
    fromStatus: fromStatus ?? null,
    toStatus:   toStatus ?? null,
    payload:    payload !== undefined ? JSON.stringify(payload) : null,
    requestId:  requestId ?? null,
    createdAt:  new Date().toISOString(),
  });
}

/**
 * @param {string} type - e.g. "unknown_checkout_request_id", "amount_mismatch", "duplicate_receipt_number"
 * @param {string|null} relatedEntityType
 * @param {string|null} relatedEntityId
 * @param {any} rawPayload
 */
export async function flagReconciliation(type, relatedEntityType, relatedEntityId, rawPayload) {
  const count = (await db.select().from(reconciliationFlags)).length;
  await db.insert(reconciliationFlags).values({
    id:                `RECON-${1000 + count}`,
    type,
    relatedEntityType: relatedEntityType ?? null,
    relatedEntityId:   relatedEntityId ?? null,
    rawPayload:        rawPayload !== undefined ? JSON.stringify(rawPayload) : null,
    status:            "open",
    createdAt:         new Date().toISOString(),
    resolvedAt:        null,
  });
}

/**
 * Phase 5D-1 — synchronous audit insert for use INSIDE a db.transaction().
 * logPaymentEvent above is async and cannot run inside better-sqlite3's
 * synchronous transaction callback; offer acceptance must write its audit rows
 * atomically with the booking, so it inserts directly through `tx`.
 */
export function logPaymentEventSync(tx, entityType, entityId, eventType, fromStatus, toStatus, payload, requestId) {
  const count = tx.select().from(paymentEvents).all().length;
  tx.insert(paymentEvents).values({
    id:         `EVT-${1000 + count}`,
    entityType,
    entityId,
    eventType,
    fromStatus: fromStatus ?? null,
    toStatus:   toStatus ?? null,
    payload:    payload !== undefined ? JSON.stringify(payload) : null,
    requestId:  requestId ?? null,
    createdAt:  new Date().toISOString(),
  }).run();
}

/** Reads a booking's rows and returns domain/ledger.js's totals. Works with `db` or a transaction handle (synchronous). */
export function loadLedgerSync(dbOrTx, bookingId) {
  const booking = dbOrTx.select().from(bookings).where(eq(bookings.id, bookingId)).get();
  if (!booking) return null;
  const rows = dbOrTx.select().from(payments).where(eq(payments.bookingId, bookingId)).all();
  const escrow = dbOrTx.select().from(escrows).where(eq(escrows.bookingId, bookingId)).get() || null;
  return computeLedger({ booking, payments: rows, escrow });
}

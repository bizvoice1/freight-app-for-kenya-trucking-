/**
 * backend/src/services/ledger.js
 * ----------------------------------
 * Phase 4K — the two append-only tables every payment/escrow/payout route
 * writes through: payment_events (what happened) and reconciliation_flags
 * (what didn't cleanly match). Centralised here so every call site logs the
 * same shape, not because it's complex — it's two inserts.
 */

import { db } from "../db/client.js";
import { paymentEvents, reconciliationFlags } from "../db/schema.js";

/**
 * @param {"payment"|"escrow"|"payout"} entityType
 * @param {string} entityId
 * @param {string} eventType
 * @param {string|null} fromStatus
 * @param {string|null} toStatus
 * @param {any} [payload] - the raw callback/request body, or any other JSON-serialisable context
 */
export async function logPaymentEvent(entityType, entityId, eventType, fromStatus, toStatus, payload) {
  const count = (await db.select().from(paymentEvents)).length;
  await db.insert(paymentEvents).values({
    id:         `EVT-${1000 + count}`,
    entityType,
    entityId,
    eventType,
    fromStatus: fromStatus ?? null,
    toStatus:   toStatus ?? null,
    payload:    payload !== undefined ? JSON.stringify(payload) : null,
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

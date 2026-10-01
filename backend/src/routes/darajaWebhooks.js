/**
 * backend/src/routes/darajaWebhooks.js
 * -----------------------------------------
 * Phase 4K, Sections 3 & 6 of docs/4K-DARAJA-SPEC.md. Deliberately NOT behind
 * requireAuth — Safaricom (real or simulated) has no JWT. This is the ONE
 * place Daraja's callback events enter Behari's own ledger (Section 0.5):
 * everything downstream reads payments/escrows/payouts, never Daraja again.
 *
 * Both handlers share one shape, stated once here rather than per-handler:
 *   unknown id            -> reconciliation_flags row, 200 (no retries wanted)
 *   already terminal       -> "duplicate_callback_ignored" event, 200, zero writes
 *   success, amount right  -> advance the state machine, log the event
 *   success, amount wrong  -> reconciliation_flags row, do NOT advance
 *   success, receipt reused -> reconciliation_flags row, do NOT advance
 *   non-zero result code   -> the attempt's own Failed/Cancelled status
 * A callback must never cause a state change twice — every branch below
 * exists to protect that one sentence.
 */

import { Router } from "express";
import { eq, and, ne } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../db/client.js";
import { payments, escrows, payouts, bookings } from "../db/schema.js";
import { PAYMENT_STATUS } from "../domain/payment.js";
import { PAYOUT_STATUS } from "../domain/payout.js";
import { ESCROW_STATUS, createEscrow } from "../domain/escrow.js";
import { logPaymentEvent, flagReconciliation } from "../services/ledger.js";
import { NOTIFICATION_TYPE } from "../domain/notification.js";
import { notifyUser, notifyUsers, allAdminUserIds } from "../services/notifications.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
const ACK = { ResultCode: 0, ResultDesc: "Accepted" };

function itemsToMap(callbackMetadata) {
  const out = {};
  for (const item of callbackMetadata?.Item || []) out[item.Name] = item.Value;
  return out;
}

function paramsToMap(resultParameters) {
  const out = {};
  for (const p of resultParameters?.ResultParameter || []) out[p.Key] = p.Value;
  return out;
}

/** POST /api/payments/callback/stk */
router.post("/payments/callback/stk", asyncHandler(async (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  const checkoutRequestId = cb?.CheckoutRequestID;
  if (!checkoutRequestId) return res.status(400).json({ error: "Missing CheckoutRequestID." });

  const [payment] = await db.select().from(payments).where(eq(payments.checkoutRequestId, checkoutRequestId));
  if (!payment) {
    await flagReconciliation("unknown_checkout_request_id", "payment", null, req.body);
    return res.status(200).json(ACK);
  }
  if (payment.status !== PAYMENT_STATUS.STK_SENT) {
    await logPaymentEvent("payment", payment.id, "duplicate_callback_ignored", payment.status, payment.status, req.body, req.id);
    return res.status(200).json(ACK);
  }

  const now = new Date().toISOString();

  if (cb.ResultCode === 0) {
    const items = itemsToMap(cb.CallbackMetadata);
    const amount = items.Amount;
    const receipt = String(items.MpesaReceiptNumber);

    if (amount !== payment.amount) {
      await flagReconciliation("amount_mismatch", "payment", payment.id, req.body);
      return res.status(200).json(ACK);
    }
    const [dupe] = await db.select().from(payments).where(and(eq(payments.mpesaReceiptNumber, receipt), ne(payments.id, payment.id)));
    if (dupe) {
      await flagReconciliation("duplicate_receipt_number", "payment", payment.id, req.body);
      return res.status(200).json(ACK);
    }

    const count = (await db.select().from(escrows)).length;
    const escrow = createEscrow({ bookingId: payment.bookingId, paymentId: payment.id, amount: payment.amount }, count);

    // Phase 4M — the payment status flip and the escrow creation are one
    // transaction, not two separate writes: without this, a crash or a
    // constraint violation between them could leave a payment marked Paid
    // with no escrow ever created for it. Either both happen or neither does.
    // better-sqlite3 transactions are synchronous — the callback must NOT
    // be async/awaited internally (drizzle/better-sqlite3 throws "Transaction
    // function cannot return a promise" otherwise); call .run() directly.
    try {
      db.transaction((tx) => {
        tx.update(payments).set({
          status: PAYMENT_STATUS.PAID,
          mpesaReceiptNumber: receipt,
          resultCode: cb.ResultCode,
          resultDesc: cb.ResultDesc,
          updatedAt: now,
        }).where(eq(payments.id, payment.id)).run();
        tx.insert(escrows).values(escrow).run();
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // Schema-level backstop — mpesaReceiptNumber reuse or (should the
        // payments_one_inflight_per_booking index ever be bypassed)
        // escrows.bookingId reuse both land here as the same honest outcome:
        // this callback is not accepted as new money movement.
        await flagReconciliation("duplicate_receipt_number", "payment", payment.id, req.body);
        return res.status(200).json(ACK);
      }
      throw err;
    }

    await logPaymentEvent("payment", payment.id, "callback_received", PAYMENT_STATUS.STK_SENT, PAYMENT_STATUS.PAID, req.body, req.id);
    await logPaymentEvent("escrow", escrow.id, "status_changed", null, ESCROW_STATUS.HELD, { paymentId: payment.id }, req.id);

    await notifyUser(payment.shipperId, NOTIFICATION_TYPE.PAYMENT_CONFIRMED,
      "Payment confirmed", `Your payment of ${payment.amount} for booking ${payment.bookingId} was received.`,
      "payment", payment.id);
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, payment.bookingId));
    if (booking) {
      await notifyUser(booking.transporterId, NOTIFICATION_TYPE.ESCROW_HELD,
        "Escrow funded", `Payment for booking ${booking.id} is confirmed and held in escrow.`,
        "escrow", escrow.id);
    }
  } else {
    const failStatus = cb.ResultCode === 1032 ? PAYMENT_STATUS.CANCELLED : PAYMENT_STATUS.FAILED;
    await db.update(payments).set({ status: failStatus, resultCode: cb.ResultCode, resultDesc: cb.ResultDesc, updatedAt: now })
      .where(eq(payments.id, payment.id));
    await logPaymentEvent("payment", payment.id, "callback_received", PAYMENT_STATUS.STK_SENT, failStatus, req.body, req.id);

    await notifyUser(payment.shipperId, NOTIFICATION_TYPE.PAYMENT_FAILED,
      failStatus === PAYMENT_STATUS.CANCELLED ? "Payment cancelled" : "Payment failed",
      `Your payment for booking ${payment.bookingId} was not completed (${cb.ResultDesc}).`,
      "payment", payment.id);
  }

  res.status(200).json(ACK);
}));

/** POST /api/payouts/callback/b2c */
router.post("/payouts/callback/b2c", asyncHandler(async (req, res) => {
  const result = req.body?.Result;
  const conversationId = result?.ConversationID;
  if (!conversationId) return res.status(400).json({ error: "Missing ConversationID." });

  const [payout] = await db.select().from(payouts).where(eq(payouts.conversationId, conversationId));
  if (!payout) {
    await flagReconciliation("unknown_conversation_id", "payout", null, req.body);
    return res.status(200).json(ACK);
  }
  if (payout.status !== PAYOUT_STATUS.REQUESTED) {
    await logPaymentEvent("payout", payout.id, "duplicate_callback_ignored", payout.status, payout.status, req.body, req.id);
    return res.status(200).json(ACK);
  }

  const now = new Date().toISOString();
  const [escrow] = await db.select().from(escrows).where(eq(escrows.id, payout.escrowId));

  if (result.ResultCode === 0) {
    const params = paramsToMap(result.ResultParameters);
    const amount = params.TransactionAmount;
    const receipt = String(params.TransactionReceipt);

    if (amount !== payout.amount) {
      await flagReconciliation("amount_mismatch", "payout", payout.id, req.body);
      return res.status(200).json(ACK);
    }
    const [dupe] = await db.select().from(payouts).where(and(eq(payouts.transactionId, receipt), ne(payouts.id, payout.id)));
    if (dupe) {
      await flagReconciliation("duplicate_receipt_number", "payout", payout.id, req.body);
      return res.status(200).json(ACK);
    }

    // Phase 4M — payout confirmation and escrow settlement are one
    // transaction: either both happen, or a constraint violation/crash
    // leaves neither changed (never a Confirmed payout against an escrow
    // that's still ReleaseInProgress). Synchronous callback, same reason as
    // the STK callback above — better-sqlite3 transactions can't be async.
    try {
      db.transaction((tx) => {
        tx.update(payouts).set({
          status: PAYOUT_STATUS.CONFIRMED,
          transactionId: receipt,
          resultCode: result.ResultCode,
          resultDesc: result.ResultDesc,
          updatedAt: now,
        }).where(eq(payouts.id, payout.id)).run();
        if (escrow) {
          tx.update(escrows).set({ status: ESCROW_STATUS.SETTLED, settledAt: now, updatedAt: now }).where(eq(escrows.id, escrow.id)).run();
        }
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        await flagReconciliation("duplicate_receipt_number", "payout", payout.id, req.body);
        return res.status(200).json(ACK);
      }
      throw err;
    }

    if (escrow) {
      await logPaymentEvent("escrow", escrow.id, "status_changed", ESCROW_STATUS.RELEASE_IN_PROGRESS, ESCROW_STATUS.SETTLED, undefined, req.id);
    }
    await logPaymentEvent("payout", payout.id, "callback_received", PAYOUT_STATUS.REQUESTED, PAYOUT_STATUS.CONFIRMED, req.body, req.id);

    await notifyUser(payout.transporterId, NOTIFICATION_TYPE.PAYOUT_CONFIRMED,
      "Payout confirmed", `Your payout of ${payout.amount} for escrow ${payout.escrowId} has been paid.`,
      "payout", payout.id);
  } else {
    await db.update(payouts).set({ status: PAYOUT_STATUS.FAILED, resultCode: result.ResultCode, resultDesc: result.ResultDesc, updatedAt: now })
      .where(eq(payouts.id, payout.id));
    if (escrow) {
      // Drops back to RELEASE_PENDING (from RELEASE_IN_PROGRESS) — retryable,
      // not stuck, not a silent success. This is also what frees the
      // payouts_one_inflight_per_escrow index for the next /release attempt.
      await db.update(escrows).set({ status: ESCROW_STATUS.RELEASE_PENDING, updatedAt: now }).where(eq(escrows.id, escrow.id));
      await logPaymentEvent("escrow", escrow.id, "status_changed", ESCROW_STATUS.RELEASE_IN_PROGRESS, ESCROW_STATUS.RELEASE_PENDING, undefined, req.id);
    }
    await logPaymentEvent("payout", payout.id, "callback_received", PAYOUT_STATUS.REQUESTED, PAYOUT_STATUS.FAILED, req.body, req.id);

    await notifyUser(payout.transporterId, NOTIFICATION_TYPE.PAYOUT_FAILED,
      "Payout failed", `Your payout for escrow ${payout.escrowId} failed (${result.ResultDesc}) and will need to be retried.`,
      "payout", payout.id);
    const adminIds = await allAdminUserIds();
    await notifyUsers(adminIds, NOTIFICATION_TYPE.PAYOUT_FAILED,
      "Payout failed — retry needed", `Payout ${payout.id} for escrow ${payout.escrowId} failed (${result.ResultDesc}).`,
      "payout", payout.id);
  }

  res.status(200).json(ACK);
}));

export default router;

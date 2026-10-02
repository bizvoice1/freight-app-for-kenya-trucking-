/**
 * backend/src/routes/adjustments.js
 * --------------------------------------
 * Phase 5D-2 — decisions and funding on an existing adjustment. Creation and
 * listing are booking-scoped and live in routes/bookings.js. No route here
 * accepts an amount: an adjustment's money is fixed at creation.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { payments } from "../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { stkPush, callbackUrl } from "../services/daraja.js";
import { logPaymentEvent } from "../services/ledger.js";
import {
  AdjustmentError, getAdjustmentFor, approveAdjustment, rejectAdjustment, withdrawAdjustment,
  beginAdjustmentPayment, abortAdjustmentPayment,
} from "../services/adjustments.js";

const router = Router();
router.use(requireAuth);

function handle(fn) {
  return asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof AdjustmentError) return res.status(err.status).json({ error: err.message, code: err.code });
      throw err;
    }
  });
}

router.get("/:id", handle(async (req, res) => {
  res.json(await getAdjustmentFor(req.user, req.params.id));
}));

router.post("/:id/approve", requireRole("shipper"), handle(async (req, res) => {
  res.json(await approveAdjustment(req.user, req.params.id, req.body, req.id));
}));

router.post("/:id/reject", requireRole("shipper"), handle(async (req, res) => {
  res.json(await rejectAdjustment(req.user, req.params.id, req.body, req.id));
}));

router.post("/:id/withdraw", requireRole("fleet_owner"), handle(async (req, res) => {
  res.json(await withdrawAdjustment(req.user, req.params.id, req.id));
}));

/** Funds an APPROVED adjustment. Amount comes from the adjustment row, never the body. */
router.post("/:id/payment", requireRole("shipper"), handle(async (req, res) => {
  const { phoneNumber, testOutcome, testForceReceipt, testDelayMs } = req.body || {};
  const { payment, booking } = await beginAdjustmentPayment(req.user, req.params.id, phoneNumber, req.id);

  let daraja;
  try {
    daraja = await stkPush({
      amount: payment.amount, phoneNumber: payment.phoneNumber, callbackUrl: callbackUrl("/api/payments/callback/stk"),
      accountReference: booking.id, testOutcome, testForceReceipt, testDelayMs,
    });
  } catch (err) {
    abortAdjustmentPayment(payment.id, "STK push could not be initiated", req.id);
    throw err;
  }

  await db.update(payments).set({
    merchantRequestId: daraja.merchantRequestId, checkoutRequestId: daraja.checkoutRequestId,
    status: "StkSent", updatedAt: new Date().toISOString(),
  }).where(eq(payments.id, payment.id));
  await logPaymentEvent("payment", payment.id, "stk_push_sent", "Pending", "StkSent", { daraja, adjustmentId: req.params.id }, req.id);
  const [updated] = await db.select().from(payments).where(eq(payments.id, payment.id));
  res.status(201).json(updated);
}));

export default router;

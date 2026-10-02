/**
 * backend/src/routes/offers.js
 * --------------------------------
 * Phase 5D-1 — /api/offers/*. Thin HTTP layer over services/offers.js; every
 * rule (authorization, state, amount, concurrency) lives in the service.
 * The loads-scoped endpoints (POST/GET /api/loads/:loadId/offers) are in
 * routes/loads.js and share offerErrorResponse below.
 */

import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  OfferError, counterOffer, acceptOffer, rejectOffer, withdrawOffer, listOffersInbox,
} from "../services/offers.js";

/** Runs an offer service call and maps OfferError to { error, code }; anything else bubbles to the 500 handler. */
export async function runOffer(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OfferError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return null;
    }
    throw err;
  }
}

export function sendOfferResult(res, result) {
  if (result.replay) res.set("Idempotent-Replay", "true");
  res.status(result.status).json(result.booking && result.offer ? { offer: result.offer, booking: result.booking } : result.offer);
}

const router = Router();
router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const rows = await runOffer(res, () => listOffersInbox(req.user, { role: req.query.role, status: req.query.status }));
  if (rows) res.json({ offers: rows });
}));

router.post("/:id/counter", asyncHandler(async (req, res) => {
  const r = await runOffer(res, () => counterOffer(req.user, req.params.id, req.body, req.get("Idempotency-Key"), req.id));
  if (r) sendOfferResult(res, r);
}));

router.post("/:id/accept", asyncHandler(async (req, res) => {
  const r = await runOffer(res, () => acceptOffer(req.user, req.params.id, req.id));
  if (r) sendOfferResult(res, r);
}));

router.post("/:id/reject", asyncHandler(async (req, res) => {
  const r = await runOffer(res, () => rejectOffer(req.user, req.params.id, req.body, req.id));
  if (r) sendOfferResult(res, r);
}));

router.post("/:id/withdraw", asyncHandler(async (req, res) => {
  const r = await runOffer(res, () => withdrawOffer(req.user, req.params.id, req.id));
  if (r) sendOfferResult(res, r);
}));

export default router;

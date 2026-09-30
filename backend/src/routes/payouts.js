/**
 * backend/src/routes/payouts.js
 * ----------------------------------
 * Phase 4K — read-only endpoints for payouts. Creation happens inside
 * routes/escrows.js's POST /:escrowId/release (an escrow action, not a
 * payouts-collection action — see docs/4K-DARAJA-SPEC.md Section 6); the
 * callback lives in routes/darajaWebhooks.js, unauthenticated.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { payouts } from "../db/schema.js";
import { requireAuth } from "../auth/middleware.js";

const router = Router();
router.use(requireAuth);

/** Shipper has no legitimate reason to read a payout directly (Section 7). */
function canViewPayout(req, payout) {
  if (req.user.role === "admin") return true;
  if (req.user.role === "fleet_owner") return payout.transporterId === req.user.id;
  return false;
}

router.get("/:id", async (req, res) => {
  const [payout] = await db.select().from(payouts).where(eq(payouts.id, req.params.id));
  if (!payout) return res.status(404).json({ error: `No payout found with id ${req.params.id}.` });
  if (!canViewPayout(req, payout)) {
    return res.status(403).json({ error: "You are not authorized to view this payout." });
  }
  res.json(payout);
});

router.get("/", async (req, res) => {
  const { escrowId } = req.query;
  let rows = escrowId
    ? await db.select().from(payouts).where(eq(payouts.escrowId, escrowId))
    : await db.select().from(payouts);

  if (req.user.role === "fleet_owner") {
    rows = rows.filter(p => p.transporterId === req.user.id);
  } else if (req.user.role !== "admin") {
    rows = [];
  }
  res.json(rows);
});

export default router;

/**
 * backend/src/routes/fleet.js
 * ------------------------------
 * Phase 4H — read-only truck/driver listing, needed by the booking
 * assignment step (a transporter must see their own trucks to pick one).
 * Fleet assignment itself (which driver is currently on which truck)
 * stays a frontend/fleetService.js concern, same boundary 4F/4G drew —
 * this just exposes the backend's own (seeded) snapshot of that data for
 * the booking flow to read.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { trucks, drivers } from "../db/schema.js";
import { requireAuth } from "../auth/middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
router.use(requireAuth);

/**
 * GET /api/trucks?ownerId=
 * Phase 4I: a transporter has no legitimate reason to browse another
 * transporter's fleet — unlike loads, there's no marketplace case for it.
 * A fleet_owner's query is always forced to their own fleetOwnerId,
 * regardless of what they pass; a mismatched explicit request is rejected
 * outright so it's visibly a permissions error, not silently ignored.
 */
router.get("/trucks", asyncHandler(async (req, res) => {
  const { ownerId } = req.query;

  if (req.user.role === "fleet_owner") {
    if (ownerId && ownerId !== req.user.fleetOwnerId) {
      return res.status(403).json({ error: "Transporters may only list their own fleet." });
    }
    const rows = await db.select().from(trucks).where(eq(trucks.ownerId, req.user.fleetOwnerId));
    return res.json(rows);
  }

  const rows = ownerId
    ? await db.select().from(trucks).where(eq(trucks.ownerId, ownerId))
    : await db.select().from(trucks);
  res.json(rows);
}));

/** GET /api/drivers */
router.get("/drivers", asyncHandler(async (_req, res) => {
  res.json(await db.select().from(drivers));
}));

export default router;

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

const router = Router();
router.use(requireAuth);

/** GET /api/trucks?ownerId= */
router.get("/trucks", async (req, res) => {
  const { ownerId } = req.query;
  const rows = ownerId
    ? await db.select().from(trucks).where(eq(trucks.ownerId, ownerId))
    : await db.select().from(trucks);
  res.json(rows);
});

/** GET /api/drivers */
router.get("/drivers", async (_req, res) => {
  res.json(await db.select().from(drivers));
});

export default router;

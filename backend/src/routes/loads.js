/**
 * backend/src/routes/loads.js
 * ------------------------------
 * Phase 4H. See backend/src/domain/load.js for why this is a new, simpler
 * entity rather than a backend mirror of the frontend's models/load.js.
 */

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { loads, bookings } from "../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { createLoad, LOAD_STATUS } from "../domain/load.js";
import { createBooking } from "../domain/booking.js";

const router = Router();
router.use(requireAuth);

/** POST /api/loads — a shipper posts a new load. */
router.post("/", requireRole("shipper"), async (req, res) => {
  const { cargo, origin, destination, weight, truckType, price, pickupDate } = req.body || {};
  if (!cargo || !origin || !destination) {
    return res.status(400).json({ error: "cargo, origin and destination are required." });
  }

  const count = (await db.select().from(loads)).length;
  const load = createLoad({ shipperId: req.user.id, cargo, origin, destination, weight, truckType, price, pickupDate }, count);
  await db.insert(loads).values(load);
  res.status(201).json(load);
});

/** GET /api/loads?status=&shipperId= — the marketplace listing. Any authenticated role may read. */
router.get("/", async (req, res) => {
  const { status, shipperId } = req.query;
  const conditions = [];
  if (status)    conditions.push(eq(loads.status, status));
  if (shipperId) conditions.push(eq(loads.shipperId, shipperId));

  const rows = conditions.length
    ? await db.select().from(loads).where(and(...conditions))
    : await db.select().from(loads);
  res.json(rows);
});

router.get("/:loadId", async (req, res) => {
  const [load] = await db.select().from(loads).where(eq(loads.id, req.params.loadId));
  if (!load) return res.status(404).json({ error: `No load found with id ${req.params.loadId}.` });
  res.json(load);
});

/**
 * POST /api/loads/:loadId/accept — "this transporter has accepted this
 * load." Creates a Booking; does NOT touch truck/driver (see
 * bookings.js's /assign) and does NOT create a Trip (see /create-trip).
 */
router.post("/:loadId/accept", requireRole("fleet_owner"), async (req, res) => {
  const [load] = await db.select().from(loads).where(eq(loads.id, req.params.loadId));
  if (!load) return res.status(404).json({ error: `No load found with id ${req.params.loadId}.` });
  if (load.status !== LOAD_STATUS.OPEN) {
    return res.status(409).json({ error: `Load ${load.id} is not open (status: ${load.status}).` });
  }

  const count = (await db.select().from(bookings)).length;
  const booking = createBooking({ loadId: load.id, transporterId: req.user.id }, count);
  await db.insert(bookings).values(booking);
  await db.update(loads).set({ status: LOAD_STATUS.BOOKED, updatedAt: new Date().toISOString() }).where(eq(loads.id, load.id));

  res.status(201).json(booking);
});

export default router;

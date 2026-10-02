/**
 * backend/src/routes/loads.js
 * ------------------------------
 * Phase 4H. See backend/src/domain/load.js for why this is a new, simpler
 * entity rather than a backend mirror of the frontend's models/load.js.
 */

import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../db/client.js";
import { loads, bookings } from "../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { createLoad, parsePlace, LOAD_STATUS } from "../domain/load.js";
import { createBooking } from "../domain/booking.js";
import { NOTIFICATION_TYPE } from "../domain/notification.js";
import { notifyUsers, allTransporterUserIds } from "../services/notifications.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
router.use(requireAuth);

/** POST /api/loads — a shipper posts a new load. */
router.post("/", requireRole("shipper"), asyncHandler(async (req, res) => {
  const { cargo, origin, destination, weight, truckType, price, pickupDate, pickup, delivery } = req.body || {};
  if (!cargo || !origin || !destination) {
    return res.status(400).json({ error: "cargo, origin and destination are required." });
  }
  const pickupParsed = parsePlace(pickup, "pickup");
  if (!pickupParsed.ok) return res.status(400).json({ error: pickupParsed.error });
  const deliveryParsed = parsePlace(delivery, "delivery");
  if (!deliveryParsed.ok) return res.status(400).json({ error: deliveryParsed.error });

  const count = (await db.select().from(loads)).length;
  const load = createLoad({ shipperId: req.user.id, cargo, origin, destination, weight, truckType, price, pickupDate, pickupPlace: pickupParsed.place, deliveryPlace: deliveryParsed.place }, count);
  await db.insert(loads).values(load);

  // Phase 4L — marketplace-wide, not targeted: there's no backend matching
  // engine yet to decide which transporter this load is actually relevant
  // to (see the frontend-only matching plan, unbuilt on this backend).
  const transporterIds = await allTransporterUserIds();
  await notifyUsers(
    transporterIds, NOTIFICATION_TYPE.LOAD_POSTED,
    "New load posted",
    `${load.cargo}: ${load.origin} → ${load.destination}`,
    "load", load.id
  );

  res.status(201).json(load);
}));

/**
 * GET /api/loads?status=&shipperId= — the marketplace listing.
 *
 * Authorization (4I): a shipper may only ever see their OWN loads —
 * "browsing the marketplace" isn't a shipper's job, they post loads, they
 * don't shop for them. A shipper passing someone else's shipperId is
 * rejected rather than silently overridden, so the client can tell the
 * difference between "no results" and "not allowed to ask." Transporters,
 * drivers and admin keep full marketplace visibility — that's the whole
 * point of a marketplace for them.
 */
router.get("/", asyncHandler(async (req, res) => {
  const { status, shipperId } = req.query;

  if (req.user.role === "shipper") {
    if (shipperId && shipperId !== req.user.id) {
      return res.status(403).json({ error: "Shippers may only list their own loads." });
    }
  }
  const effectiveShipperId = req.user.role === "shipper" ? req.user.id : shipperId;

  const conditions = [];
  if (status)             conditions.push(eq(loads.status, status));
  if (effectiveShipperId) conditions.push(eq(loads.shipperId, effectiveShipperId));

  // Newest first (5C-1); id is a tiebreaker for loads created in the same instant.
  const rows = conditions.length
    ? await db.select().from(loads).where(and(...conditions)).orderBy(desc(loads.createdAt), desc(loads.id))
    : await db.select().from(loads).orderBy(desc(loads.createdAt), desc(loads.id));
  res.json(rows);
}));

/**
 * A shipper may view any of their own loads regardless of status. Any
 * other role may view any load — a transporter needs to see a load's full
 * detail to decide whether to accept it, and that's still true after
 * another transporter has already booked it (they should see it left the
 * marketplace, not get a 403 for looking).
 */
router.get("/:loadId", asyncHandler(async (req, res) => {
  const [load] = await db.select().from(loads).where(eq(loads.id, req.params.loadId));
  if (!load) return res.status(404).json({ error: `No load found with id ${req.params.loadId}.` });
  if (req.user.role === "shipper" && load.shipperId !== req.user.id) {
    return res.status(403).json({ error: "This load does not belong to the authenticated shipper." });
  }
  res.json(load);
}));

/**
 * POST /api/loads/:loadId/accept — "this transporter has accepted this
 * load." Creates a Booking; does NOT touch truck/driver (see
 * bookings.js's /assign) and does NOT create a Trip (see /create-trip).
 *
 * Phase 4M — the `load.status !== OPEN` check above is a fast application-
 * level rejection, not the real guard against two transporters accepting
 * the same load at the same instant (the same check-then-act race pattern
 * as 4K's release endpoint). The real guard is `bookings.loadId UNIQUE`
 * (db/schema.js) — the database rejects the second concurrent INSERT
 * outright; the route catches that and returns 409.
 */
router.post("/:loadId/accept", requireRole("fleet_owner"), asyncHandler(async (req, res) => {
  const [load] = await db.select().from(loads).where(eq(loads.id, req.params.loadId));
  if (!load) return res.status(404).json({ error: `No load found with id ${req.params.loadId}.` });
  if (load.status !== LOAD_STATUS.OPEN) {
    return res.status(409).json({ error: `Load ${load.id} is not open (status: ${load.status}).` });
  }

  const count = (await db.select().from(bookings)).length;
  const booking = createBooking({ loadId: load.id, transporterId: req.user.id }, count);
  try {
    await db.insert(bookings).values(booking);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: `Load ${load.id} was just accepted by another transporter.` });
    }
    throw err;
  }
  await db.update(loads).set({ status: LOAD_STATUS.BOOKED, updatedAt: new Date().toISOString() }).where(eq(loads.id, load.id));

  res.status(201).json(booking);
}));

export default router;

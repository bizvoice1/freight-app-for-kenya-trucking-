/**
 * backend/src/routes/trips.js
 * ------------------------------
 * Phase 4F's core endpoints: trip lookup, location ingest/read, and
 * tracking start/stop. The identity rule this whole phase is built around
 * lives in one place — _assertOwnsTrip below — not scattered per-route.
 *
 * Trip CREATION is deliberately not here: there's no POST /api/trips in
 * this phase's scope (see db/seed.js's note) — that stays tripService.js's
 * job on the frontend until a later phase migrates booking/assignment too.
 *
 * Phase 4G adds exactly one thing: GET /api/trips (list, filterable) — the
 * Shipper portal needs "find my trip by loadId", the Admin portal needs
 * "list every active trip", and both are the same query with different
 * filters. Not a new GPS system, just the read side 4F was missing.
 */

import { Router } from "express";
import { eq, asc, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { trips, locationUpdates } from "../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import {
  createLocationUpdate,
  validateLocationReading,
  ACTIVE_TRIP_STATUSES,
} from "../../../src/models/trip.js";

const router = Router();
router.use(requireAuth);

async function getTripOr404(req, res) {
  const [trip] = await db.select().from(trips).where(eq(trips.id, req.params.tripId));
  if (!trip) {
    res.status(404).json({ error: `No trip found with id ${req.params.tripId}.` });
    return null;
  }
  return trip;
}

/**
 * THE identity check the whole phase is about: does the AUTHENTICATED
 * caller (req.user, resolved from a verified JWT — never from the request
 * body) actually own this trip as its driver? A request can claim whatever
 * it wants in its body; only this comparison decides.
 */
function ownsTrip(req, trip) {
  return req.user.role === "driver" && req.user.driverId === trip.driverId;
}

/**
 * GET /api/trips?loadId=&truckId=&driverId=&status=
 * Any authenticated role may read. No filters -> every trip. This is
 * intentionally open (any role sees any trip) — per-shipper/per-owner
 * ownership scoping is a Phase 4H concern once loads/bookings themselves
 * live on the backend; today nothing on the backend knows which shipper a
 * load belongs to.
 */
router.get("/", async (req, res) => {
  const { loadId, truckId, driverId, status } = req.query;
  const conditions = [];
  if (loadId)   conditions.push(eq(trips.loadId, loadId));
  if (truckId)  conditions.push(eq(trips.truckId, truckId));
  if (driverId) conditions.push(eq(trips.driverId, driverId));
  if (status)   conditions.push(eq(trips.status, status));

  const rows = conditions.length
    ? await db.select().from(trips).where(and(...conditions))
    : await db.select().from(trips);

  res.json(rows);
});

/* GET /api/trips/:tripId — any authenticated role may read */
router.get("/:tripId", async (req, res) => {
  const trip = await getTripOr404(req, res);
  if (!trip) return;
  res.json(trip);
});

/* POST /api/trips/:tripId/tracking/start */
router.post("/:tripId/tracking/start", requireRole("driver"), async (req, res) => {
  const trip = await getTripOr404(req, res);
  if (!trip) return;
  if (!ownsTrip(req, trip)) {
    return res.status(403).json({ error: "This trip is not assigned to the authenticated driver." });
  }
  if (!ACTIVE_TRIP_STATUSES.has(trip.status)) {
    return res.status(409).json({ error: `Trip ${trip.id} is not active (status: ${trip.status}).` });
  }
  res.json({ started: true });
});

/* POST /api/trips/:tripId/tracking/stop */
router.post("/:tripId/tracking/stop", requireRole("driver"), async (req, res) => {
  const trip = await getTripOr404(req, res);
  if (!trip) return;
  if (!ownsTrip(req, trip)) {
    return res.status(403).json({ error: "This trip is not assigned to the authenticated driver." });
  }
  res.json({ stopped: true });
});

/**
 * POST /api/trips/:tripId/location
 * body: { lat, lng, accuracy?, speed?, heading?, deviceTimestamp? }
 *
 * truckId/driverId are NEVER read from the body — they come from the Trip
 * row itself (truckId) and req.user (driverId), exactly mirroring the
 * frontend's trackingService.js design from Phase 4E. This is the same
 * rule enforced at the real trust boundary instead of just in a browser.
 */
router.post("/:tripId/location", requireRole("driver"), async (req, res) => {
  const trip = await getTripOr404(req, res);
  if (!trip) return;
  if (!ownsTrip(req, trip)) {
    return res.status(403).json({ error: "This trip is not assigned to the authenticated driver." });
  }

  const { lat, lng, accuracy, speed = 0, heading = 0, deviceTimestamp } = req.body || {};

  const rejection = validateLocationReading({ lat, lng, accuracy, deviceTimestamp }, await _latestLocation(trip.id));
  if (rejection) {
    return res.status(422).json({ accepted: false, reason: rejection });
  }

  const existingCount = await _countLocationUpdates(trip.id);
  const update = createLocationUpdate(
    { tripId: trip.id, truckId: trip.truckId, driverId: trip.driverId, lat, lng, accuracy, speed, heading, source: "device" },
    existingCount
  );

  await db.insert(locationUpdates).values(update);
  await db.update(trips).set({ latestLocationId: update.id, updatedAt: new Date().toISOString() }).where(eq(trips.id, trip.id));

  res.json({ accepted: true, update });
});

/* GET /api/trips/:tripId/location/latest */
router.get("/:tripId/location/latest", async (req, res) => {
  const trip = await getTripOr404(req, res);
  if (!trip) return;
  const location = await _latestLocation(trip.id);
  res.json(location || null);
});

/* GET /api/trips/:tripId/location/history — chronological, isolated to this trip */
router.get("/:tripId/location/history", async (req, res) => {
  const trip = await getTripOr404(req, res);
  if (!trip) return;
  const history = await db
    .select()
    .from(locationUpdates)
    .where(eq(locationUpdates.tripId, trip.id))
    .orderBy(asc(locationUpdates.timestamp));
  res.json(history);
});

async function _countLocationUpdates(tripId) {
  const rows = await db.select().from(locationUpdates).where(eq(locationUpdates.tripId, tripId));
  return rows.length;
}

async function _latestLocation(tripId) {
  const rows = await db
    .select()
    .from(locationUpdates)
    .where(eq(locationUpdates.tripId, tripId))
    .orderBy(asc(locationUpdates.timestamp));
  return rows.length ? rows[rows.length - 1] : null;
}

export default router;

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
 *
 * Phase 4J adds POST /:tripId/status — the backend becomes authoritative
 * for trip lifecycle transitions instead of the frontend's localStorage
 * tripService.updateTripStatus() being the only place that ever changed
 * one. Structural validity (no skipping stages, no post-terminal changes)
 * reuses models/trip.js's canTransitionTrip() unchanged — that function
 * already existed and is correct; this phase's actual job is deciding WHO
 * gets to request which specific transition, which is a new question
 * canTransitionTrip was never meant to answer.
 */

import { Router } from "express";
import { eq, asc, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { trips, locationUpdates, loads, trucks, drivers, bookings, escrows } from "../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import {
  createLocationUpdate,
  validateLocationReading,
  canTransitionTrip,
  TRIP_STATUS,
  TERMINAL_TRIP_STATUSES,
  ACTIVE_TRIP_STATUSES,
} from "../../../src/models/trip.js";
import { TRUCK_STATUS } from "../../../src/models/truck.js";
import { DRIVER_STATUS } from "../../../src/models/driver.js";
import { ESCROW_STATUS, evaluateReleaseEligibility } from "../domain/escrow.js";
import { logPaymentEvent } from "../services/ledger.js";
import { NOTIFICATION_TYPE } from "../domain/notification.js";
import { notifyUser, notifyUsers, allAdminUserIds } from "../services/notifications.js";

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
 * Phase 4I — whether the authenticated caller may VIEW (not drive) a trip.
 * GPS location is exactly the kind of data "authenticated" must not imply
 * "authorized" for: a driver's own movements shouldn't be visible to a
 * stranger just because they too have a valid token.
 *   driver     — only their own trip (same rule as ownsTrip, for reads too)
 *   fleet_owner — only a trip whose truck they own
 *   shipper    — only a trip whose load they posted
 *   admin      — everything
 */
async function canViewTrip(req, trip) {
  if (req.user.role === "admin") return true;
  if (req.user.role === "driver") return req.user.driverId === trip.driverId;
  if (req.user.role === "fleet_owner") {
    const [truck] = await db.select().from(trucks).where(eq(trucks.id, trip.truckId));
    return !!truck && truck.ownerId === req.user.fleetOwnerId;
  }
  if (req.user.role === "shipper") {
    if (!trip.loadId) return false;
    const [load] = await db.select().from(loads).where(eq(loads.id, trip.loadId));
    return !!load && load.shipperId === req.user.id;
  }
  return false;
}

/** The truckIds/loadIds this caller is allowed to see trips for — used to scope the list endpoint. */
async function _visibleTripsFilter(req) {
  if (req.user.role === "admin") return null; // no restriction
  if (req.user.role === "driver") return { field: "driverId", values: [req.user.driverId] };
  if (req.user.role === "fleet_owner") {
    const owned = await db.select().from(trucks).where(eq(trucks.ownerId, req.user.fleetOwnerId));
    return { field: "truckId", values: owned.map(t => t.id) };
  }
  if (req.user.role === "shipper") {
    const own = await db.select().from(loads).where(eq(loads.shipperId, req.user.id));
    return { field: "loadId", values: own.map(l => l.id) };
  }
  return { field: null, values: [] };
}

/**
 * Phase 4J — the operational transitions a DRIVER may request themselves.
 * Deliberately a fixed set of "from->to" pairs, not "any forward move" —
 * canTransitionTrip() already guarantees sequencing is legal; this decides
 * whether a driver (as opposed to a transporter/shipper/admin) is the
 * right actor for that specific step.
 */
const DRIVER_TRANSITIONS = new Set([
  `${TRIP_STATUS.ASSIGNED}->${TRIP_STATUS.DISPATCHED}`,
  `${TRIP_STATUS.DISPATCHED}->${TRIP_STATUS.AT_PICKUP}`,
  `${TRIP_STATUS.AT_PICKUP}->${TRIP_STATUS.LOADING}`,
  `${TRIP_STATUS.LOADING}->${TRIP_STATUS.IN_TRANSIT}`,
  `${TRIP_STATUS.IN_TRANSIT}->${TRIP_STATUS.AT_DELIVERY}`,
  `${TRIP_STATUS.AT_DELIVERY}->${TRIP_STATUS.DELIVERED}`,
]);
const SHIPPER_CONFIRM_DELIVERY = `${TRIP_STATUS.AT_DELIVERY}->${TRIP_STATUS.DELIVERED}`;

/**
 * Phase 4J — decides WHO may request a given trip-status transition. This
 * is deliberately separate from canTransitionTrip(): that function answers
 * "is Assigned -> Dispatched ever a legal move" (structure); this answers
 * "is the person asking allowed to make THIS move on THIS trip" (identity +
 * role). Both must pass.
 *
 *   driver      — only their own trip; only the fixed operational sequence
 *                 above (no cancelling — that's a transporter/admin action)
 *   fleet_owner — only a trip on a truck they own; only Cancelled (an
 *                 "operational exception", not a normal advance — a desk
 *                 click should never substitute for the driver's own report
 *                 of reaching a stage)
 *   shipper     — only a trip on a load they posted; only confirming
 *                 delivery (At Delivery -> Delivered) — "should generally
 *                 not arbitrarily change the driver's operational status"
 *   admin       — any trip, any structurally-valid transition (a
 *                 "controlled override": still gated by canTransitionTrip,
 *                 just not by per-trip ownership)
 *
 * @returns {Promise<{ok:true}|{ok:false, code:number, error:string}>}
 */
async function authorizeTransition(req, trip, nextStatus) {
  const key = `${trip.status}->${nextStatus}`;

  if (req.user.role === "admin") return { ok: true };

  if (req.user.role === "driver") {
    if (req.user.driverId !== trip.driverId) {
      return { ok: false, code: 403, error: "This trip is not assigned to the authenticated driver." };
    }
    if (!DRIVER_TRANSITIONS.has(key)) {
      return { ok: false, code: 403, error: `Drivers may not perform the ${trip.status} -> ${nextStatus} transition.` };
    }
    return { ok: true };
  }

  if (req.user.role === "fleet_owner") {
    const [truck] = await db.select().from(trucks).where(eq(trucks.id, trip.truckId));
    if (!truck || truck.ownerId !== req.user.fleetOwnerId) {
      return { ok: false, code: 403, error: "This trip does not use a truck belonging to the authenticated transporter." };
    }
    if (nextStatus !== TRIP_STATUS.CANCELLED) {
      return { ok: false, code: 403, error: "Transporters may only cancel a trip, not advance its status." };
    }
    return { ok: true };
  }

  if (req.user.role === "shipper") {
    if (!trip.loadId) return { ok: false, code: 403, error: "This trip has no associated load." };
    const [load] = await db.select().from(loads).where(eq(loads.id, trip.loadId));
    if (!load || load.shipperId !== req.user.id) {
      return { ok: false, code: 403, error: "This trip is not for a load belonging to the authenticated shipper." };
    }
    if (key !== SHIPPER_CONFIRM_DELIVERY) {
      return { ok: false, code: 403, error: "Shippers may only confirm delivery (At Delivery -> Delivered)." };
    }
    return { ok: true };
  }

  return { ok: false, code: 403, error: "This role may not update trip status." };
}

/** Mirrors tripService.js's _releaseFleetAssignment on the frontend — frees the truck+driver once a trip ends. */
async function releaseFleetAssignment(truckId) {
  const [truck] = await db.select().from(trucks).where(eq(trucks.id, truckId));
  if (!truck || !truck.currentDriverId) return;
  const driverId = truck.currentDriverId;
  await db.update(trucks).set({ currentDriverId: null, status: TRUCK_STATUS.AVAILABLE }).where(eq(trucks.id, truckId));
  await db.update(drivers).set({ assignedTruckId: null, status: DRIVER_STATUS.AVAILABLE }).where(eq(drivers.id, driverId));
}

/**
 * Phase 4K-D (docs/4K-DARAJA-SPEC.md Section 5) — the moment a trip reaches
 * Delivered, check whether its escrow may move to RELEASE_PENDING. This is
 * ONLY a status flip + audit log if eligible; it never touches Daraja. No
 * booking (a trip without one) or no escrow (payment never completed) are
 * both legitimate "not eligible" outcomes, not errors.
 */
async function maybeMakeEscrowEligibleForRelease(trip) {
  if (!trip.bookingId) return;
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, trip.bookingId));
  if (!booking) return;
  const [escrow] = await db.select().from(escrows).where(eq(escrows.bookingId, booking.id));
  const [load] = booking.loadId ? await db.select().from(loads).where(eq(loads.id, booking.loadId)) : [null];

  const decision = evaluateReleaseEligibility({ trip, booking, escrow: escrow || null, loadPrice: load?.price ?? null });
  if (!decision.eligible) return;

  const now = new Date().toISOString();
  await db.update(escrows).set({ status: ESCROW_STATUS.RELEASE_PENDING, releasePendingAt: now, updatedAt: now }).where(eq(escrows.id, escrow.id));
  await logPaymentEvent("escrow", escrow.id, "status_changed", ESCROW_STATUS.HELD, ESCROW_STATUS.RELEASE_PENDING, { tripId: trip.id });

  await notifyUser(booking.transporterId, NOTIFICATION_TYPE.RELEASE_PENDING,
    "Delivery confirmed — payout pending", `Escrow ${escrow.id} for booking ${booking.id} is ready for release.`,
    "escrow", escrow.id);
  const adminIds = await allAdminUserIds();
  await notifyUsers(adminIds, NOTIFICATION_TYPE.RELEASE_PENDING,
    "Escrow ready for release", `Escrow ${escrow.id} (booking ${booking.id}) is awaiting admin release.`,
    "escrow", escrow.id);
}

/** Phase 4L — notifies the load's shipper and the booking's transporter of every trip status change. */
async function notifyTripStatusChanged(trip, nextStatus) {
  const [load] = trip.loadId ? await db.select().from(loads).where(eq(loads.id, trip.loadId)) : [null];
  const [booking] = trip.bookingId ? await db.select().from(bookings).where(eq(bookings.id, trip.bookingId)) : [null];
  const recipients = [load?.shipperId, booking?.transporterId].filter(Boolean);
  if (!recipients.length) return;
  await notifyUsers(recipients, NOTIFICATION_TYPE.TRIP_STATUS,
    `Trip ${trip.id}: ${nextStatus}`, `Trip ${trip.id} is now ${nextStatus}.`,
    "trip", trip.id);
}

/**
 * POST /api/trips/:tripId/status
 * body: { status }
 *
 * Order matters: authorize WHO before validating WHETHER. A driver trying
 * an illegal transition on someone else's trip should get 403 (not
 * authorized), not 409 (invalid transition) — the ownership question is
 * more fundamental than the sequencing question.
 */
router.post("/:tripId/status", async (req, res) => {
  const trip = await getTripOr404(req, res);
  if (!trip) return;

  const { status: nextStatus } = req.body || {};
  if (!nextStatus) return res.status(400).json({ error: "status is required." });

  const auth = await authorizeTransition(req, trip, nextStatus);
  if (!auth.ok) return res.status(auth.code).json({ error: auth.error });

  if (!canTransitionTrip(trip.status, nextStatus)) {
    return res.status(409).json({ error: `Cannot move trip ${trip.id} from ${trip.status} to ${nextStatus}.` });
  }

  const now = new Date().toISOString();
  const updates = { status: nextStatus, updatedAt: now };
  if (nextStatus === TRIP_STATUS.DISPATCHED && !trip.startedAt) updates.startedAt = now;
  if (TERMINAL_TRIP_STATUSES.has(nextStatus)) updates.completedAt = now;

  await db.update(trips).set(updates).where(eq(trips.id, trip.id));
  if (TERMINAL_TRIP_STATUSES.has(nextStatus)) await releaseFleetAssignment(trip.truckId);
  if (nextStatus === TRIP_STATUS.DELIVERED) await maybeMakeEscrowEligibleForRelease({ ...trip, ...updates });
  await notifyTripStatusChanged(trip, nextStatus);

  const [updated] = await db.select().from(trips).where(eq(trips.id, trip.id));
  res.json(updated);
});

/**
 * GET /api/trips?loadId=&truckId=&driverId=&status=
 * Scoped per role (see _visibleTripsFilter) before the query filters are
 * even applied — a driver passing a different driverId, or a transporter
 * passing a truckId they don't own, simply narrows an already-empty set
 * rather than leaking someone else's trip.
 */
router.get("/", async (req, res) => {
  const { loadId, truckId, driverId, status } = req.query;

  const scope = await _visibleTripsFilter(req);
  if (scope && scope.field && (
    (scope.field === "driverId" && driverId && !scope.values.includes(driverId)) ||
    (scope.field === "truckId"  && truckId  && !scope.values.includes(truckId)) ||
    (scope.field === "loadId"   && loadId   && !scope.values.includes(loadId))
  )) {
    return res.status(403).json({ error: "You may only list trips you're authorized to see." });
  }

  const conditions = [];
  if (loadId)   conditions.push(eq(trips.loadId, loadId));
  if (truckId)  conditions.push(eq(trips.truckId, truckId));
  if (driverId) conditions.push(eq(trips.driverId, driverId));
  if (status)   conditions.push(eq(trips.status, status));

  let rows = conditions.length
    ? await db.select().from(trips).where(and(...conditions))
    : await db.select().from(trips);

  if (scope) {
    rows = scope.field ? rows.filter(t => scope.values.includes(t[scope.field])) : [];
  }

  res.json(rows);
});

/* GET /api/trips/:tripId — scoped to what this caller may view (see canViewTrip) */
router.get("/:tripId", async (req, res) => {
  const trip = await getTripOr404(req, res);
  if (!trip) return;
  if (!(await canViewTrip(req, trip))) {
    return res.status(403).json({ error: "You are not authorized to view this trip." });
  }
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

/* GET /api/trips/:tripId/location/latest — scoped to what this caller may view */
router.get("/:tripId/location/latest", async (req, res) => {
  const trip = await getTripOr404(req, res);
  if (!trip) return;
  if (!(await canViewTrip(req, trip))) {
    return res.status(403).json({ error: "You are not authorized to view this trip's location." });
  }
  const location = await _latestLocation(trip.id);
  res.json(location || null);
});

/* GET /api/trips/:tripId/location/history — chronological, isolated to this trip, scoped to what this caller may view */
router.get("/:tripId/location/history", async (req, res) => {
  const trip = await getTripOr404(req, res);
  if (!trip) return;
  if (!(await canViewTrip(req, trip))) {
    return res.status(403).json({ error: "You are not authorized to view this trip's location." });
  }
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

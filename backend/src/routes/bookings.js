/**
 * backend/src/routes/bookings.js
 * ----------------------------------
 * Phase 4H — the two actions that move a Booking from "accepted" to
 * "executing": assigning a truck+driver, then creating the Trip. Trip
 * creation here reuses models/trip.js's createTrip() and the same
 * invariants tripService.js's createTripFromBooking() already enforces on
 * the frontend (truck/driver still paired, no active trip already using
 * this truck/driver/load) — one rule, checked against whichever store is
 * authoritative for the caller.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../db/client.js";
import { bookings, loads, trucks, drivers, trips, payments } from "../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { BOOKING_STATUS } from "../domain/booking.js";
import { createTrip as buildTrip, ACTIVE_TRIP_STATUSES } from "../../../src/models/trip.js";
import { createPayment, NON_TERMINAL_PAYMENT_STATUSES } from "../domain/payment.js";
import { logPaymentEvent } from "../services/ledger.js";
import { withPaymentSummaries, isBookingFunded, isCanonicalKenyanMobile, expireStalePayments, notifyExpired } from "../services/bookingPayment.js";
import { stkPush, callbackUrl } from "../services/daraja.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ROAD_DISTANCE_REQUIRED } from "../services/loadRoute.js";
import { AdjustmentError, requestAdjustment, listAdjustmentsFor, getBookingLedgerFor } from "../services/adjustments.js";

const router = Router();
router.use(requireAuth);

async function getBookingOr404(req, res) {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, req.params.bookingId));
  if (!booking) {
    res.status(404).json({ error: `No booking found with id ${req.params.bookingId}.` });
    return null;
  }
  return booking;
}

function ownsBooking(req, booking) {
  return req.user.role === "fleet_owner" && req.user.id === booking.transporterId;
}

/**
 * Phase 4I — whether the authenticated caller may VIEW this booking.
 *   fleet_owner — only their own bookings (they made them)
 *   shipper     — only bookings against a load they posted
 *   admin       — everything
 *   driver      — no legitimate reason to read a booking directly
 */
async function canViewBooking(req, booking) {
  if (req.user.role === "admin") return true;
  if (req.user.role === "fleet_owner") return req.user.id === booking.transporterId;
  if (req.user.role === "shipper") {
    const [load] = await db.select().from(loads).where(eq(loads.id, booking.loadId));
    return !!load && load.shipperId === req.user.id;
  }
  return false;
}

router.get("/", asyncHandler(async (req, res) => {
  const { transporterId, loadId, status } = req.query;

  if (req.user.role === "fleet_owner" && transporterId && transporterId !== req.user.id) {
    return res.status(403).json({ error: "Transporters may only list their own bookings." });
  }

  let rows = await db.select().from(bookings);
  if (transporterId) rows = rows.filter(b => b.transporterId === transporterId);
  if (loadId)        rows = rows.filter(b => b.loadId === loadId);
  if (status)        rows = rows.filter(b => b.status === status);

  if (req.user.role === "fleet_owner") {
    rows = rows.filter(b => b.transporterId === req.user.id);
  } else if (req.user.role === "shipper") {
    const ownLoads = await db.select().from(loads).where(eq(loads.shipperId, req.user.id));
    const ownLoadIds = new Set(ownLoads.map(l => l.id));
    rows = rows.filter(b => ownLoadIds.has(b.loadId));
  } else if (req.user.role !== "admin") {
    rows = [];
  }

  res.json(await withPaymentSummaries(rows));
}));

router.get("/:bookingId", asyncHandler(async (req, res) => {
  const booking = await getBookingOr404(req, res);
  if (!booking) return;
  if (!(await canViewBooking(req, booking))) {
    return res.status(403).json({ error: "You are not authorized to view this booking." });
  }
  res.json((await withPaymentSummaries([booking]))[0]);
}));

/**
 * POST /api/bookings/:bookingId/assign
 * body: { truckId, driverId }
 * Only the transporter who owns this booking may assign to it. The truck
 * must currently have that exact driver (trucks.currentDriverId) — the
 * same invariant fleetService.assignDriverToTruck enforces on the
 * frontend, checked here against the backend's own snapshot of that data.
 */
router.post("/:bookingId/assign", requireRole("fleet_owner"), asyncHandler(async (req, res) => {
  const booking = await getBookingOr404(req, res);
  if (!booking) return;
  if (!ownsBooking(req, booking)) {
    return res.status(403).json({ error: "This booking does not belong to the authenticated transporter." });
  }
  if (booking.status !== BOOKING_STATUS.ACCEPTED && booking.status !== BOOKING_STATUS.ASSIGNED) {
    return res.status(409).json({ error: `Booking ${booking.id} is not awaiting assignment (status: ${booking.status}).` });
  }

  const { truckId, driverId } = req.body || {};
  const [truck]  = await db.select().from(trucks).where(eq(trucks.id, truckId));
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, driverId));
  if (!truck)  return res.status(404).json({ error: `No truck found with id ${truckId}.` });
  if (!driver) return res.status(404).json({ error: `No driver found with id ${driverId}.` });
  if (req.user.fleetOwnerId && truck.ownerId !== req.user.fleetOwnerId) {
    return res.status(403).json({ error: `Truck ${truck.plate} does not belong to this transporter.` });
  }
  if (req.user.fleetOwnerId && driver.fleetOwnerId !== req.user.fleetOwnerId) {
    return res.status(403).json({ error: `Driver ${driver.name} does not belong to this transporter.` });
  }
  if (truck.currentDriverId !== driverId) {
    return res.status(409).json({ error: `${driver.name} is not currently assigned to truck ${truck.plate}.` });
  }

  const now = new Date().toISOString();
  await db.update(bookings).set({ truckId, driverId, status: BOOKING_STATUS.ASSIGNED, updatedAt: now }).where(eq(bookings.id, booking.id));
  const [updated] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
  res.json(updated);
}));

/**
 * POST /api/bookings/:bookingId/create-trip
 * The final step: Booking -> Trip. Same invariants as tripService.js's
 * createTripFromBooking() on the frontend — truck/driver still paired, and
 * neither the truck, the driver, nor the load already has an active trip.
 *
 * Phase 4M — same check-then-act race as /accept: two concurrent create-trip
 * calls for the same booking could both pass the `status === ASSIGNED` check
 * before either inserts. The real guard is `trips.bookingId UNIQUE`
 * (db/schema.js); the second concurrent INSERT is rejected by the database,
 * caught below, and returned as 409 rather than creating a duplicate trip.
 */
router.post("/:bookingId/create-trip", requireRole("fleet_owner"), asyncHandler(async (req, res) => {
  const booking = await getBookingOr404(req, res);
  if (!booking) return;
  if (!ownsBooking(req, booking)) {
    return res.status(403).json({ error: "This booking does not belong to the authenticated transporter." });
  }
  if (booking.status !== BOOKING_STATUS.ASSIGNED) {
    return res.status(409).json({ error: `Booking ${booking.id} has no truck/driver assigned yet (status: ${booking.status}).` });
  }

  const [load] = await db.select().from(loads).where(eq(loads.id, booking.loadId));
  if (!load) return res.status(404).json({ error: `No load found with id ${booking.loadId}.` });

  const [truck]  = await db.select().from(trucks).where(eq(trucks.id, booking.truckId));
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, booking.driverId));
  if (!truck || !driver) return res.status(409).json({ error: "Assigned truck or driver no longer exists." });
  if (truck.currentDriverId !== booking.driverId) {
    return res.status(409).json({ error: `${driver.name} is no longer assigned to truck ${truck.plate}. Re-assign before creating the trip.` });
  }

  if (!(await isBookingFunded(booking.id))) {
    return res.status(409).json({ error: `Booking ${booking.id} is not funded. The shipper must fund it (escrow held) before the trip can be created.`, code: "PAYMENT_REQUIRED" });
  }

  const existingTrips = await db.select().from(trips);
  const hasActive = (field, value) => existingTrips.some(t => t[field] === value && ACTIVE_TRIP_STATUSES.has(t.status));
  if (hasActive("truckId", truck.id))        return res.status(409).json({ error: `Truck ${truck.plate} already has an active trip.` });
  if (hasActive("driverId", driver.id))      return res.status(409).json({ error: `${driver.name} already has an active trip.` });
  if (hasActive("loadId", load.id))          return res.status(409).json({ error: `Load ${load.id} already has an active trip.` });

  const trip = buildTrip(
    { loadId: load.id, bookingId: booking.id, truckId: truck.id, driverId: driver.id, pickup: load.origin, delivery: load.destination },
    existingTrips.length
  );
  try {
    await db.insert(trips).values(trip);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: `Booking ${booking.id} already has a trip (concurrent request detected).` });
    }
    throw err;
  }

  const now = new Date().toISOString();
  await db.update(bookings).set({ tripId: trip.id, status: BOOKING_STATUS.TRIP_CREATED, updatedAt: now }).where(eq(bookings.id, booking.id));

  res.status(201).json(trip);
}));

/**
 * POST /api/bookings/:bookingId/payment
 * body: { phoneNumber }
 *
 * Phase 4K-B (docs/4K-DARAJA-SPEC.md Section 3). amount is NEVER read from
 * the request body — it is the booking's agreedAmount (5D-1), computed here,
 * server-side, before Daraja is ever called (non-negotiable #2). Rejecting
 * a second attempt while a non-terminal one exists is idempotency layer #1
 * of Section 2.5's five ("STK request duplicated").
 *
 * Phase 4M — the "existingForBooking" check below is the same fast,
 * insufficient-alone guard as /accept and /create-trip: two rapid POSTs
 * could both pass it before either inserts. The real guard is the partial
 * unique index `payments_one_inflight_per_booking` (db/schema.js) — the
 * database rejects a second concurrent Pending/StkSent row for the same
 * booking outright.
 */
router.post("/:bookingId/payment", requireRole("shipper"), asyncHandler(async (req, res) => {
  const booking = await getBookingOr404(req, res);
  if (!booking) return;

  const [load] = await db.select().from(loads).where(eq(loads.id, booking.loadId));
  if (!load) return res.status(404).json({ error: `No load found with id ${booking.loadId}.` });
  if (load.shipperId !== req.user.id) {
    return res.status(403).json({ error: "This booking is not for a load belonging to the authenticated shipper." });
  }
  if (!(booking.agreedRoadDistanceMeters > 0)) {
    return res.status(ROAD_DISTANCE_REQUIRED.status).json(ROAD_DISTANCE_REQUIRED.body);
  }
  // 5D-1: the amount owed is the booking's agreedAmount (snapshotted at accept), never the load's mutable price.
  if (typeof booking.agreedAmount !== "number") {
    return res.status(409).json({ error: `Booking ${booking.id} has no agreed amount — cannot initiate payment.`, code: "NO_AGREED_AMOUNT" });
  }

  const { phoneNumber, testOutcome, testForceReceipt, testDelayMs } = req.body || {};
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber is required." });
  if (!isCanonicalKenyanMobile(phoneNumber)) {
    return res.status(400).json({ error: "phoneNumber must be a Kenyan mobile number in the form 2547XXXXXXXX or 2541XXXXXXXX.", code: "INVALID_PHONE" });
  }

  // A stale in-flight attempt must not block a retry: expire it first (this is a POST, so mutation is fine).
  await notifyExpired(expireStalePayments({ bookingId: booking.id, requestId: req.id }));

  const existingForBooking = await db.select().from(payments).where(eq(payments.bookingId, booking.id));
  if (existingForBooking.some(p => NON_TERMINAL_PAYMENT_STATUSES.has(p.status))) {
    return res.status(409).json({ error: `A payment is already in progress for booking ${booking.id}.` });
  }

  const count = (await db.select().from(payments)).length;
  const payment = createPayment({ bookingId: booking.id, shipperId: req.user.id, amount: booking.agreedAmount, phoneNumber }, count);
  try {
    await db.insert(payments).values(payment);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: `A payment is already in progress for booking ${booking.id} (concurrent request detected).` });
    }
    throw err;
  }

  const daraja = await stkPush({
    amount: payment.amount,
    phoneNumber: payment.phoneNumber,
    callbackUrl: callbackUrl("/api/payments/callback/stk"),
    accountReference: booking.id,
    testOutcome, testForceReceipt, testDelayMs,
  });

  const now = new Date().toISOString();
  await db.update(payments).set({
    merchantRequestId: daraja.merchantRequestId,
    checkoutRequestId: daraja.checkoutRequestId,
    status: "StkSent",
    updatedAt: now,
  }).where(eq(payments.id, payment.id));
  await logPaymentEvent("payment", payment.id, "stk_push_sent", "Pending", "StkSent", { daraja }, req.id);

  const [updated] = await db.select().from(payments).where(eq(payments.id, payment.id));
  res.status(201).json(updated);
}));

/** Phase 5D-2 — adjustments & ledger, booking-scoped. Authorization lives in services/adjustments.js. */
function adjustmentRoute(fn) {
  return asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof AdjustmentError) return res.status(err.status).json({ error: err.message, code: err.code });
      throw err;
    }
  });
}

router.post("/:bookingId/adjustments", adjustmentRoute(async (req, res) => {
  res.status(201).json(await requestAdjustment(req.user, req.params.bookingId, req.body, req.id));
}));

router.get("/:bookingId/adjustments", adjustmentRoute(async (req, res) => {
  res.json(await listAdjustmentsFor(req.user, req.params.bookingId));
}));

router.get("/:bookingId/ledger", adjustmentRoute(async (req, res) => {
  res.json(await getBookingLedgerFor(req.user, req.params.bookingId));
}));

export default router;

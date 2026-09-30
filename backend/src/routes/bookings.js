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
import { db } from "../db/client.js";
import { bookings, loads, trucks, drivers, trips } from "../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { BOOKING_STATUS } from "../domain/booking.js";
import { createTrip as buildTrip, ACTIVE_TRIP_STATUSES } from "../../../src/models/trip.js";

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

router.get("/", async (req, res) => {
  const { transporterId, loadId, status } = req.query;
  let rows = await db.select().from(bookings);
  if (transporterId) rows = rows.filter(b => b.transporterId === transporterId);
  if (loadId)        rows = rows.filter(b => b.loadId === loadId);
  if (status)        rows = rows.filter(b => b.status === status);
  res.json(rows);
});

router.get("/:bookingId", async (req, res) => {
  const booking = await getBookingOr404(req, res);
  if (!booking) return;
  res.json(booking);
});

/**
 * POST /api/bookings/:bookingId/assign
 * body: { truckId, driverId }
 * Only the transporter who owns this booking may assign to it. The truck
 * must currently have that exact driver (trucks.currentDriverId) — the
 * same invariant fleetService.assignDriverToTruck enforces on the
 * frontend, checked here against the backend's own snapshot of that data.
 */
router.post("/:bookingId/assign", requireRole("fleet_owner"), async (req, res) => {
  const booking = await getBookingOr404(req, res);
  if (!booking) return;
  if (!ownsBooking(req, booking)) {
    return res.status(403).json({ error: "This booking does not belong to the authenticated transporter." });
  }
  if (booking.status !== BOOKING_STATUS.ACCEPTED) {
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
  if (truck.currentDriverId !== driverId) {
    return res.status(409).json({ error: `${driver.name} is not currently assigned to truck ${truck.plate}.` });
  }

  const now = new Date().toISOString();
  await db.update(bookings).set({ truckId, driverId, status: BOOKING_STATUS.ASSIGNED, updatedAt: now }).where(eq(bookings.id, booking.id));
  const [updated] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
  res.json(updated);
});

/**
 * POST /api/bookings/:bookingId/create-trip
 * The final step: Booking -> Trip. Same invariants as tripService.js's
 * createTripFromBooking() on the frontend — truck/driver still paired, and
 * neither the truck, the driver, nor the load already has an active trip.
 */
router.post("/:bookingId/create-trip", requireRole("fleet_owner"), async (req, res) => {
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

  const existingTrips = await db.select().from(trips);
  const hasActive = (field, value) => existingTrips.some(t => t[field] === value && ACTIVE_TRIP_STATUSES.has(t.status));
  if (hasActive("truckId", truck.id))        return res.status(409).json({ error: `Truck ${truck.plate} already has an active trip.` });
  if (hasActive("driverId", driver.id))      return res.status(409).json({ error: `${driver.name} already has an active trip.` });
  if (hasActive("loadId", load.id))          return res.status(409).json({ error: `Load ${load.id} already has an active trip.` });

  const trip = buildTrip(
    { loadId: load.id, bookingId: booking.id, truckId: truck.id, driverId: driver.id, pickup: load.origin, delivery: load.destination },
    existingTrips.length
  );
  await db.insert(trips).values(trip);

  const now = new Date().toISOString();
  await db.update(bookings).set({ tripId: trip.id, status: BOOKING_STATUS.TRIP_CREATED, updatedAt: now }).where(eq(bookings.id, booking.id));

  res.status(201).json(trip);
});

export default router;

/**
 * src/services/tripService.js
 * -----------------------------
 * The Trip Execution Engine (Phase 4C) — mirrors the established service
 * contract (loadService.js, matchingService.js, fleetService.js): every
 * exported function returns a Promise, the module holds an in-memory store
 * persisted to localStorage, zero React imports.
 *
 * ARCHITECTURE NOTE — what this service owns and what it deliberately does
 * not:
 *
 *   tripService turns an accepted booking into an executable Trip by
 *   pulling together three things that each live in their own service:
 *     - the booking/load context        (passed in by the caller — see below)
 *     - the current Truck ↔ Driver pair (read from fleetService.js)
 *     - this service's own Trip records (created and owned here)
 *
 *   It does NOT import loadService.js. There is no formal "Booking" entity
 *   anywhere in the codebase yet — a booking today is the notification
 *   object created by models/load.js's createBookingNotification(), plus
 *   the Load's own status. Rather than reach into loadService's store to
 *   reconstruct that (which would couple this new, still-additive layer to
 *   the frozen load architecture), the caller passes in a small `booking`
 *   descriptor — `{ id, loadId, status }` — exactly the same independence
 *   pattern matchingService.js already uses for cargo pools. This also
 *   satisfies "creating a trip must not directly rewrite the canonical load
 *   record": tripService has no write path into loadService at all.
 *
 *   It DOES import fleetService.js (read-only: getTruckById/getDriverById).
 *   That dependency is intentional and one-directional — a Trip's entire
 *   reason for existing is to bind a specific Truck+Driver pair to a load,
 *   so tripService sits directly on top of fleetService, the same way
 *   loadService sits at the top of the load-side stack. tripService never
 *   calls assignDriverToTruck()/unassignDriverFromTruck() except to FREE a
 *   truck/driver when a trip reaches a terminal state (see
 *   _releaseFleetAssignment below) — it never creates or edits assignments.
 *
 *   It creates NO GPS/location data. latestLocationId stays null until
 *   Phase 4D wires in gpsService.js.
 */

import {
  createTrip as buildTrip,
  TRIP_STATUS,
  ACTIVE_TRIP_STATUSES,
  TERMINAL_TRIP_STATUSES,
  canTransitionTrip,
} from "../models/trip.js";
import { getTruckById, getDriverById, unassignDriverFromTruck } from "./fleetService.js";

const STORE_KEY = "behari_trip_v1";

const _store = {
  trips: [],
};

function _persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(_store)); } catch { /* ignore */ }
}

function _hydrate() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.trips) _store.trips = saved.trips;
  } catch { /* corrupted storage — start fresh */ }
}
_hydrate();

/* ── Internal helpers ───────────────────────────────────────────────────── */

function _findTrip(tripId) {
  return _store.trips.find(t => t.id === tripId) || null;
}

function _hasActiveTrip(field, value) {
  return _store.trips.some(t => t[field] === value && ACTIVE_TRIP_STATUSES.has(t.status));
}

/** Frees the truck/driver back to Available once a trip ends — the truck's
 *  *current* assignment, not the trip's permanent record, which is untouched. */
function _releaseFleetAssignment(truckId) {
  unassignDriverFromTruck(truckId).catch(() => { /* truck may already be unassigned/gone — non-fatal */ });
}

/* ── READ operations ────────────────────────────────────────────────────── */

export function getTrips() {
  return Promise.resolve([..._store.trips]);
}

export function getTripById(tripId) {
  return Promise.resolve(_findTrip(tripId));
}

/* ── Trip creation ──────────────────────────────────────────────────────── */

/**
 * Creates a Trip from an accepted booking, binding it to a specific
 * Truck + Driver pair. All invariant checks happen before any store
 * mutation — either the trip is created whole, or nothing changes.
 *
 * @param {Object} params
 * @param {Object} params.booking    - { id, loadId, status } — caller-supplied
 *                                     booking descriptor (see file header)
 * @param {string} params.truckId
 * @param {string} params.driverId
 * @param {string} [params.pickup]   - denormalised pickup label
 * @param {string} [params.delivery] - denormalised delivery label
 * @returns {Promise<Object>} the created Trip
 */
export function createTripFromBooking({ booking, truckId, driverId, pickup, delivery }) {
  if (!booking || !booking.id || !booking.loadId) {
    return Promise.reject(new Error("A valid booking is required to create a trip."));
  }
  if (booking.status !== "Accepted") {
    return Promise.reject(new Error(`Booking is not eligible for execution (load status: ${booking.status}).`));
  }

  return Promise.all([getTruckById(truckId), getDriverById(driverId)]).then(([truck, driver]) => {
    if (!truck)  throw new Error(`No truck found with id ${truckId}.`);
    if (!driver) throw new Error(`No driver found with id ${driverId}.`);

    if (truck.currentDriverId !== driverId) {
      throw new Error(`${driver.name} is not currently assigned to truck ${truck.plate}.`);
    }
    if (_hasActiveTrip("truckId", truckId)) {
      throw new Error(`Truck ${truck.plate} already has an active trip.`);
    }
    if (_hasActiveTrip("driverId", driverId)) {
      throw new Error(`${driver.name} already has an active trip.`);
    }
    if (_hasActiveTrip("loadId", booking.loadId)) {
      throw new Error(`Load ${booking.loadId} already has an active trip.`);
    }

    const trip = buildTrip(
      { loadId: booking.loadId, bookingId: booking.id, truckId, driverId, pickup, delivery },
      _store.trips.length
    );
    _store.trips = [..._store.trips, trip];
    _persist();
    return { ...trip };
  });
}

/* ── Trip lifecycle ─────────────────────────────────────────────────────── */

/**
 * Moves a Trip to `nextStatus`, enforcing the legal transition graph
 * (models/trip.js's canTransitionTrip): the next happy-path stage, or
 * Cancelled from any active state. Any other jump is rejected.
 *
 * Reaching a terminal state (Delivered/Cancelled) frees the trip's truck
 * and driver back to Available via fleetService — the trip's own
 * truckId/driverId fields are never touched by this.
 *
 * @param {string} tripId
 * @param {string} nextStatus - a TRIP_STATUS value
 * @returns {Promise<Object>} the updated Trip
 */
export function updateTripStatus(tripId, nextStatus) {
  const trip = _findTrip(tripId);
  if (!trip) return Promise.reject(new Error(`No trip found with id ${tripId}.`));

  if (!canTransitionTrip(trip.status, nextStatus)) {
    return Promise.reject(new Error(`Cannot move trip ${tripId} from ${trip.status} to ${nextStatus}.`));
  }

  const now = new Date().toISOString();
  trip.status    = nextStatus;
  trip.updatedAt = now;
  if (nextStatus === TRIP_STATUS.DISPATCHED && !trip.startedAt) trip.startedAt = now;
  if (TERMINAL_TRIP_STATUSES.has(nextStatus)) {
    trip.completedAt = now;
    _releaseFleetAssignment(trip.truckId);
  }

  _persist();
  return Promise.resolve({ ...trip });
}

/**
 * Convenience wrapper over updateTripStatus for the common "abandon this
 * trip" action — same rejection rules (only legal from an active state).
 */
export function cancelTrip(tripId) {
  return updateTripStatus(tripId, TRIP_STATUS.CANCELLED);
}

/**
 * src/models/trip.js
 * ------------------
 * Domain model for a Trip — the record that binds a Load (booking) to the
 * specific Truck + Driver executing it, and for the LocationUpdate events
 * that report where that Truck is while the trip is active.
 *
 * ARCHITECTURE NOTE:
 *   A Trip is created when a booking happens: it is the thing that attaches
 *   truckId + driverId to a loadId. Everything downstream — location
 *   updates, shipper/admin tracking views — reads through the Trip, never
 *   through the Fleet Owner. That is the key design decision this model
 *   encodes: a LocationUpdate belongs to a Trip (and, denormalised, its
 *   Truck), not to whichever phone happens to be logged in as the owner.
 *
 *   This file has its own status lifecycle, separate from LOAD_STATUS in
 *   models/load.js. A Load's status is about the commercial/escrow state
 *   (Escrow Held, Paid Out, ...); a Trip's status is about the physical
 *   movement of a specific truck+driver pair, and one Load could in
 *   principle be re-attempted with a new Trip if the first one falls
 *   through — keeping them separate avoids overloading one enum with two
 *   different lifecycles, the same reasoning models/load.js used to keep
 *   ESCROW_STATUS separate from LOAD_STATUS.
 *
 *   Zero React imports — plain JS, same rule as models/load.js.
 */

/* ── Trip status values ─────────────────────────────────────────────────── */

/**
 * All valid Trip status strings, in lifecycle order.
 *
 * Flow (happy path):
 *   ASSIGNED → DISPATCHED → AT_PICKUP → LOADING → IN_TRANSIT
 *     → AT_DELIVERY → DELIVERED
 *
 * Branching:
 *   Any active state → CANCELLED
 */
export const TRIP_STATUS = {
  ASSIGNED:    "Assigned",     // truckId + driverId attached; not yet moving
  DISPATCHED:  "Dispatched",   // driver has started toward pickup
  AT_PICKUP:   "At Pickup",    // truck has reached the pickup point
  LOADING:     "Loading",      // cargo being loaded
  IN_TRANSIT:  "In Transit",   // en route to delivery
  AT_DELIVERY: "At Delivery",  // truck has reached the delivery point
  DELIVERED:   "Delivered",    // trip complete; truck becomes available again
  CANCELLED:   "Cancelled",    // trip abandoned before completion
};

/**
 * Trip statuses that count as "the truck is in active use" — once a trip
 * leaves this set (DELIVERED or CANCELLED), its truck and driver should be
 * freed back to TRUCK_STATUS.AVAILABLE / DRIVER_STATUS.AVAILABLE.
 */
export const ACTIVE_TRIP_STATUSES = new Set([
  TRIP_STATUS.ASSIGNED,
  TRIP_STATUS.DISPATCHED,
  TRIP_STATUS.AT_PICKUP,
  TRIP_STATUS.LOADING,
  TRIP_STATUS.IN_TRANSIT,
  TRIP_STATUS.AT_DELIVERY,
]);

/* ── Status transitions ─────────────────────────────────────────────────── */

/**
 * The happy-path order. Used to compute the single legal "next" status —
 * a trip cannot skip stages (e.g. Assigned straight to In Transit).
 */
const TRIP_STATUS_SEQUENCE = [
  TRIP_STATUS.ASSIGNED,
  TRIP_STATUS.DISPATCHED,
  TRIP_STATUS.AT_PICKUP,
  TRIP_STATUS.LOADING,
  TRIP_STATUS.IN_TRANSIT,
  TRIP_STATUS.AT_DELIVERY,
  TRIP_STATUS.DELIVERED,
];

/**
 * Trip statuses that are terminal — once reached, no further transition
 * (including re-cancellation) is legal.
 */
export const TERMINAL_TRIP_STATUSES = new Set([TRIP_STATUS.DELIVERED, TRIP_STATUS.CANCELLED]);

/**
 * Returns the single next status in the happy-path sequence, or null if
 * `status` is unknown or already the last stage (Delivered).
 */
export function getNextTripStatus(status) {
  const i = TRIP_STATUS_SEQUENCE.indexOf(status);
  if (i === -1 || i === TRIP_STATUS_SEQUENCE.length - 1) return null;
  return TRIP_STATUS_SEQUENCE[i + 1];
}

/**
 * Whether `from` → `to` is a legal Trip status transition: either the next
 * step in the happy-path sequence, or Cancelled from any active (non-
 * terminal) state. No other jump — forward or backward — is legal.
 */
export function canTransitionTrip(from, to) {
  if (TERMINAL_TRIP_STATUSES.has(from)) return false;
  if (to === TRIP_STATUS.CANCELLED) return ACTIVE_TRIP_STATUSES.has(from);
  return getNextTripStatus(from) === to;
}

/* ── ID generation ──────────────────────────────────────────────────────── */

/**
 * Business rule: Trip IDs are prefixed TRP- and increment.
 * @param {number} existingCount - how many trips already exist
 */
export function generateTripId(existingCount) {
  return `TRP-${1000 + existingCount}`;
}

/* ── Factory: Trip ───────────────────────────────────────────────────────── */

/**
 * Creates a normalised Trip object — the record binding a booked Load to
 * the Truck + Driver executing it.
 *
 * truckId/driverId are copied in at creation time and never mutated again by
 * this model — they are the trip's permanent execution identity. Whatever
 * fleetService.js later does with Truck.currentDriverId (e.g. a different
 * driver takes over the same truck next week) has no bearing on a trip
 * that has already been created; only tripService's own store, keyed by
 * these two fields as they were at creation, is authoritative for history.
 *
 * @param {Object} data
 * @param {string} data.loadId     - the Load this trip fulfils
 * @param {string} data.bookingId  - the booking (notification id) that authorized this trip
 * @param {string} data.truckId    - Truck assigned to this trip (permanent)
 * @param {string} data.driverId   - Driver assigned to this trip (permanent)
 * @param {string} [data.pickup]   - pickup location label, denormalised from the Load
 * @param {string} [data.delivery] - delivery location label, denormalised from the Load
 * @param {number} existingCount   - existing trip count (for ID)
 * @returns {Object}
 */
export function createTrip({ loadId, bookingId, truckId, driverId, pickup, delivery }, existingCount) {
  const now = new Date().toISOString();
  return {
    id:               generateTripId(existingCount),
    loadId:           loadId    || null,
    bookingId:        bookingId || null,
    truckId:          truckId   || null,
    driverId:         driverId  || null,
    status:           TRIP_STATUS.ASSIGNED,
    pickup:           pickup   || "",
    delivery:         delivery || "",
    startedAt:        null,   // set when status first reaches DISPATCHED
    completedAt:      null,   // set when status reaches DELIVERED or CANCELLED
    latestLocationId: null,   // set by Phase 4D/4E — no GPS data at creation
    createdAt:        now,
    updatedAt:        now,
  };
}

/**
 * Business rule: LocationUpdate IDs are prefixed LOC- and increment.
 * @param {number} existingCount - how many location updates already exist
 */
export function generateLocationUpdateId(existingCount) {
  return `LOC-${1000 + existingCount}`;
}

/**
 * Creates a normalised LocationUpdate event.
 *
 * WHY tripId, truckId AND driverId are all stored: a LocationUpdate is
 * reported by a physical truck (source of truth: the device on that
 * vehicle, driven by whoever is at the wheel that day), but is only
 * meaningful in the context of whatever Trip it's currently executing —
 * carrying all three lets Admin query "everywhere this truck has ever been"
 * (by truckId), "everywhere this driver has ever driven" (by driverId), and
 * the Shipper/Admin trip-tracking views query "this trip's path so far" (by
 * tripId), all without a join. Once written, a LocationUpdate's truckId/
 * driverId are historical fact — see models/trip.js's own truckId/driverId
 * fields for why that permanence matters (fleetService.js's current
 * assignment can drift after the fact; old records must not).
 *
 * source distinguishes how the position was obtained: "simulation" (Phase
 * 4D, services/gpsService.js) vs "device" (Phase 4E, the driver's own phone)
 * — everything downstream of this shape (history, latestLocation, tracking
 * UI) is identical either way, by design.
 *
 * @param {Object} data
 * @param {string} data.tripId     - Trip this update belongs to
 * @param {string} data.truckId    - Truck reporting the position
 * @param {string} data.driverId   - Driver operating the truck at the time
 * @param {number} data.lat
 * @param {number} data.lng
 * @param {number} [data.accuracy] - simulated/reported GPS accuracy, metres
 * @param {number} [data.speed]    - km/h
 * @param {number} [data.heading]  - degrees, 0-359 (0 = north)
 * @param {string} [data.source]   - "simulation" | "device"
 * @param {number} existingCount   - existing location-update count (for ID)
 * @returns {Object}
 */
export function createLocationUpdate(
  { tripId, truckId, driverId, lat, lng, accuracy = 15, speed = 0, heading = 0, source = "simulation" },
  existingCount
) {
  return {
    id: generateLocationUpdateId(existingCount),
    tripId,
    truckId,
    driverId,
    lat,
    lng,
    accuracy,
    speed,
    heading,
    source,
    timestamp: new Date().toISOString(),
  };
}

/**
 * src/models/truck.js
 * -------------------
 * Domain model for a Truck — a persistent vehicle identity owned by a
 * Fleet Owner, independent of whichever Driver or Trip is currently using it.
 *
 * ARCHITECTURE NOTE:
 *   This is the key correction over the old data/fleet.js seed shape
 *   (id, plate, type, year, status — no owner, no driver, no location):
 *   a Truck now carries its own persistent id, its owning Fleet Owner, and
 *   its current location, and is assigned a Driver *per trip* rather than
 *   having a driver baked into the truck record. A fleet owner with 10
 *   trucks needs 10 independently-trackable Truck records, each of which
 *   can be paired with a different Driver on a different day.
 *
 *   data/fleet.js (CARRIER_FLEET_SEED) is left untouched by Phase 4A — this
 *   file defines the shape and factory only. Reconciling/extending that seed
 *   data with ownerId + capacity + location fields is Phase 4B's job (the
 *   assignment engine), not this one — same "verify before you touch seed
 *   data" discipline used in the load-unification work.
 *
 *   Zero React imports — plain JS, same rule as models/load.js.
 */

/* ── Truck status values ────────────────────────────────────────────────── */

/**
 * A Truck's own availability state — separate from any Trip's status.
 * A truck is "Available" whenever it has no active trip, regardless of
 * whether a Driver happens to be assigned to it at the moment.
 */
export const TRUCK_STATUS = {
  AVAILABLE:   "Available",    // idle, can be assigned to a new trip
  ASSIGNED:    "Assigned",     // a driver + trip are set but trip hasn't dispatched yet
  ON_TRIP:     "On Trip",      // actively executing a trip
  MAINTENANCE: "Maintenance",  // taken out of service
};

/* ── ID generation ──────────────────────────────────────────────────────── */

/**
 * Business rule: Truck IDs are prefixed TRK- and increment.
 * @param {number} existingCount - how many trucks already exist
 */
export function generateTruckId(existingCount) {
  return `TRK-${1000 + existingCount}`;
}

/* ── Factory ─────────────────────────────────────────────────────────────── */

/**
 * Creates a normalised Truck object.
 *
 * @param {Object} data
 * @param {string} data.plate            - number plate, e.g. "KBD 092K"
 * @param {string} data.truckType        - e.g. "33-Tonne Flatbed"
 * @param {string} [data.capacity]       - e.g. "10T"
 * @param {string} data.ownerId          - owning FleetOwner id
 * @param {{lat:number,lng:number}} [data.currentLocation] - last known position
 * @param {string} [data.status]         - initial TRUCK_STATUS; defaults to Available
 * @param {number} existingCount         - existing truck count (for ID)
 * @returns {Object}
 */
export function createTruck(data, existingCount) {
  return {
    id:              generateTruckId(existingCount),
    plate:           data.plate     || "",
    truckType:       data.truckType || "",
    capacity:        data.capacity  || "",
    ownerId:         data.ownerId   || null,
    currentLocation: data.currentLocation || null,
    // Set by the assignment engine (services/fleetService.js) — the Driver
    // currently paired with this truck, independent of whether a trip is
    // underway. null whenever the truck has no driver assigned.
    currentDriverId: null,
    status:          data.status || TRUCK_STATUS.AVAILABLE,
  };
}

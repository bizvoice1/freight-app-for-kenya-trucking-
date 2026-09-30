/**
 * src/models/driver.js
 * --------------------
 * Domain model for a Driver — a person who may be assigned to operate a
 * Fleet Owner's Truck, distinct from the Fleet Owner and from the Truck
 * itself.
 *
 * ARCHITECTURE NOTE:
 *   A Driver is assigned to a Truck (assignedTruckId), not to a Fleet Owner
 *   directly — the owner relationship is reached by looking up the truck.
 *   This mirrors the real-world fact this model exists to capture: the
 *   owner of a truck and the person driving it are frequently different
 *   people, and that pairing can change from trip to trip.
 *
 *   Zero React imports — plain JS, same rule as models/load.js.
 */

/* ── Driver status values ───────────────────────────────────────────────── */

export const DRIVER_STATUS = {
  AVAILABLE: "Available",  // not currently assigned to an active trip
  ASSIGNED:  "Assigned",   // paired with a truck/trip, not yet dispatched
  ON_TRIP:   "On Trip",    // actively driving a trip
  OFF_DUTY:  "Off Duty",   // unavailable (rest, leave, etc.)
};

/* ── ID generation ──────────────────────────────────────────────────────── */

/**
 * Business rule: Driver IDs are prefixed DRV- and increment.
 * @param {number} existingCount - how many drivers already exist
 */
export function generateDriverId(existingCount) {
  return `DRV-${1000 + existingCount}`;
}

/* ── Factory ─────────────────────────────────────────────────────────────── */

/**
 * Creates a normalised Driver object.
 *
 * @param {Object} data
 * @param {string} data.name             - driver's full name
 * @param {string} [data.phone]          - contact phone
 * @param {string} [data.licenseNumber]  - driving license number
 * @param {string} [data.assignedTruckId]- Truck id currently assigned, if any
 * @param {number} existingCount         - existing driver count (for ID)
 * @returns {Object}
 */
export function createDriver(data, existingCount) {
  return {
    id:              generateDriverId(existingCount),
    name:            data.name          || "",
    phone:           data.phone         || "",
    licenseNumber:   data.licenseNumber || "",
    assignedTruckId: data.assignedTruckId || null,
    status:          data.assignedTruckId ? DRIVER_STATUS.ASSIGNED : DRIVER_STATUS.AVAILABLE,
  };
}

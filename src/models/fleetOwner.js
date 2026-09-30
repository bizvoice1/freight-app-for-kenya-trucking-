/**
 * src/models/fleetOwner.js
 * ------------------------
 * Domain model for a Fleet Owner — the account that owns one or more Trucks.
 *
 * ARCHITECTURE NOTE:
 *   A Fleet Owner is NOT a tracking identity. It owns Trucks, and (indirectly,
 *   through Truck assignment) is associated with Drivers, but a trip's live
 *   location always belongs to the Truck/Trip, never to the owner's own
 *   device — see models/trip.js's LocationUpdate for why this distinction
 *   is load-bearing once a single owner runs more than one truck at once.
 *
 *   Today's demo has exactly one carrier ("James Mwangi", see App.jsx's
 *   MY_CARRIER_NAME) who is both the fleet owner and, incidentally, the only
 *   driver — so this model has no seed data or wiring yet (Phase 4A is the
 *   domain model only). Phase 4B introduces the fleet owner → truck → driver
 *   assignment engine and the seed data to exercise it.
 *
 *   Zero React imports — plain JS, same rule as models/load.js.
 */

/**
 * Business rule: Fleet Owner IDs are prefixed FO- and increment.
 * @param {number} existingCount - how many fleet owners already exist
 */
export function generateFleetOwnerId(existingCount) {
  return `FO-${1000 + existingCount}`;
}

/**
 * Creates a normalised FleetOwner object.
 *
 * @param {Object} data
 * @param {string} data.name        - owner's display name
 * @param {string} [data.phone]     - contact phone
 * @param {string} [data.company]   - registered company name, if any
 * @param {number} existingCount    - existing fleet owner count (for ID)
 * @returns {Object}
 */
export function createFleetOwner(data, existingCount) {
  return {
    id:      generateFleetOwnerId(existingCount),
    name:    data.name    || "",
    phone:   data.phone   || "",
    company: data.company || "",
  };
}

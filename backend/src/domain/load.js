/**
 * backend/src/domain/load.js
 * -----------------------------
 * Phase 4H's backend Load — deliberately NOT the frontend's models/load.js.
 * That file's LOAD_STATUS (Escrow Held -> Accepted -> ... -> Paid Out) is
 * the frozen demo model's full commercial lifecycle, including escrow —
 * this phase explicitly excludes escrow/payment, so importing it here
 * would either be unused ceremony or an invitation to wire up escrow
 * early by accident. This is a new, smaller entity for a new, smaller
 * phase; the two Load concepts get reconciled only if/when a later phase
 * decides the backend should become the frontend demo's data source too —
 * not assumed here.
 */

export const LOAD_STATUS = {
  OPEN:      "Open",      // posted, no transporter has accepted it yet
  BOOKED:    "Booked",    // a booking exists for this load
  CANCELLED: "Cancelled",
};

export function generateLoadId(existingCount) {
  return `BHL-${1000 + existingCount}`;
}

/**
 * @param {Object} data
 * @param {string} data.shipperId
 * @param {string} data.cargo
 * @param {string} data.origin
 * @param {string} data.destination
 * @param {string} [data.weight]
 * @param {string} [data.truckType]
 * @param {number} [data.price]
 * @param {string} [data.pickupDate]
 * @param {number} existingCount
 */
export function createLoad(data, existingCount) {
  const now = new Date().toISOString();
  return {
    id:          generateLoadId(existingCount),
    shipperId:   data.shipperId,
    cargo:       data.cargo,
    origin:      data.origin,
    destination: data.destination,
    weight:      data.weight || null,
    truckType:   data.truckType || null,
    price:       typeof data.price === "number" ? data.price : null,
    pickupDate:  data.pickupDate || null,
    status:      LOAD_STATUS.OPEN,
    createdAt:   now,
    updatedAt:   now,
  };
}

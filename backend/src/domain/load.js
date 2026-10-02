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
 * @param {{name?:string,placeId?:string,lat?:number,lng?:number}} [data.pickup]
 * @param {{name?:string,placeId?:string,lat?:number,lng?:number}} [data.delivery]
 * @param {number} existingCount
 */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Validates an optional {name, placeId, lat, lng} place. Returns
 * { ok:true, place } (place fields null when absent) or { ok:false, error }.
 * lat and lng must be supplied together and be in range.
 */
export function parsePlace(raw, label) {
  if (raw == null) return { ok: true, place: { name: null, placeId: null, lat: null, lng: null } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${label} must be an object.` };
  const hasLat = raw.lat != null, hasLng = raw.lng != null;
  if (hasLat !== hasLng) return { ok: false, error: `${label} needs both lat and lng, or neither.` };
  if (hasLat) {
    if (num(raw.lat) == null || num(raw.lng) == null || Math.abs(raw.lat) > 90 || Math.abs(raw.lng) > 180) {
      return { ok: false, error: `${label} lat/lng are out of range.` };
    }
  }
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  return { ok: true, place: { name: str(raw.name), placeId: str(raw.placeId), lat: num(raw.lat), lng: num(raw.lng) } };
}

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
    pickupName:      data.pickupPlace?.name || data.origin,
    pickupPlaceId:   data.pickupPlace?.placeId ?? null,
    pickupLat:       data.pickupPlace?.lat ?? null,
    pickupLng:       data.pickupPlace?.lng ?? null,
    deliveryName:    data.deliveryPlace?.name || data.destination,
    deliveryPlaceId: data.deliveryPlace?.placeId ?? null,
    deliveryLat:     data.deliveryPlace?.lat ?? null,
    deliveryLng:     data.deliveryPlace?.lng ?? null,
    distanceMeters: null, routePolyline: null, routeDurationSec: null, distanceSource: null, // 5C-3: filled once by services/loadRoute.js
    status:      LOAD_STATUS.OPEN,
    createdAt:   now,
    updatedAt:   now,
  };
}

/**
 * src/models/backendLoad.js
 * --------------------------
 * 5D-3 — pure helpers over backend commercial records. Nothing here reads
 * local load.pay or a rounded display distance: rates come from exact meters.
 */
import { metersToKm } from "./geo.js";

export const COMMERCIAL_NOTIFICATION_TYPES = new Set([
  "offer_received", "offer_countered", "offer_accepted", "offer_rejected", "booking_confirmed",
]);

/** agreedAmount ÷ (agreedRoadDistanceMeters / 1000), whole KSh/km. Null when it cannot be computed. */
export function agreedRatePerKm(amount, meters) {
  if (!(amount > 0) || !(meters > 0)) return null;
  return Math.round(amount / (meters / 1000));
}

export const ksh = (n) => `KSh ${Number(n).toLocaleString("en-US")}`;

/** Maps a backend load view into the shape the carrier portal cards already render. */
export function fromBackendLoad(v) {
  const road = v.distanceSource === "ROAD" && v.distanceMeters > 0;
  const exact = v.locationPrecision === "exact";
  const from = exact ? v.origin : (v.pickupArea || v.origin);
  const to = exact ? v.destination : (v.deliveryArea || v.destination);
  return {
    id: v.id, backendLoadId: v.id, isBackend: true, isDemo: false,
    status: v.status, shipperId: v.shipperId,
    cargo: v.cargo, from, to, weight: v.weight ?? "—", truck: v.truckType || "Any truck",
    pay: v.price ?? null, postedPrice: v.price ?? null,
    distanceMeters: road ? v.distanceMeters : null,
    dist: road ? metersToKm(v.distanceMeters) : 0, distSource: road ? "route" : "unresolved",
    rateKm: road && v.price > 0 ? Math.round(v.price / (v.distanceMeters / 1000)) : 0,
    pickD: v.pickupDate || "TBD", pickT: "", delD: "TBD", delT: "",
    shipper: "Verified shipper", rating: "—", facilRating: "—",
    createdAt: v.createdAt ? Date.parse(v.createdAt) : 0,
  };
}

/** Groups offer rows into threads: { [loadId]: [{ key, loadId, transporterId, transporterName, rows[], latest }] } */
export function groupOfferThreads(offers) {
  const byLoad = {};
  for (const o of offers) {
    const list = (byLoad[o.loadId] ||= []);
    let t = list.find(x => x.transporterId === o.transporterId);
    if (!t) { t = { key: `${o.loadId}:${o.transporterId}`, loadId: o.loadId, transporterId: o.transporterId, transporterName: o.transporterName, rows: [] }; list.push(t); }
    t.rows.push(o);
  }
  for (const list of Object.values(byLoad)) for (const t of list) { t.rows.sort((a, b) => a.round - b.round); t.latest = t.rows[t.rows.length - 1]; }
  return byLoad;
}

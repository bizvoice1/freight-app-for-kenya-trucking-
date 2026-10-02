/**
 * src/models/backendLoad.js
 * --------------------------
 * 5D-3 — pure helpers over backend commercial records. Nothing here reads
 * local load.pay or a rounded display distance: rates come from exact meters.
 */
import { metersToKm } from "./geo.js";

export const COMMERCIAL_NOTIFICATION_TYPES = new Set([
  "offer_received", "offer_countered", "offer_accepted", "offer_rejected", "booking_confirmed",
  "payment_confirmed", "payment_failed", "escrow_held",
  "adjustment_proposed", "adjustment_decided", "adjustment_funded",
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

/** Normalizes 07xx / 01xx / +254 / 254 input to canonical 254XXXXXXXXX; null when not a Kenyan mobile. The backend re-validates. */
export function normalizeKenyanPhone(input) {
  const d = String(input ?? "").replace(/[\s\-()]/g, "").replace(/^\+/, "");
  let n = null;
  if (/^0[17]\d{8}$/.test(d)) n = "254" + d.slice(1);
  else if (/^254[17]\d{8}$/.test(d)) n = d;
  return n;
}

/** Display state for a booking's backend payment summary. The UI keeps no payment state of its own. */
export function paymentView(payment) {
  const st = payment?.status ?? "None";
  if (st === "Paid" && payment.escrowStatus === "Held") return { key: "funded", label: "Payment confirmed · Escrow held" };
  if (st === "Paid") return { key: "paid", label: "Payment confirmed" };
  if (st === "StkSent" || st === "Pending") return { key: "awaiting", label: "Awaiting M-Pesa confirmation" };
  if (["Timeout", "Failed", "Cancelled"].includes(st)) return { key: "unsuccessful", label: "Payment unsuccessful" };
  return { key: "required", label: "Payment required" };
}

/** Display label for a backend adjustment status, per viewer. */
export function adjustmentStatusLabel(status, viewer) {
  switch (status) {
    case "PROPOSED":  return viewer === "shipper" ? "Awaiting your approval" : "Awaiting shipper approval";
    case "APPROVED":  return viewer === "shipper" ? "Approved — payment required" : "Approved — awaiting payment";
    case "FUNDING":   return "Funding — awaiting M-Pesa confirmation";
    case "FUNDED":    return "Funded";
    case "REJECTED":  return "Rejected";
    case "WITHDRAWN": return "Withdrawn";
    case "EXPIRED":   return "Expired";
    default:          return status;
  }
}

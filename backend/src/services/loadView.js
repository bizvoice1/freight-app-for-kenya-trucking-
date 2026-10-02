/**
 * backend/src/services/loadView.js
 * -----------------------------------
 * Phase 5C-3 — privacy at the API boundary. Exact addresses, place ids and
 * coordinates go only to the owning shipper, admin, and the transporter/driver
 * assigned by a booking. Everyone else gets approximate pins (snapped to a
 * ~2 km grid), area labels, and a route polyline with the ends trimmed off so
 * it cannot reveal the exact pickup/delivery point. The stored route and
 * distanceMeters stay exact; only this representation is coarsened.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { bookings } from "../db/schema.js";
import { decodePolyline, encodePolyline, haversineKm } from "./routeCodec.js";
import { metersToKm } from "./googleRoutes.js";

const GRID_DEG = 0.02;      // ~2.2 km
const TRIM_KM = 3;          // route ends hidden within this radius of each endpoint
const snap = (v) => (Number.isFinite(v) ? Math.round(Math.round(v / GRID_DEG) * GRID_DEG * 1e4) / 1e4 : null);

function coarsePolyline(load, pickup, delivery) {
  if (!load.routePolyline || !pickup || !delivery) return null;
  const exactA = { lat: load.pickupLat, lng: load.pickupLng };
  const exactB = { lat: load.deliveryLat, lng: load.deliveryLng };
  const pts = decodePolyline(load.routePolyline);
  let from = 0, to = pts.length - 1;
  while (from < to && haversineKm(pts[from], exactA) < TRIM_KM) from++;
  while (to > from && haversineKm(pts[to], exactB) < TRIM_KM) to--;
  const mid = pts.slice(from, to + 1);
  return encodePolyline([pickup, ...mid, delivery]);
}

const base = (load) => ({
  id: load.id, shipperId: load.shipperId, cargo: load.cargo, origin: load.origin, destination: load.destination,
  weight: load.weight, truckType: load.truckType, price: load.price, pickupDate: load.pickupDate,
  status: load.status, createdAt: load.createdAt, updatedAt: load.updatedAt,
  distanceMeters: load.distanceMeters, distanceKm: load.distanceMeters != null ? metersToKm(load.distanceMeters) : null,
  distanceSource: load.distanceSource === "ROAD" ? "ROAD" : null,
  routeDurationMin: load.routeDurationSec != null ? Math.round(load.routeDurationSec / 60) : null,
});

export function exactView(load) {
  const b = base(load);
  return { ...load, distanceKm: b.distanceKm, distanceSource: b.distanceSource, routeDurationMin: b.routeDurationMin, locationPrecision: "exact" };
}

export function approximateView(load) {
  const has = [load.pickupLat, load.pickupLng, load.deliveryLat, load.deliveryLng].every(Number.isFinite);
  const pickup   = has ? { lat: snap(load.pickupLat),   lng: snap(load.pickupLng) }   : null;
  const delivery = has ? { lat: snap(load.deliveryLat), lng: snap(load.deliveryLng) } : null;
  return {
    ...base(load),
    pickupArea: load.origin, deliveryArea: load.destination,
    pickupLat: pickup?.lat ?? null, pickupLng: pickup?.lng ?? null,
    deliveryLat: delivery?.lat ?? null, deliveryLng: delivery?.lng ?? null,
    routePolyline: coarsePolyline(load, pickup, delivery),
    locationPrecision: "approximate",
  };
}

/** Does this user get exact operational data for this load? */
export async function hasExactAccess(user, load) {
  if (user.role === "admin") return true;
  if (user.role === "shipper") return load.shipperId === user.id;
  if (user.role !== "fleet_owner" && user.role !== "driver") return false;
  const [b] = await db.select().from(bookings).where(eq(bookings.loadId, load.id));
  if (!b || b.status === "Cancelled") return false;
  return user.role === "fleet_owner" ? b.transporterId === user.id : Boolean(user.driverId) && b.driverId === user.driverId;
}

export async function viewLoadFor(user, load) {
  return (await hasExactAccess(user, load)) ? exactView(load) : approximateView(load);
}

export async function viewLoadsFor(user, rows) {
  if (user.role === "admin") return rows.map(exactView);
  if (user.role === "shipper") return rows.map(l => (l.shipperId === user.id ? exactView(l) : approximateView(l)));
  const all = await db.select().from(bookings);
  const byLoad = new Map(all.filter(b => b.status !== "Cancelled").map(b => [b.loadId, b]));
  return rows.map(l => {
    const b = byLoad.get(l.id);
    const mine = b && (user.role === "fleet_owner" ? b.transporterId === user.id : user.role === "driver" && Boolean(user.driverId) && b.driverId === user.driverId);
    return mine ? exactView(l) : approximateView(l);
  });
}

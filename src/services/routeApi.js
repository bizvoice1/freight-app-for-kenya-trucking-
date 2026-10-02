/**
 * src/services/routeApi.js
 * -------------------------
 * Phase 5C-2 — asks the Behari backend for the road route between two places.
 * Returns { routeKm, durationMin, polyline } or null on ANY failure (backend
 * down, key not configured, no route, rate limited) so the caller falls back to
 * the known-corridor distance already in models/geo.js.
 */
import { postJson } from "./trackingApi.js";

const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

export async function fetchRoadRoute(pickup, delivery) {
  if (!ok(pickup) || !ok(delivery)) return null;
  try {
    const { status, json } = await postJson("/api/geo/route", {
      origin:      { lat: pickup.lat,   lng: pickup.lng },
      destination: { lat: delivery.lat, lng: delivery.lng },
    });
    if (status !== 200 || !json || !Number.isFinite(json.distanceKm)) return null;
    return { routeKm: json.distanceKm, durationMin: json.durationMin, polyline: json.polyline || null };
  } catch {
    return null;
  }
}

/**
 * backend/src/services/loadRoute.js
 * ------------------------------------
 * Phase 5C-3 — the single place a load's road route is computed and persisted.
 * Pricing, KSh/km, maps and the booking snapshot all read the stored result;
 * nothing else calls the Routes provider for a load. Google always receives the
 * EXACT coordinates; coarsening (see loadView.js) applies only to what an
 * unassigned viewer is shown.
 */
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { loads } from "../db/schema.js";
import { computeRoadRoute } from "./googleRoutes.js";

const inflight = new Map(); // loadId -> Promise<load row>

const hasCoords = (l) => [l.pickupLat, l.pickupLng, l.deliveryLat, l.deliveryLng].every(Number.isFinite);

/** Returns the freshest load row; distanceMeters stays null if no real route could be had. */
export function ensureLoadRoute(load) {
  if (load.distanceMeters != null || !hasCoords(load)) return Promise.resolve(load);
  if (inflight.has(load.id)) return inflight.get(load.id);
  const p = (async () => {
    try {
      const r = await computeRoadRoute(
        { lat: load.pickupLat, lng: load.pickupLng },
        { lat: load.deliveryLat, lng: load.deliveryLng }
      );
      await db.update(loads).set({
        distanceMeters: r.distanceMeters, routePolyline: r.polyline,
        routeDurationSec: r.durationSec, distanceSource: "ROAD",
      }).where(and(eq(loads.id, load.id), isNull(loads.distanceMeters)));
    } catch (e) {
      if (!["ROUTES_UNCONFIGURED", "NO_ROUTE", "ROUTES_UPSTREAM"].includes(e.code)) throw e;
    }
    const [fresh] = await db.select().from(loads).where(eq(loads.id, load.id));
    return fresh;
  })().finally(() => inflight.delete(load.id));
  inflight.set(load.id, p);
  return p;
}

/** The commercial gate: a real stored road distance, or a 409 ROAD_DISTANCE_REQUIRED. */
export async function requireRoadDistance(load) {
  const fresh = await ensureLoadRoute(load);
  return fresh.distanceSource === "ROAD" && fresh.distanceMeters > 0 ? fresh : null;
}

export const ROAD_DISTANCE_REQUIRED = {
  status: 409,
  body: { error: "A drivable-road distance is required before this can be committed. An estimated distance is not enough.", code: "ROAD_DISTANCE_REQUIRED" },
};

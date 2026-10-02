/**
 * src/models/geo.js
 * ------------------
 * Phase 5C-1 — pure geospatial helpers for loads (no React, no Google).
 *
 * Place shape (used for load.pickup / load.delivery):
 *   { name, placeId, lat, lng }   — placeId/lat/lng are null when unresolved.
 *
 * Distance hierarchy (explicit, never silently invented):
 *   1. "route"     — real road distance from a routing provider (Google Routes
 *                    in 5C-2). Passed in as `routeKm`; nothing here fabricates it.
 *   2. "corridor"  — the known corridor table (road km).
 *   3. "unresolved"— km = 0, nothing known. Straight-line (Haversine) distance is
 *                    deliberately NOT used: it understates road distance and would
 *                    mislead pricing, so an unknown road distance stays unknown.
 */

import { resolveTownCoord } from "./match.js";

export const DIST_SOURCE = {
  ROUTE:      "route",
  CORRIDOR:   "corridor",
  UNRESOLVED: "unresolved",
};

const validCoord = (p) =>
  p && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

/**
 * Normalises a place. Accepts an explicit place object (e.g. from Places
 * autocomplete), or just a name — in which case coordinates are looked up in
 * the known-town table when possible, else left null.
 */
export function makePlace(name = "", explicit = null) {
  if (explicit && validCoord(explicit)) {
    return {
      name:    explicit.name || name || "",
      placeId: explicit.placeId || null,
      lat:     Number(explicit.lat),
      lng:     Number(explicit.lng),
    };
  }
  const town = name ? resolveTownCoord(name) : null;
  return {
    name:    name || "",
    placeId: null,
    lat:     town ? town.lat : null,
    lng:     town ? town.lng : null,
  };
}

/**
 * Resolves the distance for a pickup→delivery pair.
 * @param {Object}  p
 * @param {Object}  p.pickup, p.delivery   place objects
 * @param {number}  [p.routeKm]            real road distance, if a provider gave one
 * @param {number}  [p.corridorKm]         known-corridor road distance, if any
 * @returns {{ km:number, source:string }}
 */
export function resolveDistance({ pickup, delivery, routeKm, corridorKm }) {
  if (Number.isFinite(routeKm) && routeKm > 0) {
    return { km: Math.round(routeKm), source: DIST_SOURCE.ROUTE };
  }
  if (Number.isFinite(corridorKm) && corridorKm > 0) {
    return { km: Math.round(corridorKm), source: DIST_SOURCE.CORRIDOR };
  }
  return { km: 0, source: DIST_SOURCE.UNRESOLVED };
}

/** KSh per km from the offered price and the resolved distance (0 if either is missing). */
export function ratePerKm(pay, km) {
  return km > 0 && pay > 0 ? Math.round(pay / km) : 0;
}

/**
 * Deterministic historical creation time for seed/legacy loads that have no
 * real timestamp: derived from the numeric part of the ID ("KE-2048" is newer
 * than "KE-2041"), one hour apart, starting 1 Jan 2026 UTC. Loads created in a
 * session use Date.now() and therefore always sort ahead of every seed load.
 */
const SEED_EPOCH = Date.UTC(2026, 0, 1);
export function seedCreatedAt(id = "") {
  const n = parseInt(String(id).replace(/\D/g, ""), 10);
  return SEED_EPOCH + (Number.isFinite(n) ? n : 0) * 3600 * 1000;
}

/** Adds pickup/delivery places and createdAt to a legacy seed load, leaving existing values alone. */
export function withSeedGeo(load) {
  return {
    ...load,
    pickup:    load.pickup    || makePlace(load.from),
    delivery:  load.delivery  || makePlace(load.to),
    createdAt: Number.isFinite(load.createdAt) ? load.createdAt : seedCreatedAt(load.id),
  };
}

/** Newest first, stable for equal timestamps. Never mutates the input. */
export function sortNewestFirst(loads) {
  return [...loads].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** Decodes a Google encoded polyline (precision 5) into [{lat,lng}]. */
export function decodePolyline(str = "") {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i <= str.length);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (axis === 0) lat += d; else lng += d;
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

/** User-facing label for how a load's distance was obtained. */
export function distLabel(load) {
  const km = load?.dist || 0;
  // "haversine" = legacy straight-line value stored by an earlier build; never shown as a distance.
  if (!km || load.distSource === "haversine") return { text: "Distance n/a", approx: true, source: DIST_SOURCE.UNRESOLVED };
  switch (load.distSource) {
    case DIST_SOURCE.ROUTE:     return { text: `${km} km by road`,        approx: false, source: DIST_SOURCE.ROUTE };
    default:                    return { text: `${km} km`,                approx: false, source: load.distSource || DIST_SOURCE.CORRIDOR };
  }
}

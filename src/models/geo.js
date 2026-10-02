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
 *   3. "haversine" — straight-line distance between two coordinates. NOT road
 *                    distance; it understates it, so it is labelled as such.
 *   4. "unresolved"— km = 0, nothing known.
 */

import { distanceKm, resolveTownCoord } from "./match.js";

export const DIST_SOURCE = {
  ROUTE:      "route",
  CORRIDOR:   "corridor",
  HAVERSINE:  "haversine",
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
  if (validCoord(pickup) && validCoord(delivery)) {
    const km = Math.round(distanceKm(pickup, delivery));
    if (km > 0) return { km, source: DIST_SOURCE.HAVERSINE };
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

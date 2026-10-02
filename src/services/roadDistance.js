/**
 * src/services/roadDistance.js
 * -----------------------------
 * "All by road": resolves the real Google road distance for every load
 * (seed, marketplace and posted), caches it, and lets views overlay it.
 * Straight-line distance is never used. Places with no coordinates are
 * geocoded through the Maps JS Geocoder when a key is configured.
 * Anything that can't be resolved keeps its corridor/unresolved value.
 */
import { fetchRoadRoute } from "./routeApi.js";
import { loadGoogleMaps } from "./googleMaps.js";
import { ratePerKm } from "../models/geo.js";

const ROAD_KEY = "behari_road_km_v1";
const GEO_KEY  = "behari_geocode_v1";

const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const roadCache = read(ROAD_KEY);
const geoCache  = read(GEO_KEY);
const failedAt  = new Map();            // key -> ts, retry after 2 min
const listeners = new Set();
const geoFailed = new Set();            // names that failed this session
let geoErrors = 0;                      // stop calling the Geocoder after repeated errors (e.g. billing off)

const c3 = (n) => Number(n).toFixed(3);
const hasCoord = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
const pairKey = (a, b) => `${c3(a.lat)},${c3(a.lng)}|${c3(b.lat)},${c3(b.lng)}`;
const nameKey = (n) => String(n || "").trim().toLowerCase();

export function subscribeRoadDistances(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => listeners.forEach(fn => { try { fn(); } catch {} });

/** Place with coordinates filled from the geocode cache when it had none. */
function withCoords(place, fallbackName) {
  if (hasCoord(place)) return place;
  const hit = geoCache[nameKey(place?.name || fallbackName)];
  return hit ? { ...(place || {}), name: place?.name || fallbackName, lat: hit.lat, lng: hit.lng } : null;
}

/** Pure: overlays a cached road distance onto a load. Touches only dist/distSource/rateKm (derived display values) — never pay, bookings or escrow. Returns the load unchanged if none is cached. */
export function applyRoadDistance(load) {
  const p = withCoords(load.pickup, load.from);
  const d = withCoords(load.delivery, load.to);
  if (!p || !d) return load;
  const hit = roadCache[pairKey(p, d)];
  if (!hit) return load;
  const dist = Math.round(hit.km);
  return { ...load, dist, distSource: "route", rateKm: ratePerKm(load.pay || load.budget || 0, dist) };
}

async function geocode(name) {
  const k = nameKey(name);
  if (!k) return null;
  if (geoCache[k]) return geoCache[k];
  if (geoFailed.has(k) || geoErrors >= 3) return null;
  const maps = await loadGoogleMaps();
  if (!maps) return null;
  try {
    const { Geocoder } = await maps.importLibrary("geocoding");
    const res = await new Geocoder().geocode({ address: name, region: "ke" });
    const loc = res?.results?.[0]?.geometry?.location;
    if (!loc) { geoFailed.add(k); return null; }
    geoCache[k] = { lat: loc.lat(), lng: loc.lng() };
    write(GEO_KEY, geoCache);
    return geoCache[k];
  } catch { geoFailed.add(k); geoErrors++; return null; }
}

let running = false;
let queued = null;

/** Fetches (in the background) every road distance the given loads are missing, then notifies subscribers. */
export async function resolveRoadDistances(loads) {
  queued = loads;
  if (running) return;
  running = true;
  try {
    while (queued) {
      const batch = queued; queued = null;
      let changed = false;
      const seen = new Set();
      for (const l of batch) {
        let p = withCoords(l.pickup, l.from);
        let d = withCoords(l.delivery, l.to);
        if (!p) { const g = await geocode(l.pickup?.name || l.from); if (g) { p = g; changed = true; } }
        if (!d) { const g = await geocode(l.delivery?.name || l.to); if (g) { d = g; changed = true; } }
        if (!hasCoord(p) || !hasCoord(d)) continue;
        const key = pairKey(p, d);
        if (roadCache[key] || seen.has(key)) continue;
        seen.add(key);
        if (Date.now() - (failedAt.get(key) || 0) < 120_000) continue;
        const r = await fetchRoadRoute(p, d);
        if (r) { roadCache[key] = { km: r.routeKm }; write(ROAD_KEY, roadCache); changed = true; }
        else failedAt.set(key, Date.now());
      }
      if (changed) notify();
    }
  } finally { running = false; }
}

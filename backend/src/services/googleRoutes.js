/**
 * backend/src/services/googleRoutes.js
 * ---------------------------------------
 * Phase 5C-2 — road distance from the Google Routes API, called server-side so
 * the key never reaches a browser. Read from GOOGLE_MAPS_API_KEY (backend/.env,
 * git-ignored). Results are cached per exact origin/destination pair.
 */

const DEFAULT_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
// GOOGLE_ROUTES_ENDPOINT lets the acceptance suite point at a local mock; unset in real use.
const endpoint = () => process.env.GOOGLE_ROUTES_ENDPOINT || DEFAULT_ENDPOINT;
const FIELD_MASK = "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline";
const TIMEOUT_MS = 8000;
const CACHE_MAX = 500;

const cache = new Map();

export function routesConfigured() {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY);
}

const cacheKey = (a, b) => [a.lat, a.lng, b.lat, b.lng].map(n => n.toFixed(6)).join(",");

/**
 * @returns {Promise<{distanceMeters:number, durationSec:number, polyline:string|null}>}
 * @throws Error with .code "ROUTES_UNCONFIGURED" | "NO_ROUTE" | "ROUTES_UPSTREAM"
 */
export async function computeRoadRoute(origin, destination) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw Object.assign(new Error("Route distance is not configured."), { code: "ROUTES_UNCONFIGURED" });

  const ck = cacheKey(origin, destination);
  if (cache.has(ck)) return cache.get(ck);

  let res;
  try {
    res = await fetch(endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify({
        origin:      { location: { latLng: { latitude: origin.lat,      longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: "DRIVE",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw Object.assign(new Error("Routing provider unreachable."), { code: "ROUTES_UPSTREAM" });
  }

  if (!res.ok) {
    // Log the provider's status only — never its body, which can echo request details.
    console.error(`[routes] Google Routes API responded ${res.status}`);
    throw Object.assign(new Error("Routing provider error."), { code: "ROUTES_UPSTREAM" });
  }
  const route = (await res.json())?.routes?.[0];
  if (!route || !Number.isFinite(route.distanceMeters)) {
    throw Object.assign(new Error("No drivable route found."), { code: "NO_ROUTE" });
  }

  const result = {
    distanceMeters: Math.round(route.distanceMeters),
    durationSec:    parseInt(String(route.duration || "0"), 10) || 0,
    polyline:    route.polyline?.encodedPolyline || null,
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(ck, result);
  return result;
}

/** Display rounding only (0.1 km). Commercial maths always uses meters. */
export const metersToKm = (m) => Math.round(m / 100) / 10;

export function _clearRouteCache() { cache.clear(); }

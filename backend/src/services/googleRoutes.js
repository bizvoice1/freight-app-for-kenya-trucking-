/**
 * backend/src/services/googleRoutes.js
 * ---------------------------------------
 * Phase 5C-2 — road distance from the Google Routes API, called server-side so
 * the key never reaches a browser. Read from GOOGLE_MAPS_API_KEY (backend/.env,
 * git-ignored). Results are cached per rounded origin/destination pair.
 */

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELD_MASK = "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline";
const TIMEOUT_MS = 8000;
const CACHE_MAX = 500;

const cache = new Map();

export function routesConfigured() {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY);
}

const cacheKey = (a, b) => [a.lat, a.lng, b.lat, b.lng].map(n => n.toFixed(4)).join(",");

/**
 * @returns {Promise<{distanceKm:number, durationMin:number, polyline:string|null}>}
 * @throws Error with .code "ROUTES_UNCONFIGURED" | "NO_ROUTE" | "ROUTES_UPSTREAM"
 */
export async function computeRoadRoute(origin, destination) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw Object.assign(new Error("Route distance is not configured."), { code: "ROUTES_UNCONFIGURED" });

  const ck = cacheKey(origin, destination);
  if (cache.has(ck)) return cache.get(ck);

  let res;
  try {
    res = await fetch(ENDPOINT, {
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
    distanceKm:  Math.round(route.distanceMeters / 100) / 10,
    durationMin: Math.round((parseInt(String(route.duration || "0"), 10) || 0) / 60),
    polyline:    route.polyline?.encodedPolyline || null,
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(ck, result);
  return result;
}

export function _clearRouteCache() { cache.clear(); }

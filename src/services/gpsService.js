/**
 * src/services/gpsService.js
 * --------------------------
 * Simulated GPS engine for live trip progression.
 *
 * In production: replace with Google Maps Routes API, HERE SDK,
 * or a WebSocket stream from the truck's GPS device.
 *
 * Core concepts:
 *   ROUTE      — ordered list of waypoints for a corridor (Nairobi → Mombasa, etc.)
 *   SEGMENT    — distance between two consecutive waypoints (km)
 *   POSITION   — how far along a segment a truck currently is (0.0 – 1.0)
 *   TRIP STATE — the snapshot React renders: latlng, speed, eta, waypoint reached
 *
 * PHASE 4D NOTE — two generations of API live in this file side by side:
 *
 *   ORIGINAL (buildTripSnapshot, statusToProgress, ...): driven by a Load's
 *   own `.status` field. This is exactly what behari-freight-v2.jsx's
 *   TripGPSModal calls today (buildTripSnapshot(load) — the only real
 *   consumer of this file, confirmed before writing a line of Phase 4D) —
 *   the modal then animates progress itself in a local setInterval. Kept
 *   completely unchanged: zero risk to that existing UI.
 *
 *   NEW (generateLocationUpdate, getCurrentLocation, getLocationHistory,
 *   startSimulation/stopSimulation): driven by a models/trip.js Trip's own
 *   `.status`, producing persisted LocationUpdate records instead of an
 *   ephemeral per-render snapshot. Both generations share the same route
 *   dictionary and the same computeTruckPosition() interpolation — the
 *   route/interpolation engine is not duplicated, only the "what determines
 *   progress" layer changes, from Load.status to Trip.status.
 */

import { createLocationUpdate, TRIP_STATUS, TERMINAL_TRIP_STATUSES } from "../models/trip.js";
import { distanceKm } from "../models/match.js";

/* ── Route definitions ──────────────────────────────────────────────────── */

/**
 * Each route is keyed by canonical "FROM → TO" string.
 * Each waypoint: { name, lat, lng, icon?, border? }
 */
export const ROUTES = {
  "Nairobi → Mombasa": {
    totalKm: 485,
    waypoints: [
      { name:"Nairobi (CFS)",      lat:-1.2921, lng:36.8219 },
      { name:"Athi River Gate",    lat:-1.4537, lng:36.9775, icon:"🚦" },
      { name:"Machakos Junction",  lat:-1.5221, lng:37.2634 },
      { name:"Mtito Andei",        lat:-2.6874, lng:38.1711 },
      { name:"Voi",                lat:-3.3960, lng:38.5593 },
      { name:"Mariakani",          lat:-3.8671, lng:39.4771 },
      { name:"Mombasa Port",       lat:-4.0435, lng:39.6682 },
    ],
  },
  "Eldoret → Nairobi": {
    totalKm: 312,
    waypoints: [
      { name:"Eldoret ICD",        lat: 0.5143, lng:35.2698 },
      { name:"Kericho",            lat:-0.3664, lng:35.2836 },
      { name:"Nakuru",             lat:-0.3031, lng:36.0800 },
      { name:"Naivasha",           lat:-0.7132, lng:36.4313 },
      { name:"Limuru",             lat:-1.1136, lng:36.6540 },
      { name:"Nairobi (CBD)",      lat:-1.2921, lng:36.8219 },
    ],
  },
  "Nairobi → Kampala": {
    totalKm: 683,
    waypoints: [
      { name:"Nairobi (CBD)",      lat:-1.2921, lng:36.8219 },
      { name:"Nakuru",             lat:-0.3031, lng:36.0800 },
      { name:"Eldoret",            lat: 0.5143, lng:35.2698 },
      { name:"Malaba Border",      lat: 0.6231, lng:34.2678, icon:"🛃", border:true },
      { name:"Tororo",             lat: 0.6931, lng:34.1815 },
      { name:"Jinja",              lat: 0.4244, lng:33.2042 },
      { name:"Kampala",            lat: 0.3476, lng:32.5825 },
    ],
  },
  "Mombasa → Nairobi": {
    totalKm: 485,
    waypoints: [
      { name:"Mombasa Port",       lat:-4.0435, lng:39.6682 },
      { name:"Mariakani",          lat:-3.8671, lng:39.4771 },
      { name:"Voi",                lat:-3.3960, lng:38.5593 },
      { name:"Mtito Andei",        lat:-2.6874, lng:38.1711 },
      { name:"Machakos Junction",  lat:-1.5221, lng:37.2634 },
      { name:"Athi River",         lat:-1.4537, lng:36.9775, icon:"🚦" },
      { name:"Nairobi (CFS)",      lat:-1.2921, lng:36.8219 },
    ],
  },
  "Naivasha → JKIA": {
    totalKm: 90,
    waypoints: [
      { name:"Naivasha Farms",     lat:-0.7132, lng:36.4313 },
      { name:"Limuru",             lat:-1.1136, lng:36.6540 },
      { name:"Westlands",          lat:-1.2676, lng:36.8115 },
      { name:"JKIA Cargo",         lat:-1.3192, lng:36.9275 },
    ],
  },
  "Nairobi → Arusha": {
    totalKm: 272,
    waypoints: [
      { name:"Nairobi (CBD)",      lat:-1.2921, lng:36.8219 },
      { name:"Athi River",         lat:-1.4537, lng:36.9775 },
      { name:"Namanga Border",     lat:-2.5506, lng:36.7867, icon:"🛃", border:true },
      { name:"Longido",            lat:-2.7393, lng:36.6967 },
      { name:"Arusha",             lat:-3.3869, lng:36.6829 },
    ],
  },
  "Athi River → Kisumu": {
    totalKm: 355,
    waypoints: [
      { name:"Athi River",         lat:-1.4537, lng:36.9775 },
      { name:"Nairobi",            lat:-1.2921, lng:36.8219 },
      { name:"Nakuru",             lat:-0.3031, lng:36.0800 },
      { name:"Kericho",            lat:-0.3664, lng:35.2836 },
      { name:"Kisumu Port",        lat:-0.0917, lng:34.7680 },
    ],
  },
};

/**
 * Looks up the best route for a load's from→to pair.
 * Falls back to a straight-line 2-waypoint route if not found.
 */
export function getRouteForLoad(from, to) {
  const key    = `${from} → ${to}`;
  const revKey = `${to} → ${from}`;
  return ROUTES[key] || ROUTES[revKey] || null;
}

/**
 * Returns a default 2-waypoint route so GPS always works even for
 * custom loads not in the ROUTES dictionary.
 */
function buildFallbackRoute(from, to) {
  return {
    totalKm: 200,
    waypoints: [
      { name: from || "Origin",      lat:-1.2921, lng:36.8219 },
      { name: to   || "Destination", lat:-4.0435, lng:39.6682 },
    ],
  };
}

/* ── Trip state machine ─────────────────────────────────────────────────── */

/**
 * Computes the truck's current GPS position and trip stats given:
 *   totalDistanceKm — total route length
 *   waypoints        — ordered list of { name, lat, lng }
 *   progressPct      — 0..100 (from load status + elapsed time)
 *
 * Returns: { lat, lng, speedKmh, etaHours, currentSegIndex, segProgress, kmDone }
 */
export function computeTruckPosition(waypoints, progressPct) {
  if (!waypoints || waypoints.length < 2) {
    return { lat: waypoints?.[0]?.lat ?? -1.29, lng: waypoints?.[0]?.lng ?? 36.82, speedKmh: 0, etaHours: 0, currentSegIndex: 0, segProgress: 0, kmDone: 0 };
  }

  const clampedPct = Math.max(0, Math.min(100, progressPct));
  const n          = waypoints.length;
  const segCount   = n - 1;

  // Distribute progress evenly across segments
  const totalProg  = clampedPct / 100; // 0..1
  const segFloat   = totalProg * segCount;
  const segIndex   = Math.min(Math.floor(segFloat), segCount - 1);
  const segProgress = segFloat - segIndex; // 0..1 within current segment

  const A = waypoints[segIndex];
  const B = waypoints[segIndex + 1];

  // Interpolate lat/lng
  const lat = A.lat + (B.lat - A.lat) * segProgress;
  const lng = A.lng + (B.lng - A.lng) * segProgress;

  // Estimate speed (avg 65 km/h on Kenya highways)
  const speedKmh   = clampedPct > 0 && clampedPct < 100 ? 55 + Math.floor(Math.random() * 20) : 0;

  return {
    lat,
    lng,
    speedKmh,
    currentSegIndex: segIndex,
    segProgress,
    arrivedAt: clampedPct >= 100 ? waypoints[waypoints.length - 1].name : null,
  };
}

/**
 * Converts a load's STATUS into a GPS progress percentage.
 * This determines where on the route the truck sits.
 */
export function statusToProgress(status) {
  const MAP = {
    "Escrow Held":        2,
    "Accepted":           5,
    "Loading":            8,
    "In Transit":         40,
    "Arrived":            95,
    "Delivery Confirmed": 99,
    "Paid Out":           100,
    "Delivered":          100,
    "Cancelled":          0,
    "Disputed":           40,
    "Dispute Resolved":   40,
  };
  return MAP[status] ?? 0;
}

/**
 * Returns human-readable ETA string.
 * @param {number} progressPct  - 0..100
 * @param {number} totalKm      - route total distance in km
 */
export function computeETA(progressPct, totalKm = 485) {
  if (progressPct >= 100) return "Arrived";
  if (progressPct <= 0)   return "Not started";
  const kmRemaining  = (1 - progressPct / 100) * totalKm;
  const hoursLeft    = kmRemaining / 60; // avg 60 km/h
  if (hoursLeft < 1) return `${Math.round(hoursLeft * 60)} min`;
  return `${hoursLeft.toFixed(1)} hrs`;
}

/**
 * Builds a GeoJSON-style polyline of the full route (for map rendering).
 */
export function buildRoutePolyline(waypoints) {
  return waypoints.map(w => [w.lat, w.lng]);
}

/**
 * Main function: given a load object, return a complete GPS trip snapshot.
 */
export function buildTripSnapshot(load) {
  const route = getRouteForLoad(load.from, load.to) || buildFallbackRoute(load.from, load.to);
  const progressPct = statusToProgress(load.status);
  const position    = computeTruckPosition(route.waypoints, progressPct);
  const eta         = computeETA(progressPct, route.totalKm);
  const polyline    = buildRoutePolyline(route.waypoints);

  // Determine which waypoints are "done" vs upcoming
  const { currentSegIndex, segProgress } = position;
  const waypointsWithStatus = route.waypoints.map((w, i) => ({
    ...w,
    done:    i < currentSegIndex || (i === currentSegIndex && segProgress > 0.5),
    current: i === currentSegIndex && segProgress <= 0.5,
    upcoming:i > currentSegIndex,
  }));

  return {
    route,
    progressPct,
    position,
    eta,
    polyline,
    waypoints: waypointsWithStatus,
    totalKm:   route.totalKm,
    kmDone:    Math.round((progressPct / 100) * route.totalKm),
    kmLeft:    Math.round(((100 - progressPct) / 100) * route.totalKm),
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * PHASE 4D — Trip-driven simulation (new)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Everything below reads a Trip's `.status` instead of a Load's, and
 * persists what it produces as LocationUpdate records (models/trip.js)
 * rather than handing back an ephemeral snapshot. It reuses getRouteForLoad,
 * buildFallbackRoute and computeTruckPosition unchanged from above — same
 * engine, new driver.
 */

const GPS_STORE_KEY = "behari_gps_v1";

const _gpsStore = {
  locationUpdates: [],     // flat list, all trips — filtered per-trip by the getters below
  progressByTrip:  {},     // tripId -> last computed progress %, so IN_TRANSIT can advance tick over tick
};

function _persistGps() {
  try { localStorage.setItem(GPS_STORE_KEY, JSON.stringify(_gpsStore)); } catch { /* ignore */ }
}

function _hydrateGps() {
  try {
    const raw = localStorage.getItem(GPS_STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.locationUpdates) _gpsStore.locationUpdates = saved.locationUpdates;
    if (saved.progressByTrip)  _gpsStore.progressByTrip  = saved.progressByTrip;
  } catch { /* corrupted storage — start fresh */ }
}
_hydrateGps();

/**
 * Maps a Trip's status onto a route-progress percentage. This is the direct
 * replacement for statusToProgress(load.status) in the trip-driven world —
 * kept separate (not merged into statusToProgress) because a Trip's
 * IN_TRANSIT needs STATE (how far along it got last tick), where a Load's
 * "In Transit" was always a fixed number. Everything else parks, per the
 * simulation rules: Assigned/At Pickup/Loading are all "still at pickup",
 * At Delivery/Delivered are "at or approaching destination", Cancelled
 * freezes wherever it last was.
 */
const TRANSIT_STEP    = 12; // percentage points gained per simulated tick while In Transit
const TRANSIT_FLOOR   = 8;
const TRANSIT_CEILING = 92;

function _tripProgress(trip) {
  const last = _gpsStore.progressByTrip[trip.id];
  switch (trip.status) {
    case TRIP_STATUS.ASSIGNED:    return 0;                         // parked at pickup
    case TRIP_STATUS.DISPATCHED:  return 3;                         // beginning route
    case TRIP_STATUS.AT_PICKUP:   return 5;                         // parked at pickup
    case TRIP_STATUS.LOADING:     return 5;                         // parked at pickup
    case TRIP_STATUS.IN_TRANSIT:
      return Math.min(TRANSIT_CEILING, Math.max(last ?? TRANSIT_FLOOR, TRANSIT_FLOOR) + TRANSIT_STEP);
    case TRIP_STATUS.AT_DELIVERY: return 96;                        // parked at destination
    case TRIP_STATUS.DELIVERED:   return 100;                       // final destination
    case TRIP_STATUS.CANCELLED:   return last ?? 0;                 // frozen — no further movement
    default:                      return last ?? 0;
  }
}

/** Compass bearing (0-359°) from waypoint A to waypoint B, for the `heading` field. */
function _computeHeading(a, b) {
  if (!a || !b) return 0;
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const dLng  = toRad(b.lng - a.lng);
  const lat1  = toRad(a.lat);
  const lat2  = toRad(b.lat);
  const y     = Math.sin(dLng) * Math.cos(lat2);
  const x     = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return Math.round((toDeg(Math.atan2(y, x)) + 360) % 360);
}

/**
 * Generates and persists exactly one new LocationUpdate for a Trip, derived
 * from the Trip's CURRENT status — this is the core simulation tick.
 *
 * A Cancelled trip never advances: this returns the last known location
 * unchanged (or null if it never moved) rather than creating a new record,
 * which is what makes "simulation stops" on cancellation an inherent
 * property of calling this function, not something a caller has to
 * remember to check separately.
 *
 * @param {Object} trip - a full Trip record (models/trip.js shape): needs
 *                        .id, .status, .truckId, .driverId, .pickup, .delivery
 * @returns {Object|null} the new LocationUpdate, or the frozen last one if Cancelled
 */
export function generateLocationUpdate(trip) {
  if (!trip) return null;

  // Cancelled never produces a new position — frozen at whatever was last recorded.
  if (trip.status === TRIP_STATUS.CANCELLED) {
    return getCurrentLocation(trip.id);
  }
  // Delivered gets exactly one final tick to record the arrival position;
  // once that's been recorded, further calls are idempotent (no duplicate
  // "still parked" records piling up).
  if (trip.status === TRIP_STATUS.DELIVERED && _gpsStore.progressByTrip[trip.id] === 100) {
    return getCurrentLocation(trip.id);
  }

  const route = getRouteForLoad(trip.pickup, trip.delivery) || buildFallbackRoute(trip.pickup, trip.delivery);
  const progressPct = _tripProgress(trip);
  _gpsStore.progressByTrip[trip.id] = progressPct;

  const position = computeTruckPosition(route.waypoints, progressPct);
  const moving   = trip.status === TRIP_STATUS.IN_TRANSIT;
  const a        = route.waypoints[position.currentSegIndex];
  const b        = route.waypoints[Math.min(position.currentSegIndex + 1, route.waypoints.length - 1)];

  const update = createLocationUpdate(
    {
      tripId:   trip.id,
      truckId:  trip.truckId,
      driverId: trip.driverId,
      lat:      position.lat,
      lng:      position.lng,
      accuracy: 10 + Math.round(Math.random() * 10), // simulated GPS noise, 10-20m
      speed:    moving ? position.speedKmh : 0,
      heading:  _computeHeading(a, b),
      source:   "simulation",
    },
    _gpsStore.locationUpdates.length
  );

  _gpsStore.locationUpdates = [..._gpsStore.locationUpdates, update];
  _persistGps();
  return update;
}

/** Returns the most recent LocationUpdate for a trip, or null if it has never moved. */
export function getCurrentLocation(tripId) {
  const history = getLocationHistory(tripId);
  return history.length ? history[history.length - 1] : null;
}

/** Returns all LocationUpdates for a trip, oldest first, isolated to that trip only. */
export function getLocationHistory(tripId) {
  return _gpsStore.locationUpdates
    .filter(u => u.tripId === tripId)
    .sort((x, y) => new Date(x.timestamp) - new Date(y.timestamp));
}

/* ── Auto-ticking (optional convenience — the acceptance tests exercise
 *    generateLocationUpdate() directly for determinism; these wrap it in a
 *    real interval for actual runtime use once wired into a hook/UI) ────── */

const _simIntervals = new Map(); // tripId -> interval handle; runtime-only, never persisted

/**
 * Starts auto-generating LocationUpdates for a trip every `intervalMs`.
 * Fetches the trip fresh on each tick (via tripService, read-only) so it
 * always reflects the trip's current status, and self-stops the moment
 * that trip is gone or has reached a terminal state.
 *
 * Lazily imports tripService to avoid a hard circular-import edge at module
 * load time — gpsService is otherwise independent of the trip layer.
 */
export function startSimulation(tripId, intervalMs = 4000) {
  stopSimulation(tripId);
  const handle = setInterval(async () => {
    const { getTripById } = await import("./tripService.js");
    const trip = await getTripById(tripId);
    if (!trip || TERMINAL_TRIP_STATUSES.has(trip.status)) {
      stopSimulation(tripId);
      return;
    }
    generateLocationUpdate(trip);
  }, intervalMs);
  _simIntervals.set(tripId, handle);
}

/** Stops auto-ticking for a trip. Safe to call even if nothing is running. */
export function stopSimulation(tripId) {
  const handle = _simIntervals.get(tripId);
  if (handle) {
    clearInterval(handle);
    _simIntervals.delete(tripId);
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * PHASE 4E — Device-sourced locations (real driver-phone GPS)
 * ════════════════════════════════════════════════════════════════════════
 *
 * recordDeviceLocation() is the device-tracking equivalent of
 * generateLocationUpdate(): both end up producing the exact same
 * LocationUpdate shape (models/trip.js) through the exact same store, so
 * getCurrentLocation()/getLocationHistory() and every UI reading them don't
 * know or care which one wrote a given record — only its `source` field
 * differs ("simulation" vs "device"). That's the entire payoff of building
 * the LocationUpdate contract in Phase 4D before touching a real phone.
 *
 * IDENTITY NOTE: this function does not resolve who's allowed to report a
 * position for a trip — it trusts truckId/driverId exactly as given. That
 * check belongs one layer up, in services/trackingService.js, which derives
 * them from the Trip record itself (never from client input) before ever
 * calling this. What this function DOES own is GPS *quality*: a reading can
 * come from the right person and still be garbage (stale, wildly
 * inaccurate, a physically impossible jump) — see _validateDeviceReading.
 */

const MAX_ACCURACY_M    = 500;  // reject readings this imprecise or worse
const MAX_STALENESS_MS  = 60000; // reject a device timestamp older than this
const MAX_PLAUSIBLE_KMH = 180;   // reject an implied speed above this between consecutive points

/**
 * Basic GPS-quality guards — deliberately simple checks, not fraud
 * detection, per the phase scope. Returns a rejection reason string, or
 * null if the reading is acceptable.
 */
function _validateDeviceReading(tripId, { lat, lng, accuracy, deviceTimestamp }) {
  if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) {
    return "Missing or invalid coordinates.";
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return "Coordinate values out of range.";
  }
  if (typeof accuracy === "number" && accuracy > MAX_ACCURACY_M) {
    return `GPS accuracy too poor (${Math.round(accuracy)}m).`;
  }
  if (typeof deviceTimestamp === "number" && (Date.now() - deviceTimestamp) > MAX_STALENESS_MS) {
    return "GPS reading is stale.";
  }

  const prev = getCurrentLocation(tripId);
  if (prev) {
    const km          = distanceKm({ lat: prev.lat, lng: prev.lng }, { lat, lng }) ?? 0;
    const elapsedHrs  = Math.max((Date.now() - new Date(prev.timestamp).getTime()) / 3_600_000, 1 / 3600);
    const impliedKmh  = km / elapsedHrs;
    if (impliedKmh > MAX_PLAUSIBLE_KMH) {
      return `Implausible jump for a truck (${Math.round(impliedKmh)} km/h implied).`;
    }
  }
  return null;
}

/**
 * Records a real device-reported position for a trip. Unlike
 * generateLocationUpdate() (which derives a position from Trip.status),
 * this trusts the coordinates it's given, subject to the quality guards
 * above, and always stamps source:"device".
 *
 * @param {Object} params
 * @param {string} params.tripId
 * @param {string} params.truckId
 * @param {string} params.driverId
 * @param {number} params.lat
 * @param {number} params.lng
 * @param {number} [params.accuracy]
 * @param {number} [params.speed]           - km/h
 * @param {number} [params.heading]         - degrees
 * @param {number} [params.deviceTimestamp] - ms epoch, from the GPS reading itself
 * @returns {{accepted:boolean, update:Object|null, reason:string|null}}
 */
export function recordDeviceLocation({ tripId, truckId, driverId, lat, lng, accuracy, speed = 0, heading = 0, deviceTimestamp }) {
  const rejection = _validateDeviceReading(tripId, { lat, lng, accuracy, deviceTimestamp });
  if (rejection) return { accepted: false, update: null, reason: rejection };

  const update = createLocationUpdate(
    { tripId, truckId, driverId, lat, lng, accuracy, speed, heading, source: "device" },
    _gpsStore.locationUpdates.length
  );
  _gpsStore.locationUpdates = [..._gpsStore.locationUpdates, update];
  _persistGps();
  return { accepted: true, update, reason: null };
}

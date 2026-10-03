/**
 * src/services/trackingService.js
 * ---------------------------------
 * Phase 4F — this file now talks to the REAL backend (backend/) instead of
 * localStorage. It is the ONLY file that touches navigator.geolocation
 * (unchanged from Phase 4E) AND the only frontend file that holds the
 * driver's auth token.
 *
 * WHAT CHANGED FROM PHASE 4E:
 *   4E's getCurrentDriverId()/setCurrentDriverId() were a bare, unverified
 *   localStorage string — any code in the page could set it to anything.
 *   That's gone. Identity now comes from loginDriver(phone, pin) calling
 *   POST /api/auth/login; the backend issues a signed token, and every
 *   subsequent call sends that token — the backend (backend/src/routes/
 *   trips.js) is what decides whether this driver may act on a given trip,
 *   not this file and not the client. See that file's ownsTrip() check.
 *
 *   generateLocationUpdate()/getCurrentLocation()/getLocationHistory() for
 *   the SIMULATED path (gpsService.js) are untouched — Phase 4F only
 *   replaces the DEVICE path's persistence, per its own scope (simulation
 *   stays a frontend concern; only real driver-phone GPS needed a real
 *   trust boundary).
 */

import { API_BASE, currentSession, authAuthHeader, login as sessionLogin, logout as sessionLogout } from "./session.js";

function _authHeaders() { return authAuthHeader(); }
function _getToken() { return currentSession()?.token ?? null; }

/** Logs a driver in against the real backend (shared session). */
export async function loginDriver(phone, pin) { return sessionLogin(phone, pin, "driver"); }

/** The driver identity attached to the current session, or null if not signed in as a driver. */
export function getCurrentDriverUser() {
  const s = currentSession();
  return s && s.user.role === "driver" ? s.user : null;
}

export function logoutDriver() { sessionLogout(); }

// Runtime-only — see Phase 4E's identical note: a watch handle can't survive
// reload, and shouldn't; reopening the screen re-requests a fresh GPS lock.
const _watches = new Map(); // tripId -> { watchId }
const _idleState = { status: "idle", lastUpdate: null, error: null };
const _stateByTrip = new Map();

function _setState(tripId, patch) {
  _stateByTrip.set(tripId, { ..._stateByTrip.get(tripId) ?? _idleState, ...patch });
}

export function getTrackingState(tripId) {
  return { ..._stateByTrip.get(tripId) ?? _idleState };
}

/**
 * Starts sharing this device's location for a trip via the real backend.
 * The backend re-derives and re-checks ownership itself (POST /tracking/
 * start) — this call is not just a client-side gate, it's the first real
 * request that can fail with a 403 if this driver doesn't own the trip.
 */
export async function startDriverTracking(tripId) {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    const reason = "Geolocation is not available on this device/browser.";
    _setState(tripId, { status: "error", error: reason });
    return { started: false, reason };
  }
  if (!_getToken()) {
    return { started: false, reason: "Not logged in." };
  }

  let startRes, startData;
  try {
    startRes = await fetch(`${API_BASE}/api/trips/${tripId}/tracking/start`, {
      method: "POST",
      headers: _authHeaders(),
    });
    startData = await startRes.json();
  } catch {
    const reason = `Could not reach the tracking backend at ${API_BASE}.`;
    _setState(tripId, { status: "error", error: reason });
    return { started: false, reason };
  }
  if (!startRes.ok) {
    return { started: false, reason: startData.error || "Could not start tracking." };
  }

  stopDriverTracking(tripId);
  _setState(tripId, { status: "requesting-permission", error: null });

  const watchId = navigator.geolocation.watchPosition(
    async (position) => {
      const { latitude, longitude, accuracy, speed, heading } = position.coords;
      try {
        const res = await fetch(`${API_BASE}/api/trips/${tripId}/location`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ..._authHeaders() },
          body: JSON.stringify({
            lat: latitude,
            lng: longitude,
            accuracy: accuracy ?? undefined,
            speed:   (typeof speed === "number" && !Number.isNaN(speed)) ? speed * 3.6 : 0,
            heading: (typeof heading === "number" && !Number.isNaN(heading)) ? heading : 0,
            deviceTimestamp: position.timestamp,
          }),
        });
        const data = await res.json();
        _setState(tripId, data.accepted
          ? { status: "tracking", lastUpdate: data.update, error: null }
          : { status: "tracking", error: data.reason || data.error }
        );
      } catch {
        _setState(tripId, { status: "tracking", error: "Could not reach the tracking backend — reading not sent." });
      }
    },
    (err) => {
      _setState(tripId, { status: "error", error: err?.message || "Location permission denied." });
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );

  _watches.set(tripId, { watchId });
  return { started: true, reason: null };
}

/** Stops sharing this device's location for a trip. Safe to call if nothing is running. */
export function stopDriverTracking(tripId) {
  const entry = _watches.get(tripId);
  if (entry && typeof navigator !== "undefined" && navigator.geolocation) {
    navigator.geolocation.clearWatch(entry.watchId);
  }
  _watches.delete(tripId);
  _setState(tripId, { status: "stopped" });

  if (_getToken()) {
    fetch(`${API_BASE}/api/trips/${tripId}/tracking/stop`, { method: "POST", headers: _authHeaders() }).catch(() => { /* best-effort */ });
  }
}

/**
 * Phase 4H — the trips a logged-in driver is actually assigned to, per the
 * real backend (now the authoritative source once a trip comes from the
 * Marketplace's Booking -> Trip flow, not just the Phase 4F/4G seed trip).
 * Uses this file's own already-authenticated token — not trackingApi.js's
 * separate demo-auth cache, since this driver already has a real one.
 */
export async function getMyTrips() {
  const user = getCurrentDriverUser();
  if (!user) return [];
  try {
    const res = await fetch(`${API_BASE}/api/trips?driverId=${encodeURIComponent(user.driverId)}`, { headers: _authHeaders() });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/** Canonical trip from the backend (used to render and to refetch after any action). */
export async function getTrip(tripId) {
  try {
    const res = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(tripId)}`, { headers: _authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Asks the backend to move the trip to `status`. The backend decides; returns { ok, trip, error, code }. */
export async function requestTripStatus(tripId, status) {
  try {
    const res = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(tripId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._authHeaders() },
      body: JSON.stringify({ status }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || "Could not update trip status.", code: data.code };
    return { ok: true, trip: data };
  } catch {
    return { ok: false, error: `Could not reach the backend at ${API_BASE}.` };
  }
}

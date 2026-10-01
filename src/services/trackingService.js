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

// A real driver opens this screen on their OWN phone, not the machine
// running the backend — hardcoding "localhost" here means the phone calls
// itself and every request silently fails to connect (surfaces as "Could
// not reach the tracking backend", i.e. "I can't log in"). Default to
// whatever host actually served this page (vite.config.js already exposes
// the dev server on the LAN via host:true) so it resolves correctly
// whether opened locally or from another device on the same network, with
// no per-network manual config. VITE_API_BASE_URL still wins if set.
const API_BASE = (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL)
  || (typeof window !== "undefined" && `http://${window.location.hostname}:4000`)
  || "http://localhost:4000";
const TOKEN_KEY = "behari_driver_token";
const USER_KEY  = "behari_driver_user";

function _authHeaders() {
  const token = _getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function _getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

/**
 * Logs a driver in against the real backend. phone+PIN, exactly like the
 * rest of this demo's sign-in — the difference is the backend now actually
 * verifies it (bcrypt-hashed PIN) and issues a token, rather than the
 * client just remembering a chosen name.
 *
 * @returns {Promise<{ok:boolean, user?:Object, error?:string}>}
 */
export async function loginDriver(phone, pin) {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, pin, role: "driver" }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || "Login failed." };
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    return { ok: true, user: data.user };
  } catch {
    return { ok: false, error: `Could not reach the tracking backend at ${API_BASE}.` };
  }
}

/** The driver identity attached to the current token, or null if not logged in. */
export function getCurrentDriverUser() {
  try {
    if (!_getToken()) return null;
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function logoutDriver() {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
}

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

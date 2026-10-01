/**
 * src/services/trackingApi.js
 * ------------------------------
 * Phase 4G — the READ-ONLY client the Shipper/Transporter/Admin portals use
 * to consume Phase 4F's backend. Not the driver's own posting path (that's
 * trackingService.js) — this file never posts a location, only reads.
 *
 * DEMO AUTH NOTE: Shipper/Admin/Transporter have no real login flow in this
 * prototype (App.jsx's role switch is a localStorage stand-in, same as it's
 * always been). Rather than build one now — real auth hardening is
 * explicitly Phase 4I — this file transparently logs into the SAME backend
 * used by the Driver Tracker, using the demo credentials documented in
 * backend/README.md (phone+PIN "1234", exactly as seeded). The request
 * still goes through the real JWT-checked API; nothing here bypasses the
 * backend's identity checks, it just supplies credentials on the portal's
 * behalf instead of asking a human to type them. That's a shortcut for
 * portal login, not a hole in trip/location authorization.
 */

// See trackingService.js's identical note: default to whatever host served
// this page, not a hardcoded "localhost", so a portal opened from another
// device on the LAN still reaches the right backend.
const API_BASE = (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL)
  || (typeof window !== "undefined" && `http://${window.location.hostname}:4000`)
  || "http://localhost:4000";

// Matches backend/src/db/seed.js exactly — see backend/README.md's dev login table.
const DEMO_CREDENTIALS = {
  shipper:     { phone: "0700000001", pin: "1234" },
  admin:       { phone: "0700000002", pin: "1234" },
  fleet_owner: { phone: "0722100200", pin: "1234" },
};

const _tokenCache = new Map(); // role -> token

async function _ensureToken(role) {
  if (_tokenCache.has(role)) return _tokenCache.get(role);
  const creds = DEMO_CREDENTIALS[role];
  if (!creds) throw new Error(`No demo credentials configured for role "${role}".`);

  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...creds, role }),
  });
  if (!res.ok) throw new Error(`Could not authenticate with tracking backend as ${role}.`);
  const data = await res.json();
  _tokenCache.set(role, data.token);
  return data.token;
}

async function _get(path, role) {
  const token = await _ensureToken(role);
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Tracking API error (${res.status}) on ${path}`);
  return res.json();
}

/** Finds the backend trip for a Load id, or null if that load has no live-tracked trip. */
export async function findTripByLoadId(loadId, role = "shipper") {
  const rows = await _get(`/api/trips?loadId=${encodeURIComponent(loadId)}`, role);
  return rows?.[0] || null;
}

/** Every backend trip currently bound to a truck (there's at most one active one in practice). */
export async function findTripsByTruckId(truckId, role = "fleet_owner") {
  return (await _get(`/api/trips?truckId=${encodeURIComponent(truckId)}`, role)) || [];
}

/** All backend trips — Admin's operations view, filterable client-side or via params. */
export async function listTrips(params = {}, role = "admin") {
  const qs = new URLSearchParams(params).toString();
  return (await _get(`/api/trips${qs ? `?${qs}` : ""}`, role)) || [];
}

export async function getLatestLocation(tripId, role = "shipper") {
  return _get(`/api/trips/${tripId}/location/latest`, role);
}

export async function getLocationHistory(tripId, role = "shipper") {
  return (await _get(`/api/trips/${tripId}/location/history`, role)) || [];
}

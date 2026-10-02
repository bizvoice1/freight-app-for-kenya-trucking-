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

import { getToken } from "./backendSession.js";
import { API_BASE } from "./backendSession.js";

const _ensureToken = getToken;

async function _get(path, role) {
  const token = await _ensureToken(role);
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Tracking API error (${res.status}) on ${path}`);
  return res.json();
}

/** Finds the backend trip for a Load id, or null if that load has no live-tracked trip. */
export async function findTripByLoadId(loadId, role = "shipper") {
  try {
    const rows = await _get(`/api/trips?loadId=${encodeURIComponent(loadId)}`, role);
    return rows?.[0] || null;
  } catch (e) {
    // The backend answers 403 (not 404) for any loadId outside the caller's scope, so
    // frontend-only seed loads (e.g. KE-2041) look the same as someone else's load.
    // For this lookup both mean "no backend-tracked trip you can see".
    if (/\(403\)/.test(e.message)) return null;
    throw e;
  }
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

/** Authenticated JSON POST to the backend (used by the 5C-2 route-distance call). Returns {status, json}. */
export async function postJson(path, body, role = "shipper") {
  const token = await _ensureToken(role);
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/** Authenticated GET returning parsed JSON or null (404/403/failure). Used for the stored load view. */
export async function getJson(path, role = "fleet_owner") {
  try { return await _get(path, role); } catch { return null; }
}

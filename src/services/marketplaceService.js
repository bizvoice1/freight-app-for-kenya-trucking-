/**
 * src/services/marketplaceService.js
 * -------------------------------------
 * Phase 4H — client for the real Load -> Booking -> Trip backend chain.
 * Mirrors trackingService.js's shape (real phone+PIN login, real JWT,
 * never a client-trusted id) rather than trackingApi.js's silent demo
 * auto-auth: creating a load or accepting one is a mutating, consequential
 * action, so — like the Driver Tracker — this asks for an explicit login.
 */

// See trackingService.js's identical note: default to whatever host served
// this page, not a hardcoded "localhost", so a portal opened from another
// device on the LAN still reaches the right backend.
const API_BASE = (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL)
  || (typeof window !== "undefined" && `http://${window.location.hostname}:4000`)
  || "http://localhost:4000";
const TOKEN_KEY = "behari_marketplace_token";
const USER_KEY  = "behari_marketplace_user";

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export async function login(phone, pin, role) {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, pin, role }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || "Login failed." };
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    return { ok: true, user: data.user };
  } catch {
    return { ok: false, error: `Could not reach the backend at ${API_BASE}.` };
  }
}

export function getCurrentUser() {
  try {
    if (!getToken()) return null;
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function logout() {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
}

async function request(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const createLoad   = (data) => request("POST", "/api/loads", data);
export const listLoads    = (params = {}) => request("GET", `/api/loads${_qs(params)}`);
export const getLoad      = (loadId) => request("GET", `/api/loads/${loadId}`);
export const acceptLoad   = (loadId) => request("POST", `/api/loads/${loadId}/accept`);

export const listBookings = (params = {}) => request("GET", `/api/bookings${_qs(params)}`);
export const assignBooking   = (bookingId, { truckId, driverId }) => request("POST", `/api/bookings/${bookingId}/assign`, { truckId, driverId });
export const createTripForBooking = (bookingId) => request("POST", `/api/bookings/${bookingId}/create-trip`);

export const listMyTrucks = (ownerId) => request("GET", `/api/trucks${_qs({ ownerId })}`);
export const listDrivers  = () => request("GET", "/api/drivers");

function _qs(params) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ""));
  const qs = new URLSearchParams(clean).toString();
  return qs ? `?${qs}` : "";
}

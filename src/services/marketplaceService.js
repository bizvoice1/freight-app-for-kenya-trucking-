/**
 * src/services/marketplaceService.js
 * -------------------------------------
 * Phase 4H — client for the real Load -> Booking -> Trip backend chain.
 * Mirrors trackingService.js's shape (real phone+PIN login, real JWT,
 * never a client-trusted id) rather than trackingApi.js's silent demo
 * auto-auth: creating a load or accepting one is a mutating, consequential
 * action, so — like the Driver Tracker — this asks for an explicit login.
 */

import { API_BASE, currentSession, authAuthHeader, login as sessionLogin, logout as sessionLogout } from "./session.js";

function authHeaders() { return authAuthHeader(); }

export const login = (phone, pin, role) => sessionLogin(phone, pin, role);
export function getCurrentUser() { return currentSession()?.user ?? null; }
export const logout = sessionLogout;

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

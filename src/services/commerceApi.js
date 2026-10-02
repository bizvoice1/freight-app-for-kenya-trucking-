/**
 * src/services/commerceApi.js
 * ----------------------------
 * 5D-3 — thin client for the backend's commercial authority: loads, offers,
 * bookings and notifications. Every amount/distance the UI shows as binding
 * comes from these responses, never from local state.
 */
import { apiRequest } from "./backendSession.js";

const newKey = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Normalizes {status,json} into {ok, data, error, code}. */
const result = ({ status, json }) => status >= 200 && status < 300
  ? { ok: true, data: json, status }
  : { ok: false, status, error: json?.error || `Request failed (${status}).`, code: json?.code ?? null };

const call = async (role, method, path, body, headers) => {
  try { return result(await apiRequest(role, method, path, body, headers)); }
  catch (err) { return { ok: false, status: 0, error: err?.message || "Network error.", code: "NETWORK" }; }
};

export const fetchOpenLoads   = () => call("fleet_owner", "GET", "/api/loads?status=Open");
export const fetchLoadAs      = (role, id) => call(role, "GET", `/api/loads/${encodeURIComponent(id)}`);
export const fetchShipperLoads = () => call("shipper", "GET", "/api/loads");
export const fetchOffers      = (role) => call(role, "GET", "/api/offers");
export const fetchBookings    = (role) => call(role, "GET", "/api/bookings");
export const fetchNotifications = (role) => call(role, "GET", "/api/notifications");
export const markNotificationRead = (role, id) => call(role, "POST", `/api/notifications/${encodeURIComponent(id)}/read`, {});

export const createBackendLoadRaw = (body) => call("shipper", "POST", "/api/loads", body);
export const acceptPostedPrice = (loadId) => call("fleet_owner", "POST", `/api/loads/${encodeURIComponent(loadId)}/accept`, {});
export const makeOffer = (loadId, amount, note) =>
  call("fleet_owner", "POST", `/api/loads/${encodeURIComponent(loadId)}/offers`, { amount, ...(note ? { note } : {}) }, { "Idempotency-Key": newKey() });
export const counterOffer = (role, offerId, amount, note) =>
  call(role, "POST", `/api/offers/${encodeURIComponent(offerId)}/counter`, { amount, ...(note ? { note } : {}) }, { "Idempotency-Key": newKey() });
export const acceptOffer   = (role, offerId) => call(role, "POST", `/api/offers/${encodeURIComponent(offerId)}/accept`, {});
export const rejectOffer   = (role, offerId, reason) => call(role, "POST", `/api/offers/${encodeURIComponent(offerId)}/reject`, reason ? { reason } : {});
export const withdrawOffer = (role, offerId) => call(role, "POST", `/api/offers/${encodeURIComponent(offerId)}/withdraw`, {});

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

/** Starts an M-Pesa STK push for the booking. Only the phone is sent — the backend decides the amount. */
export const startBookingPayment = (bookingId, phoneNumber) =>
  call("shipper", "POST", `/api/bookings/${encodeURIComponent(bookingId)}/payment`, { phoneNumber });

// 5D-5 — adjustments over the existing 5D-2 contract. No call here ever sends a payable amount for approve/reject/pay.
export const fetchBookingFinance = async (role, bookingId) => {
  const id = encodeURIComponent(bookingId);
  const [ledger, adjustments] = await Promise.all([call(role, "GET", `/api/bookings/${id}/ledger`), call(role, "GET", `/api/bookings/${id}/adjustments`)]);
  return ledger.ok && adjustments.ok ? { ok: true, data: { ledger: ledger.data, adjustments: adjustments.data } } : { ok: false, error: ledger.error || adjustments.error };
};
export const requestAdjustment = (bookingId, amount, reason, reasonCode = "OTHER") =>
  call("fleet_owner", "POST", `/api/bookings/${encodeURIComponent(bookingId)}/adjustments`, { amount, reason, reasonCode });
export const approveAdjustment  = (id) => call("shipper", "POST", `/api/adjustments/${encodeURIComponent(id)}/approve`, {});
export const rejectAdjustment   = (id) => call("shipper", "POST", `/api/adjustments/${encodeURIComponent(id)}/reject`, {});
export const withdrawAdjustment = (id) => call("fleet_owner", "POST", `/api/adjustments/${encodeURIComponent(id)}/withdraw`, {});
export const startAdjustmentPayment = (id, phoneNumber) =>
  call("shipper", "POST", `/api/adjustments/${encodeURIComponent(id)}/payment`, { phoneNumber });

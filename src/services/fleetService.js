/**
 * src/services/fleetService.js
 * -----------------------------
 * 5P-2 — read-only client over the backend fleet (GET /api/trucks, /api/drivers).
 * No local store, no seed, no localStorage. Backend scopes results per role.
 * 5P-3 writes: POST /api/trucks, POST /api/drivers (driver record + login), PUT /api/trucks/:id/driver.
 * Ownership is decided by the backend from the session; nothing is cached locally.
 */
import { API_BASE, authAuthHeader } from "./session.js";

async function _get(path) {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: authAuthHeader() });
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

export const getTrucks  = () => _get("/api/trucks");
export const getDrivers = () => _get("/api/drivers");
export const getTruckById  = async (id) => (await getTrucks()).find(t => t.id === id) || null;
export const getDriverById = async (id) => (await getDrivers()).find(d => d.id === id) || null;

async function _send(method, path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method, headers: { "Content-Type": "application/json", ...authAuthHeader() }, body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, data } : { ok: false, error: data.error || "Request failed.", code: data.code };
  } catch { return { ok: false, error: "Could not reach the backend." }; }
}

export const addTruck  = ({ plate, truckType, capacity }) => _send("POST", "/api/trucks", { plate, truckType, capacity });
export const addDriver = ({ name, phone, pin, licenseNumber, truckId }) => _send("POST", "/api/drivers", { name, phone, pin, licenseNumber, truckId: truckId || undefined });
export const pairDriver = (truckId, driverId) => _send("PUT", `/api/trucks/${encodeURIComponent(truckId)}/driver`, { driverId });

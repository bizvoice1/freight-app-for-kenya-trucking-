/**
 * src/services/routeApi.js
 * -------------------------
 * 5C-3 — the backend owns the one canonical Routes computation per load.
 * The client only posts the load (exact places) and reads back the stored view.
 */
import { postJson, getJson } from "./trackingApi.js";

/** Posts a load to the backend; returns the shipper's exact view or null on any failure. */
export async function createBackendLoad(load) {
  try {
    const { status, json } = await postJson("/api/loads", {
      cargo: load.cargo, origin: load.from, destination: load.to,
      weight: load.weight, truckType: load.truck, price: load.pay, pickupDate: load.pickD,
      pickup: load.pickup, delivery: load.delivery,
    }, "shipper");
    return status === 201 ? json : null;
  } catch { return null; }
}

/** Fetches a load through the API's privacy boundary as the given role. */
export const fetchBackendLoad = (id, role = "fleet_owner") =>
  getJson(`/api/loads/${encodeURIComponent(id)}`, role);

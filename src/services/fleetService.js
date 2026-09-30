/**
 * src/services/fleetService.js
 * -----------------------------
 * The Fleet Assignment Engine (Phase 4B) — mirrors loadService.js's and
 * matchingService.js's contract: every exported function returns a Promise,
 * the module holds an in-memory store persisted to localStorage, zero React
 * imports.
 *
 * This service owns exactly one relationship:
 *
 *   FleetOwner ── Truck.ownerId
 *   Truck.currentDriverId  <──── assignDriverToTruck ────>  Driver.assignedTruckId
 *
 * IMPORTANT — what this service deliberately does NOT do:
 *   Assigning a driver to a truck is a standalone fact ("this person may
 *   currently operate this vehicle"). It is NOT a booking, NOT a trip, and
 *   NOT a GPS event. This service never imports loadService.js or
 *   gpsService.js, never touches Load status, and never creates a location
 *   record — assignDriverToTruck()/unassignDriverFromTruck() only ever
 *   return the updated Truck/Driver objects. Trip creation (Phase 4C) reads
 *   a truck's currentDriverId at booking time to know who's driving; it does
 *   not go through this service to do so.
 */

import { FLEET_SEED_TRUCKS, FLEET_SEED_DRIVERS, DEMO_FLEET_OWNER } from "../data/fleetSeed.js";
import { TRUCK_STATUS } from "../models/truck.js";
import { DRIVER_STATUS } from "../models/driver.js";

const STORE_KEY = "behari_fleet_v1";

const _store = {
  trucks:  FLEET_SEED_TRUCKS.map(t => ({ ...t })),
  drivers: FLEET_SEED_DRIVERS.map(d => ({ ...d })),
};

function _persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(_store)); } catch { /* ignore */ }
}

function _hydrate() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.trucks)  _store.trucks  = saved.trucks;
    if (saved.drivers) _store.drivers = saved.drivers;
  } catch { /* corrupted storage — start fresh */ }
}
_hydrate();

/* ── Internal helpers ───────────────────────────────────────────────────── */

function _findTruck(truckId) {
  return _store.trucks.find(t => t.id === truckId) || null;
}

function _findDriver(driverId) {
  return _store.drivers.find(d => d.id === driverId) || null;
}

/* ── READ operations ────────────────────────────────────────────────────── */

export function getFleetOwners() {
  return Promise.resolve([DEMO_FLEET_OWNER]);
}

export function getTrucks() {
  return Promise.resolve([..._store.trucks]);
}

export function getDrivers() {
  return Promise.resolve([..._store.drivers]);
}

export function getTruckById(truckId) {
  return Promise.resolve(_findTruck(truckId));
}

export function getDriverById(driverId) {
  return Promise.resolve(_findDriver(driverId));
}

/* ── Assignment engine ──────────────────────────────────────────────────── */

/**
 * Assigns a Driver to a Truck. Explicit two-sided write: both
 * truck.currentDriverId and driver.assignedTruckId are updated together, or
 * neither is (all invariant checks happen before any mutation).
 *
 * Enforced invariants:
 *   - truck and driver must both exist
 *   - a Maintenance truck cannot receive a driver
 *   - an Off-Duty driver cannot be assigned
 *   - a driver already assigned to a DIFFERENT truck cannot be reassigned
 *     here — unassignDriverFromTruck() must be called first
 *   - a truck that already has a DIFFERENT driver cannot receive a second
 *
 * Assigning does NOT put the truck "on a trip" — status moves to
 * TRUCK_STATUS.ASSIGNED / DRIVER_STATUS.ASSIGNED, not ON_TRIP. Trip
 * execution is a separate concept (Phase 4C).
 *
 * @param {string} truckId
 * @param {string} driverId
 * @returns {Promise<{truck:Object, driver:Object}>}
 */
export function assignDriverToTruck(truckId, driverId) {
  const truck  = _findTruck(truckId);
  const driver = _findDriver(driverId);

  if (!truck)  return Promise.reject(new Error(`No truck found with id ${truckId}.`));
  if (!driver) return Promise.reject(new Error(`No driver found with id ${driverId}.`));

  if (truck.status === TRUCK_STATUS.MAINTENANCE) {
    return Promise.reject(new Error(`Truck ${truck.plate} is under maintenance and cannot receive a driver.`));
  }
  if (driver.status === DRIVER_STATUS.OFF_DUTY) {
    return Promise.reject(new Error(`${driver.name} is off duty and cannot be assigned.`));
  }
  if (driver.assignedTruckId && driver.assignedTruckId !== truckId) {
    return Promise.reject(new Error(`${driver.name} is already assigned to another truck. Unassign first.`));
  }
  if (truck.currentDriverId && truck.currentDriverId !== driverId) {
    return Promise.reject(new Error(`Truck ${truck.plate} already has a driver assigned. Unassign first.`));
  }

  truck.currentDriverId  = driverId;
  truck.status           = TRUCK_STATUS.ASSIGNED;
  driver.assignedTruckId = truckId;
  driver.status          = DRIVER_STATUS.ASSIGNED;

  _persist();
  return Promise.resolve({ truck: { ...truck }, driver: { ...driver } });
}

/**
 * Clears the assignment on both sides. Idempotent: calling this on a truck
 * that already has no driver simply resolves with the truck unchanged and
 * driver:null, rather than rejecting.
 *
 * @param {string} truckId
 * @returns {Promise<{truck:Object, driver:Object|null}>}
 */
export function unassignDriverFromTruck(truckId) {
  const truck = _findTruck(truckId);
  if (!truck) return Promise.reject(new Error(`No truck found with id ${truckId}.`));

  // Already has no driver (includes a Maintenance truck, which can never
  // reach this point with a driver attached) — no-op, don't touch status.
  if (!truck.currentDriverId) {
    return Promise.resolve({ truck: { ...truck }, driver: null });
  }

  const driver = _findDriver(truck.currentDriverId);

  truck.currentDriverId = null;
  truck.status          = TRUCK_STATUS.AVAILABLE;
  if (driver) {
    driver.assignedTruckId = null;
    driver.status          = DRIVER_STATUS.AVAILABLE;
  }

  _persist();
  return Promise.resolve({ truck: { ...truck }, driver: driver ? { ...driver } : null });
}

/**
 * src/data/fleetSeed.js
 * ---------------------
 * Canonical fleet seed data for the Truck/Driver assignment engine
 * (Phase 4B) — one FleetOwner, a normalized set of Trucks, and a set of
 * Drivers, consumed by services/fleetService.js.
 *
 * ARCHITECTURE NOTE — why this file exists instead of reusing
 * CARRIER_FLEET_SEED directly (data/fleet.js):
 *
 *   Consumers checked before writing this file:
 *     - behari-freight-v2.jsx imports CARRIER_FLEET_SEED directly for two
 *       read-only UI lists: the BookModal's truck-selection step (reads
 *       .id, .plate, .type, .year, .status) and TruckAvailabilityForm
 *       (reads .plate, .type). Neither writes back to it.
 *     - behari-freight-v2.jsx ALSO has its own, entirely separate,
 *       localStorage-backed fleet ("behari_carrier_fleet", seeded with the
 *       same 3 trucks inline) used by the Account tab's Add/Remove Truck
 *       UI and the public-profile modal. That copy never imports
 *       data/fleet.js at all — it's a pre-existing, disconnected duplicate
 *       of CARRIER_FLEET_SEED, not something Phase 4B introduces. Flagged
 *       for a later cleanup pass; out of scope for the assignment engine.
 *
 *   CARRIER_FLEET_SEED's shape — { id, plate, type, year, status } — has no
 *   ownerId, no capacity, no currentDriverId, no currentLocation. Those are
 *   exactly the fields models/truck.js's Truck was designed to add. Rather
 *   than force CARRIER_FLEET_SEED to become the canonical source (option A)
 *   or invent an unrelated new roster (option B), this file NORMALIZES
 *   CARRIER_FLEET_SEED's existing 3 trucks through createTruck() — same
 *   ids' real-world plates carry over, nothing is renamed or reinvented —
 *   and adds the two demo records (one Maintenance truck, one Off-Duty
 *   driver) needed to exercise the invariant tests that CARRIER_FLEET_SEED
 *   has no equivalent of today.
 *
 *   data/fleet.js itself is untouched: its existing consumers keep working
 *   exactly as they do now. This file is purely additive.
 */

import { CARRIER_FLEET_SEED } from "./fleet.js";
import { createFleetOwner } from "../../../../src/models/fleetOwner.js";
import { createTruck, TRUCK_STATUS } from "../../../../src/models/truck.js";
import { createDriver, DRIVER_STATUS } from "../../../../src/models/driver.js";

/** The demo account's single fleet owner — matches App.jsx's MY_CARRIER_NAME. */
export const DEMO_FLEET_OWNER = createFleetOwner(
  { name: "James Mwangi", phone: "0722100200" },
  0
);

// CARRIER_FLEET_SEED's own status strings ("Available"/"On Trip") map 1:1
// onto TRUCK_STATUS's values, so they pass through unchanged.
const _normalizedTrucks = CARRIER_FLEET_SEED.map((t, i) =>
  createTruck(
    {
      plate:     t.plate,
      truckType: t.type,
      ownerId:   DEMO_FLEET_OWNER.id,
      status:    t.status === "On Trip" ? TRUCK_STATUS.ON_TRIP : TRUCK_STATUS.AVAILABLE,
    },
    i
  )
);

/**
 * Canonical Truck seed: CARRIER_FLEET_SEED's 3 trucks, normalized, plus one
 * additional Maintenance-status truck (needed to exercise the "Maintenance
 * trucks cannot receive a driver" invariant — CARRIER_FLEET_SEED has no
 * maintenance truck of its own).
 */
export const FLEET_SEED_TRUCKS = [
  ..._normalizedTrucks,
  createTruck(
    { plate: "KKX 550D", truckType: "Lowbed", ownerId: DEMO_FLEET_OWNER.id, status: TRUCK_STATUS.MAINTENANCE },
    _normalizedTrucks.length
  ),
];

/**
 * Canonical Driver seed. Includes one Off-Duty driver (needed to exercise
 * the "Off-duty drivers cannot be assigned" invariant).
 */
export const FLEET_SEED_DRIVERS = [
  createDriver({ name: "Samuel Kamau",  phone: "0733111222" }, 0),
  createDriver({ name: "Peter Otieno",  phone: "0733222333" }, 1),
  createDriver({ name: "James Mwangi",  phone: "0722100200" }, 2), // owner-operator: also drives
  createDriver({ name: "Grace Wanjiru", phone: "0733444555" }, 3),
].map(d => d.name === "Grace Wanjiru" ? { ...d, status: DRIVER_STATUS.OFF_DUTY } : d);

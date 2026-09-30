/**
 * backend/src/db/seed.js
 * ------------------------
 * Phase 4F — seeds the backend database from the SAME demo data the
 * frontend has used since Phase 4B, rather than inventing a second,
 * disconnected roster. src/data/fleetSeed.js and its models/*.js factories
 * are zero-React, zero-DOM plain JS (documented as importable from Node
 * since Phase 4A) — this is that design paying off.
 */

import bcrypt from "bcryptjs";
import { db, sqlite } from "./client.js";
import { fleetOwners, trucks, drivers, trips, users } from "./schema.js";
import { DEMO_FLEET_OWNER, FLEET_SEED_TRUCKS, FLEET_SEED_DRIVERS } from "../../../src/data/fleetSeed.js";
import { createTrip, TRIP_STATUS } from "../../../src/models/trip.js";

const DEV_PIN = "1234"; // documented dev-only PIN for every seeded login — see backend/README.md

function driverByName(name) {
  return FLEET_SEED_DRIVERS.find(d => d.name === name);
}

async function seed() {
  const pinHash = await bcrypt.hash(DEV_PIN, 10);

  db.insert(fleetOwners).values({
    id: DEMO_FLEET_OWNER.id,
    name: DEMO_FLEET_OWNER.name,
    phone: DEMO_FLEET_OWNER.phone,
    company: DEMO_FLEET_OWNER.company || null,
  }).onConflictDoNothing().run();

  const james = driverByName("James Mwangi");
  const peter = driverByName("Peter Otieno");
  const kdj   = FLEET_SEED_TRUCKS.find(t => t.plate === "KDJ 441Z");

  for (const t of FLEET_SEED_TRUCKS) {
    // Seed one live assignment (James -> KDJ 441Z) so the location/tracking
    // endpoints have a real, already-active trip to exercise end-to-end,
    // matching the exact scenario already demonstrated on the frontend.
    const isKdj = t.id === kdj.id;
    db.insert(trucks).values({
      id: t.id,
      plate: t.plate,
      truckType: t.truckType,
      capacity: t.capacity || null,
      ownerId: t.ownerId,
      currentDriverId: isKdj ? james.id : t.currentDriverId,
      status: isKdj ? "Assigned" : t.status,
      currentLat: t.currentLocation?.lat ?? null,
      currentLng: t.currentLocation?.lng ?? null,
    }).onConflictDoNothing().run();
  }

  for (const d of FLEET_SEED_DRIVERS) {
    const isJames = d.id === james.id;
    db.insert(drivers).values({
      id: d.id,
      name: d.name,
      phone: d.phone || null,
      licenseNumber: d.licenseNumber || null,
      assignedTruckId: isJames ? kdj.id : d.assignedTruckId,
      status: isJames ? "Assigned" : d.status,
    }).onConflictDoNothing().run();
  }

  // One demo trip: mirrors the exact scenario proven end-to-end on the
  // frontend in Phase 4E (James driving KDJ 441Z on load KE-2039).
  // Trip CREATION itself stays a frontend/tripService.js concern for now —
  // there's no POST /api/trips in this phase's endpoint list — this seed
  // exists purely so the location/tracking endpoints have real data.
  const demoTrip = createTrip(
    { loadId: "KE-2039", bookingId: "seed-booking-1", truckId: kdj.id, driverId: james.id, pickup: "Nairobi EPZ", delivery: "Kampala" },
    0
  );
  db.insert(trips).values({
    ...demoTrip,
    status: TRIP_STATUS.DISPATCHED,
    startedAt: demoTrip.createdAt,
  }).onConflictDoNothing().run();

  // One login per seeded driver, plus a shipper and an admin dev account —
  // enough to exercise every role's auth path without a real signup flow.
  const seedUsers = [
    { id: "USR-1000", phone: james.phone, role: "driver",      name: james.name,     driverId: james.id },
    { id: "USR-1001", phone: peter.phone, role: "driver",      name: peter.name,     driverId: peter.id },
    { id: "USR-1002", phone: "0700000001", role: "shipper",    name: "Demo Shipper", driverId: null },
    { id: "USR-1003", phone: "0700000002", role: "admin",      name: "Demo Admin",   driverId: null },
    { id: "USR-1004", phone: DEMO_FLEET_OWNER.phone, role: "fleet_owner", name: DEMO_FLEET_OWNER.name, driverId: null },
  ];

  for (const u of seedUsers) {
    db.insert(users).values({ ...u, pinHash }).onConflictDoNothing().run();
  }

  console.log(`Seeded ${FLEET_SEED_TRUCKS.length} trucks, ${FLEET_SEED_DRIVERS.length} drivers, ${seedUsers.length} users.`);
  console.log(`Dev login PIN for every seeded user: ${DEV_PIN}`);
  console.table(seedUsers.map(u => ({ phone: u.phone, role: u.role, name: u.name })));
}

seed().then(() => sqlite.close()).catch(err => { console.error(err); sqlite.close(); process.exit(1); });

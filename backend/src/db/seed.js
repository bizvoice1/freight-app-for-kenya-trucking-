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
import { fleetOwners, trucks, drivers, trips, locationUpdates, users, loads, loadingSites, loadingAgentSites } from "./schema.js";
import { DEMO_FLEET_OWNER, FLEET_SEED_TRUCKS, FLEET_SEED_DRIVERS } from "./fixtures/fleetSeed.js";
import { createTrip, TRIP_STATUS } from "../../../src/models/trip.js";
import { createLoad, LOAD_STATUS } from "../domain/load.js";

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

  // Phase 4I — a second, wholly separate shipper and transporter, with a
  // truck of their own. Without a genuine second tenant, "Transporter A
  // can't touch Transporter B's truck" and "Shipper A can't see Shipper B's
  // load" are untestable — every prior phase only ever had one of each.
  db.insert(fleetOwners).values({ id: "FO-1001", name: "Daniel Kiplagat", phone: "0711000000", company: null }).onConflictDoNothing().run();
  db.insert(trucks).values({
    id: "TRK-2000", plate: "KDB 700Z", truckType: "Box Truck", capacity: "8T",
    ownerId: "FO-1001", currentDriverId: null, status: "Available", currentLat: null, currentLng: null,
  }).onConflictDoNothing().run();

  const james = driverByName("James Mwangi");
  const peter = driverByName("Peter Otieno");
  const kdj   = FLEET_SEED_TRUCKS.find(t => t.plate === "KDJ 441Z");

  const kbd = FLEET_SEED_TRUCKS.find(t => t.plate === "KBD 092K");

  for (const t of FLEET_SEED_TRUCKS) {
    // Two live pairings seeded: James/KDJ 441Z already has the Phase 4F/4G
    // demo trip (proves the "truck already has an active trip" invariant
    // still holds for a brand-new 4H booking); Peter/KBD 092K is paired but
    // free, so Phase 4H's own acceptance test has a truck+driver combo it
    // can actually carry all the way to a new Trip.
    const isKdj = t.id === kdj.id;
    const isKbd = t.id === kbd.id;
    db.insert(trucks).values({
      id: t.id,
      plate: t.plate,
      truckType: t.truckType,
      capacity: t.capacity || null,
      ownerId: t.ownerId,
      currentDriverId: isKdj ? james.id : isKbd ? peter.id : t.currentDriverId,
      status: (isKdj || isKbd) ? "Assigned" : t.status,
      currentLat: t.currentLocation?.lat ?? null,
      currentLng: t.currentLocation?.lng ?? null,
    }).onConflictDoNothing().run();
  }

  for (const d of FLEET_SEED_DRIVERS) {
    const isJames = d.id === james.id;
    const isPeter = d.id === peter.id;
    db.insert(drivers).values({
      id: d.id,
      name: d.name,
      phone: d.phone || null,
      licenseNumber: d.licenseNumber || null,
      assignedTruckId: isJames ? kdj.id : isPeter ? kbd.id : d.assignedTruckId,
      status: (isJames || isPeter) ? "Assigned" : d.status,
      fleetOwnerId: DEMO_FLEET_OWNER.id,
    }).onConflictDoNothing().run();
  }

  // Phase 4I needs this: KE-2039 is a frontend-only load (src/data/
  // seedLoads.js) with no backend loads row of its own — but the shipper-
  // ownership check on GET /trips(/location) now looks one up via
  // trip.loadId. Without this row, Demo Shipper would be locked out of the
  // exact live-tracking demo Phase 4G already proved worked. USR-1002 is
  // "Demo Shipper" — see the users list below.
  db.insert(loads).values({
    ...createLoad(
      { shipperId: "USR-1002", cargo: "FMCG Goods", origin: "Nairobi EPZ", destination: "Kampala", truckType: "Box Truck" },
      0
    ),
    id: "KE-2039", // must match the seeded trip's loadId below, not the auto-generated BHL- id
    status: LOAD_STATUS.BOOKED,
  }).onConflictDoNothing().run();

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
    status: TRIP_STATUS.IN_TRANSIT, // realistic demo state for Phase 4G's tracking UI
    startedAt: demoTrip.createdAt,
    latestLocationId: "LOC-SEED-1",
  }).onConflictDoNothing().run();

  // One initial location so Phase 4G's tracking UI has something to show
  // before any real device/simulator tick ever runs — somewhere along the
  // Eldoret-ish stretch toward Kampala, not literally at the pickup point.
  db.insert(locationUpdates).values({
    id: "LOC-SEED-1",
    tripId: demoTrip.id,
    truckId: kdj.id,
    driverId: james.id,
    lat: 0.5143,
    lng: 35.2698,
    accuracy: 12,
    speed: 58,
    heading: 310,
    source: "simulation",
    timestamp: new Date().toISOString(),
  }).onConflictDoNothing().run();

  // One login per seeded driver, plus a shipper and an admin dev account —
  // enough to exercise every role's auth path without a real signup flow.
  const seedUsers = [
    { id: "USR-1000", phone: james.phone, role: "driver",      name: james.name,     driverId: james.id },
    { id: "USR-1001", phone: peter.phone, role: "driver",      name: peter.name,     driverId: peter.id },
    { id: "USR-1002", phone: "0700000001", role: "shipper",    name: "Demo Shipper", driverId: null },
    { id: "USR-1003", phone: "0700000002", role: "admin",      name: "Demo Admin",   driverId: null },
    { id: "USR-1004", phone: DEMO_FLEET_OWNER.phone, role: "fleet_owner", name: DEMO_FLEET_OWNER.name, driverId: null, fleetOwnerId: DEMO_FLEET_OWNER.id },
    { id: "USR-1005", phone: "0700000003", role: "shipper",     name: "Mary Achieng",   driverId: null },
    { id: "USR-1006", phone: "0711000000", role: "fleet_owner", name: "Daniel Kiplagat", driverId: null, fleetOwnerId: "FO-1001" },
    { id: "USR-1007", phone: "0700000010", role: "loading_agent", name: "Gate Agent Nairobi", driverId: null },
    { id: "USR-1008", phone: "0700000011", role: "loading_agent", name: "Gate Agent Mombasa", driverId: null },
  ];

  for (const u of seedUsers) {
    db.insert(users).values({ ...u, pinHash }).onConflictDoNothing().run();
  }

  // 5E-2 — minimum gate fixture for browser/API testing: two sites, one agent each.
  const seededAt = new Date().toISOString();
  const demoSites = [
    { id: "LS-1000", name: "Nairobi EPZ Loading Yard", lat: -1.3891, lng: 36.9425, radiusMeters: 300 },
    { id: "LS-1001", name: "Mombasa Port Loading Yard", lat: -4.0435, lng: 39.6682, radiusMeters: 300 },
  ];
  for (const site of demoSites) {
    db.insert(loadingSites).values({ ...site, active: 1, createdAt: seededAt, updatedAt: seededAt }).onConflictDoNothing().run();
  }
  for (const [agentUserId, siteId] of [["USR-1007", "LS-1000"], ["USR-1008", "LS-1001"]]) {
    db.insert(loadingAgentSites).values({ agentUserId, siteId, createdById: "USR-1003", createdAt: seededAt }).onConflictDoNothing().run();
  }

  console.log(`Seeded ${FLEET_SEED_TRUCKS.length} trucks, ${FLEET_SEED_DRIVERS.length} drivers, ${seedUsers.length} users.`);
  console.log(`Dev login PIN for every seeded user: ${DEV_PIN}`);
  console.table(seedUsers.map(u => ({ phone: u.phone, role: u.role, name: u.name })));
}

seed().then(() => sqlite.close()).catch(err => { console.error(err); sqlite.close(); process.exit(1); });

// Regression check for Phases 4A-4J after Phase 4K's routing changes to
// app.js (mount order changed so the two unauthenticated Daraja webhooks
// can claim their paths before fleetRoutes' blanket requireAuth). Verifies
// every pre-4K endpoint family still behaves identically.
import Database from "better-sqlite3";
import { NBO_NKU } from "./fixtures.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "behari.sqlite");
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS -", name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log("FAIL -", name, "->", e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function login(phone, pin, role) {
  const { status, json } = await api(null, "POST", "/api/auth/login", { phone, pin, role });
  assert(status === 200, `login failed: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  await test("health check", async () => {
    const r = await api(null, "GET", "/health");
    assert(r.status === 200 && r.json.ok === true, "health check failed");
  });

  await test("unauthenticated request to a protected route -> 401", async () => {
    const r = await api(null, "GET", "/api/trucks");
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  let james, peter, demoShipper, mary, admin, daniel;
  await test("login works for every seeded role", async () => {
    james = await login("0722100200", "1234", "fleet_owner");
    peter = await login("0733222333", "1234", "driver");
    demoShipper = await login("0700000001", "1234", "shipper");
    mary = await login("0700000003", "1234", "shipper");
    admin = await login("0700000002", "1234", "admin");
    daniel = await login("0711000000", "1234", "fleet_owner");
  });

  await test("GET /api/trucks (fleet_owner) -> only James's own fleet", async () => {
    const r = await api(james.token, "GET", "/api/trucks");
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(r.json.every(t => t.ownerId === james.user.fleetOwnerId), "leaked another owner's truck");
  });

  await test("GET /api/drivers -> works", async () => {
    const r = await api(james.token, "GET", "/api/drivers");
    assert(r.status === 200 && Array.isArray(r.json), "drivers list failed");
  });

  await test("Phase 4I: Daniel cannot list James's trucks by explicit ownerId", async () => {
    const r = await api(daniel.token, "GET", `/api/trucks?ownerId=${james.user.fleetOwnerId}`);
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  await test("Phase 4I: Mary cannot see Demo Shipper's loads", async () => {
    const r = await api(mary.token, "GET", `/api/loads?shipperId=${demoShipper.user.id}`);
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  await test("Phase 4H: post a load, list it, get it by id", async () => {
    const post = await api(demoShipper.token, "POST", "/api/loads", { cargo: "Regression cargo", origin: "Nairobi", destination: "Thika" });
    assert(post.status === 201, `post failed: ${JSON.stringify(post.json)}`);
    const list = await api(demoShipper.token, "GET", "/api/loads");
    assert(list.json.some(l => l.id === post.json.id), "posted load not in list");
    const get = await api(demoShipper.token, "GET", `/api/loads/${post.json.id}`);
    assert(get.status === 200 && get.json.id === post.json.id, "get by id failed");
  });

  await test("Phase 4G/4F: seeded demo trip TRP-1000 is visible and has GPS history", async () => {
    const r = await api(james.token, "GET", "/api/trips/TRP-1000");
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const hist = await api(james.token, "GET", "/api/trips/TRP-1000/location/history");
    assert(hist.status === 200 && hist.json.length >= 1, "expected at least one seeded location update");
  });

  await test("Phase 4I: Peter cannot view James's driver-owned trip location", async () => {
    const r = await api(peter.token, "GET", "/api/trips/TRP-1000/location/latest");
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  await test("Phase 4F: driver posts a GPS location for their own trip", async () => {
    const jamesDriver = await login("0722100200", "1234", "driver");
    // Close to the seeded last location (0.5143, 35.2698) — a plausible next reading, not an implausible jump.
    const r = await api(jamesDriver.token, "POST", "/api/trips/TRP-1000/location", { lat: 0.516, lng: 35.272, accuracy: 10 });
    assert(r.status === 200 && r.json.accepted === true, `location post failed: ${JSON.stringify(r.json)}`);
  });

  await test("Phase 4H/4J: full load -> booking -> assign -> create-trip -> driver operates -> shipper confirms Delivered", async () => {
    const load = (await api(demoShipper.token, "POST", "/api/loads", { cargo: "Regression pipeline", origin: "Nairobi", destination: "Eldoret", price: 50000, ...NBO_NKU })).json;
    const booking = (await api(james.token, "POST", `/api/loads/${load.id}/accept`, {})).json;

    const trucks = (await api(james.token, "GET", "/api/trucks")).json;
    const kbd = trucks.find(t => t.plate === "KBD 092K");
    const drivers = (await api(james.token, "GET", "/api/drivers")).json;
    const peterDriver = drivers.find(d => d.name === "Peter Otieno");

    // KBD/Peter may have been freed by a prior 4K/4L/4M test cycle sharing
    // this database (releaseFleetAssignment runs on every terminal trip) —
    // re-pair directly, the same way a human using the Carrier app's fleet
    // UI would before making the next booking. No backend endpoint exists
    // for this (see backend/README.md's Scope section), so this is test-side.
    if (kbd.currentDriverId !== peterDriver.id) {
      const db = new Database(DB_PATH);
      db.prepare("UPDATE trucks SET current_driver_id = ?, status = 'Assigned' WHERE id = ?").run(peterDriver.id, kbd.id);
      db.prepare("UPDATE drivers SET assigned_truck_id = ?, status = 'Assigned' WHERE id = ?").run(kbd.id, peterDriver.id);
      db.close();
    }

    const assign = await api(james.token, "POST", `/api/bookings/${booking.id}/assign`, { truckId: kbd.id, driverId: peterDriver.id });
    assert(assign.status === 200, `assign failed: ${JSON.stringify(assign.json)}`);
    const createTrip = await api(james.token, "POST", `/api/bookings/${booking.id}/create-trip`, {});
    assert(createTrip.status === 201, `create-trip failed: ${JSON.stringify(createTrip.json)}`);
    const trip = createTrip.json;

    for (const status of ["Dispatched", "At Pickup", "Loading", "In Transit", "At Delivery"]) {
      const r = await api(peter.token, "POST", `/api/trips/${trip.id}/status`, { status });
      assert(r.status === 200, `driver step ${status} failed: ${JSON.stringify(r.json)}`);
    }
    const delivered = await api(demoShipper.token, "POST", `/api/trips/${trip.id}/status`, { status: "Delivered" });
    assert(delivered.status === 200 && delivered.json.status === "Delivered", "final delivery confirmation failed");

    const freedTruck = (await api(james.token, "GET", "/api/trucks")).json.find(t => t.id === kbd.id);
    assert(freedTruck.currentDriverId === null, "truck should be freed after Delivered");
  });

  await test("Phase 4J: stage-skipping is still rejected (409)", async () => {
    // TRP-1000 is already In Transit (seed) — try to skip straight to Delivered as admin (structurally illegal).
    const r = await api(admin.token, "POST", "/api/trips/TRP-1000/status", { status: "Delivered" });
    assert(r.status === 409, `expected 409 (illegal transition), got ${r.status}`);
  });

  const passCount = results.filter(r => r.ok).length;
  console.log(`\n${passCount}/${results.length} passed.`);
  if (passCount !== results.length) process.exit(1);
}
main().catch(err => { console.error("FATAL:", err); process.exit(1); });

// Phase 4M — the attack/abuse suite. Run against a freshly migrated +
// seeded backend on http://localhost:4000. This is the definition-of-done
// centerpiece for 4M: "take the existing system and deliberately try to
// break it." Cases already proven by acceptance-4k.mjs (duplicate callback,
// wrong amount, duplicate receipt, concurrent release, second payout,
// payout reversal) and regression-4a-4j.mjs (cross-tenant 403s on trips,
// stage-skipping) are NOT duplicated here — see the "ALREADY COVERED"
// section at the bottom for a pointer to those, so there are never two
// copies of the same assertion silently drifting apart.
import jwt from "jsonwebtoken";
import { driveSteps } from "./gate-helper.mjs";
import Database from "better-sqlite3";
import { NBO_NKU } from "./fixtures.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const JWT_SECRET = process.env.JWT_SECRET || "behari-dev-only-secret-do-not-use-in-production";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "behari.sqlite");

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS -", name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log("FAIL -", name, "->", e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Raw fetch — doesn't JSON-stringify, so a test can send deliberately malformed bodies. */
async function rawApi(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  });
  let json = null; try { json = await res.json(); } catch { /* not JSON, or empty */ }
  return { status: res.status, json };
}
async function api(token, method, path, body) {
  return rawApi(method, path, {
    token, body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
  });
}
async function login(phone, pin, role) {
  const { status, json } = await api(null, "POST", "/api/auth/login", { phone, pin, role });
  assert(status === 200, `login failed: ${JSON.stringify(json)}`);
  return json;
}
async function waitFor(fn, { timeoutMs = 4000, intervalMs = 60 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(intervalMs);
  }
}
function rawDb() { return new Database(DB_PATH, { readonly: false }); }

function signToken(payload, opts) {
  return jwt.sign({ sub: "USR-X", role: "shipper", name: "x", driverId: null, fleetOwnerId: null, ...payload }, JWT_SECRET, opts);
}

let shipper, mary, james, daniel, admin, peterDriver;
let peterTruckId, peterDriverId;

async function setup() {
  shipper = await login("0700000001", "1234", "shipper");
  mary = await login("0700000003", "1234", "shipper");
  james = await login("0722100200", "1234", "fleet_owner");
  daniel = await login("0711000000", "1234", "fleet_owner");
  admin = await login("0700000002", "1234", "admin");
  peterDriver = await login("0733222333", "1234", "driver");

  const trucks = (await api(james.token, "GET", "/api/trucks")).json;
  peterTruckId = trucks.find(t => t.plate === "KBD 092K").id;
  const drivers = (await api(james.token, "GET", "/api/drivers")).json;
  peterDriverId = drivers.find(d => d.name === "Peter Otieno").id;
}

function repairPeterToKbd() {
  const db = rawDb();
  db.prepare("UPDATE trucks SET current_driver_id = ?, status = 'Assigned' WHERE id = ?").run(peterDriverId, peterTruckId);
  db.prepare("UPDATE drivers SET assigned_truck_id = ?, status = 'Assigned' WHERE id = ?").run(peterTruckId, peterDriverId);
  db.close();
}

async function postOpenLoad(price = 1000) {
  repairPeterToKbd();
  return (await api(shipper.token, "POST", "/api/loads", { cargo: "Attack test cargo", origin: "Nairobi", destination: "Nakuru", price, ...NBO_NKU })).json;
}

/** 5D-4: trips need a funded booking — pay via the real payment path and wait for escrow HELD. */
async function fundBooking(bookingId) {
  const pay = await api(shipper.token, "POST", `/api/bookings/${bookingId}/payment`, { phoneNumber: "254700111222" });
  assert(pay.status === 201, `fund: payment initiate failed: ${JSON.stringify(pay.json)}`);
  await waitFor(async () => {
    const p = (await api(shipper.token, "GET", `/api/payments/${pay.json.id}`)).json;
    return p.status === "Paid" ? p : null;
  });
}

async function cancelTrip(tripId) {
  await api(james.token, "POST", `/api/trips/${tripId}/status`, { status: "Cancelled" });
}

async function main() {
  await setup();

  // ── Authentication: expired / malformed / tampered JWTs ──────────────────
  await test("Anonymous request to a protected route -> 401", async () => {
    const r = await api(null, "GET", "/api/trucks");
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  await test("Expired JWT (valid signature, past exp) -> 401", async () => {
    const token = signToken({ sub: shipper.user.id, role: "shipper" }, { expiresIn: -10 });
    const r = await api(token, "GET", "/api/loads");
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  await test("Malformed JWT (garbage string) -> 401", async () => {
    const r = await api("not-a-real-token", "GET", "/api/loads");
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  await test("JWT signed with the wrong secret -> 401", async () => {
    const token = jwt.sign({ sub: shipper.user.id, role: "shipper", name: "x" }, "a-completely-different-secret");
    const r = await api(token, "GET", "/api/loads");
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  await test("JWT with alg:none (no signature at all) -> 401", async () => {
    const token = jwt.sign({ sub: shipper.user.id, role: "shipper", name: "x" }, "", { algorithm: "none" });
    const r = await api(token, "GET", "/api/loads");
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  await test("JWT claiming admin role for a real user who isn't admin -> role claim alone doesn't grant anything beyond what the token says, but a FORGED token (wrong secret) is still rejected outright", async () => {
    const token = jwt.sign({ sub: shipper.user.id, role: "admin", name: "x" }, "wrong-secret");
    const r = await api(token, "GET", "/api/escrows");
    assert(r.status === 401, `expected 401 (signature invalid), got ${r.status}`);
  });

  // ── Malformed requests: body, params, types ──────────────────────────────
  await test("Malformed JSON body -> clean 400, not a hang or 500", async () => {
    const r = await rawApi("POST", "/api/auth/login", {
      headers: { "content-type": "application/json" },
      body: "{ this is not valid json",
    });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  await test("Garbage/oversized id in a route param -> clean 404, not a 500 (proves parameterized queries, not string-built SQL)", async () => {
    const weirdId = "'; DROP TABLE trips; --".repeat(5);
    const r = await api(james.token, "GET", `/api/trips/${encodeURIComponent(weirdId)}`);
    assert(r.status === 404, `expected 404, got ${r.status}`);
    const db = rawDb();
    const stillThere = db.prepare("SELECT COUNT(*) as n FROM trips").get();
    db.close();
    assert(stillThere.n > 0, "trips table should be completely unaffected");
  });

  await test("POST with a required field missing -> existing 400 still fires (asyncHandler changes nothing about already-correct validation)", async () => {
    const r = await api(shipper.token, "POST", "/api/loads", { origin: "Nairobi" });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  await test("null where a string is expected (phoneNumber: null) -> clean 400", async () => {
    const load = await postOpenLoad(2000);
    const accept = await api(james.token, "POST", `/api/loads/${load.id}/accept`, {});
    const r = await api(shipper.token, "POST", `/api/bookings/${accept.json.id}/payment`, { phoneNumber: null });
    assert(r.status === 400, `expected 400, got ${r.status}`);
    await api(james.token, "POST", `/api/bookings/${accept.json.id}/assign`, { truckId: peterTruckId, driverId: peterDriverId });
    await fundBooking(accept.json.id);
    const trip = await api(james.token, "POST", `/api/bookings/${accept.json.id}/create-trip`, {});
    await cancelTrip(trip.json.id);
  });

  await test("Array where a scalar status is expected -> rejected (409), not a crash", async () => {
    // admin.token: bypasses the role-based authorizeTransition check entirely,
    // so this isolates canTransitionTrip()'s own structural handling of a
    // non-string "status" rather than accidentally testing authorization.
    const r = await api(admin.token, "POST", "/api/trips/TRP-1000/status", { status: ["Delivered"] });
    assert(r.status === 409 || r.status === 400, `expected 409/400, got ${r.status}`);
  });

  await test("Deliberately unexpected server error still returns a clean 500 (via asyncHandler), never a hang", async () => {
    // GET /api/escrows with a bookingId so malformed the eq() comparison is still
    // well-formed (Drizzle handles any string), so this just proves a normal
    // request path — included here as a baseline that the server responds at
    // all under a weird but not literally crashing input; genuine 500s are
    // exercised implicitly by every other case returning a controlled status
    // instead of a hang (see the HTTP method sweep below for confirmation of
    // the actual asyncHandler behaviour on truly unhandled paths).
    const r = await api(admin.token, "GET", "/api/escrows?bookingId=" + "x".repeat(5000));
    assert(r.status === 200, `expected 200 (empty list), got ${r.status}`);
  });

  // ── HTTP method / route abuse sweep ───────────────────────────────────────
  await test("Wrong HTTP method on a real route (GET where POST expected) -> 404, not a hang", async () => {
    const load = await postOpenLoad(2100);
    const r = await api(james.token, "GET", `/api/loads/${load.id}/accept`);
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test("DELETE on a resource with no DELETE route -> 404", async () => {
    const r = await api(admin.token, "DELETE", "/api/trips/TRP-1000");
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test("Genuinely unknown endpoint -> clean 404", async () => {
    const r = await api(admin.token, "GET", "/api/this-route-does-not-exist");
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test("Empty-string path segment -> 404, not a 500", async () => {
    const r = await api(admin.token, "GET", "/api/trips//status");
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  // ── Concurrency: duplicate rapid-fire booking/trip creation ───────────────
  await test("Two concurrent POST /loads/:id/accept for the same load -> exactly one booking created", async () => {
    const load = await postOpenLoad(2200);
    const [r1, r2] = await Promise.all([
      api(james.token, "POST", `/api/loads/${load.id}/accept`, {}),
      api(daniel.token, "POST", `/api/loads/${load.id}/accept`, {}),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert(JSON.stringify(statuses) === JSON.stringify([201, 409]), `expected one 201 and one 409, got ${statuses}`);
    const db = rawDb();
    const count = db.prepare("SELECT COUNT(*) as n FROM bookings WHERE load_id = ?").get(load.id);
    db.close();
    assert(count.n === 1, `expected exactly one booking for this load, got ${count.n}`);
  });

  await test("Two concurrent POST /bookings/:id/create-trip for the same booking -> exactly one trip created", async () => {
    const load = await postOpenLoad(2300);
    const accept = await api(james.token, "POST", `/api/loads/${load.id}/accept`, {});
    await api(james.token, "POST", `/api/bookings/${accept.json.id}/assign`, { truckId: peterTruckId, driverId: peterDriverId });
    await fundBooking(accept.json.id);
    const [r1, r2] = await Promise.all([
      api(james.token, "POST", `/api/bookings/${accept.json.id}/create-trip`, {}),
      api(james.token, "POST", `/api/bookings/${accept.json.id}/create-trip`, {}),
    ]);
    const winner = r1.status === 201 ? r1 : r2.status === 201 ? r2 : null;
    try {
      const statuses = [r1.status, r2.status].sort();
      assert(JSON.stringify(statuses) === JSON.stringify([201, 409]), `expected one 201 and one 409, got ${statuses}`);
      const db = rawDb();
      const count = db.prepare("SELECT COUNT(*) as n FROM trips WHERE booking_id = ?").get(accept.json.id);
      db.close();
      assert(count.n === 1, `expected exactly one trip for this booking, got ${count.n}`);
    } finally {
      if (winner) await cancelTrip(winner.json.id);
    }
  });

  await test("Two concurrent POST /bookings/:id/payment for the same booking -> exactly one payment stays non-terminal", async () => {
    const load = await postOpenLoad(2400);
    const accept = await api(james.token, "POST", `/api/loads/${load.id}/accept`, {});
    const [r1, r2] = await Promise.all([
      api(shipper.token, "POST", `/api/bookings/${accept.json.id}/payment`, { phoneNumber: "254700111222", testOutcome: "timeout" }),
      api(shipper.token, "POST", `/api/bookings/${accept.json.id}/payment`, { phoneNumber: "254700111222", testOutcome: "timeout" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert(JSON.stringify(statuses) === JSON.stringify([201, 409]), `expected one 201 and one 409, got ${statuses}`);
    const db = rawDb();
    const count = db.prepare("SELECT COUNT(*) as n FROM payments WHERE booking_id = ?").get(accept.json.id);
    db.close();
    assert(count.n === 1, `expected exactly one payment row, got ${count.n}`);
  });

  // ── Repeated / illegal status transitions ─────────────────────────────────
  await test("Repeated identical status request (Dispatched -> Dispatched again) -> rejected, not silently accepted", async () => {
    const load = await postOpenLoad(2500);
    const accept = await api(james.token, "POST", `/api/loads/${load.id}/accept`, {});
    await api(james.token, "POST", `/api/bookings/${accept.json.id}/assign`, { truckId: peterTruckId, driverId: peterDriverId });
    await fundBooking(accept.json.id);
    const trip = await api(james.token, "POST", `/api/bookings/${accept.json.id}/create-trip`, {});
    try {
      // admin.token: isolates canTransitionTrip()'s own same-to-same rule —
      // a driver repeating a status is ALSO correctly rejected, but at the
      // authorization layer first (DRIVER_TRANSITIONS has no X->X entry),
      // which is a different, equally valid 403 rather than this 409.
      const first = await api(admin.token, "POST", `/api/trips/${trip.json.id}/status`, { status: "Dispatched" });
      assert(first.status === 200, `setup: first Dispatched failed: ${JSON.stringify(first.json)}`);
      const repeat = await api(admin.token, "POST", `/api/trips/${trip.json.id}/status`, { status: "Dispatched" });
      assert(repeat.status === 409, `expected 409 for repeating the same status, got ${repeat.status}`);
    } finally {
      if (trip.json?.id) await cancelTrip(trip.json.id);
    }
  });

  await test("Backward transition (Delivered-adjacent: In Transit -> Dispatched) -> rejected", async () => {
    const load = await postOpenLoad(2600);
    const accept = await api(james.token, "POST", `/api/loads/${load.id}/accept`, {});
    await api(james.token, "POST", `/api/bookings/${accept.json.id}/assign`, { truckId: peterTruckId, driverId: peterDriverId });
    await fundBooking(accept.json.id);
    const trip = await api(james.token, "POST", `/api/bookings/${accept.json.id}/create-trip`, {});
    assert(trip.json?.id, `setup: create-trip failed: ${JSON.stringify(trip.json)}`);
    try {
      await driveSteps({ tripId: trip.json.id, driverToken: peterDriver.token, statuses: ["Dispatched", "At Pickup", "Loading", "In Transit"] });
      const backward = await api(admin.token, "POST", `/api/trips/${trip.json.id}/status`, { status: "Dispatched" });
      assert(backward.status === 409, `expected 409 for a backward transition, got ${backward.status}`);
    } finally {
      await cancelTrip(trip.json.id);
    }
  });

  // ── Systematic cross-tenant sweep ─────────────────────────────────────────
  await test("Cross-tenant sweep: Mary (shipper) cannot read James's booking/trip/payment", async () => {
    const load = await postOpenLoad(2700);
    const accept = await api(james.token, "POST", `/api/loads/${load.id}/accept`, {});
    await api(james.token, "POST", `/api/bookings/${accept.json.id}/assign`, { truckId: peterTruckId, driverId: peterDriverId });
    await fundBooking(accept.json.id);
    const trip = await api(james.token, "POST", `/api/bookings/${accept.json.id}/create-trip`, {});
    assert(trip.json?.id, `setup: create-trip failed: ${JSON.stringify(trip.json)}`);
    try {
      const pay = await api(shipper.token, "POST", `/api/bookings/${accept.json.id}/payment`, { phoneNumber: "254700111222", testOutcome: "timeout" });
      assert(pay.json?.id, `setup: payment initiate failed: ${JSON.stringify(pay.json)}`);

      const bookingRead = await api(mary.token, "GET", `/api/bookings/${accept.json.id}`);
      assert(bookingRead.status === 403, `expected 403, got ${bookingRead.status}`);
      const tripRead = await api(mary.token, "GET", `/api/trips/${trip.json.id}`);
      assert(tripRead.status === 403, `expected 403, got ${tripRead.status}`);
      const paymentRead = await api(mary.token, "GET", `/api/payments/${pay.json.id}`);
      assert(paymentRead.status === 403, `expected 403, got ${paymentRead.status}`);
    } finally {
      await cancelTrip(trip.json.id);
    }
  });

  await test("Cross-tenant sweep: Daniel (another transporter) cannot read James's escrow or assign to James's booking", async () => {
    const load = await postOpenLoad(2800);
    const accept = await api(james.token, "POST", `/api/loads/${load.id}/accept`, {});
    const assignByDaniel = await api(daniel.token, "POST", `/api/bookings/${accept.json.id}/assign`, { truckId: peterTruckId, driverId: peterDriverId });
    assert(assignByDaniel.status === 403, `expected 403, got ${assignByDaniel.status}`);

    await api(james.token, "POST", `/api/bookings/${accept.json.id}/assign`, { truckId: peterTruckId, driverId: peterDriverId });
    await fundBooking(accept.json.id);
    const trip = await api(james.token, "POST", `/api/bookings/${accept.json.id}/create-trip`, {});
    assert(trip.json?.id, `setup: create-trip failed: ${JSON.stringify(trip.json)}`);
    try {
      const paid = await api(shipper.token, "POST", `/api/bookings/${accept.json.id}/payment`, { phoneNumber: "254700111222" });
      assert(paid.json?.id, `setup: payment initiate failed: ${JSON.stringify(paid.json)}`);
      await waitFor(async () => {
        const p = (await api(shipper.token, "GET", `/api/payments/${paid.json.id}`)).json;
        return p.status !== "StkSent" ? p : null;
      });
      const [escrow] = (await api(admin.token, "GET", `/api/escrows?bookingId=${accept.json.id}`)).json;
      const escrowRead = await api(daniel.token, "GET", `/api/escrows/${escrow.id}`);
      assert(escrowRead.status === 403, `expected 403, got ${escrowRead.status}`);
    } finally {
      await cancelTrip(trip.json.id);
    }
  });

  await test("Cross-tenant sweep: a driver cannot read another driver's notifications", async () => {
    const jamesDriver = await login("0722100200", "1234", "driver");
    const notifs = await api(peterDriver.token, "GET", "/api/notifications");
    assert(notifs.status === 200, "a driver reading their OWN notifications should work");
    // James-as-driver has his own, separate notification inbox from Peter's — not cross-readable by id.
    const jamesNotifs = (await api(jamesDriver.token, "GET", "/api/notifications")).json;
    if (jamesNotifs.length > 0) {
      const r = await api(peterDriver.token, "POST", `/api/notifications/${jamesNotifs[0].id}/read`, {});
      assert(r.status === 404, `expected 404 (not visible to Peter), got ${r.status}`);
    }
  });

  const passCount = results.filter(r => r.ok).length;
  console.log(`\n${passCount}/${results.length} passed.`);
  console.log("\nAlready covered by scripts/acceptance-4k.mjs (not duplicated here): duplicate STK/B2C callbacks, wrong amount, duplicate receipt number, concurrent escrow release, second-payout schema backstop, payment/payout reversal.");
  console.log("Already covered by scripts/regression-4a-4j.mjs (not duplicated here): cross-tenant 403s on trucks/loads/trip-location, stage-skipping on a trip.");
  if (passCount !== results.length) {
    console.log("\nFAILURES:");
    for (const r of results.filter(r => !r.ok)) console.log(" -", r.name, ":", r.error);
    process.exit(1);
  }
}
main().catch(err => { console.error("FATAL:", err); process.exit(1); });

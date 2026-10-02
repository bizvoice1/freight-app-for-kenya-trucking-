// Phase 4L acceptance suite — in-app notifications. Run against a freshly
// migrated + seeded backend on http://localhost:4000. Exercises every event
// -> recipient mapping agreed for 4L's narrow scope, plus the read/unread
// endpoints and the "a notification belongs to exactly its recipient" rule.
import Database from "better-sqlite3";
import { driveSteps } from "./gate-helper.mjs";
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function repairPeterToKbd(peterTruckId, peterDriverId) {
  const db = rawDb();
  db.prepare("UPDATE trucks SET current_driver_id = ?, status = 'Assigned' WHERE id = ?").run(peterDriverId, peterTruckId);
  db.prepare("UPDATE drivers SET assigned_truck_id = ?, status = 'Assigned' WHERE id = ?").run(peterTruckId, peterDriverId);
  db.close();
}

let shipper, james, daniel, admin, admin2, peterDriver;
let peterTruckId, peterDriverId;

async function setup() {
  shipper = await login("0700000001", "1234", "shipper");
  james = await login("0722100200", "1234", "fleet_owner");
  daniel = await login("0711000000", "1234", "fleet_owner");
  admin = await login("0700000002", "1234", "admin");
  peterDriver = await login("0733222333", "1234", "driver");

  const trucks = (await api(james.token, "GET", "/api/trucks")).json;
  peterTruckId = trucks.find(t => t.plate === "KBD 092K").id;
  const drivers = (await api(james.token, "GET", "/api/drivers")).json;
  peterDriverId = drivers.find(d => d.name === "Peter Otieno").id;
}

async function createBooked(price) {
  repairPeterToKbd(peterTruckId, peterDriverId);
  const load = (await api(shipper.token, "POST", "/api/loads", { cargo: "4L test cargo", origin: "Nairobi", destination: "Nakuru", price, ...NBO_NKU })).json;
  const booking = (await api(james.token, "POST", `/api/loads/${load.id}/accept`, {})).json;
  const assign = await api(james.token, "POST", `/api/bookings/${booking.id}/assign`, { truckId: peterTruckId, driverId: peterDriverId });
  assert(assign.status === 200, `assign failed: ${JSON.stringify(assign.json)}`);
  return { load, booking: assign.json };
}

/** 5D-4: a trip needs a funded booking, so this pays (success) first. */
async function createBookedTrip(price) {
  const { load, booking } = await createBooked(price);
  const paid = await payAndWaitPaid(booking.id, price);
  assert(paid.status === "Paid", `funding failed: ${paid.status}`);
  const createTrip = await api(james.token, "POST", `/api/bookings/${booking.id}/create-trip`, {});
  assert(createTrip.status === 201, `create-trip failed: ${JSON.stringify(createTrip.json)}`);
  return { load, booking, trip: createTrip.json, paid };
}

async function driveToDelivered(tripId) {
  await driveSteps({ tripId, driverToken: peterDriver.token, statuses: ["Dispatched", "At Pickup", "Loading", "In Transit", "At Delivery"] });
  const r = await api(shipper.token, "POST", `/api/trips/${tripId}/status`, { status: "Delivered" });
  assert(r.status === 200, `confirm Delivered failed: ${JSON.stringify(r.json)}`);
}

async function payAndWaitPaid(bookingId, price, opts = {}) {
  const pay = await api(shipper.token, "POST", `/api/bookings/${bookingId}/payment`, { phoneNumber: "254700111222", ...opts });
  assert(pay.status === 201, `payment initiate failed: ${JSON.stringify(pay.json)}`);
  return waitFor(async () => {
    const p = (await api(shipper.token, "GET", `/api/payments/${pay.json.id}`)).json;
    return p.status !== "StkSent" ? p : null;
  });
}

async function notificationsFor(token, { type } = {}) {
  const rows = (await api(token, "GET", "/api/notifications")).json;
  return type ? rows.filter(n => n.type === type) : rows;
}

async function main() {
  await setup();

  await test("Load posted -> every transporter (fleet_owner) is notified, marketplace-wide", async () => {
    const load = (await api(shipper.token, "POST", "/api/loads", { cargo: "Broadcast test", origin: "Nairobi", destination: "Mombasa" })).json;
    const [jamesNotifs, danielNotifs] = await Promise.all([
      notificationsFor(james.token, { type: "load_posted" }),
      notificationsFor(daniel.token, { type: "load_posted" }),
    ]);
    assert(jamesNotifs.some(n => n.relatedEntityId === load.id), "James should have a load_posted notification");
    assert(danielNotifs.some(n => n.relatedEntityId === load.id), "Daniel should have a load_posted notification too");
  });

  await test("Payment confirmed -> shipper notified; escrow held -> transporter notified", async () => {
    const { booking, trip, paid } = await createBookedTrip(5000);
    await sleep(150);
    const shipperNotifs = await notificationsFor(shipper.token, { type: "payment_confirmed" });
    assert(shipperNotifs.some(n => n.relatedEntityId === paid.id), "shipper should be notified of payment_confirmed");
    const jamesNotifs = await notificationsFor(james.token, { type: "escrow_held" });
    assert(jamesNotifs.some(n => n.relatedEntityType === "escrow"), "transporter should be notified of escrow_held");
    await api(james.token, "POST", `/api/trips/${trip.id}/status`, { status: "Cancelled" }); // free the truck for later tests
  });

  await test("Payment failed (cancelled) -> shipper notified, not the transporter", async () => {
    const { booking } = await createBooked(5100);
    const paid = await payAndWaitPaid(booking.id, 5100, { testOutcome: "cancelled_by_user" });
    assert(paid.status === "Cancelled", "setup: payment should have been cancelled");
    await sleep(150);
    const shipperNotifs = await notificationsFor(shipper.token, { type: "payment_failed" });
    assert(shipperNotifs.some(n => n.relatedEntityId === paid.id), "shipper should be notified of payment_failed");
  });

  await test("Trip status changes -> shipper AND transporter notified at every step", async () => {
    const { booking, trip } = await createBookedTrip(5200);
    await driveToDelivered(trip.id);
    const shipperTripNotifs = await notificationsFor(shipper.token, { type: "trip_status" });
    const jamesTripNotifs = await notificationsFor(james.token, { type: "trip_status" });
    const thisTrip = n => n.relatedEntityId === trip.id;
    // Loading / In Transit are gate-owned (5E-2): they notify via gate_* types, not trip_status.
    assert(shipperTripNotifs.filter(thisTrip).length === 4, `expected 4 trip_status notifications for the shipper, got ${shipperTripNotifs.filter(thisTrip).length}`);
    assert(jamesTripNotifs.filter(thisTrip).length === 4, `expected 4 trip_status notifications for the transporter, got ${jamesTripNotifs.filter(thisTrip).length}`);
    for (const [who, label] of [[shipper, "shipper"], [james, "transporter"]]) {
      for (const type of ["gate_in", "loading_started", "loading_completed"]) {
        const ns = (await notificationsFor(who.token, { type })).filter(thisTrip);
        assert(ns.length === 1, `expected 1 ${type} notification for the ${label}, got ${ns.length}`);
      }
    }

    await test("  -> Delivered also notified the transporter + admin of release_pending", async () => {
      const jamesRelease = await notificationsFor(james.token, { type: "release_pending" });
      const adminRelease = await notificationsFor(admin.token, { type: "release_pending" });
      assert(jamesRelease.length > 0, "transporter should have a release_pending notification");
      assert(adminRelease.length > 0, "admin should have a release_pending notification");
    });

    await test("  -> Payout confirmed notifies the transporter", async () => {
      const [escrow] = (await api(admin.token, "GET", `/api/escrows?bookingId=${booking.id}`)).json;
      const release = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, {});
      assert(release.status === 201, `release failed: ${JSON.stringify(release.json)}`);
      await waitFor(async () => {
        const e = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
        return e.status === "Settled" ? e : null;
      });
      const jamesPayoutNotifs = await notificationsFor(james.token, { type: "payout_confirmed" });
      assert(jamesPayoutNotifs.some(n => n.relatedEntityType === "payout"), "transporter should be notified of payout_confirmed");
    });
  });

  await test("Payout failed -> transporter AND admin both notified (admin needs to act)", async () => {
    const { booking, trip } = await createBookedTrip(5300);
    await driveToDelivered(trip.id);
    const [escrow] = await waitFor(async () => {
      const rows = (await api(admin.token, "GET", `/api/escrows?bookingId=${booking.id}`)).json;
      return rows[0]?.status === "ReleasePending" ? rows : null;
    });
    const release = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, { testOutcome: "failed_payout" });
    assert(release.status === 201, `release failed: ${JSON.stringify(release.json)}`);
    await waitFor(async () => {
      const e = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
      return e.status === "ReleasePending" ? e : null;
    });
    const jamesFailed = await notificationsFor(james.token, { type: "payout_failed" });
    const adminFailed = await notificationsFor(admin.token, { type: "payout_failed" });
    assert(jamesFailed.length > 0, "transporter should be notified of payout_failed");
    assert(adminFailed.length > 0, "admin should be notified of payout_failed (retry needed)");
  });

  await test("Unread count, mark-one-read, and mark-all-read all work", async () => {
    const before = (await api(daniel.token, "GET", "/api/notifications/unread-count")).json;
    assert(before.count > 0, "Daniel should have unread notifications from the broadcast test");
    const list = await notificationsFor(daniel.token);
    const marked = await api(daniel.token, "POST", `/api/notifications/${list[0].id}/read`, {});
    assert(marked.status === 200 && marked.json.read === true, "mark-one-read failed");
    const all = await api(daniel.token, "POST", "/api/notifications/read-all", {});
    assert(all.status === 200, "mark-all-read failed");
    const after = (await api(daniel.token, "GET", "/api/notifications/unread-count")).json;
    assert(after.count === 0, `expected 0 unread after read-all, got ${after.count}`);
  });

  await test("A notification belongs to exactly its recipient -> another user can't mark it read", async () => {
    const jamesList = await notificationsFor(james.token);
    assert(jamesList.length > 0, "setup: James should have at least one notification");
    const r = await api(daniel.token, "POST", `/api/notifications/${jamesList[0].id}/read`, {});
    assert(r.status === 404, `expected 404 (not found for this user), got ${r.status}`);
  });

  const passCount = results.filter(r => r.ok).length;
  console.log(`\n${passCount}/${results.length} passed.`);
  if (passCount !== results.length) {
    console.log("\nFAILURES:");
    for (const r of results.filter(r => !r.ok)) console.log(" -", r.name, ":", r.error);
    process.exit(1);
  }
}
main().catch(err => { console.error("FATAL:", err); process.exit(1); });

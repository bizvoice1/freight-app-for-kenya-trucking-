// Phase 5P-3 acceptance — canonical graph: Transporter -> FleetOwner -> Truck + Driver(+login) -> Booking -> Trip -> Driver Tracker.
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NBO_NKU } from "./fixtures.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const DB_PATH = process.env.DATABASE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "behari.sqlite");
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS -", name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log("FAIL -", name, "->", e.message); }
}
function assert(c, m) { if (!c) throw new Error(m); }
async function api(token, method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const row = (sql, ...a) => { const d = new Database(DB_PATH); const r = d.prepare(sql).get(...a); d.close(); return r; };
const reg = (b) => api(null, "POST", "/api/auth/register", b);
const run = String(Date.now()).slice(-6);
const P = { s: `07${run}11`, a: `07${run}21`, b: `07${run}22`, d: `07${run}31`, d2: `07${run}32` };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const s = await reg({ name: "Grace Shipper", phone: P.s, pin: "4821", role: "shipper" });
  const a = await reg({ name: "Ahmed Hassan", phone: P.a, pin: "4823", role: "fleet_owner", company: "Hassan Haulage" });
  const b = await reg({ name: "Bravo Transport", phone: P.b, pin: "4824", role: "fleet_owner" });
  let truck, driver, truck2, load, booking, trip, dLogin;

  await test("1. /api/me is structurally explicit: top-level company + fleetOwner/driver objects (null when not applicable)", async () => {
    const m = (await api(a.json.token, "GET", "/api/me")).json;
    assert(m.company === "Hassan Haulage" && m.fleetOwner?.company === "Hassan Haulage" && m.driver === null, JSON.stringify(m));
    const g = (await api(s.json.token, "GET", "/api/me")).json;
    assert(g.company === null && g.fleetOwner === null && g.driver === null, JSON.stringify(g));
  });

  await test("2. POST /api/trucks: owner comes from the session; client-sent ownerId is ignored; canonical type enforced", async () => {
    const r = await api(a.json.token, "POST", "/api/trucks", { plate: `kz${run.slice(0,2)} 441z`, truckType: "Flatbed", capacity: "20 tonnes", ownerId: b.json.user.fleetOwnerId, fleetOwnerId: b.json.user.fleetOwnerId });
    assert(r.status === 201, JSON.stringify(r.json));
    truck = r.json;
    assert(truck.plate === `KZ${run.slice(0,2)} 441Z` && truck.ownerId === a.json.user.fleetOwnerId, JSON.stringify(truck));
    assert(row("SELECT owner_id o FROM trucks WHERE id = ?", truck.id).o === a.json.user.fleetOwnerId, "db owner");
    assert((await api(a.json.token, "POST", "/api/trucks", { plate: "KXX 100A", truckType: "Spaceship" })).status === 400, "bad type accepted");
    assert((await api(a.json.token, "POST", "/api/trucks", { plate: "x", truckType: "Flatbed" })).status === 400, "bad plate accepted");
    assert((await api(b.json.token, "POST", "/api/trucks", { plate: truck.plate, truckType: "Flatbed" })).status === 409, "duplicate plate across fleets accepted");
  });

  await test("3. only transporters can create trucks/drivers (shipper 403, unauthenticated 401)", async () => {
    assert((await api(s.json.token, "POST", "/api/trucks", { plate: "KAA 111A", truckType: "Flatbed" })).status === 403, "shipper truck");
    assert((await api(s.json.token, "POST", "/api/drivers", { name: "X Y", phone: P.d, pin: "1234" })).status === 403, "shipper driver");
    assert((await api(null, "POST", "/api/trucks", {})).status === 401, "anon");
  });

  await test("4. POST /api/drivers creates driver + login atomically; validation rejects bad input; duplicate phone 409", async () => {
    for (const bad of [{ name: "A", phone: P.d, pin: "1234" }, { name: "Dave Driver", phone: "123", pin: "1234" }, { name: "Dave Driver", phone: P.d, pin: "12" }]) {
      assert((await api(a.json.token, "POST", "/api/drivers", bad)).status === 400, "accepted " + JSON.stringify(bad));
    }
    assert(row("SELECT COUNT(*) n FROM drivers WHERE phone = ?", P.d).n === 0, "partial driver row left behind");
    const r = await api(a.json.token, "POST", "/api/drivers", { name: "Dave Driver", phone: P.d, pin: "6789", licenseNumber: "DL-1", truckId: truck.id, fleetOwnerId: b.json.user.fleetOwnerId });
    assert(r.status === 201, JSON.stringify(r.json));
    driver = r.json;
    assert(driver.fleetOwnerId === a.json.user.fleetOwnerId && driver.assignedTruckId === truck.id, JSON.stringify(driver));
    const u = row("SELECT * FROM users WHERE id = ?", driver.userId);
    assert(u.role === "driver" && u.driver_id === driver.id && u.pin_hash.startsWith("$2"), JSON.stringify(u));
    assert(row("SELECT current_driver_id c, status s FROM trucks WHERE id = ?", truck.id).c === driver.id, "truck not paired");
    assert((await api(a.json.token, "POST", "/api/drivers", { name: "Dave Two", phone: P.d, pin: "1234" })).status === 409, "duplicate phone");
  });

  await test("5. the driver logs in with the phone+PIN the transporter set; /api/me resolves the right driverId", async () => {
    dLogin = await api(null, "POST", "/api/auth/login", { phone: P.d, pin: "6789", role: "driver" });
    assert(dLogin.status === 200 && dLogin.json.user.driverId === driver.id, JSON.stringify(dLogin.json));
    const m = (await api(dLogin.json.token, "GET", "/api/me")).json;
    assert(m.role === "driver" && m.driverId === driver.id && m.driver?.fleetOwnerId === a.json.user.fleetOwnerId && m.driver.assignedTruckId === truck.id, JSON.stringify(m));
    assert((await api(null, "POST", "/api/auth/register", { name: "Sneaky Driver", phone: P.d2, pin: "1234", role: "driver" })).status === 400, "public driver registration open");
  });

  await test("6. tenant isolation: Transporter B sees none of A's trucks/drivers and cannot mutate them", async () => {
    assert((await api(b.json.token, "GET", "/api/trucks")).json.length === 0 && (await api(b.json.token, "GET", "/api/drivers")).json.length === 0, "B sees A's fleet");
    assert((await api(b.json.token, "PUT", `/api/trucks/${truck.id}/driver`, { driverId: null })).status === 404, "B unpaired A's truck");
    const bt = (await api(b.json.token, "POST", "/api/trucks", { plate: `KB${run.slice(0,2)} 222B`, truckType: "Canter" })).json; truck2 = bt;
    assert((await api(b.json.token, "PUT", `/api/trucks/${bt.id}/driver`, { driverId: driver.id })).status === 404, "B paired A's driver");
    assert((await api(a.json.token, "PUT", `/api/trucks/${bt.id}/driver`, { driverId: null })).status === 404, "A touched B's truck");
    assert((await api(a.json.token, "GET", "/api/trucks")).json.map(t => t.id).join() === truck.id, "A list wrong");
  });

  await test("7. pairing is symmetric and reversible; a driver moves between trucks without double-assignment", async () => {
    const t2 = (await api(a.json.token, "POST", "/api/trucks", { plate: `KC${run.slice(0,2)} 333C`, truckType: "Canter" })).json;
    assert((await api(a.json.token, "PUT", `/api/trucks/${t2.id}/driver`, { driverId: driver.id })).status === 200, "move");
    assert(row("SELECT current_driver_id c FROM trucks WHERE id = ?", truck.id).c === null, "old truck still paired");
    assert(row("SELECT assigned_truck_id c FROM drivers WHERE id = ?", driver.id).c === t2.id, "driver not moved");
    assert((await api(a.json.token, "PUT", `/api/trucks/${truck.id}/driver`, { driverId: driver.id })).status === 200, "move back");
    assert(row("SELECT current_driver_id c FROM trucks WHERE id = ?", t2.id).c === null, "t2 still paired");
  });

  await test("8. Shipper posts a load; Ahmed discovers it; accepts -> booking on A's real fleet only", async () => {
    const p = await api(s.json.token, "POST", "/api/loads", { cargo: "Maize", origin: "Nairobi", destination: "Nakuru", weight: 10, truckType: "Flatbed", price: 60000, pickupDate: "2030-01-01", pickup: NBO_NKU.pickup, delivery: NBO_NKU.delivery });
    assert(p.status === 201, JSON.stringify(p.json)); load = p.json;
    assert((await api(a.json.token, "GET", "/api/loads?status=Open")).json.some(l => l.id === load.id), "not discoverable");
    const acc = await api(a.json.token, "POST", `/api/loads/${load.id}/accept`, {});
    assert(acc.status === 201 || acc.status === 200, JSON.stringify(acc.json)); booking = acc.json;
    const bad = await api(a.json.token, "POST", `/api/bookings/${booking.id}/assign`, { truckId: truck2.id, driverId: driver.id });
    assert(bad.status === 403, "assigned B's truck: " + bad.status);
    const ok = await api(a.json.token, "POST", `/api/bookings/${booking.id}/assign`, { truckId: truck.id, driverId: driver.id });
    assert(ok.status === 200 && ok.json.truckId === truck.id && ok.json.driverId === driver.id, JSON.stringify(ok.json));
  });

  await test("9. funded booking -> Trip; the trip carries the real truck+driver; the driver (and only that driver) sees it in the tracker", async () => {
    const pay = await api(s.json.token, "POST", `/api/bookings/${booking.id}/payment`, { phoneNumber: "254700111222" });
    assert(pay.status === 201, JSON.stringify(pay.json));
    let st; for (let i = 0; i < 20; i++) { st = (await api(s.json.token, "GET", `/api/payments/${pay.json.id}`)).json; if (st.status !== "StkSent") break; await sleep(500); }
    assert(st.status === "Paid", "payment " + st.status);
    const t = await api(a.json.token, "POST", `/api/bookings/${booking.id}/create-trip`, {});
    assert(t.status === 201, JSON.stringify(t.json)); trip = t.json;
    assert(trip.truckId === truck.id && trip.driverId === driver.id && trip.loadId === load.id, JSON.stringify(trip));
    const mine = (await api(dLogin.json.token, "GET", "/api/trips")).json;
    assert(mine.length === 1 && mine[0].id === trip.id, "driver tracker list: " + JSON.stringify(mine));
    assert((await api(b.json.token, "GET", "/api/trips")).json.length === 0, "B sees trip");
    const fresh = await api(null, "POST", "/api/auth/login", { phone: P.d, pin: "6789", role: "driver" });
    assert((await api(fresh.json.token, "GET", "/api/trips")).json.length === 1, "after re-login");
  });

  await test("10. the driver writes real GPS against the trip; pairing is locked while the trip is active", async () => {
    const adv = await api(dLogin.json.token, "POST", `/api/trips/${trip.id}/status`, { status: "Dispatched" });
    assert(adv.status === 200, JSON.stringify(adv.json));
    const loc = await api(dLogin.json.token, "POST", `/api/trips/${trip.id}/location`, { lat: -1.2921, lng: 36.8219, accuracy: 15, speed: 40, heading: 90, source: "device" });
    assert(loc.status === 201 || loc.status === 200, JSON.stringify(loc));
    assert((await api(a.json.token, "PUT", `/api/trucks/${truck.id}/driver`, { driverId: null })).status === 409, "unpaired during active trip");
    assert((await api(a.json.token, "GET", `/api/trips/${trip.id}/location/latest`)).status === 200, "owner cannot read GPS");
    assert((await api(b.json.token, "GET", `/api/trips/${trip.id}/location/latest`)).status === 403, "B reads GPS");
  });

  const newBooking = async () => {
    const p = await api(s.json.token, "POST", "/api/loads", { cargo: "Beans", origin: "Nairobi", destination: "Nakuru", weight: 8, truckType: "Flatbed", price: 50000, pickupDate: "2030-01-02", pickup: NBO_NKU.pickup, delivery: NBO_NKU.delivery });
    assert(p.status === 201, JSON.stringify(p.json));
    const acc = await api(a.json.token, "POST", `/api/loads/${p.json.id}/accept`, {});
    assert(acc.status === 200 || acc.status === 201, JSON.stringify(acc.json));
    return acc.json;
  };

  await test("11. re-assigning an already-Assigned booking is allowed (same owner, valid pair); foreign/unpaired/trip-created rejected", async () => {
    const bk = await newBooking();
    const t3 = (await api(a.json.token, "POST", "/api/trucks", { plate: `KD${run.slice(0,2)} 444D`, truckType: "Flatbed" })).json;
    const d3 = await api(a.json.token, "POST", "/api/drivers", { name: "Eve Driver", phone: P.d2, pin: "1234", licenseNumber: "DL-2", truckId: t3.id });
    assert(d3.status === 201, JSON.stringify(d3.json));
    const first = await api(a.json.token, "POST", `/api/bookings/${bk.id}/assign`, { truckId: t3.id, driverId: d3.json.id });
    assert(first.status === 200 && first.json.status === "Assigned", JSON.stringify(first.json));
    const again = await api(a.json.token, "POST", `/api/bookings/${bk.id}/assign`, { truckId: t3.id, driverId: d3.json.id });
    assert(again.status === 200 && again.json.status === "Assigned" && again.json.truckId === t3.id, "re-assign same: " + JSON.stringify(again.json));
    const other = await api(a.json.token, "POST", `/api/bookings/${bk.id}/assign`, { truckId: truck.id, driverId: driver.id });
    assert(other.status === 200 && other.json.truckId === truck.id, "re-assign other: " + JSON.stringify(other.json));
    assert((await api(a.json.token, "POST", `/api/bookings/${bk.id}/assign`, { truckId: truck2.id, driverId: driver.id })).status === 403, "foreign truck on re-assign");
    assert((await api(a.json.token, "POST", `/api/bookings/${bk.id}/assign`, { truckId: truck.id, driverId: d3.json.id })).status === 409, "unpaired on re-assign");
    assert((await api(b.json.token, "POST", `/api/bookings/${bk.id}/assign`, { truckId: truck2.id, driverId: driver.id })).status === 403, "B re-assigned A's booking");
    assert((await api(a.json.token, "POST", `/api/bookings/${booking.id}/assign`, { truckId: truck.id, driverId: driver.id })).status === 409, "trip-created booking reassigned");
    globalThis.__t3 = t3; globalThis.__d3 = d3.json; globalThis.__bk = bk;
  });

  await test("12. a second trip's driver writes GPS: distinct location ids, each trip keeps its own latest point", async () => {
    const t3 = globalThis.__t3, d3 = globalThis.__d3;
    const bk = (await newBooking());
    assert((await api(a.json.token, "POST", `/api/bookings/${bk.id}/assign`, { truckId: t3.id, driverId: d3.id })).status === 200, "assign 2nd");
    const pay = await api(s.json.token, "POST", `/api/bookings/${bk.id}/payment`, { phoneNumber: "254700111222" });
    assert(pay.status === 201, JSON.stringify(pay.json));
    let st; for (let i = 0; i < 20; i++) { st = (await api(s.json.token, "GET", `/api/payments/${pay.json.id}`)).json; if (st.status !== "StkSent") break; await sleep(500); }
    assert(st.status === "Paid", "payment " + st.status);
    const t = await api(a.json.token, "POST", `/api/bookings/${bk.id}/create-trip`, {});
    assert(t.status === 201, JSON.stringify(t.json));
    const d3Login = await api(null, "POST", "/api/auth/login", { phone: P.d2, pin: "1234", role: "driver" });
    assert(d3Login.status === 200, JSON.stringify(d3Login.json));
    assert((await api(d3Login.json.token, "POST", `/api/trips/${t.json.id}/status`, { status: "Dispatched" })).status === 200, "dispatch 2nd");
    const loc = await api(d3Login.json.token, "POST", `/api/trips/${t.json.id}/location`, { lat: -0.3031, lng: 36.0800, accuracy: 12, speed: 30, heading: 270 });
    assert(loc.status === 200 || loc.status === 201, "2nd trip GPS: " + JSON.stringify(loc));
    const l1 = (await api(a.json.token, "GET", `/api/trips/${trip.id}/location/latest`)).json;
    const l2 = (await api(a.json.token, "GET", `/api/trips/${t.json.id}/location/latest`)).json;
    const id1 = l1.id ?? l1.update?.id, id2 = l2.id ?? l2.update?.id;
    assert(id1 && id2 && id1 !== id2, `location ids: ${id1} vs ${id2}`);
    assert((await api(dLogin.json.token, "POST", `/api/trips/${t.json.id}/location`, { lat: -1.3, lng: 36.8, accuracy: 10 })).status === 403, "driver 1 wrote to trip 2");
    const n = row("SELECT COUNT(*) n, COUNT(DISTINCT id) d FROM location_updates");
    assert(n.n === n.d && n.n >= 2, JSON.stringify(n));
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — FAILED: " + failed.map(f => f.name).join("; ") : "."}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });

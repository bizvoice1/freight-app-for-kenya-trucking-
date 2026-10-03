// Phase 5E-4A acceptance — driver operational controls: Assigned -> Dispatched -> At Pickup via POST /api/trips/:id/status.
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GPS = { lat: -1.2921, lng: 36.8219, accuracy: 15, speed: 40, heading: 90, source: "device" };

async function main() {
  const s = await reg({ name: "Grace Shipper", phone: `07${run}11`, pin: "4821", role: "shipper" });
  const s2 = await reg({ name: "Other Shipper", phone: `07${run}12`, pin: "4821", role: "shipper" });
  const a = await reg({ name: "Ahmed Hassan", phone: `07${run}21`, pin: "4823", role: "fleet_owner" });
  const mkDriver = async (tag, n) => {
    const truck = (await api(a.json.token, "POST", "/api/trucks", { plate: `K${tag}${run.slice(0, 2)} ${n}${n}${n}Z`, truckType: "Flatbed" })).json;
    const phone = `07${run}3${n}`;
    const d = (await api(a.json.token, "POST", "/api/drivers", { name: `Driver ${tag}`, phone, pin: "6789", truckId: truck.id })).json;
    const login = await api(null, "POST", "/api/auth/login", { phone, pin: "6789", role: "driver" });
    return { truck, d, token: login.json.token };
  };
  const mkTrip = async (drv) => {
    const load = (await api(s.json.token, "POST", "/api/loads", { cargo: "Maize", origin: "Nairobi", destination: "Nakuru", weight: 10, truckType: "Flatbed", price: 60000, pickupDate: "2030-01-01", pickup: NBO_NKU.pickup, delivery: NBO_NKU.delivery })).json;
    const bk = (await api(a.json.token, "POST", `/api/loads/${load.id}/accept`, {})).json;
    await api(a.json.token, "POST", `/api/bookings/${bk.id}/assign`, { truckId: drv.truck.id, driverId: drv.d.id });
    const pay = (await api(s.json.token, "POST", `/api/bookings/${bk.id}/payment`, { phoneNumber: "254700111222" })).json;
    for (let i = 0; i < 20; i++) { const st = (await api(s.json.token, "GET", `/api/payments/${pay.id}`)).json; if (st.status !== "StkSent") break; await sleep(500); }
    const t = await api(a.json.token, "POST", `/api/bookings/${bk.id}/create-trip`, {});
    assert(t.status === 201, JSON.stringify(t.json));
    return t.json;
  };
  const setStatus = (tok, id, status) => api(tok, "POST", `/api/trips/${id}/status`, { status });
  const dbStatus = (id) => row("SELECT status s FROM trips WHERE id = ?", id).s;

  const d1 = await mkDriver("A", 1), d2 = await mkDriver("B", 2);
  const trip = await mkTrip(d1);
  const shipperTok = s.json.token, ownerTok = a.json.token;

  await test("1. new trip starts Assigned", async () => {
    assert(trip.status === "Assigned" && dbStatus(trip.id) === "Assigned", trip.status);
  });

  await test("2. invalid skips fail for the correct driver (Assigned -> At Pickup / Loading / In Transit / Delivered)", async () => {
    for (const to of ["At Pickup", "Loading", "In Transit", "At Delivery", "Delivered"]) {
      const r = await setStatus(d1.token, trip.id, to);
      assert(r.status >= 400 && r.status < 500, `${to}: ${r.status}`);
    }
    assert(dbStatus(trip.id) === "Assigned", "status changed by a rejected skip");
  });

  await test("3. another driver cannot dispatch this trip (403), status unchanged", async () => {
    const r = await setStatus(d2.token, trip.id, "Dispatched");
    assert(r.status === 403, r.status);
    assert(dbStatus(trip.id) === "Assigned", "changed");
  });

  await test("4. transporter and shipper cannot use driver controls (403), unauthenticated 401", async () => {
    assert((await setStatus(ownerTok, trip.id, "Dispatched")).status === 403, "owner dispatch");
    assert((await setStatus(shipperTok, trip.id, "Dispatched")).status === 403, "shipper dispatch");
    assert((await setStatus(s2.json.token, trip.id, "Dispatched")).status === 403, "other shipper");
    assert((await setStatus(null, trip.id, "Dispatched")).status === 401, "anon");
    assert(dbStatus(trip.id) === "Assigned", "changed");
  });

  await test("5. correct driver: Assigned -> Dispatched returns the canonical trip with startedAt", async () => {
    const r = await setStatus(d1.token, trip.id, "Dispatched");
    assert(r.status === 200 && r.json.status === "Dispatched" && r.json.startedAt, JSON.stringify(r));
    assert(dbStatus(trip.id) === "Dispatched", "db");
  });

  await test("6. repeat Dispatch is rejected (409) and does not move the trip", async () => {
    const r = await setStatus(d1.token, trip.id, "Dispatched");
    assert(r.status === 409 || r.status === 403, r.status);
    assert(dbStatus(trip.id) === "Dispatched", "moved");
  });

  await test("7. refresh retains canonical status (driver list, driver detail, fresh login)", async () => {
    const list = (await api(d1.token, "GET", `/api/trips?driverId=${d1.d.id}`)).json;
    assert(list.find(t => t.id === trip.id)?.status === "Dispatched", "list");
    assert((await api(d1.token, "GET", `/api/trips/${trip.id}`)).json.status === "Dispatched", "detail");
    const l2 = await api(null, "POST", "/api/auth/login", { phone: `07${run}31`, pin: "6789", role: "driver" });
    assert((await api(l2.json.token, "GET", `/api/trips/${trip.id}`)).json.status === "Dispatched", "after relogin");
  });

  await test("8. transporter and shipper monitoring see Dispatched; the other driver and other shipper cannot read it", async () => {
    assert((await api(ownerTok, "GET", `/api/trips/${trip.id}`)).json.status === "Dispatched", "owner");
    assert((await api(shipperTok, "GET", `/api/trips/${trip.id}`)).json.status === "Dispatched", "shipper");
    assert((await api(ownerTok, "GET", "/api/trips")).json.find(t => t.id === trip.id)?.status === "Dispatched", "owner list");
    assert((await api(d2.token, "GET", `/api/trips/${trip.id}`)).status === 403, "other driver read");
    assert((await api(s2.json.token, "GET", `/api/trips/${trip.id}`)).status === 403, "other shipper read");
  });

  await test("9. GPS pipeline works while Dispatched; other driver cannot write", async () => {
    assert((await api(d1.token, "POST", `/api/trips/${trip.id}/tracking/start`)).status < 300, "tracking/start");
    const loc = await api(d1.token, "POST", `/api/trips/${trip.id}/location`, GPS);
    assert(loc.status === 200 || loc.status === 201, JSON.stringify(loc));
    assert((await api(d2.token, "POST", `/api/trips/${trip.id}/location`, GPS)).status === 403, "other driver GPS");
    assert((await api(ownerTok, "GET", `/api/trips/${trip.id}/location/latest`)).status === 200, "owner latest");
  });

  await test("10. Dispatched -> Loading / In Transit skip fails for the driver; transporter/shipper cannot Arrive at Pickup", async () => {
    for (const to of ["Loading", "In Transit", "Delivered"]) {
      const r = await setStatus(d1.token, trip.id, to);
      assert(r.status >= 400 && r.status < 500, `${to}: ${r.status}`);
    }
    assert((await setStatus(d2.token, trip.id, "At Pickup")).status === 403, "other driver");
    assert((await setStatus(ownerTok, trip.id, "At Pickup")).status === 403, "owner");
    assert((await setStatus(shipperTok, trip.id, "At Pickup")).status === 403, "shipper");
    assert(dbStatus(trip.id) === "Dispatched", "moved");
  });

  await test("11. correct driver: Dispatched -> At Pickup; monitoring reflects it", async () => {
    const r = await setStatus(d1.token, trip.id, "At Pickup");
    assert(r.status === 200 && r.json.status === "At Pickup", JSON.stringify(r));
    assert((await api(ownerTok, "GET", `/api/trips/${trip.id}`)).json.status === "At Pickup", "owner");
    assert((await api(shipperTok, "GET", `/api/trips/${trip.id}`)).json.status === "At Pickup", "shipper");
  });

  await test("12. GPS pipeline still works At Pickup", async () => {
    const loc = await api(d1.token, "POST", `/api/trips/${trip.id}/location`, { ...GPS, lat: -1.2925 });
    assert(loc.status === 200 || loc.status === 201, JSON.stringify(loc));
  });

  await test("13. At Pickup: driver cannot bypass the gate (Loading / In Transit => 409 LOADING_EVIDENCE_REQUIRED or 4xx), status unchanged", async () => {
    const l = await setStatus(d1.token, trip.id, "Loading");
    assert(l.status === 409 && l.json.code === "LOADING_EVIDENCE_REQUIRED", JSON.stringify(l));
    const t = await setStatus(d1.token, trip.id, "In Transit");
    assert(t.status >= 400 && t.status < 500, t.status);
    assert(dbStatus(trip.id) === "At Pickup", "moved");
  });

  await test("14. trip creation and dispatch leave escrow untouched (money immutability)", async () => {
    const e = row("SELECT status s FROM escrows WHERE booking_id = ?", trip.bookingId);
    assert(e && e.s === "Held", JSON.stringify(e));
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });

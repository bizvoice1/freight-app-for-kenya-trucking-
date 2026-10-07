// Phase 5E-4B acceptance — backend contract behind the Driver Gate Pass + Loading Agent screens. Run against a server started with GATE_TOKEN_TTL_SECONDS=4.
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
  const login = async (phone, role, pin = "1234") => (await api(null, "POST", "/api/auth/login", { phone, pin, role })).json.token;
  const admin = await login("0700000002", "admin");
  const agentNbo = await login("0700000010", "loading_agent");
  const agentMsa = await login("0700000011", "loading_agent");
  const s = await reg({ name: "Grace Shipper", phone: `07${run}11`, pin: "4821", role: "shipper" });
  const a = await reg({ name: "Ahmed Hassan", phone: `07${run}21`, pin: "4823", role: "fleet_owner" });
  const mkDriver = async (tag, n) => {
    const truck = (await api(a.json.token, "POST", "/api/trucks", { plate: `K${tag}${run.slice(0, 2)} ${n}${n}${n}Z`, truckType: "Flatbed" })).json;
    const phone = `07${run}3${n}`;
    const d = (await api(a.json.token, "POST", "/api/drivers", { name: `Driver ${tag}`, phone, pin: "6789", truckId: truck.id })).json;
    return { truck, d, token: await login(phone, "driver", "6789") };
  };
  const mkTrip = async (drv) => {
    const load = (await api(s.json.token, "POST", "/api/loads", { cargo: "Maize", origin: "Nairobi", destination: "Nakuru", weight: 10, truckType: "Flatbed", price: 60000, pickupDate: "2030-01-01", pickup: NBO_NKU.pickup, delivery: NBO_NKU.delivery })).json;
    assert((await api(admin, "PUT", `/api/loads/${load.id}/pickup-site`, { siteId: "LS-1000" })).status < 300, "assign site");
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
  const events = (id) => row("SELECT count(*) n FROM gate_events WHERE trip_id = ?", id).n;
  const money = () => JSON.stringify([row("SELECT count(*) n, group_concat(status) s FROM escrows"), row("SELECT count(*) n FROM payouts"), row("SELECT count(*) n FROM payments")]);

  const d1 = await mkDriver("A", 1), d2 = await mkDriver("B", 2);
  const trip = await mkTrip(d1);
  assert((await setStatus(d1.token, trip.id, "Dispatched")).status === 200, "dispatch");
  assert((await setStatus(d1.token, trip.id, "At Pickup")).status === 200, "at pickup");
  const moneyBefore = money();
  const issue = (tok, purpose) => api(tok, "POST", `/api/trips/${trip.id}/gate-token`, purpose ? { purpose } : {});

  await test("1. GET /gate/agent/sites returns only the agent's own site(s), id+name+active only", async () => {
    const r = await api(agentNbo, "GET", "/api/gate/agent/sites");
    assert(r.status === 200 && r.json.length === 1 && r.json[0].id === "LS-1000", JSON.stringify(r));
    assert(Object.keys(r.json[0]).sort().join() === "active,id,name", Object.keys(r.json[0]).join());
    const m = await api(agentMsa, "GET", "/api/gate/agent/sites");
    assert(m.json.length === 1 && m.json[0].id === "LS-1001", JSON.stringify(m.json));
  });

  await test("2. non-agents cannot call /gate/agent/sites", async () => {
    for (const [name, tok] of [["driver", d1.token], ["shipper", s.json.token], ["owner", a.json.token], ["admin", admin]]) {
      assert((await api(tok, "GET", "/api/gate/agent/sites")).status === 403, name);
    }
    assert((await api(null, "GET", "/api/gate/agent/sites")).status === 401, "anon");
  });

  await test("3. agent read model: site trip visible, other site's agent sees nothing, no commercial fields", async () => {
    const r = await api(agentNbo, "GET", "/api/gate/agent/trips");
    const t = r.json.find(x => x.tripId === trip.id);
    assert(t && t.truck.registration === d1.truck.plate && t.driver.name === "Driver A", JSON.stringify(r.json));
    const txt = JSON.stringify(t).toLowerCase();
    for (const bad of ["price", "escrow", "amount", "phone", "shipper", "negotiat", "payment"]) assert(!txt.includes(bad), `leaks ${bad}`);
    assert(!(await api(agentMsa, "GET", "/api/gate/agent/trips")).json.some(x => x.tripId === trip.id), "wrong-site agent sees trip");
  });

  await test("4. agents are blocked from commercial endpoints", async () => {
    for (const p of ["/api/loads", "/api/bookings", "/api/escrows", "/api/payments", `/api/trips/${trip.id}`, "/api/trucks", "/api/drivers"]) {
      const r = await api(agentNbo, "GET", p);
      assert(r.status === 403, `${p}: ${r.status}`);
    }
  });

  await test("5. wrong driver cannot get a gate pass; shipper/owner/agent cannot either", async () => {
    assert((await issue(d2.token)).status === 403, "other driver");
    for (const tok of [s.json.token, a.json.token, agentNbo]) assert((await issue(tok)).status === 403, "non-driver");
    assert((await api(d2.token, "GET", `/api/trips/${trip.id}/gate`)).status === 403, "other driver gate state");
  });

  await test("6. driver must request the eligible step: LOADING_START before GATE_IN is refused", async () => {
    const r = await issue(d1.token, "LOADING_START");
    assert(r.status === 409, JSON.stringify(r));
  });

  let p1;
  await test("7. driver issues GATE_IN pass; gate state shows the active pass and the next action", async () => {
    const r = await issue(d1.token, "GATE_IN");
    assert(r.status === 201 && r.json.qrText.startsWith("behari:gate:") && r.json.purpose === "GATE_IN", JSON.stringify(r));
    p1 = r.json;
    const g = (await api(d1.token, "GET", `/api/trips/${trip.id}/gate`)).json;
    assert(g.activeToken?.purpose === "GATE_IN" && g.nextAction?.purpose === "GATE_IN" && g.site?.id === "LS-1000", JSON.stringify(g));
  });

  await test("8. wrong-site agent scan is refused, nothing recorded, pass remains usable", async () => {
    const r = await api(agentMsa, "POST", "/api/gate/scan", { token: p1.qrText });
    assert(r.status === 403 && r.json.code === "GATE_AGENT_NOT_AUTHORIZED", JSON.stringify(r));
    assert(events(trip.id) === 0 && dbStatus(trip.id) === "At Pickup", "state changed");
  });

  await test("9. garbage / empty scan bodies fail safely", async () => {
    assert((await api(agentNbo, "POST", "/api/gate/scan", { token: "not-a-pass" })).json.code === "GATE_TOKEN_INVALID", "garbage");
    assert((await api(agentNbo, "POST", "/api/gate/scan", {})).status === 400, "empty");
    assert((await api(agentNbo, "POST", "/api/gate/scan", { token: "behari:gate:" + "x".repeat(40) })).status === 404, "unknown token");
    assert((await api(d1.token, "POST", "/api/gate/scan", { token: p1.qrText })).status === 403, "driver scanning");
  });

  await test("10. correct agent: GATE_IN recorded, trip stays At Pickup", async () => {
    const r = await api(agentNbo, "POST", "/api/gate/scan", { token: p1.qrText });
    assert(r.status === 201 && r.json.event.eventType === "GATE_IN" && r.json.event.tripStatusAfter === "At Pickup", JSON.stringify(r));
    assert(r.json.trip.truck.registration === d1.truck.plate && r.json.trip.driver.name === "Driver A", "facts");
    assert(dbStatus(trip.id) === "At Pickup" && events(trip.id) === 1, "db");
  });

  await test("11. replayed QR is refused (used); no second event", async () => {
    const r = await api(agentNbo, "POST", "/api/gate/scan", { token: p1.qrText });
    assert(r.status === 409 && r.json.code === "GATE_TOKEN_USED", JSON.stringify(r));
    assert(events(trip.id) === 1, "duplicate event");
  });

  await test("12. a replacement pass revokes the previous one (refresh behaviour)", async () => {
    const first = (await issue(d1.token, "LOADING_START")).json;
    const second = (await issue(d1.token, "LOADING_START")).json;
    assert(first.qrText !== second.qrText, "same token reissued");
    const g = (await api(d1.token, "GET", `/api/trips/${trip.id}/gate`)).json;
    assert(g.activeToken?.expiresAt === second.expiresAt, "active token is not the replacement");
    const old = await api(agentNbo, "POST", "/api/gate/scan", { token: first.qrText });
    assert(old.status === 409 && old.json.code === "GATE_TOKEN_REVOKED", JSON.stringify(old));
    assert(events(trip.id) === 1, "event from revoked pass");
    p1 = second;
  });

  await test("13. LOADING_STARTED: scan moves the trip to Loading", async () => {
    const r = await api(agentNbo, "POST", "/api/gate/scan", { token: p1.qrText });
    assert(r.status === 201 && r.json.event.eventType === "LOADING_STARTED" && r.json.event.tripStatusAfter === "Loading", JSON.stringify(r));
    assert(dbStatus(trip.id) === "Loading", "db");
    const g = (await api(d1.token, "GET", `/api/trips/${trip.id}/gate`)).json;
    assert(g.tripStatus === "Loading" && g.nextAction?.purpose === "LOADING_COMPLETE", JSON.stringify(g));
  });

  await test("14. expired pass is refused (GATE_TOKEN_EXPIRED) and records nothing", async () => {
    const p = (await issue(d1.token, "LOADING_COMPLETE")).json;
    await sleep(5500);
    const r = await api(agentNbo, "POST", "/api/gate/scan", { token: p.qrText });
    assert(r.status === 410 && r.json.code === "GATE_TOKEN_EXPIRED", JSON.stringify(r));
    assert(dbStatus(trip.id) === "Loading" && events(trip.id) === 2, "state changed");
  });

  await test("15. direct status bypass fails while Loading (driver, owner, admin)", async () => {
    for (const [n, tok] of [["driver", d1.token], ["owner", a.json.token], ["admin", admin]]) {
      const r = await setStatus(tok, trip.id, "In Transit");
      assert(r.status >= 400 && r.status < 500, `${n}: ${r.status}`);
    }
    assert(dbStatus(trip.id) === "Loading", "moved");
  });

  await test("16. LOADING_COMPLETED: scan moves the trip to In Transit and the agent list drops it", async () => {
    const p = (await issue(d1.token, "LOADING_COMPLETE")).json;
    const r = await api(agentNbo, "POST", "/api/gate/scan", { token: p.qrText });
    assert(r.status === 201 && r.json.event.eventType === "LOADING_COMPLETED" && r.json.event.tripStatusAfter === "In Transit", JSON.stringify(r));
    assert(dbStatus(trip.id) === "In Transit" && events(trip.id) === 3, "db");
    assert(!(await api(agentNbo, "GET", "/api/gate/agent/trips")).json.some(x => x.tripId === trip.id), "still listed");
  });

  await test("17. no further pass can be issued once In Transit", async () => {
    const r = await issue(d1.token);
    assert(r.status >= 400 && r.status < 500, JSON.stringify(r));
  });

  await test("18. no gate success or failure altered escrow / payout / payment state", async () => {
    assert(money() === moneyBefore, `${moneyBefore} -> ${money()}`);
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });

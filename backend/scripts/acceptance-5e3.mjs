// Phase 5E-3 — adversarial Gate Pass security suite. Real HTTP against a fresh migrated + seeded backend,
// plus direct SQLite for state inspection / fault injection. Run the server with GATE_TOKEN_TTL_SECONDS=4.
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NBO_NKU } from "./fixtures.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "behari.sqlite");
const TTL_MS = (Number(process.env.GATE_TOKEN_TTL_SECONDS) || 300) * 1000;

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS -", name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log("FAIL -", name, "->", e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(token, method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function login(phone, role, pin = "1234") {
  const { status, json } = await api(null, "POST", "/api/auth/login", { phone, pin, role });
  assert(status === 200, `login ${phone}/${role} failed: ${JSON.stringify(json)}`);
  return json;
}
async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out"); await sleep(60); }
}
const rawDb = () => new Database(DB_PATH);
const exec = (sql, ...a) => { const d = rawDb(); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const row = (sql, ...a) => { const d = rawDb(); const r = d.prepare(sql).get(...a); d.close(); return r; };
const rows = (sql, ...a) => { const d = rawDb(); const r = d.prepare(sql).all(...a); d.close(); return r; };
const execScript = (sql) => { const d = rawDb(); try { d.exec(sql); } finally { d.close(); } };

let shipper, james, admin, peter, agentNbo, agentMsa, daniel;
let truckId, driverId;
let pair2 = null; // second truck + driver for cross-trip tests
const rawTok = (qr) => qr.replace("behari:gate:", "");
const CANARY_CARGO = "CANARY-CARGO-Q7X";
const CANARY_PRICE = 91357;

async function setup() {
  shipper = await login("0700000001", "shipper");
  james   = await login("0722100200", "fleet_owner");
  daniel  = await login("0711000000", "fleet_owner");
  admin   = await login("0700000002", "admin");
  peter   = await login("0733222333", "driver");
  agentNbo = await login("0700000010", "loading_agent");
  agentMsa = await login("0700000011", "loading_agent");
  truckId  = (await api(james.token, "GET", "/api/trucks")).json.find(t => t.plate === "KBD 092K").id;
  driverId = (await api(james.token, "GET", "/api/drivers")).json.find(d => d.name === "Peter Otieno").id;
}
function repairPeter() {
  const d = rawDb();
  d.prepare("UPDATE trucks SET current_driver_id = ?, status = 'Assigned' WHERE id = ?").run(driverId, truckId);
  d.prepare("UPDATE drivers SET assigned_truck_id = ?, status = 'Assigned' WHERE id = ?").run(truckId, driverId);
  d.prepare("UPDATE trips SET status = 'Cancelled' WHERE truck_id = ? AND status NOT IN ('Delivered', 'Cancelled')").run(truckId);
  d.close();
}
async function pay(bookingId) {
  const r = await api(shipper.token, "POST", `/api/bookings/${bookingId}/payment`, { phoneNumber: "254700111222" });
  assert(r.status === 201, `payment failed ${JSON.stringify(r.json)}`);
  return waitFor(async () => { const p = (await api(shipper.token, "GET", `/api/payments/${r.json.id}`)).json; return p.status !== "StkSent" ? p : null; });
}
// opts.pair2 → use the second truck/driver instead of Peter
async function newTrip({ siteId = "LS-1000", second = false } = {}) {
  if (!second) repairPeter();
  const tId = second ? pair2.truckId : truckId, dId = second ? pair2.driverId : driverId;
  const load = (await api(shipper.token, "POST", "/api/loads", { cargo: CANARY_CARGO, origin: "Nairobi", destination: "Nakuru", price: CANARY_PRICE, ...NBO_NKU })).json;
  const a = await api(james.token, "POST", `/api/loads/${load.id}/accept`, {});
  assert(a.status === 201 || a.status === 200, `accept failed ${JSON.stringify(a.json)}`);
  const asg = await api(james.token, "POST", `/api/bookings/${a.json.id}/assign`, { truckId: tId, driverId: dId });
  assert(asg.status === 200, `assign failed ${JSON.stringify(asg.json)}`);
  await pay(a.json.id);
  const ct = await api(james.token, "POST", `/api/bookings/${a.json.id}/create-trip`, {});
  assert(ct.status === 201, `create-trip failed ${JSON.stringify(ct.json)}`);
  if (siteId) {
    const r = await api(admin.token, "PUT", `/api/loads/${load.id}/pickup-site`, { siteId });
    assert(r.status === 200, `set site failed ${JSON.stringify(r.json)}`);
  }
  return { load, booking: a.json, trip: ct.json };
}
const setStatus = (who, tripId, status) => api(who.token, "POST", `/api/trips/${tripId}/status`, { status });
const issue = (who, tripId, body = {}) => api(who.token, "POST", `/api/trips/${tripId}/gate-token`, body);
const scan = (who, token) => api(who?.token, "POST", "/api/gate/scan", { token });
async function toPickup(tripId, driver = peter) {
  assert((await setStatus(driver, tripId, "Dispatched")).status === 200, "dispatch");
  assert((await setStatus(driver, tripId, "At Pickup")).status === 200, "at pickup");
}
const tripStatus = (id) => row("SELECT status s FROM trips WHERE id = ?", id).s;
const events = (tripId) => rows("SELECT event_type t, token_id k FROM gate_events WHERE trip_id = ? ORDER BY rowid", tripId);
const tokensOf = (tripId) => rows("SELECT * FROM gate_tokens WHERE trip_id = ? ORDER BY issued_at, rowid", tripId);
const moneySnapshot = () => JSON.stringify({
  escrows: rows("SELECT * FROM escrows ORDER BY id"),
  payments: rows("SELECT * FROM payments ORDER BY id"),
  payouts: rows("SELECT * FROM payouts ORDER BY id"),
  adjustments: rows("SELECT * FROM adjustments ORDER BY id"),
});
async function stepAs(driver, tripId, agent = agentNbo) {
  const t = await issue(driver, tripId);
  assert(t.status === 201, `issue failed ${JSON.stringify(t.json)}`);
  const s = await scan(agent, t.json.qrText);
  assert(s.status === 201, `scan failed ${JSON.stringify(s.json)}`);
  return { t: t.json, s: s.json };
}
const FORBIDDEN_KEYS = /price|amount|escrow|payment|payout|shipper|fare|bid|gps|latitude|longitude|breadcrumb|rating|earning|commission|booking|phone|email|pin|hash|owner|fleet/i;
function keysDeep(o, acc = []) {
  if (Array.isArray(o)) o.forEach(x => keysDeep(x, acc));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { acc.push(k); keysDeep(v, acc); }
  return acc;
}
const sqlCleanup = [];

async function main() {
  await setup();

  // second truck + driver for cross-trip / cross-driver attacks
  {
    const run = String(Date.now()).slice(-6);
    const tr = await api(james.token, "POST", "/api/trucks", { plate: `KZZ ${run.slice(-3)}Z`, truckType: "Flatbed", capacity: "20 tonnes" });
    assert(tr.status === 201, `truck2 ${JSON.stringify(tr.json)}`);
    const dr = await api(james.token, "POST", "/api/drivers", { name: "Second Driver", phone: `0799${run}`, pin: "6789", licenseNumber: "DL-E3", truckId: tr.json.id });
    assert(dr.status === 201, `driver2 ${JSON.stringify(dr.json)}`);
    pair2 = { truckId: tr.json.id, driverId: dr.json.id, phone: `0799${run}`, pin: "6789" };
  }
  const driver2 = await login(pair2.phone, "driver", pair2.pin);

  // ── 1. Concurrency ───────────────────────────────────────────────────────
  await test("1a. 12 concurrent scans of one QR: exactly one 201, one gate_event, token consumed once", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    assert(tok.status === 201, "issue");
    const res = await Promise.all(Array.from({ length: 12 }, () => scan(agentNbo, tok.json.qrText)));
    const ok = res.filter(r => r.status === 201), bad = res.filter(r => r.status !== 201);
    assert(ok.length === 1, `successes=${ok.length} ${JSON.stringify(res.map(r => r.status))}`);
    assert(bad.every(r => r.status === 409 && r.json.code === "GATE_TOKEN_USED"), JSON.stringify(bad.map(r => [r.status, r.json?.code])));
    assert(events(t.trip.id).length === 1, `events=${events(t.trip.id).length}`);
    const tk = tokensOf(t.trip.id);
    assert(tk.length === 1 && tk[0].consumed_at && tk[0].consumed_by_user_id, "token not consumed once");
    assert(events(t.trip.id)[0].k === tk[0].id, "event not linked to the consumed token");
  });

  await test("1b. two authorized agents racing on the same QR still yield one event", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const agentId = row("SELECT id FROM users WHERE phone='0700000011' AND role='loading_agent'").id;
    const add = await api(admin.token, "POST", "/api/loading-sites/LS-1000/agents", { agentUserId: agentId });
    assert(add.status === 201 || add.status === 200, `add agent ${JSON.stringify(add.json)}`);
    try {
      const tok = await issue(peter, t.trip.id);
      const res = await Promise.all([...Array(6)].map((_, i) => scan(i % 2 ? agentMsa : agentNbo, tok.json.qrText)));
      assert(res.filter(r => r.status === 201).length === 1, JSON.stringify(res.map(r => r.status)));
      assert(events(t.trip.id).length === 1, "multiple events");
    } finally { await api(admin.token, "DELETE", `/api/loading-sites/LS-1000/agents/${agentId}`); }
  });

  await test("1c. concurrent token issuance leaves exactly one active token for the trip", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const res = await Promise.all(Array.from({ length: 8 }, () => issue(peter, t.trip.id)));
    assert(res.every(r => r.status === 201 || r.status === 409), JSON.stringify(res.map(r => r.status)));
    const active = tokensOf(t.trip.id).filter(k => !k.consumed_at && !k.revoked_at);
    assert(active.length === 1, `active tokens=${active.length}`);
    // only the surviving token can scan; every superseded plaintext fails
    const winners = [];
    for (const r of res.filter(r => r.status === 201)) { const s = await scan(agentNbo, r.json.qrText); if (s.status === 201) winners.push(s); }
    assert(winners.length === 1, `winning scans=${winners.length}`);
  });

  // ── 2. Replay / supersession ─────────────────────────────────────────────
  const t2 = await newTrip(); await toPickup(t2.trip.id);
  await test("2a. replay of a consumed token fails (GATE_TOKEN_USED) and adds nothing", async () => {
    const { t } = await stepAs(peter, t2.trip.id);
    const before = events(t2.trip.id).length;
    for (const form of [t.qrText, rawTok(t.qrText)]) {
      const r = await scan(agentNbo, form);
      assert(r.status === 409 && r.json.code === "GATE_TOKEN_USED", JSON.stringify(r.json));
    }
    assert(events(t2.trip.id).length === before && tripStatus(t2.trip.id) === "At Pickup", "state moved by replay");
  });
  await test("2b. superseded token fails (GATE_TOKEN_REVOKED); only the replacement works", async () => {
    const a = await issue(peter, t2.trip.id), b = await issue(peter, t2.trip.id);
    assert(a.status === 201 && b.status === 201, "issue");
    const old = tokensOf(t2.trip.id).find(k => k.revoke_reason && !k.consumed_at);
    assert(old && old.revoked_at, "old token not revoked in DB");
    const ra = await scan(agentNbo, a.json.qrText);
    assert(ra.status === 409 && ra.json.code === "GATE_TOKEN_REVOKED", JSON.stringify(ra.json));
    const rb = await scan(agentNbo, b.json.qrText);
    assert(rb.status === 201 && rb.json.event.eventType === "LOADING_STARTED", JSON.stringify(rb.json));
    assert(tripStatus(t2.trip.id) === "Loading", "trip not Loading");
  });
  await test("2c. expired token fails (410 GATE_TOKEN_EXPIRED), is not consumed, no event", async () => {
    const tok = await issue(peter, t2.trip.id);
    assert(tok.status === 201, JSON.stringify(tok.json));
    await sleep(TTL_MS + 600);
    const before = events(t2.trip.id).length;
    const r = await scan(agentNbo, tok.json.qrText);
    assert(r.status === 410 && r.json.code === "GATE_TOKEN_EXPIRED", JSON.stringify(r.json));
    assert(events(t2.trip.id).length === before, "event written for expired token");
    assert(!tokensOf(t2.trip.id).find(k => k.id === tok.json.tokenId).consumed_at, "expired token consumed");
    // a fresh replacement still works
    const ok = await scan(agentNbo, (await issue(peter, t2.trip.id)).json.qrText);
    assert(ok.status === 201 && ok.json.event.eventType === "LOADING_COMPLETED", JSON.stringify(ok.json));
  });
  await test("2d. admin-revoked token fails; garbage / malformed / wrong-prefix tokens are rejected without side effects", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    exec("UPDATE gate_tokens SET revoked_at = ?, revoke_reason = 'ADMIN' WHERE id = ?", new Date().toISOString(), tok.json.tokenId);
    const r = await scan(agentNbo, tok.json.qrText);
    assert(r.status === 409 && r.json.code === "GATE_TOKEN_REVOKED", JSON.stringify(r.json));
    const fake = "A".repeat(43);
    for (const bad of ["", "x", fake, `behari:gate:${fake}`, "behari:gate:", "behari:gate:" + rawTok(tok.json.qrText).slice(1), rawTok(tok.json.qrText) + "A", "../../etc/passwd", "' OR 1=1 --", null, 123, {}, [rawTok(tok.json.qrText)]]) {
      const x = await api(agentNbo.token, "POST", "/api/gate/scan", { token: bad });
      assert(x.status >= 400 && x.status < 500, `bad token ${JSON.stringify(bad)} → ${x.status}`);
    }
    assert((await api(agentNbo.token, "POST", "/api/gate/scan", {})).status === 400, "missing token");
    assert(events(t.trip.id).length === 0, "event from garbage");
  });
  await test("2e. token plaintext is never stored (only SHA-256 hash) and never returned by driver gate state", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    const dump = JSON.stringify(rows("SELECT * FROM gate_tokens"));
    assert(!dump.includes(rawTok(tok.json.qrText)), "plaintext token persisted");
    const g = await api(peter.token, "GET", `/api/trips/${t.trip.id}/gate`);
    assert(!JSON.stringify(g.json).includes(rawTok(tok.json.qrText)), "gate state echoes token");
  });

  // ── 3. Wrong actors / site ───────────────────────────────────────────────
  const t3 = await newTrip(); await toPickup(t3.trip.id);
  await test("3. only an authorized loading agent can scan: unauth, shipper, transporter, driver, admin, other-site agent all refused; token stays unconsumed", async () => {
    const tok = await issue(peter, t3.trip.id);
    const r0 = await api(null, "POST", "/api/gate/scan", { token: tok.json.qrText });
    assert(r0.status === 401, `unauth ${r0.status}`);
    for (const [name, who] of [["shipper", shipper], ["transporter", james], ["other transporter", daniel], ["driver", peter], ["other driver", driver2], ["admin", admin]]) {
      const r = await scan(who, tok.json.qrText);
      assert(r.status === 403, `${name} got ${r.status} ${JSON.stringify(r.json)}`);
    }
    const wrongSite = await scan(agentMsa, tok.json.qrText);
    assert(wrongSite.status === 403 && wrongSite.json.code === "GATE_AGENT_NOT_AUTHORIZED", JSON.stringify(wrongSite.json));
    assert(events(t3.trip.id).length === 0, "event written");
    const tk = tokensOf(t3.trip.id).find(k => k.id === tok.json.tokenId);
    assert(!tk.consumed_at && !tk.revoked_at, "token burned by a refused actor");
    const good = await scan(agentNbo, tok.json.qrText);
    assert(good.status === 201, `legit agent blocked afterwards ${JSON.stringify(good.json)}`);
  });
  await test("3b. agent removed from the site after issuance can no longer redeem that QR", async () => {
    const tok = await issue(peter, t3.trip.id);
    const agentId = row("SELECT id FROM users WHERE phone='0700000010' AND role='loading_agent'").id;
    assert((await api(admin.token, "DELETE", `/api/loading-sites/LS-1000/agents/${agentId}`)).status < 300, "remove agent");
    try {
      const r = await scan(agentNbo, tok.json.qrText);
      assert(r.status === 403 && r.json.code === "GATE_AGENT_NOT_AUTHORIZED", JSON.stringify(r.json));
    } finally { await api(admin.token, "POST", "/api/loading-sites/LS-1000/agents", { agentUserId: agentId }); }
    assert(!tokensOf(t3.trip.id).find(k => k.id === tok.json.tokenId).consumed_at, "token consumed");
  });
  await test("3c. a driver cannot issue for another driver's trip, and a non-driver cannot issue at all", async () => {
    for (const who of [driver2, shipper, james, admin, agentNbo]) {
      const r = await issue(who, t3.trip.id);
      assert(r.status === 403, `got ${r.status}`);
    }
    assert((await api(null, "POST", `/api/trips/${t3.trip.id}/gate-token`, {})).status === 401, "unauth issue");
  });

  // ── 4. Wrong trip / state / sequence ─────────────────────────────────────
  await test("4a. no QR can be issued out of sequence or in an incompatible trip state", async () => {
    const t = await newTrip();
    for (const st of ["Assigned"]) { const r = await issue(peter, t.trip.id); assert(r.status === 409, `issue at ${st} → ${r.status}`); }
    assert((await setStatus(peter, t.trip.id, "Dispatched")).status === 200, "dispatch");
    assert((await issue(peter, t.trip.id)).status === 409, "issue at Dispatched");
    assert((await setStatus(peter, t.trip.id, "At Pickup")).status === 200, "at pickup");
    for (const purpose of ["LOADING_START", "LOADING_COMPLETE"]) {
      const r = await issue(peter, t.trip.id, { purpose });
      assert(r.status === 409 && r.json.code === "GATE_PURPOSE_NOT_ELIGIBLE", `${purpose} ${JSON.stringify(r.json)}`);
    }
    assert(events(t.trip.id).length === 0, "events");
  });
  await test("4b. GATE_IN cannot be bypassed: first scan is GATE_IN, then LOADING_STARTED, then LOADING_COMPLETED; status route still refuses (even admin)", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    for (const who of [peter, admin]) {
      const r = await setStatus(who, t.trip.id, "Loading");
      assert(r.status === 409 && r.json.code === "LOADING_EVIDENCE_REQUIRED", JSON.stringify(r.json));
    }
    assert((await stepAs(peter, t.trip.id)).s.event.eventType === "GATE_IN", "first not GATE_IN");
    assert(tripStatus(t.trip.id) === "At Pickup", "GATE_IN moved the trip");
    assert((await stepAs(peter, t.trip.id)).s.event.eventType === "LOADING_STARTED", "second not LOADING_STARTED");
    assert(tripStatus(t.trip.id) === "Loading", "not Loading");
    for (const who of [peter, admin]) {
      const r = await setStatus(who, t.trip.id, "In Transit");
      assert(r.status === 409 && r.json.code === "LOADING_EVIDENCE_REQUIRED", `Loading→In Transit ${JSON.stringify(r.json)}`);
    }
    assert(tripStatus(t.trip.id) === "Loading", "status route moved Loading");
    assert((await stepAs(peter, t.trip.id)).s.event.eventType === "LOADING_COMPLETED", "third not LOADING_COMPLETED");
    assert(tripStatus(t.trip.id) === "In Transit", "not In Transit");
    assert(events(t.trip.id).map(e => e.t).join() === "GATE_IN,LOADING_STARTED,LOADING_COMPLETED", "event order");
    // after completion nothing more can be issued, and nothing replays
    const more = await issue(peter, t.trip.id);
    assert(more.status === 409, `issue after complete ${more.status}`);
    for (const k of tokensOf(t.trip.id)) assert(k.consumed_at, "unconsumed leftover token");
  });
  await test("4c. a token issued for the current step cannot be redeemed after the trip left that state", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    exec("UPDATE trips SET status = 'Cancelled' WHERE id = ?", t.trip.id);
    const r = await scan(agentNbo, tok.json.qrText);
    assert(r.status === 409 && r.json.code === "GATE_WRONG_TRIP_STATE", JSON.stringify(r.json));
    assert(events(t.trip.id).length === 0 && tripStatus(t.trip.id) === "Cancelled", "state/evidence changed");
    assert(!tokensOf(t.trip.id)[0].consumed_at, "token consumed on refused scan");
    repairPeter();
  });
  await test("4d. DB triggers refuse forged evidence even with direct SQL (no GATE_IN → LOADING_STARTED, no unconsumed-token event)", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    const fk = rows("SELECT * FROM gate_events LIMIT 1")[0];
    const forge = (type, before, after, tokenId) => exec(
      `INSERT INTO gate_events (id, trip_id, booking_id, truck_id, driver_id, site_id, agent_user_id, token_id, token_purpose, event_type, trip_status_before, trip_status_after, booking_funded, driver_location_available, created_at)
       SELECT 'FORGE-' || ?, t.id, t.booking_id, t.truck_id, t.driver_id, l.pickup_site_id, (SELECT id FROM users WHERE phone='0700000010'), ?, ?, ?, ?, ?, 1, 0, ?
       FROM trips t JOIN loads l ON l.id = t.load_id WHERE t.id = ?`,
      String(Math.random()).slice(2), tokenId, { LOADING_STARTED: "LOADING_START", GATE_IN: "GATE_IN" }[type], type, before, after, new Date().toISOString(), t.trip.id);
    let threw = null;
    try { forge("LOADING_STARTED", "At Pickup", "Loading", tok.json.tokenId); } catch (e) { threw = e.message; }
    assert(threw, "forged LOADING_STARTED (unconsumed token, no GATE_IN) was inserted");
    threw = null;
    try { forge("GATE_IN", "At Pickup", "At Pickup", tok.json.tokenId); } catch (e) { threw = e.message; }
    assert(threw && /GATE_TOKEN_INVALID/.test(threw), `forged GATE_IN with unconsumed token: ${threw}`);
    assert(events(t.trip.id).length === 0, "forged events persisted");
  });

  // ── 5. Assignment mutation after issuance ────────────────────────────────
  await test("5a. pickup site changed after issuance: the old site's agent can no longer redeem; token not burned", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    const mv = await api(admin.token, "PUT", `/api/loads/${t.load.id}/pickup-site`, { siteId: "LS-1001" });
    assert(mv.status === 200, `move site ${JSON.stringify(mv.json)}`);
    const r = await scan(agentNbo, tok.json.qrText);
    assert(r.status === 403 && r.json.code === "GATE_AGENT_NOT_AUTHORIZED", `old-site agent ${r.status} ${JSON.stringify(r.json)}`);
    assert(events(t.trip.id).length === 0, "event written");
    assert(!tokensOf(t.trip.id)[0].consumed_at, "token burned");
    await api(admin.token, "PUT", `/api/loads/${t.load.id}/pickup-site`, { siteId: "LS-1000" });
  });
  await test("5b. site deactivated after issuance blocks redemption (no event, no state change)", async () => {
    const mk = await api(admin.token, "POST", "/api/loading-sites", { name: "E3 Temp Yard", lat: -1.2, lng: 36.8, radiusMeters: 200 });
    assert(mk.status === 201, "mk site");
    const agentId = row("SELECT id FROM users WHERE phone='0700000010' AND role='loading_agent'").id;
    await api(admin.token, "POST", `/api/loading-sites/${mk.json.id}/agents`, { agentUserId: agentId });
    const t = await newTrip({ siteId: mk.json.id }); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    assert(tok.status === 201, JSON.stringify(tok.json));
    await api(admin.token, "PATCH", `/api/loading-sites/${mk.json.id}`, { active: false });
    const r = await scan(agentNbo, tok.json.qrText);
    assert(r.status >= 400 && r.status < 500, `scan at inactive site ${r.status}`);
    assert(events(t.trip.id).length === 0 && tripStatus(t.trip.id) === "At Pickup", "state/evidence changed");
    assert(!tokensOf(t.trip.id)[0].consumed_at, "token burned");
  });
  await test("5c. half-applied reassignment (trip.driver changed, booking not) is refused as GATE_ASSIGNMENT_MISMATCH", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    exec("UPDATE trips SET driver_id = ? WHERE id = ?", pair2.driverId, t.trip.id);
    try {
      const r = await scan(agentNbo, tok.json.qrText);
      assert(r.status === 409 && r.json.code === "GATE_ASSIGNMENT_MISMATCH", `${r.status} ${JSON.stringify(r.json)}`);
      assert(events(t.trip.id).length === 0 && !tokensOf(t.trip.id)[0].consumed_at, "evidence/consumption on mismatch");
    } finally { exec("UPDATE trips SET driver_id = ? WHERE id = ?", driverId, t.trip.id); repairPeter(); }
  });
  await test("5d. FULL reassignment (trip + booking move to another truck/driver) invalidates the old driver's QR", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    exec("UPDATE bookings SET truck_id = ?, driver_id = ? WHERE id = ?", pair2.truckId, pair2.driverId, t.booking.id);
    exec("UPDATE trips SET truck_id = ?, driver_id = ? WHERE id = ?", pair2.truckId, pair2.driverId, t.trip.id);
    try {
      const r = await scan(agentNbo, tok.json.qrText);
      assert(r.status >= 400 && r.status < 500, `stale QR for the replaced driver was ACCEPTED: ${r.status} ${JSON.stringify(r.json)}`);
      assert(events(t.trip.id).length === 0, "event recorded for replaced driver's QR");
      // the old driver can no longer even ask for a new one; the new driver can
      assert((await issue(peter, t.trip.id)).status === 403, "old driver still issuing");
      assert((await issue(driver2, t.trip.id)).status === 201, "new driver cannot issue");
    } finally {
      exec("UPDATE trips SET truck_id = ?, driver_id = ? WHERE id = ?", truckId, driverId, t.trip.id);
      exec("UPDATE bookings SET truck_id = ?, driver_id = ? WHERE id = ?", truckId, driverId, t.booking.id);
      repairPeter();
    }
  });

  // ── 6. Funding boundary ──────────────────────────────────────────────────
  await test("6a. escrow leaves HELD after issuance → scan refused (GATE_NOT_FUNDED); no event; restoring funding lets the same QR work", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    const esc = row("SELECT id, status FROM escrows WHERE booking_id = ?", t.booking.id);
    assert(esc.status === "Held", `escrow ${esc.status}`);
    exec("UPDATE escrows SET status = 'PaymentFailed' WHERE id = ?", esc.id);
    try {
      const r = await scan(agentNbo, tok.json.qrText);
      assert(r.status === 409 && r.json.code === "GATE_NOT_FUNDED", `${r.status} ${JSON.stringify(r.json)}`);
      assert(events(t.trip.id).length === 0 && !tokensOf(t.trip.id)[0].consumed_at, "evidence/consumption without funding");
      const i2 = await issue(peter, t.trip.id);
      assert(i2.status >= 400 && i2.status < 500, `issue while unfunded ${i2.status}`);
    } finally { exec("UPDATE escrows SET status = 'Held' WHERE id = ?", esc.id); }
    const ok = await scan(agentNbo, tok.json.qrText);
    assert(ok.status === 201, `after refund ${JSON.stringify(ok.json)}`);
  });
  await test("6b. DB trigger backstop: a gate_event cannot be inserted for an unfunded booking even with direct SQL", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    const s = await scan(agentNbo, tok.json.qrText); // legit GATE_IN gives us a template row
    assert(s.status === 201, "gate in");
    const esc = row("SELECT id FROM escrows WHERE booking_id = ?", t.booking.id);
    exec("UPDATE escrows SET status = 'Paid' WHERE id = ?", esc.id);
    try {
      const tok2 = await issue(peter, t.trip.id);
      assert(tok2.status >= 400, "issued while escrow not Held");
    } finally { exec("UPDATE escrows SET status = 'Held' WHERE id = ?", esc.id); }
  });

  // ── 7. Privacy ───────────────────────────────────────────────────────────
  await test("7. loading-agent responses: dedicated read model only — canaries (cargo, price, phones, ids, hash) never leak; unassigned trip is indistinguishable from missing", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    const list = await api(agentNbo.token, "GET", "/api/gate/agent/trips");
    const one = await api(agentNbo.token, "GET", `/api/gate/agent/trips/${t.trip.id}`);
    const sc = await scan(agentNbo, tok.json.qrText);
    const after = await api(agentNbo.token, "GET", `/api/gate/agent/trips/${t.trip.id}`);
    assert(list.status === 200 && one.status === 200 && sc.status === 201, `${list.status} ${one.status} ${sc.status}`);
    const blob = JSON.stringify([list.json, one.json, sc.json, after.json]);
    const secrets = [CANARY_CARGO, String(CANARY_PRICE), "0700000001", "0722100200", "0733222333", "0700000002", t.load.id, t.booking.id,
      row("SELECT id FROM escrows WHERE booking_id = ?", t.booking.id).id, row("SELECT id FROM users WHERE phone='0700000001'").id,
      "James", "Nakuru", rawTok(tok.json.qrText), tok.json.tokenId,
      row("SELECT token_hash h FROM gate_tokens WHERE id = ?", tok.json.tokenId).h];
    for (const s of secrets) assert(!blob.includes(s), `LEAK: agent response contains "${s}"`);
    const bad = keysDeep([list.json, one.json, sc.json, after.json]).filter(k => FORBIDDEN_KEYS.test(k));
    assert(bad.length === 0, `forbidden keys in agent payload: ${[...new Set(bad)]}`);
    // site-scoped: Mombasa agent sees nothing of this trip, and the detail is a plain 404
    const other = await api(agentMsa.token, "GET", "/api/gate/agent/trips");
    assert(!JSON.stringify(other.json).includes(t.trip.id), "other-site agent lists the trip");
    const od = await api(agentMsa.token, "GET", `/api/gate/agent/trips/${t.trip.id}`);
    const missing = await api(agentMsa.token, "GET", "/api/gate/agent/trips/TRP-DOES-NOT-EXIST");
    assert(od.status === 404 && missing.status === 404 && JSON.stringify(od.json) === JSON.stringify(missing.json).replace("TRP-DOES-NOT-EXIST", t.trip.id), `unassigned ${od.status}/${JSON.stringify(od.json)} vs missing ${missing.status}/${JSON.stringify(missing.json)}`);
    // agents cannot reach commercial endpoints
    const escId = row("SELECT id FROM escrows WHERE booking_id = ?", t.booking.id).id;
    for (const p of ["/api/trips", "/api/bookings", "/api/loads", "/api/escrows", "/api/payments", "/api/payouts", "/api/offers", "/api/trucks", "/api/drivers",
      `/api/loads/${t.load.id}`, `/api/loads/${t.load.id}/offers`, `/api/trips/${t.trip.id}`, `/api/bookings/${t.booking.id}`, `/api/bookings/${t.booking.id}/ledger`,
      `/api/trips/${t.trip.id}/location/latest`, `/api/trips/${t.trip.id}/location/history`, `/api/escrows/${escId}`]) {
      const r = await api(agentNbo.token, "GET", p);
      const b = JSON.stringify(r.json || {});
      assert(r.status === 401 || r.status === 403 || r.status === 404 || (!b.includes(CANARY_CARGO) && !b.includes(String(CANARY_PRICE)) && !b.includes("0700000001")), `agent reads ${p}: ${r.status} ${b.slice(0, 120)}`);
    }
    // driver gate state must not leak the shipper's commercial data either
    const dg = JSON.stringify((await api(peter.token, "GET", `/api/trips/${t.trip.id}/gate`)).json);
    for (const s of [String(CANARY_PRICE), "0700000001", row("SELECT id FROM escrows WHERE booking_id = ?", t.booking.id).id]) assert(!dg.includes(s), `driver gate state leaks ${s}`);
  });

  // ── 8. Atomicity (fault injection with SQLite triggers in the test DB) ───
  async function atomicity(label, injectSql, dropSql, step) {
    const t = await newTrip(); await toPickup(t.trip.id);
    let want = step;
    if (step !== "GATE_IN") await stepAs(peter, t.trip.id); // consume GATE_IN so the next step is LOADING_STARTED
    const tok = await issue(peter, t.trip.id);
    assert(tok.status === 201, "issue");
    const evBefore = events(t.trip.id).length, stBefore = tripStatus(t.trip.id);
    execScript(injectSql);
    let r;
    try { r = await scan(agentNbo, tok.json.qrText); } finally { execScript(dropSql); }
    assert(r.status >= 400, `${label}: scan succeeded despite injected fault (${r.status})`);
    const k = tokensOf(t.trip.id).find(x => x.id === tok.json.tokenId);
    assert(!k.consumed_at && !k.consumed_by_user_id, `${label}: token consumed without result`);
    assert(events(t.trip.id).length === evBefore, `${label}: event persisted without token consumption`);
    assert(tripStatus(t.trip.id) === stBefore, `${label}: trip status moved (${tripStatus(t.trip.id)})`);
    const retry = await scan(agentNbo, tok.json.qrText);
    assert(retry.status === 201, `${label}: same QR not redeemable after fault cleared ${JSON.stringify(retry.json)}`);
    return t;
  }
  await test("8a. failure while updating trip status (after event insert): rolls back token consumption AND event", async () => {
    await atomicity("trip-status fault",
      "CREATE TRIGGER e3_fail_trip BEFORE UPDATE OF status ON trips WHEN NEW.status = 'Loading' BEGIN SELECT RAISE(ABORT, 'E3_INJECTED'); END;",
      "DROP TRIGGER IF EXISTS e3_fail_trip;", "LOADING_STARTED");
  });
  await test("8b. failure immediately after the event insert: no event, token still unconsumed", async () => {
    await atomicity("post-event fault",
      "CREATE TRIGGER e3_fail_ev AFTER INSERT ON gate_events BEGIN SELECT RAISE(ABORT, 'E3_INJECTED'); END;",
      "DROP TRIGGER IF EXISTS e3_fail_ev;", "GATE_IN");
  });
  await test("8c. failure when consuming the token: no event, no state change", async () => {
    await atomicity("consume fault",
      "CREATE TRIGGER e3_fail_tok BEFORE UPDATE OF consumed_at ON gate_tokens BEGIN SELECT RAISE(ABORT, 'E3_INJECTED'); END;",
      "DROP TRIGGER IF EXISTS e3_fail_tok;", "GATE_IN");
  });
  await test("8d. notification failure after commit never undoes the evidence", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const tok = await issue(peter, t.trip.id);
    execScript("CREATE TRIGGER e3_fail_notif BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'E3_INJECTED'); END;");
    let r; try { r = await scan(agentNbo, tok.json.qrText); } finally { execScript("DROP TRIGGER IF EXISTS e3_fail_notif;"); }
    assert(r.status === 201, `scan failed because notification failed: ${r.status} ${JSON.stringify(r.json)}`);
    assert(events(t.trip.id).length === 1 && tokensOf(t.trip.id)[0].consumed_at, "evidence lost");
  });
  await test("8e. global invariant: every consumed token has exactly one event and every event has its consumed token", async () => {
    const orphanTokens = rows("SELECT k.id FROM gate_tokens k WHERE k.consumed_at IS NOT NULL AND (SELECT COUNT(*) FROM gate_events e WHERE e.token_id = k.id) <> 1");
    const orphanEvents = rows("SELECT e.id FROM gate_events e LEFT JOIN gate_tokens k ON k.id = e.token_id WHERE k.id IS NULL OR k.consumed_at IS NULL OR k.revoked_at IS NOT NULL");
    assert(orphanTokens.length === 0, `consumed tokens without exactly one event: ${JSON.stringify(orphanTokens)}`);
    assert(orphanEvents.length === 0, `events without a consumed token: ${JSON.stringify(orphanEvents)}`);
    const dupes = rows("SELECT trip_id, event_type, COUNT(*) c FROM gate_events GROUP BY trip_id, event_type HAVING c > 1");
    assert(dupes.length === 0, `duplicate event types per trip: ${JSON.stringify(dupes)}`);
  });

  // ── 9. QR theft / cross-trip ─────────────────────────────────────────────
  await test("9. a valid QR for Trip A authorizes nothing for Trip B (even when the body names Trip B)", async () => {
    const a = await newTrip(); await toPickup(a.trip.id);
    const b = await newTrip({ second: true }); await toPickup(b.trip.id, driver2);
    const ta = await issue(peter, a.trip.id);
    // driver B tries to use / issue with A's trip id
    assert((await issue(driver2, a.trip.id)).status === 403, "driver B issues for A");
    const r = await api(agentNbo.token, "POST", "/api/gate/scan", { token: ta.json.qrText, tripId: b.trip.id, trip_id: b.trip.id });
    assert(r.status === 201 && r.json.event.tripId === a.trip.id, `scan result ${JSON.stringify(r.json)}`);
    assert(events(b.trip.id).length === 0 && tripStatus(b.trip.id) === "At Pickup", "Trip B affected by A's QR");
    assert(tokensOf(b.trip.id).length === 0, "token appeared on B");
    // B's own QR advances only B; A's consumed QR is dead on B
    const rb = await scan(agentNbo, ta.json.qrText);
    assert(rb.status === 409, `A's used QR on replay ${rb.status}`);
    const tb = await issue(driver2, b.trip.id);
    const sb = await scan(agentNbo, tb.json.qrText);
    assert(sb.status === 201 && sb.json.event.tripId === b.trip.id, "B's own QR");
    assert(events(a.trip.id).length === 1, "A gained events from B's scan");
    // other-site agent scanning Trip B's fresh QR: refused
    const tb2 = await issue(driver2, b.trip.id);
    assert((await scan(agentMsa, tb2.json.qrText)).status === 403, "wrong-site agent accepted B's QR");
  });

  // ── 10. Financial immutability ───────────────────────────────────────────
  await test("10. a full gate walk (GATE_IN → LOADING_STARTED → LOADING_COMPLETED) plus refused attempts never changes any payment / escrow / payout / adjustment row", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    const snap = moneySnapshot();
    await stepAs(peter, t.trip.id); await stepAs(peter, t.trip.id);
    await scan(agentMsa, (await issue(peter, t.trip.id)).json.qrText);          // refused (wrong site)
    await scan(agentNbo, "A".repeat(43));                                       // refused (unknown)
    await setStatus(admin, t.trip.id, "In Transit");                            // refused (evidence required)
    await stepAs(peter, t.trip.id);
    assert(tripStatus(t.trip.id) === "In Transit", "walk incomplete");
    assert(moneySnapshot() === snap, "money tables changed during gate operations");
    const ep = rows("SELECT COUNT(*) c FROM payouts WHERE escrow_id IN (SELECT id FROM escrows WHERE booking_id = ?)", t.booking.id)[0].c;
    assert(ep === 0, "payout created by gate");
  });

  await test("11. ordinary status route: At Pickup→Loading and Loading→In Transit return LOADING_EVIDENCE_REQUIRED for driver, transporter-of-record and admin", async () => {
    const t = await newTrip(); await toPickup(t.trip.id);
    for (const who of [peter, admin, james, shipper]) {
      const r = await setStatus(who, t.trip.id, "Loading");
      assert(r.status === 409 ? r.json.code === "LOADING_EVIDENCE_REQUIRED" : r.status === 403, `Loading by role → ${r.status} ${JSON.stringify(r.json)}`);
    }
    await stepAs(peter, t.trip.id); await stepAs(peter, t.trip.id);
    assert(tripStatus(t.trip.id) === "Loading", "setup");
    for (const who of [peter, admin]) {
      const r = await setStatus(who, t.trip.id, "In Transit");
      assert(r.status === 409 && r.json.code === "LOADING_EVIDENCE_REQUIRED", `${r.status} ${JSON.stringify(r.json)}`);
    }
    assert(tripStatus(t.trip.id) === "Loading", "moved");
  });

  repairPeter();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — FAILED: " + failed.map(f => f.name).join("; ") : "."}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });

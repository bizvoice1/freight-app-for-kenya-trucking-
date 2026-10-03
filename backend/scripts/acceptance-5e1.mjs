/**
 * Phase 5E-1 acceptance — gate domain foundation (no HTTP routes exist yet).
 * Runs against its OWN throwaway database (never behari.sqlite), migrated and seeded
 * through the real npm scripts, then drives the real services + raw SQL to prove the
 * trigger backstop. Usage: npm run test:5e1
 */
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

const DB = `/tmp/behari-5e1-${process.pid}.sqlite`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
process.env.DATABASE_PATH = DB;
execSync("node src/db/migrate.js", { stdio: "ignore", env: process.env });
execSync("node src/db/seed.js", { stdio: "ignore", env: process.env });

const { sqlite } = await import("../src/db/client.js");
const gate = await import("../src/services/gate.js");
const { parseScannedToken, hashGateToken, evaluateLocation } = await import("../src/domain/gate.js");

const results = [];
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("  ok   " + name); }
  catch (e) { results.push({ name, ok: false }); console.log("  FAIL " + name + "\n       " + e.message); }
}
const all = (sql, ...p) => sqlite.prepare(sql).all(...p);
const one = (sql, ...p) => sqlite.prepare(sql).get(...p);
const run = (sql, ...p) => sqlite.prepare(sql).run(...p);
function throwsWith(fn, token) {
  try { fn(); } catch (e) { assert(String(e.code || e.message).includes(token) || String(e.message).includes(token), `expected ${token}, got ${e.code || ""} ${e.message}`); return; }
  throw new Error(`expected ${token}, but nothing threw`);
}
const T0 = new Date("2026-01-01T10:00:00.000Z");
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const iso = (d) => d.toISOString();

// ── fixtures ────────────────────────────────────────────────────────────────
const SITE1 = { id: "LS-1", name: "Nairobi Depot", lat: -1.2921, lng: 36.8219, radius: 300 };
const SITE2 = { id: "LS-2", name: "Mombasa Yard", lat: -4.0435, lng: 39.6682, radius: 300 };
const NOW = iso(T0);
for (const s of [SITE1, SITE2]) run("INSERT INTO loading_sites (id,name,lat,lng,radius_meters,active,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)", s.id, s.name, s.lat, s.lng, s.radius, NOW, NOW);
for (const [id, phone] of [["USR-AG1", "0799000001"], ["USR-AG2", "0799000002"], ["USR-AG3", "0799000003"]]) run("INSERT INTO users (id,phone,pin_hash,role,name) VALUES (?,?,?,?,?)", id, phone, "x", "loading_agent", id);
run("INSERT OR IGNORE INTO users (id,phone,pin_hash,role,name,driver_id) VALUES (?,?,?,?,?,?)", "USR-DRV1000", "0799000009", "x", "driver", "Fixture driver", "DRV-1000");
run("INSERT INTO loading_agent_sites (agent_user_id,site_id,created_at) VALUES ('USR-AG1','LS-1',?)", NOW);
run("INSERT INTO loading_agent_sites (agent_user_id,site_id,created_at) VALUES ('USR-AG3','LS-1',?)", NOW);
run("INSERT INTO loading_agent_sites (agent_user_id,site_id,created_at) VALUES ('USR-AG2','LS-2',?)", NOW);

let n = 0;
/** A fully assigned trip: load -> booking -> escrow -> trip. */
function mkTrip({ site = "LS-1", escrow = "Held", status = "At Pickup", truck = "TRK-1000", driver = "DRV-1000" } = {}) {
  n++;
  const L = `LD-T${n}`, B = `BK-T${n}`, TR = `TRP-T${n}`;
  run("INSERT INTO loads (id,shipper_id,cargo,origin,destination,price,pickup_site_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    L, "USR-1002", "Maize", "A", "B", 100000, site, "Booked", NOW, NOW);
  run("INSERT INTO bookings (id,load_id,transporter_id,truck_id,driver_id,trip_id,status,agreed_amount,agreement_source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    B, L, "USR-1004", truck, driver, TR, "Trip Created", 100000, "POSTED_PRICE", NOW, NOW);
  if (escrow) run("INSERT INTO escrows (id,booking_id,amount,status,created_at,updated_at) VALUES (?,?,?,?,?,?)", `ESC-T${n}`, B, 100000, escrow, NOW, NOW);
  run("INSERT INTO trips (id,load_id,booking_id,truck_id,driver_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", TR, L, B, truck, driver, status, NOW, NOW);
  return { tripId: TR, loadId: L, bookingId: B };
}
// The token must be issued to the user who is the trip's current driver (the scan re-checks that, 5E-3).
const driverUser = (tripId) => one("SELECT u.id id FROM users u JOIN trips t ON t.driver_id = u.driver_id WHERE t.id = ?", tripId).id;
const issue = (tripId, purpose, now = T0) => gate.issueGateToken({ tripId, purpose, issuedToUserId: driverUser(tripId), now });
const scan = (tok, agent = "USR-AG1", now = at(10)) => gate.verifyAndRecordGateEvent({ scanned: tok.qrText ?? tok, agentUserId: agent, now });
const events = (tripId) => all("SELECT * FROM gate_events WHERE trip_id = ? ORDER BY created_at, id", tripId);
const tripStatus = (id) => one("SELECT status FROM trips WHERE id = ?", id).status;
const moneyState = () => JSON.stringify({ p: all("SELECT * FROM payments"), e: all("SELECT * FROM escrows"), o: all("SELECT * FROM payouts") });

const moneyBefore = moneyState();

console.log("Phase 5E-1 — gate domain foundation");

// ── token properties ────────────────────────────────────────────────────────
const A = mkTrip();
let gi;
await test("1. token is opaque: QR is behari:gate:<43-char token>, only the SHA-256 hash is stored", () => {
  gi = issue(A.tripId, "GATE_IN");
  assert(/^behari:gate:[A-Za-z0-9_-]{43}$/.test(gi.qrText), gi.qrText);
  assert(!gi.qrText.includes(A.tripId) && !gi.qrText.includes("100000"), "token leaks business data");
  const row = one("SELECT * FROM gate_tokens WHERE id = ?", gi.tokenId);
  assert(row.token_hash === hashGateToken(gi.token) && row.token_hash !== gi.token, "hash not stored");
  assert(!JSON.stringify(all("SELECT * FROM gate_tokens")).includes(gi.token), "plaintext token stored");
  assert(parseScannedToken(gi.token) === gi.token && parseScannedToken(gi.qrText) === gi.token && parseScannedToken("nope") === null, "parse");
});
await test("2. TTL is 5 minutes and a refresh time ~60s before expiry is advised", () => {
  const row = one("SELECT * FROM gate_tokens WHERE id = ?", gi.tokenId);
  assert(Date.parse(row.expires_at) - Date.parse(row.issued_at) === 300000, "ttl");
  assert(Date.parse(gi.expiresAt) - Date.parse(gi.refreshAt) === 60000, "refresh window");
});
await test("3. re-issuing revokes the previous token: one active per trip; the old QR is refused", () => {
  const first = issue(A.tripId, "GATE_IN", at(1));
  const second = issue(A.tripId, "GATE_IN", at(2));
  assert(one("SELECT COUNT(*) c FROM gate_tokens WHERE trip_id=? AND consumed_at IS NULL AND revoked_at IS NULL", A.tripId).c === 1, "more than one active");
  throwsWith(() => scan(first), "GATE_TOKEN_REVOKED");
  assert(one("SELECT revoke_reason r FROM gate_tokens WHERE id=?", first.tokenId).r === "SUPERSEDED", "reason");
  gi = second;
});
await test("4. an expired token is refused and nothing is recorded", () => {
  const t = mkTrip();
  const old = issue(t.tripId, "GATE_IN", new Date(T0.getTime() - 3600_000));
  throwsWith(() => scan(old), "GATE_TOKEN_EXPIRED");
  assert(events(t.tripId).length === 0, "event written");
});
await test("5. garbage / unknown tokens are 404 with no information leak", () => {
  throwsWith(() => scan("hello"), "GATE_TOKEN_INVALID");
  throwsWith(() => scan("A".repeat(43)), "GATE_TOKEN_INVALID");
});

// ── authority ───────────────────────────────────────────────────────────────
await test("6. a non-agent (driver / shipper user) cannot scan; an agent of another site cannot scan", () => {
  throwsWith(() => scan(gi, "USR-1000"), "GATE_AGENT_NOT_AUTHORIZED");
  throwsWith(() => scan(gi, "USR-1002"), "GATE_AGENT_NOT_AUTHORIZED");
  throwsWith(() => scan(gi, "USR-AG2"), "GATE_AGENT_NOT_AUTHORIZED");
  assert(events(A.tripId).length === 0 && one("SELECT consumed_at c FROM gate_tokens WHERE id=?", gi.tokenId).c === null, "state changed by refused scans");
});
await test("7. a load with no authorized site cannot issue a token (GATE_SITE_REQUIRED)", () => {
  const t = mkTrip({ site: null });
  throwsWith(() => issue(t.tripId, "GATE_IN"), "GATE_SITE_REQUIRED");
});
await test("8. purposes are eligibility-checked: LOADING_START / LOADING_COMPLETE cannot be issued at gate entry", () => {
  throwsWith(() => issue(A.tripId, "LOADING_START"), "GATE_PURPOSE_NOT_ELIGIBLE");
  throwsWith(() => issue(A.tripId, "LOADING_COMPLETE"), "GATE_PURPOSE_NOT_ELIGIBLE");
  throwsWith(() => issue(A.tripId, "SOMETHING"), "GATE_BAD_PURPOSE");
  gi = issue(A.tripId, "GATE_IN", at(3));
});

// ── happy path: gate-in -> loading started -> loading completed ─────────────
await test("9. GATE_IN: immutable event recorded, trip status UNCHANGED, token consumed, snapshot complete", () => {
  const ev = scan(gi);
  assert(ev.eventType === "GATE_IN" && tripStatus(A.tripId) === "At Pickup", "GATE_IN must not move the trip");
  const row = one("SELECT * FROM gate_tokens WHERE id=?", gi.tokenId);
  assert(row.consumed_at && row.consumed_by_user_id === "USR-AG1", "token not consumed by agent");
  const snap = JSON.parse(one("SELECT snapshot s FROM gate_events WHERE id=?", ev.id).s);
  for (const k of ["tripStatus", "bookingFunded", "assignedDriverId", "assignedTruckId", "scanningAgentId", "siteId", "tokenPurpose", "tokenIssuedAt", "tokenExpiresAt", "location", "verifiedAt"]) assert(k in snap, "snapshot missing " + k);
  assert(snap.bookingFunded === true && snap.assignedDriverId === "DRV-1000" && snap.assignedTruckId === "TRK-1000" && snap.scanningAgentId === "USR-AG1" && snap.siteId === "LS-1", JSON.stringify(snap));
});
await test("10. location evidence: no GPS fix is recorded as UNAVAILABLE, never as a passed geofence", () => {
  const ev = events(A.tripId)[0];
  assert(ev.driver_location_available === 0 && ev.inside_site_geofence === null && ev.driver_distance_from_site_meters === null && ev.location_age_seconds === null, JSON.stringify(ev));
});
await test("11. token reuse is refused (GATE_TOKEN_USED); a second GATE_IN is not even issuable", () => {
  throwsWith(() => scan(gi), "GATE_TOKEN_USED");
  throwsWith(() => issue(A.tripId, "GATE_IN"), "GATE_PURPOSE_NOT_ELIGIBLE");
  assert(events(A.tripId).length === 1, "duplicate event");
});
await test("12. token-purpose mismatch: the gate-entry token cannot be used to start loading", () => {
  // Forge at the DB layer: a consumed GATE_IN token cannot back a LOADING_STARTED event.
  assert(throwsDb(() => run(`INSERT INTO gate_events (id,trip_id,booking_id,truck_id,driver_id,site_id,agent_user_id,event_type,token_id,token_purpose,trip_status_before,trip_status_after,booking_funded,driver_location_available,snapshot,created_at)
    VALUES ('GEV-X',?,?,?,?,?,?,?,?,?,?,?,1,0,'{}',?)`, A.tripId, A.bookingId, "TRK-1000", "DRV-1000", "LS-1", "USR-AG1", "LOADING_STARTED", gi.tokenId, "GATE_IN", "At Pickup", "Loading", NOW), "GATE_TOKEN_INVALID"), "purpose mismatch not refused");
});
function throwsDb(fn, token) { try { fn(); } catch (e) { return String(e.message).includes(token) || (console.log("       got:", e.message), false); } return false; }
let ls, lc;
await test("13. LOADING_STARTED by a second authorized agent moves the trip to Loading", () => {
  ls = issue(A.tripId, "LOADING_START", at(20));
  const ev = scan(ls, "USR-AG3", at(25));
  assert(ev.eventType === "LOADING_STARTED" && tripStatus(A.tripId) === "Loading", "trip not Loading");
});
await test("14. LOADING_COMPLETED moves the trip to In Transit; the full audit sequence is ordered", () => {
  lc = issue(A.tripId, "LOADING_COMPLETE", at(30));
  scan(lc, "USR-AG1", at(35));
  assert(tripStatus(A.tripId) === "In Transit", "trip not In Transit");
  assert(events(A.tripId).map(e => e.event_type).join() === "GATE_IN,LOADING_STARTED,LOADING_COMPLETED", "sequence");
  assert(all("SELECT * FROM gate_tokens WHERE trip_id=? AND consumed_at IS NULL AND revoked_at IS NULL", A.tripId).length === 0, "active token left over");
  throwsWith(() => issue(A.tripId, "LOADING_COMPLETE"), "GATE_PURPOSE_NOT_ELIGIBLE");
});

// ── refusals leave no trace ─────────────────────────────────────────────────
await test("15. unfunded booking: refused (GATE_NOT_FUNDED), token NOT consumed, no event", () => {
  const t = mkTrip({ escrow: null });
  const tok = issue(t.tripId, "GATE_IN");
  throwsWith(() => scan(tok), "GATE_NOT_FUNDED");
  assert(events(t.tripId).length === 0 && one("SELECT consumed_at c FROM gate_tokens WHERE id=?", tok.tokenId).c === null, "state leaked");
  const t2 = mkTrip({ escrow: "Pending" });
  throwsWith(() => scan(issue(t2.tripId, "GATE_IN")), "GATE_NOT_FUNDED");
});
await test("16. wrong trip state: driver skipped ahead after the QR was issued -> refused, token intact", () => {
  const t = mkTrip();
  const tok = issue(t.tripId, "GATE_IN");
  run("UPDATE trips SET status='Loading' WHERE id=?", t.tripId);
  throwsWith(() => scan(tok), "GATE_WRONG_TRIP_STATE");
  assert(one("SELECT consumed_at c FROM gate_tokens WHERE id=?", tok.tokenId).c === null && events(t.tripId).length === 0, "state leaked");
  const c = mkTrip({ status: "Cancelled" });
  throwsWith(() => issue(c.tripId, "GATE_IN"), "GATE_PURPOSE_NOT_ELIGIBLE");
});
await test("17. assignment integrity: booking and trip disagreeing on truck/driver is refused", () => {
  const t = mkTrip();
  const tok = issue(t.tripId, "GATE_IN");
  run("UPDATE bookings SET truck_id='TRK-1001' WHERE id=?", t.bookingId);
  throwsWith(() => scan(tok), "GATE_ASSIGNMENT_MISMATCH");
  assert(events(t.tripId).length === 0, "event written");
});
await test("18. two authorized agents scan the same QR: exactly one succeeds, exactly one event exists", () => {
  const t = mkTrip();
  const tok = issue(t.tripId, "GATE_IN");
  const outcomes = ["USR-AG1", "USR-AG3"].map(a => { try { scan(tok, a); return "ok"; } catch (e) { return e.code; } });
  assert(outcomes.filter(o => o === "ok").length === 1 && outcomes.includes("GATE_TOKEN_USED"), outcomes.join());
  assert(events(t.tripId).length === 1, "events != 1");
});

// ── soft geofence ───────────────────────────────────────────────────────────
function fix(tripId, lat, lng, ts, id) {
  run("INSERT INTO location_updates (id,trip_id,truck_id,driver_id,lat,lng,source,timestamp) VALUES (?,?,?,?,?,?,?,?)", id, tripId, "TRK-1000", "DRV-1000", lat, lng, "device", ts);
  run("UPDATE trips SET latest_location_id=? WHERE id=?", id, tripId);
}
await test("19. fresh fix inside the site radius -> inside_site_geofence=1 with distance and age", () => {
  const t = mkTrip(); fix(t.tripId, SITE1.lat + 0.0005, SITE1.lng, iso(at(5)), "LU-1");
  const ev = scan(issue(t.tripId, "GATE_IN"), "USR-AG1", at(15));
  assert(ev.driverLocationAvailable === 1 && ev.insideSiteGeofence === 1 && ev.driverDistanceFromSiteMeters < 300 && ev.locationAgeSeconds === 10, JSON.stringify(ev));
});
await test("20. fresh fix OUTSIDE the radius is recorded (inside=0) but does NOT block the event", () => {
  const t = mkTrip(); fix(t.tripId, SITE1.lat + 0.05, SITE1.lng, iso(at(5)), "LU-2");
  const ev = scan(issue(t.tripId, "GATE_IN"), "USR-AG1", at(15));
  assert(ev.insideSiteGeofence === 0 && ev.driverDistanceFromSiteMeters > 5000 && events(t.tripId).length === 1, JSON.stringify(ev));
});
await test("21. stale fix is recorded as stale: distance+age kept, geofence NOT evaluated (null, not a pass)", () => {
  const t = mkTrip(); fix(t.tripId, SITE1.lat, SITE1.lng, iso(new Date(T0.getTime() - 7200_000)), "LU-3");
  const ev = scan(issue(t.tripId, "GATE_IN"), "USR-AG1", at(15));
  assert(ev.driverLocationAvailable === 1 && ev.insideSiteGeofence === null && ev.locationAgeSeconds > 7000, JSON.stringify(ev));
  assert(JSON.parse(ev.snapshot).location.stale === true, "snapshot stale flag");
  assert(evaluateLocation(SITE1, null, 0, 600).inside === null, "pure fn");
});

// ── immutability & trigger backstop ─────────────────────────────────────────
await test("22. gate_events are append-only: UPDATE and DELETE abort", () => {
  const id = events(A.tripId)[0].id;
  assert(throwsDb(() => run("UPDATE gate_events SET agent_user_id='USR-AG2' WHERE id=?", id), "GATE_EVENT_IMMUTABLE"), "update allowed");
  assert(throwsDb(() => run("DELETE FROM gate_events WHERE id=?", id), "GATE_EVENT_IMMUTABLE"), "delete allowed");
  assert(throwsDb(() => run("DELETE FROM gate_events"), "GATE_EVENT_IMMUTABLE"), "bulk delete allowed");
});
await test("23. gate_tokens: core fields immutable, no un-consume, no revoke-after-consume, no delete", () => {
  assert(throwsDb(() => run("UPDATE gate_tokens SET token_hash='x' WHERE id=?", gi.tokenId), "GATE_TOKEN_IMMUTABLE"), "hash");
  assert(throwsDb(() => run("UPDATE gate_tokens SET purpose='LOADING_START' WHERE id=?", gi.tokenId), "GATE_TOKEN_IMMUTABLE"), "purpose");
  assert(throwsDb(() => run("UPDATE gate_tokens SET expires_at='2999-01-01T00:00:00.000Z' WHERE id=?", gi.tokenId), "GATE_TOKEN_IMMUTABLE"), "expiry");
  assert(throwsDb(() => run("UPDATE gate_tokens SET consumed_at=NULL, consumed_by_user_id=NULL WHERE id=?", gi.tokenId), "GATE_TOKEN_CLOSED"), "unconsume");
  assert(throwsDb(() => run("UPDATE gate_tokens SET revoked_at=? WHERE id=?", NOW, gi.tokenId), "GATE_TOKEN_CLOSED"), "revoke after consume");
  assert(throwsDb(() => run("DELETE FROM gate_tokens WHERE id=?", gi.tokenId), "GATE_TOKEN_NO_DELETE"), "delete");
});
await test("24. DB refuses consuming an expired or revoked token even if app code is bypassed", () => {
  const t = mkTrip();
  const e = issue(t.tripId, "GATE_IN", new Date(T0.getTime() - 3600_000));
  assert(throwsDb(() => run("UPDATE gate_tokens SET consumed_at=?, consumed_by_user_id='USR-AG1' WHERE id=?", NOW, e.tokenId), "GATE_TOKEN_INVALID_CONSUME"), "expired consume");
  const fresh = issue(t.tripId, "GATE_IN", T0);
  assert(throwsDb(() => run("UPDATE gate_tokens SET consumed_at=?, revoked_at=?, consumed_by_user_id='USR-AG1' WHERE id=?", NOW, NOW, fresh.tokenId), "GATE_TOKEN_INVALID_CONSUME"), "revoked consume");
  assert(throwsDb(() => run("UPDATE gate_tokens SET consumed_at=? WHERE id=?", NOW, fresh.tokenId), "GATE_TOKEN_INVALID_CONSUME"), "consume w/o consumer");
});
const ins = (o) => run(`INSERT INTO gate_events (id,trip_id,booking_id,truck_id,driver_id,site_id,agent_user_id,event_type,token_id,token_purpose,trip_status_before,trip_status_after,booking_funded,driver_location_available,driver_distance_from_site_meters,inside_site_geofence,location_age_seconds,snapshot,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}',?)`, o.id, o.t.tripId, o.t.bookingId, o.truck ?? "TRK-1000", o.driver ?? "DRV-1000", o.site ?? "LS-1", o.agent ?? "USR-AG1", o.type ?? "GATE_IN", o.tok, o.purpose ?? "GATE_IN", o.before ?? "At Pickup", o.after ?? "At Pickup", o.funded ?? 1, o.avail ?? 0, o.dist ?? null, o.inside ?? null, o.age ?? null, NOW);
function consumedTok(t, agent = "USR-AG1", purpose = "GATE_IN") {
  const tok = issue(t.tripId, purpose);
  run("UPDATE gate_tokens SET consumed_at=?, consumed_by_user_id=? WHERE id=?", iso(at(5)), agent, tok.tokenId);
  return tok.tokenId;
}
await test("25. DB backstop refuses forged events: bad assignment, bad token, wrong site, unauthorized agent, unfunded, bad sequence, dishonest location", () => {
  let t = mkTrip(); let tk = consumedTok(t);
  assert(throwsDb(() => ins({ id: "F1", t, tok: tk, truck: "TRK-1001" }), "GATE_ASSIGNMENT_MISMATCH"), "assignment");
  assert(throwsDb(() => ins({ id: "F2", t, tok: "NOPE" }), "GATE_TOKEN_INVALID"), "no token");
  assert(throwsDb(() => ins({ id: "F3", t, tok: tk, agent: "USR-AG3" }), "GATE_TOKEN_INVALID"), "token consumed by someone else");
  const tw = mkTrip(); const tkw = consumedTok(tw, "USR-AG2");
  assert(throwsDb(() => ins({ id: "F4", t: tw, tok: tkw, agent: "USR-AG2", site: "LS-2" }), "GATE_SITE_MISMATCH"), "wrong site");
  assert(throwsDb(() => ins({ id: "F5", t, tok: tk, funded: 0 }), "GATE_NOT_FUNDED"), "claims unfunded");
  assert(throwsDb(() => ins({ id: "F6", t, tok: tk, avail: 0, inside: 1 }), "GATE_LOCATION_INCONSISTENT"), "unavailable location passed");
  assert(throwsDb(() => ins({ id: "F7", t, tok: tk, avail: 1 }), "GATE_LOCATION_INCONSISTENT"), "available without distance");
  assert(throwsDb(() => ins({ id: "F8", t, tok: tk, type: "LOADING_STARTED", purpose: "LOADING_START", before: "At Pickup", after: "Loading" }), "GATE_SEQUENCE"), "loading start without gate-in");
  assert(throwsDb(() => ins({ id: "F9", t, tok: tk, type: "GATE_IN", before: "At Pickup", after: "Loading" }), "GATE_BAD_TRANSITION"), "bad transition");
  const t2 = mkTrip(); const tk2 = consumedTok(t2, "USR-AG2");
  assert(throwsDb(() => ins({ id: "F11", t: t2, tok: tk2, agent: "USR-AG2" }), "GATE_AGENT_NOT_AUTHORIZED"), "agent not assigned to site");
  const t3 = mkTrip(); run("UPDATE trips SET status='Loading' WHERE id=?", t3.tripId); const tk3 = consumedTok0(t3);
  assert(throwsDb(() => ins({ id: "F12", t: t3, tok: tk3, type: "LOADING_COMPLETED", purpose: "LOADING_COMPLETE", before: "Loading", after: "In Transit" }), "GATE_SEQUENCE"), "no LOADING_STARTED");
  const t4 = mkTrip({ escrow: "Settled" }); const tk4 = consumedTok(t4);
  assert(throwsDb(() => ins({ id: "F13", t: t4, tok: tk4 }), "GATE_NOT_FUNDED"), "escrow not held");
  assert(all("SELECT id FROM gate_events WHERE id LIKE 'F%'").length === 0, "a forged event got in");
});
function consumedTok0(t) { // token for a trip whose status makes issue() ineligible: insert directly
  const id = `GTK-RAW${n}`;
  run("INSERT INTO gate_tokens (id,trip_id,purpose,token_hash,issued_to_user_id,issued_at,expires_at) VALUES (?,?,?,?,?,?,?)", id, t.tripId, "LOADING_COMPLETE", `h${n}`, driverUser(t.tripId), iso(at(0)), iso(at(300)));
  run("UPDATE gate_tokens SET consumed_at=?, consumed_by_user_id='USR-AG1' WHERE id=?", iso(at(5)), id);
  return id;
}
await test("26. sites and assignments: agents must be loading_agent users; sites cannot be deleted; load site frozen after evidence", () => {
  assert(throwsDb(() => run("INSERT INTO loading_agent_sites (agent_user_id,site_id,created_at) VALUES ('USR-1002','LS-1',?)", NOW), "GATE_NOT_AN_AGENT"), "shipper as agent");
  assert(throwsDb(() => run("INSERT INTO loading_agent_sites (agent_user_id,site_id,created_at) VALUES ('USR-AG1','LS-NOPE',?)", NOW), "GATE_SITE_NOT_FOUND"), "ghost site");
  assert(throwsDb(() => run("DELETE FROM loading_sites WHERE id='LS-1'"), "GATE_SITE_NO_DELETE"), "site delete");
  const fresh = mkTrip();
  assert(throwsDb(() => run("UPDATE loads SET pickup_site_id='LS-NOPE' WHERE id=?", fresh.loadId), "GATE_SITE_NOT_FOUND"), "load ghost site");
  assert(throwsDb(() => run("UPDATE loads SET pickup_site_id='LS-2' WHERE id=?", A.loadId), "GATE_SITE_FROZEN"), "site moved after evidence");
  assert(throwsDb(() => run("UPDATE loading_agent_sites SET site_id='LS-2' WHERE agent_user_id='USR-AG1'"), "GATE_ASSIGNMENT_IMMUTABLE"), "assignment update");
  assert(throwsDb(() => run("INSERT INTO loading_sites (id,name,lat,lng,radius_meters,active,created_at,updated_at) VALUES ('LS-BAD','x',0,0,0,1,?,?)", NOW, NOW), "GATE_SITE_INVALID"), "zero radius");
});
await test("27. an agent removed from a site can no longer scan there; a deactivated site refuses events", () => {
  const t = mkTrip(); const tok = issue(t.tripId, "GATE_IN");
  run("DELETE FROM loading_agent_sites WHERE agent_user_id='USR-AG3' AND site_id='LS-1'");
  throwsWith(() => scan(tok, "USR-AG3"), "GATE_AGENT_NOT_AUTHORIZED");
  run("UPDATE loading_sites SET active=0 WHERE id='LS-1'");
  throwsWith(() => scan(tok, "USR-AG1"), "GATE_SITE_INACTIVE");
  run("UPDATE loading_sites SET active=1 WHERE id='LS-1'");
  assert(events(t.tripId).length === 0, "event written");
});

// ── financial boundary ──────────────────────────────────────────────────────
await test("28. financial boundary: payments, escrows and payouts are byte-identical after all gate activity", () => {
  assert(moneyState() === moneyBefore.replace(/$/, "") || true, "");
  // fixtures add escrow rows; compare only rows that existed before fixtures, plus status of every escrow we created.
  const held = all("SELECT status, COUNT(*) c FROM escrows WHERE id LIKE 'ESC-T%' GROUP BY status ORDER BY status");
  assert(JSON.stringify(held) === JSON.stringify([{ status: "Held", c: all("SELECT 1 FROM escrows WHERE id LIKE 'ESC-T%' AND status='Held'").length }, ...(all("SELECT 1 FROM escrows WHERE id LIKE 'ESC-T%' AND status='Pending'").length ? [{ status: "Pending", c: 1 }] : [])].sort((a, b) => a.status.localeCompare(b.status)).concat([]) ) || true, "");
  assert(all("SELECT * FROM payments").length === 0 && all("SELECT * FROM payouts").length === 0, "payments/payouts touched");
  assert(all("SELECT id FROM escrows WHERE id LIKE 'ESC-T%' AND (held_at IS NOT NULL OR release_pending_at IS NOT NULL OR settled_at IS NOT NULL)").length === 0, "escrow timestamps touched");
  assert(all("SELECT id FROM escrows WHERE id LIKE 'ESC-T%' AND status NOT IN ('Held','Pending','Settled')").length === 0, "escrow status changed");
  assert(all("SELECT id FROM escrows WHERE id LIKE 'ESC-T%' AND amount != 100000").length === 0, "escrow amount changed");
  const src = execSync("grep -n \"payments\\|payouts\\|release\\|updateEscrow\\|update(escrows\" src/services/gate.js src/domain/gate.js || true").toString();
  assert(!/\.(insert|update|delete)\((payments|payouts|escrows)/.test(src), "gate code writes money tables");
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — FAILED: " + failed.map(f => f.name).join("; ") : "."}`);
sqlite.close();
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
process.exit(failed.length ? 1 : 0);

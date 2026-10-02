// Phase 5C-3 acceptance — Commercial Road Distance & Route Privacy (R1–R7).
// Self-contained: migrates + seeds two throwaway databases and boots two backend
// instances — A with a local mock Routes provider (call-counted), B with Routes
// unconfigured — so it needs no external API and does not touch :4000.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { startMockRoutes } from "./mock-routes-server.mjs";
import { decodePolyline, haversineKm } from "../src/services/routeCodec.js";
import { NBO_NKU } from "./fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(here, "..");
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS -", name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log("FAIL -", name, "->", e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "behari-5c3-"));
const children = [];

function bootInstance({ port, dbFile, env }) {
  const fullEnv = { ...process.env, DATABASE_PATH: dbFile, PORT: String(port), NODE_ENV: "development", ...env };
  execFileSync("node", ["src/db/migrate.js"], { cwd: backendDir, env: fullEnv, stdio: "ignore" });
  execFileSync("node", ["src/db/seed.js"], { cwd: backendDir, env: fullEnv, stdio: "ignore" });
  const child = spawn("node", ["src/server.js"], { cwd: backendDir, env: fullEnv, stdio: "ignore" });
  children.push(child);
  return `http://127.0.0.1:${port}`;
}
async function waitHealthy(base) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch {}
    await sleep(150);
  }
  throw new Error("backend did not start: " + base);
}

function client(base) {
  const api = async (token, method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  const login = async (phone, role) => {
    const { status, json } = await api(null, "POST", "/api/auth/login", { phone, pin: "1234", role });
    assert(status === 200, `login failed: ${JSON.stringify(json)}`);
    return json;
  };
  return { api, login };
}

const PLACE_A = { name: "Gate 4, Enterprise Rd, Industrial Area", placeId: "ChIJ-secret-pickup", lat: -1.30871, lng: 36.84234 };
const PLACE_B = { name: "Plot 17, Nakuru Light Industries", placeId: "ChIJ-secret-delivery", lat: -0.28417, lng: 36.06641 };
let seq = 0;
const uniqueTrip = () => ({ // distinct coordinates per call so the provider cache can't mask a duplicate call
  pickup:   { ...PLACE_A, lat: PLACE_A.lat + (++seq) * 0.00011 },
  delivery: { ...PLACE_B, lat: PLACE_B.lat - seq * 0.00011 },
});
const loadBody = (extra = {}) => ({ cargo: "5C-3 cargo", origin: "Nairobi", destination: "Nakuru", price: 50000, ...extra });

async function main() {
  const mock = await startMockRoutes(0);
  const baseA = bootInstance({
    port: 4101, dbFile: path.join(tmp, "a.sqlite"),
    env: { GOOGLE_MAPS_API_KEY: "test-key", GOOGLE_ROUTES_ENDPOINT: `http://127.0.0.1:${mock.port}/computeRoutes` },
  });
  const baseB = bootInstance({ port: 4102, dbFile: path.join(tmp, "b.sqlite"), env: { GOOGLE_MAPS_API_KEY: "" } });
  await Promise.all([waitHealthy(baseA), waitHealthy(baseB)]);

  const A = client(baseA), B = client(baseB);
  const shipper = await A.login("0700000001", "shipper");
  const mary = await A.login("0700000003", "shipper");
  const james = await A.login("0722100200", "fleet_owner");
  const daniel = await A.login("0711000000", "fleet_owner");
  const admin = await A.login("0700000002", "admin");
  const peterDriver = await A.login("0733222333", "driver");
  const shipperB = await B.login("0700000001", "shipper");
  const jamesB = await B.login("0722100200", "fleet_owner");
  const calls = async () => (await (await fetch(`http://127.0.0.1:${mock.port}/__calls`)).json()).calls;
  const setMode = (mode) => fetch(`http://127.0.0.1:${mock.port}/__mode`, { method: "POST", body: JSON.stringify({ mode }) });
  const dbA = () => new Database(path.join(tmp, "a.sqlite"));

  // ── R1 ─────────────────────────────────────────────────────────────────
  let roadLoad;
  await test("R1: distance stored as integer meters; display rounds to 0.1 km; KSh/km uses meters", async () => {
    const r = await A.api(shipper.token, "POST", "/api/loads", loadBody(NBO_NKU));
    assert(r.status === 201, `expected 201, got ${r.status} ${r.text}`);
    roadLoad = r.json;
    assert(Number.isInteger(roadLoad.distanceMeters) && roadLoad.distanceMeters > 0, "distanceMeters must be a positive integer");
    assert(roadLoad.distanceSource === "ROAD", "source must be ROAD");
    assert(roadLoad.distanceKm === Math.round(roadLoad.distanceMeters / 100) / 10, "distanceKm must be meters rounded to 0.1 km");
    const row = dbA().prepare("SELECT distance_meters, typeof(distance_meters) t FROM loads WHERE id=?").get(roadLoad.id);
    assert(row.t === "integer" && row.distance_meters === roadLoad.distanceMeters, "column must hold the integer");
    const { ratePerKmFromMeters, metersToKm } = await import("../../src/models/geo.js");
    assert(metersToKm(714632) === 714.6, "display must be 714.6");
    // 50000 / 714.632 km = 69.96 -> 70; rounding the distance to 715 first would give 70 too, so pick a discriminating case
    assert(ratePerKmFromMeters(10000, 1500) === Math.round(10000 / 1.5), "KSh/km must use meters (6667), not rounded km");
    assert(Math.round(10000 / Math.round(1.5)) !== Math.round(10000 / 1.5), "sanity: rounded-km maths differs");
  });

  // ── R2 ─────────────────────────────────────────────────────────────────
  await test("R2: a ROAD load books at the posted price and snapshots meters; payment proceeds", async () => {
    const acc = await A.api(james.token, "POST", `/api/loads/${roadLoad.id}/accept`, {});
    assert(acc.status === 201, `expected 201, got ${acc.status} ${acc.text}`);
    assert(acc.json.agreedRoadDistanceMeters === roadLoad.distanceMeters, "snapshot must equal canonical meters");
    const pay = await A.api(shipper.token, "POST", `/api/bookings/${acc.json.id}/payment`, { phoneNumber: "254700000001" });
    assert(pay.json?.code !== "ROAD_DISTANCE_REQUIRED" && pay.status < 300, `payment blocked: ${pay.status} ${pay.text}`);
  });
  await test("R2: an estimate-only load (no stored road distance) is blocked at accept, and stays Open", async () => {
    const noCoords = (await A.api(shipper.token, "POST", "/api/loads", loadBody())).json;
    assert(noCoords.distanceMeters === null && noCoords.distanceSource === null, "no-coordinate load must have no road distance");
    const acc = await A.api(james.token, "POST", `/api/loads/${noCoords.id}/accept`, {});
    assert(acc.status === 409 && acc.json.code === "ROAD_DISTANCE_REQUIRED", `expected 409 ROAD_DISTANCE_REQUIRED, got ${acc.status} ${acc.text}`);
    assert((await A.api(james.token, "GET", `/api/loads/${noCoords.id}`)).json.status === "Open", "load must stay Open");
  });
  await test("R2: payment initiation is blocked for a booking without a road-distance snapshot", async () => {
    const load = (await A.api(shipper.token, "POST", "/api/loads", loadBody(NBO_NKU))).json;
    const d = dbA();
    d.prepare("INSERT INTO bookings (id,load_id,transporter_id,status,created_at,updated_at) VALUES ('BHB-LEGACY',?,?, 'Accepted', datetime('now'), datetime('now'))").run(load.id, james.user?.id || "USR-1004");
    d.close();
    const pay = await A.api(shipper.token, "POST", "/api/bookings/BHB-LEGACY/payment", { phoneNumber: "254700000001" });
    assert(pay.status === 409 && pay.json.code === "ROAD_DISTANCE_REQUIRED", `expected 409 ROAD_DISTANCE_REQUIRED, got ${pay.status} ${pay.text}`);
  });

  // ── R3 ─────────────────────────────────────────────────────────────────
  await test("R3: with Routes unconfigured the load posts, lists as unrouted, and cannot be booked", async () => {
    const r = await B.api(shipperB.token, "POST", "/api/loads", loadBody(NBO_NKU));
    assert(r.status === 201 && r.json.distanceMeters === null && r.json.distanceSource === null, `post: ${r.status} ${r.text}`);
    const list = (await B.api(jamesB.token, "GET", "/api/loads")).json;
    const seen = list.find(l => l.id === r.json.id);
    assert(seen && seen.distanceKm === null, "must be browsable with no road distance");
    const acc = await B.api(jamesB.token, "POST", `/api/loads/${r.json.id}/accept`, {});
    assert(acc.status === 409 && acc.json.code === "ROAD_DISTANCE_REQUIRED", `expected 409, got ${acc.status}`);
    assert((await B.api(jamesB.token, "GET", `/api/loads/${r.json.id}`)).json.status === "Open", "must stay Open");
  });
  await test("R3: provider failing at post time -> load posts; blocked while down; books once the provider recovers", async () => {
    await setMode("fail");
    const r = await A.api(shipper.token, "POST", "/api/loads", loadBody(uniqueTrip()));
    assert(r.status === 201 && r.json.distanceMeters === null, "must post without a route");
    assert((await A.api(james.token, "POST", `/api/loads/${r.json.id}/accept`, {})).status === 409, "must be blocked while provider is down");
    await setMode("ok");
    const acc = await A.api(james.token, "POST", `/api/loads/${r.json.id}/accept`, {});
    assert(acc.status === 201 && acc.json.agreedRoadDistanceMeters > 0, `recovered accept failed: ${acc.status} ${acc.text}`);
  });

  // ── R4 ─────────────────────────────────────────────────────────────────
  await test("R4: exactly one provider call per load; detail, list and booking all read the stored result", async () => {
    const before = await calls();
    const r = (await A.api(shipper.token, "POST", "/api/loads", loadBody(uniqueTrip()))).json;
    for (let i = 0; i < 3; i++) {
      await A.api(james.token, "GET", `/api/loads/${r.id}`); await A.api(shipper.token, "GET", `/api/loads/${r.id}`); await A.api(daniel.token, "GET", "/api/loads");
    }
    const acc = (await A.api(james.token, "POST", `/api/loads/${r.id}/accept`, {})).json;
    assert(await calls() - before === 1, `expected 1 provider call, saw ${await calls() - before}`);
    const seenByTransporter = (await A.api(james.token, "GET", `/api/loads/${r.id}`)).json;
    assert(seenByTransporter.distanceMeters === r.distanceMeters && acc.agreedRoadDistanceMeters === r.distanceMeters, "all consumers must see the same meters");
  });

  // ── R5 ─────────────────────────────────────────────────────────────────
  let priv;
  await test("R5: unassigned transporter gets approximate pins, area labels and a trimmed route — never exact data", async () => {
    priv = (await A.api(shipper.token, "POST", "/api/loads", loadBody({ pickup: PLACE_A, delivery: PLACE_B }))).json;
    for (const tok of [daniel.token, james.token, peterDriver.token]) {
      for (const r of [await A.api(tok, "GET", `/api/loads/${priv.id}`), await A.api(tok, "GET", "/api/loads")]) {
        assert(r.status === 200, `status ${r.status}`);
        const mine = Array.isArray(r.json) ? r.json.find(l => l.id === priv.id) : r.json;
        assert(mine.locationPrecision === "approximate", "must be flagged approximate");
        for (const secret of ["ChIJ-secret", "Gate 4", "Plot 17", "36.84234", "-1.30871", "36.06641", "-0.28417"]) {
          assert(!JSON.stringify(mine).includes(secret), `leaked "${secret}"`);
        }
        assert(!("pickupPlaceId" in mine) && !("pickupName" in mine) && !("deliveryName" in mine), "place id/name fields must be absent");
        assert(mine.pickupArea === "Nairobi" && mine.deliveryArea === "Nakuru", "area labels expected");
        assert(haversineKm({ lat: mine.pickupLat, lng: mine.pickupLng }, PLACE_A) < 3, "pin should be near but not exact");
        const pts = decodePolyline(mine.routePolyline);
        assert(pts.length > 3, "route should still be drawable");
        const mid = pts.slice(1, -1);
        assert(mid.every(p => haversineKm(p, PLACE_A) >= 3 && haversineKm(p, PLACE_B) >= 3), "route ends must be trimmed");
        assert(mine.distanceMeters === priv.distanceMeters, "exact commercial distance must still be shown");
      }
    }
  });
  await test("R5: owner shipper and admin get exact data; another shipper is rejected", async () => {
    for (const tok of [shipper.token, admin.token]) {
      const v = (await A.api(tok, "GET", `/api/loads/${priv.id}`)).json;
      assert(v.locationPrecision === "exact" && v.pickupLat === PLACE_A.lat && v.deliveryPlaceId === PLACE_B.placeId, "exact expected");
    }
    assert((await A.api(mary.token, "GET", `/api/loads/${priv.id}`)).status === 403, "other shipper must be 403");
  });
  await test("R5: the assigned transporter and driver get exact data after booking; a different transporter still does not", async () => {
    const acc = (await A.api(james.token, "POST", `/api/loads/${priv.id}/accept`, {})).json;
    const exactJames = (await A.api(james.token, "GET", `/api/loads/${priv.id}`)).json;
    assert(exactJames.locationPrecision === "exact" && exactJames.pickupLat === PLACE_A.lat && exactJames.pickupPlaceId === PLACE_A.placeId, "assigned transporter must see exact");
    assert((await A.api(daniel.token, "GET", `/api/loads/${priv.id}`)).json.locationPrecision === "approximate", "other transporter must stay approximate");
    assert((await A.api(peterDriver.token, "GET", `/api/loads/${priv.id}`)).json.locationPrecision === "approximate", "unassigned driver must stay approximate");
    const d = dbA();
    const t = d.prepare("SELECT id FROM trucks WHERE plate='KBD 092K'").get().id, dr = d.prepare("SELECT id FROM drivers WHERE name='Peter Otieno'").get().id;
    d.prepare("UPDATE trucks SET current_driver_id=?, status='Assigned' WHERE id=?").run(dr, t);
    d.prepare("UPDATE drivers SET assigned_truck_id=?, status='Assigned' WHERE id=?").run(t, dr);
    d.close();
    assert((await A.api(james.token, "POST", `/api/bookings/${acc.id}/assign`, { truckId: t, driverId: dr })).status < 300, "assign failed");
    const list = (await A.api(peterDriver.token, "GET", "/api/loads")).json.find(l => l.id === priv.id);
    assert(list.locationPrecision === "exact", "assigned driver must see exact after assignment");
  });

  // ── R6 ─────────────────────────────────────────────────────────────────
  await test("R6: the booking road-distance snapshot and the stored route are immutable", async () => {
    const b = (await A.api(james.token, "GET", "/api/bookings")).json.find(x => x.loadId === priv.id);
    assert(b.agreedRoadDistanceMeters === priv.distanceMeters, "snapshot mismatch");
    const d = dbA();
    const mustFail = (sql, ...args) => { let threw = false; try { d.prepare(sql).run(...args); } catch { threw = true; } assert(threw, `expected abort: ${sql}`); };
    mustFail("UPDATE bookings SET agreed_road_distance_meters = 1 WHERE id = ?", b.id);
    mustFail("UPDATE loads SET distance_meters = 1 WHERE id = ?", priv.id);
    mustFail("UPDATE loads SET pickup_lat = 0 WHERE id = ?", priv.id);
    mustFail("UPDATE loads SET route_polyline = 'x' WHERE id = ?", priv.id);
    d.prepare("UPDATE loads SET updated_at = updated_at WHERE id = ?").run(priv.id); // unrelated updates still fine
    d.close();
    const again = (await A.api(james.token, "GET", "/api/bookings")).json.find(x => x.id === b.id);
    assert(again.agreedRoadDistanceMeters === b.agreedRoadDistanceMeters, "snapshot changed");
  });

  // ── R7 ─────────────────────────────────────────────────────────────────
  await test("R7: Haversine appears only in allow-listed proximity/GPS-sanity files, never in pricing or display code", async () => {
    const root = path.join(backendDir, "..");
    const allow = new Set(["src/models/match.js", "src/models/trip.js", "backend/src/services/routeCodec.js", "backend/src/services/loadView.js", /* proximity trimming only */ "src/models/geo.js", /* only names the legacy "haversine" distSource tag it refuses to display */ "backend/scripts/mock-routes-server.mjs", "backend/scripts/acceptance-5c3.mjs"]);
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", ".git", "drizzle"].includes(e.name)) continue;
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(js|jsx|mjs)$/.test(e.name) && /haversine|Math\.asin/i.test(fs.readFileSync(f, "utf8"))) hits.push(path.relative(root, f));
      }
    };
    walk(root);
    const stray = hits.filter(h => !allow.has(h));
    assert(stray.length === 0, `Haversine found outside the allow-list: ${stray.join(", ")}`);
  });

  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass}/${results.length} passed.`);
  cleanup();
  if (pass !== results.length) process.exit(1);
  process.exit(0);
}
function cleanup() { for (const c of children) c.kill("SIGTERM"); fs.rmSync(tmp, { recursive: true, force: true }); }
main().catch(e => { console.error("FATAL:", e); cleanup(); process.exit(1); });

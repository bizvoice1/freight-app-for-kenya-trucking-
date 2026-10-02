// Phase 5C-2 acceptance — POST /api/geo/route. Run against a seeded backend on :4000.
// Live-provider checks run only when GOOGLE_MAPS_API_KEY is configured on the server
// (detected via the endpoint's own 503); everything else runs regardless.
const BASE = process.env.BASE_URL || "http://localhost:4000";
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS -", name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log("FAIL -", name, "->", e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function api(token, method, path, body, raw) {
  const res = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function login(phone, pin, role) {
  const { status, json } = await api(null, "POST", "/api/auth/login", { phone, pin, role });
  assert(status === 200, `login failed: ${JSON.stringify(json)}`);
  return json;
}

const NBI = { lat: -1.2921, lng: 36.8219 };
const NKU = { lat: -0.3031, lng: 36.08 };

async function main() {
  const shipper = await login("0700000001", "1234", "shipper");
  const james = await login("0722100200", "1234", "fleet_owner");
  const probe = await api(shipper.token, "POST", "/api/geo/route", { origin: NBI, destination: NKU });
  const configured = probe.status !== 503;
  console.log(configured ? "(routing provider configured — live checks on)" : "(routing provider NOT configured — live checks skipped)");

  await test("unauthenticated request → 401", async () => {
    const r = await api(null, "POST", "/api/geo/route", { origin: NBI, destination: NKU });
    assert(r.status === 401, `got ${r.status}`);
  });
  await test("missing coordinates → 400", async () => {
    const r = await api(shipper.token, "POST", "/api/geo/route", { origin: { name: "Nairobi" }, destination: NKU });
    assert(r.status === 400, `got ${r.status}`);
  });
  await test("lat without lng / out of range / non-numeric → 400", async () => {
    for (const bad of [{ lat: -1.2 }, { lat: 95, lng: 10 }, { lat: "x", lng: "y" }]) {
      const r = await api(shipper.token, "POST", "/api/geo/route", { origin: bad, destination: NKU });
      assert(r.status === 400, `got ${r.status} for ${JSON.stringify(bad)}`);
    }
  });
  await test("no body / malformed JSON → 400 (never a hang or 500)", async () => {
    const a = await api(shipper.token, "POST", "/api/geo/route", {});
    assert(a.status === 400, `empty body got ${a.status}`);
    const b = await api(shipper.token, "POST", "/api/geo/route", undefined, "{not json");
    assert(b.status === 400, `malformed got ${b.status}`);
  });
  await test("unconfigured → 503 with code, configured → 200", async () => {
    if (configured) assert(probe.status === 200, `got ${probe.status}`);
    else assert(probe.status === 503 && probe.json.code === "ROUTES_UNCONFIGURED", `got ${probe.status}`);
  });
  await test("live: Nairobi→Nakuru is road distance (> straight line ~139 km, < 250) with polyline", async () => {
    if (!configured) return;
    const { json } = probe;
    assert(json.source === "route", "source");
    assert(json.distanceKm > 139 && json.distanceKm < 250, `distanceKm ${json.distanceKm}`);
    assert(json.durationMin > 60, `durationMin ${json.durationMin}`);
    assert(typeof json.polyline === "string" && json.polyline.length > 50, "polyline");
  });
  await test("live: repeated identical request is stable (cache)", async () => {
    if (!configured) return;
    const r = await api(shipper.token, "POST", "/api/geo/route", { origin: NBI, destination: NKU });
    assert(r.status === 200 && r.json.distanceKm === probe.json.distanceKm, "unstable");
  });
  await test("per-user rate limit → 429 after the window cap; other users unaffected", async () => {
    if (!configured) return;
    let last = 0;
    for (let i = 0; i < 35; i++) {
      last = (await api(james.token, "POST", "/api/geo/route", { origin: NBI, destination: NKU })).status;
      if (last === 429) break;
    }
    assert(last === 429, `never rate limited (last ${last})`);
    const other = await api(shipper.token, "POST", "/api/geo/route", { origin: NBI, destination: NKU });
    assert(other.status === 200, `shipper got ${other.status}`);
  });
  await test("response never contains the API key", async () => {
    const text = JSON.stringify(probe.json);
    assert(!/AIza/.test(text), "key leaked");
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main();

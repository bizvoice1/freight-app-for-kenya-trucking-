// Phase 5C-1 acceptance — load coordinates + newest-first ordering on the real
// backend. Run against a freshly migrated + seeded backend on :4000.
const BASE = process.env.BASE_URL || "http://localhost:4000";
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS -", name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log("FAIL -", name, "->", e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

const base = { cargo: "5C-1 cargo", origin: "Nairobi", destination: "Nakuru", price: 20000 };

async function main() {
  const shipper = await login("0700000001", "1234", "shipper");
  const james = await login("0722100200", "1234", "fleet_owner");
  let withCoords, textOnly;

  await test("POST with pickup/delivery places stores name, placeId, lat, lng", async () => {
    const r = await api(shipper.token, "POST", "/api/loads", {
      ...base,
      pickup:   { name: "Nairobi CBD", placeId: "ChIJ-nbi", lat: -1.2921, lng: 36.8219 },
      delivery: { name: "Nakuru Town", placeId: "ChIJ-nku", lat: -0.3031, lng: 36.08 },
    });
    assert(r.status === 201, `expected 201, got ${r.status} ${JSON.stringify(r.json)}`);
    withCoords = r.json;
    assert(r.json.pickupLat === -1.2921 && r.json.pickupLng === 36.8219, "pickup coords not stored");
    assert(r.json.deliveryLat === -0.3031 && r.json.deliveryPlaceId === "ChIJ-nku", "delivery fields not stored");
    const back = (await api(shipper.token, "GET", `/api/loads/${r.json.id}`)).json;
    assert(back.pickupName === "Nairobi CBD" && back.deliveryLng === 36.08, "round-trip via GET lost data");
  });

  await sleep(15);
  await test("POST without places stays valid; names default to origin/destination, coords null", async () => {
    const r = await api(shipper.token, "POST", "/api/loads", base);
    assert(r.status === 201, `expected 201, got ${r.status}`);
    textOnly = r.json;
    assert(r.json.pickupName === "Nairobi" && r.json.deliveryName === "Nakuru", "names should default to text fields");
    assert(r.json.pickupLat === null && r.json.deliveryLat === null, "coords should be null");
  });

  await test("lat without lng is rejected with 400", async () => {
    const r = await api(shipper.token, "POST", "/api/loads", { ...base, pickup: { name: "x", lat: -1.2 } });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });
  await test("out-of-range and non-numeric coordinates are rejected with 400", async () => {
    for (const pickup of [{ lat: 95, lng: 10 }, { lat: 10, lng: 181 }, { lat: "-1.2", lng: "36.8" }, { lat: null, lng: 5 }]) {
      const r = await api(shipper.token, "POST", "/api/loads", { ...base, pickup });
      assert(r.status === 400, `expected 400 for ${JSON.stringify(pickup)}, got ${r.status}`);
    }
  });
  await test("malformed place (array / string) is rejected with 400", async () => {
    for (const delivery of [[1, 2], "Nakuru", 5]) {
      const r = await api(shipper.token, "POST", "/api/loads", { ...base, delivery });
      assert(r.status === 400, `expected 400 for ${JSON.stringify(delivery)}, got ${r.status}`);
    }
  });

  await test("GET /api/loads returns newest first", async () => {
    const r = await api(james.token, "GET", "/api/loads");
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const ids = r.json.map(l => l.id);
    assert(ids.indexOf(textOnly.id) < ids.indexOf(withCoords.id), "later load should precede earlier load");
    for (let i = 1; i < r.json.length; i++) {
      assert(r.json[i - 1].createdAt >= r.json[i].createdAt, `not descending at index ${i}`);
    }
  });

  await test("Pre-existing seeded load (no coordinates) still lists and fetches", async () => {
    const list = (await api(james.token, "GET", "/api/loads")).json;
    const seeded = list.find(l => l.cargo === "FMCG Goods");
    assert(seeded && seeded.pickupLat === null, "seeded load should exist with null coords");
    assert((await api(james.token, "GET", `/api/loads/${seeded.id}`)).status === 200, "seeded load fetch failed");
  });

  await test("Shipper still can't list another shipper's loads (4I unchanged)", async () => {
    const r = await api(shipper.token, "GET", "/api/loads?shipperId=USR-9999");
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass}/${results.length} passed.`);
  if (pass !== results.length) process.exit(1);
}
main().catch(e => { console.error("FATAL:", e); process.exit(1); });

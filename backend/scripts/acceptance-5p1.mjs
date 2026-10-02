// Phase 5P-1 acceptance — Identity Foundation: register / login / GET /api/me, transporter fleet-owner creation,
// brute-force lock, and tenant isolation across freshly registered Shipper A/B and Transporter A/B.
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NBO_NKU } from "./fixtures.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "behari.sqlite");
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS -", name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log("FAIL -", name, "->", e.message); }
}
function assert(c, m) { if (!c) throw new Error(m); }
async function api(token, method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const row = (sql, ...a) => { const d = new Database(DB_PATH); const r = d.prepare(sql).get(...a); d.close(); return r; };
const reg = (b) => api(null, "POST", "/api/auth/register", b);
const run = String(Date.now()).slice(-6); // unique phones per run: 07 + 6 digits + 2 suffix digits
const P = { sA: `07${run}11`, sB: `07${run}12`, tA: `07${run}21`, tB: `07${run}22` };

let sA, sB, tA, tB;

async function main() {
  await test("0. auth config states dev-pin mode with NO phone verification; public roles are shipper + fleet_owner only", async () => {
    const r = await api(null, "GET", "/api/auth/config");
    assert(r.status === 200 && r.json.mode === "dev-pin" && r.json.phoneVerification === false, JSON.stringify(r.json));
    assert(JSON.stringify([...r.json.publicRoles].sort()) === '["fleet_owner","shipper"]', JSON.stringify(r.json.publicRoles));
  });

  await test("1. register Shipper A, Shipper B, Transporter A, Transporter B -> 201 + token + session user", async () => {
    sA = await reg({ name: "Shipper Alpha", phone: P.sA, pin: "4821", role: "shipper" });
    sB = await reg({ name: "Shipper Bravo", phone: P.sB, pin: "4822", role: "shipper" });
    tA = await reg({ name: "Transporter Alpha", phone: P.tA, pin: "4823", role: "fleet_owner", company: "Alpha Haulage" });
    tB = await reg({ name: "Transporter Bravo", phone: P.tB, pin: "4824", role: "fleet_owner" });
    for (const r of [sA, sB, tA, tB]) assert(r.status === 201 && r.json.token && r.json.user?.id, JSON.stringify(r.json));
    assert(sA.json.user.fleetOwnerId === null && sA.json.user.role === "shipper", "shipper must have no fleetOwnerId");
    assert(new Set([sA, sB, tA, tB].map(r => r.json.user.id)).size === 4, "ids must be distinct");
  });

  await test("2. PIN is stored hashed (never plaintext) and the new user is unverified", async () => {
    const u = row("SELECT pin_hash, phone_verified, created_at FROM users WHERE id = ?", sA.json.user.id);
    assert(u.pin_hash && u.pin_hash !== "4821" && u.pin_hash.startsWith("$2"), "pin not bcrypt-hashed");
    assert(u.phone_verified === 0 && u.created_at, "phone_verified must be 0");
  });

  await test("3. transporter registration atomically creates users + fleet_owners and links user.fleetOwnerId", async () => {
    const u = row("SELECT * FROM users WHERE id = ?", tA.json.user.id);
    assert(u.fleet_owner_id && u.fleet_owner_id === tA.json.user.fleetOwnerId, "fleetOwnerId not linked");
    const fo = row("SELECT * FROM fleet_owners WHERE id = ?", u.fleet_owner_id);
    assert(fo && fo.name === "Transporter Alpha" && fo.phone === P.tA && fo.company === "Alpha Haulage", JSON.stringify(fo));
    assert(tA.json.user.fleetOwnerId !== tB.json.user.fleetOwnerId, "transporters must not share a fleet owner");
    assert(row("SELECT fleet_owner_id f FROM users WHERE id = ?", sA.json.user.id).f === null, "shipper must not get a fleet owner");
  });

  await test("4. GET /api/me returns the canonical backend identity (id, role, name, phone, fleetOwner, phoneVerified=false)", async () => {
    const m = (await api(tA.json.token, "GET", "/api/me")).json;
    assert(m.id === tA.json.user.id && m.role === "fleet_owner" && m.name === "Transporter Alpha" && m.phone === P.tA, JSON.stringify(m));
    assert(m.fleetOwnerId === tA.json.user.fleetOwnerId && m.fleetOwner?.id === m.fleetOwnerId && m.fleetOwner.company === "Alpha Haulage", JSON.stringify(m));
    assert(m.phoneVerified === false && m.authMode?.mode === "dev-pin", JSON.stringify(m));
    assert(!("pinHash" in m) && !("pin_hash" in m), "must not leak the PIN hash");
    const s = (await api(sA.json.token, "GET", "/api/me")).json;
    assert(s.id === sA.json.user.id && s.role === "shipper" && s.fleetOwner === null, JSON.stringify(s));
  });

  await test("5. /api/me without / with a bad token -> 401", async () => {
    assert((await api(null, "GET", "/api/me")).status === 401, "no token");
    assert((await api("garbage", "GET", "/api/me")).status === 401, "bad token");
  });

  await test("6. non-public roles cannot be registered (admin, driver, loading_agent, transporter alias, missing, non-string) and create nothing", async () => {
    const before = row("SELECT COUNT(*) n FROM users").n;
    for (const role of ["admin", "driver", "loading_agent", "transporter", "", undefined, 5, ["admin"]]) {
      const r = await reg({ name: "Mallory", phone: `07${run}99`, pin: "4821", role });
      assert(r.status === 400 && r.json.code === "ROLE_NOT_REGISTERABLE", `${JSON.stringify(role)} -> ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert(row("SELECT COUNT(*) n FROM users").n === before, "a user row was created");
  });

  await test("7. validation: bad name/phone/PIN/types are rejected with 400 and create nothing", async () => {
    const before = { u: row("SELECT COUNT(*) n FROM users").n, f: row("SELECT COUNT(*) n FROM fleet_owners").n };
    const good = { name: "Valid Name", phone: `07${run}98`, pin: "4821", role: "fleet_owner" };
    const bads = [
      [{ ...good, name: "x" }, "INVALID_NAME"], [{ ...good, name: 42 }, "INVALID_NAME"],
      [{ ...good, phone: "12345" }, "INVALID_PHONE"], [{ ...good, phone: null }, "INVALID_PHONE"], [{ ...good, phone: "0212345678" }, "INVALID_PHONE"],
      [{ ...good, pin: "123" }, "INVALID_PIN"], [{ ...good, pin: "1234567" }, "INVALID_PIN"], [{ ...good, pin: "12a4" }, "INVALID_PIN"], [{ ...good, pin: 1234 }, "INVALID_PIN"], [{ ...good, pin: null }, "INVALID_PIN"],
    ];
    for (const [b, code] of bads) {
      const r = await reg(b);
      assert(r.status === 400 && r.json.code === code, `${JSON.stringify(b)} -> ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert((await api(null, "POST", "/api/auth/register", undefined)).status === 400, "empty body");
    assert(row("SELECT COUNT(*) n FROM users").n === before.u && row("SELECT COUNT(*) n FROM fleet_owners").n === before.f, "rows created by rejected registrations");
  });

  await test("8. duplicate (phone, role) -> 409 PHONE_TAKEN, including other phone formats (+254 / spaces) and an existing seeded account", async () => {
    assert((await reg({ name: "Dup", phone: P.sA, pin: "4821", role: "shipper" })).json.code === "PHONE_TAKEN", "same format");
    const intl = "+254 " + P.sA.slice(1, 4) + " " + P.sA.slice(4);
    const r = await reg({ name: "Dup", phone: intl, pin: "4821", role: "shipper" });
    assert(r.status === 409 && r.json.code === "PHONE_TAKEN", `${intl} -> ${JSON.stringify(r.json)}`);
    assert((await reg({ name: "Dup", phone: "0700000001", pin: "4821", role: "shipper" })).status === 409, "seeded shipper phone");
  });

  await test("9. the same phone may hold a different role as a SEPARATE identity", async () => {
    const r = await reg({ name: "Shipper Alpha (haulage)", phone: P.sA, pin: "4821", role: "fleet_owner" });
    assert(r.status === 201 && r.json.user.id !== sA.json.user.id && r.json.user.fleetOwnerId, JSON.stringify(r.json));
  });

  await test("10. concurrent identical registrations -> exactly one wins, and no orphan fleet_owners row is left behind", async () => {
    const orphans = () => row("SELECT COUNT(*) n FROM fleet_owners fo WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.fleet_owner_id = fo.id)").n;
    const o0 = orphans();
    const b = { name: "Racer", phone: `07${run}77`, pin: "4821", role: "fleet_owner" };
    const rs = await Promise.all(Array.from({ length: 6 }, () => reg(b)));
    const wins = rs.filter(r => r.status === 201).length, dups = rs.filter(r => r.status === 409).length;
    assert(wins === 1 && wins + dups === 6, rs.map(r => r.status).join(","));
    assert(row("SELECT COUNT(*) n FROM users WHERE phone = ? AND role = 'fleet_owner'", b.phone).n === 1, "duplicate user rows");
    assert(orphans() === o0, `orphan fleet_owners: ${orphans() - o0}`);
  });

  await test("11. login: phone formats normalise; unknown account and wrong PIN give the SAME 401 body (no enumeration); wrong role fails", async () => {
    const ok = await api(null, "POST", "/api/auth/login", { phone: "+254" + P.tA.slice(1), pin: "4823", role: "fleet_owner" });
    assert(ok.status === 200 && ok.json.user.id === tA.json.user.id, JSON.stringify(ok.json));
    const wrongPin = await api(null, "POST", "/api/auth/login", { phone: P.tB, pin: "0000", role: "fleet_owner" });
    const unknown = await api(null, "POST", "/api/auth/login", { phone: `07${run}55`, pin: "0000", role: "fleet_owner" });
    assert(wrongPin.status === 401 && unknown.status === 401 && JSON.stringify(wrongPin.json) === JSON.stringify(unknown.json), `${JSON.stringify(wrongPin.json)} vs ${JSON.stringify(unknown.json)}`);
    assert((await api(null, "POST", "/api/auth/login", { phone: P.tA, pin: "4823", role: "shipper" })).status === 401, "wrong role");
    assert((await api(null, "POST", "/api/auth/login", { phone: P.tA, pin: 4823, role: "fleet_owner" })).status === 400, "numeric pin");
  });

  await test("12. brute force: 5 wrong PINs lock that phone+role (429), even the correct PIN is refused; other accounts unaffected", async () => {
    // Shipper Bravo is locked here; its registration token remains a valid session for the isolation tests.
    for (let i = 0; i < 5; i++) assert((await api(null, "POST", "/api/auth/login", { phone: P.sB, pin: "0000", role: "shipper" })).status === 401, "attempt " + i);
    const locked = await api(null, "POST", "/api/auth/login", { phone: P.sB, pin: "4822", role: "shipper" });
    assert(locked.status === 429 && locked.json.code === "LOGIN_LOCKED", JSON.stringify(locked));
    assert((await api(null, "POST", "/api/auth/login", { phone: P.sA, pin: "4821", role: "shipper" })).status === 200, "other account affected");
  });

  const post = (who) => api(who.json.token, "POST", "/api/loads", {
    cargo: "Maize", origin: "Nairobi", destination: "Nakuru", weight: 10, truckType: "Flatbed", price: 60000, pickupDate: "2030-01-01",
    pickup: NBO_NKU.pickup, delivery: NBO_NKU.delivery,
  });
  let load, offer, booking;

  await test("13. isolation: fresh accounts see empty worlds (no loads, bookings, trucks, drivers, offers)", async () => {
    for (const who of [sA, sB]) {
      assert((await api(who.json.token, "GET", "/api/loads")).json.length === 0, "shipper loads");
      assert((await api(who.json.token, "GET", "/api/bookings")).json.length === 0, "shipper bookings");
    }
    for (const who of [tA, tB]) {
      assert((await api(who.json.token, "GET", "/api/trucks")).json.length === 0, "trucks");
      assert((await api(who.json.token, "GET", "/api/drivers")).json.length === 0, "drivers");
      assert((await api(who.json.token, "GET", "/api/bookings")).json.length === 0, "bookings");
      assert((await api(who.json.token, "GET", "/api/offers")).json.offers.length === 0, "offers");
    }
  });

  await test("14. fleet listings are scoped: shippers cannot list trucks/drivers; a transporter cannot ask for another fleet", async () => {
    for (const who of [sA, sB]) {
      assert((await api(who.json.token, "GET", "/api/trucks")).status === 403, "shipper trucks");
      assert((await api(who.json.token, "GET", "/api/drivers")).status === 403, "shipper drivers");
    }
    assert((await api(tA.json.token, "GET", `/api/trucks?ownerId=${tB.json.user.fleetOwnerId}`)).status === 403, "cross-fleet trucks");
    assert((await api(tA.json.token, "GET", "/api/trucks?ownerId=FO-1000")).status === 403, "seeded fleet visible");
  });

  await test("15. Shipper A posts a load: A sees it, B does not and is refused direct access; transporters can discover it", async () => {
    const p = await post(sA);
    assert(p.status === 201, JSON.stringify(p.json));
    load = p.json;
    assert(row("SELECT shipper_id s FROM loads WHERE id = ?", load.id).s === sA.json.user.id, "load not owned by A in DB");
    assert((await api(sA.json.token, "GET", "/api/loads")).json.some(l => l.id === load.id), "A cannot see own load");
    assert(!(await api(sB.json.token, "GET", "/api/loads")).json.some(l => l.id === load.id), "B list leaked A's load");
    assert((await api(sB.json.token, "GET", `/api/loads/${load.id}`)).status === 403, "B direct get");
    assert((await api(sB.json.token, "GET", `/api/loads?shipperId=${sA.json.user.id}`)).status === 403, "B list-by-A");
    for (const t of [tA, tB]) assert((await api(t.json.token, "GET", "/api/loads?status=Open")).json.some(l => l.id === load.id), "transporter cannot discover");
  });

  await test("16. Transporter A offers; Transporter B and Shipper B cannot see or act on A's thread", async () => {
    const o = await api(tA.json.token, "POST", `/api/loads/${load.id}/offers`, { amount: 55000 });
    assert(o.status === 201, JSON.stringify(o.json));
    offer = o.json;
    assert(row("SELECT transporter_id t FROM offers WHERE id = ?", offer.id).t === tA.json.user.id, "offer not owned by A");
    assert((await api(sA.json.token, "GET", `/api/loads/${load.id}/offers`)).status === 200, "owning shipper cannot read the thread");
    for (const who of [tB, sB]) {
      assert((await api(who.json.token, "GET", "/api/offers")).json.offers.every(x => x.id !== offer.id), "offer inbox leak");
      const act = await api(who.json.token, "POST", `/api/offers/${offer.id}/accept`, {});
      assert(act.status === 403 || act.status === 404, "foreign accept -> " + act.status);
      const cnt = await api(who.json.token, "POST", `/api/offers/${offer.id}/counter`, { amount: 1 });
      assert(cnt.status === 403 || cnt.status === 404, "foreign counter -> " + cnt.status);
    }
    const sbThread = await api(sB.json.token, "GET", `/api/loads/${load.id}/offers`);
    assert(sbThread.status === 403 || sbThread.status === 404, "Shipper B sees A's thread: " + sbThread.status);
    const tbThread = await api(tB.json.token, "GET", `/api/loads/${load.id}/offers`);
    assert(!Array.isArray(tbThread.json) || tbThread.json.every(x => x.id !== offer.id), "Transporter B sees A's offers");
  });

  await test("17. Shipper A accepts -> booking; only A and Transporter A can see it; B-side identities get 403/404 and empty lists", async () => {
    const a = await api(sA.json.token, "POST", `/api/offers/${offer.id}/accept`, {});
    assert(a.status === 200 || a.status === 201, JSON.stringify(a.json));
    booking = a.json.booking;
    assert(booking?.id, JSON.stringify(a.json));
    for (const who of [sA, tA]) {
      assert((await api(who.json.token, "GET", `/api/bookings/${booking.id}`)).status === 200, "party cannot read booking");
      assert((await api(who.json.token, "GET", "/api/bookings")).json.some(b => b.id === booking.id), "party list missing booking");
    }
    for (const who of [sB, tB]) {
      const g = await api(who.json.token, "GET", `/api/bookings/${booking.id}`);
      assert(g.status === 403 || g.status === 404, "foreign booking get -> " + g.status);
      assert((await api(who.json.token, "GET", "/api/bookings")).json.length === 0, "foreign booking list");
      for (const ep of ["ledger", "adjustments"]) {
        const e = await api(who.json.token, "GET", `/api/bookings/${booking.id}/${ep}`);
        assert(e.status === 403 || e.status === 404, `foreign ${ep} -> ${e.status}`);
      }
    }
    assert(row("SELECT transporter_id t FROM bookings WHERE id = ?", booking.id).t === tA.json.user.id, "booking transporter is not A");
  });

  await test("18. foreign identities cannot fund, assign, or create a trip for A's booking; /api/me never drifts to another identity", async () => {
    const pay = await api(sB.json.token, "POST", `/api/bookings/${booking.id}/payment`, { phoneNumber: "254712345678" });
    assert(pay.status === 403 || pay.status === 404, "foreign payment -> " + pay.status);
    for (const ep of ["assign", "create-trip"]) {
      const r = await api(tB.json.token, "POST", `/api/bookings/${booking.id}/${ep}`, { truckId: "x", driverId: "y" });
      assert(r.status === 403 || r.status === 404, `foreign ${ep} -> ${r.status}`);
    }
    assert((await api(sB.json.token, "GET", "/api/me")).json.id === sB.json.user.id, "/me identity drifted");
    assert((await api(tB.json.token, "GET", "/api/me")).json.fleetOwnerId === tB.json.user.fleetOwnerId, "/me fleet drifted");
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — FAILED: " + failed.map(f => f.name).join("; ") : "."}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });

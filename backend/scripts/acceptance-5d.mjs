// Phase 5D-1 acceptance — negotiation/pricing foundation (docs/5D-PRICING-SPEC.md Section 11,
// tests 1-18 and 42; 40-41 are browser-verified). Real HTTP against a freshly migrated + seeded
// backend on :4000, plus direct SQLite access for triggers, CHECK, expiry set-up and the sweeper.
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NBO_NKU } from "./fixtures.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "behari.sqlite");
process.env.DATABASE_PATH = DB_PATH;

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS -", name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log("FAIL -", name, "->", e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(token, method, p, body, headers = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}
async function login(phone, role) {
  const { status, json } = await api(null, "POST", "/api/auth/login", { phone, pin: "1234", role });
  assert(status === 200, `login ${phone}/${role} failed: ${JSON.stringify(json)}`);
  return json;
}
async function waitFor(fn, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(60);
  }
}
const rawDb = () => new Database(DB_PATH);

let shipper, mary, james, daniel, carol, admin, driver;

async function setup() {
  // A third transporter so "two other competitors" (test 11) is possible; the seed has two.
  const db = rawDb();
  const dan = db.prepare("SELECT * FROM users WHERE phone = '0711000000' AND role = 'fleet_owner'").get();
  db.prepare("INSERT OR IGNORE INTO users (id, phone, pin_hash, role, name, driver_id, fleet_owner_id) VALUES ('USR-9001', '0799000001', ?, 'fleet_owner', 'Carol Wanjiru', NULL, 'FO-1001')").run(dan.pin_hash);
  db.close();

  shipper = await login("0700000001", "shipper");
  mary    = await login("0700000003", "shipper");
  james   = await login("0722100200", "fleet_owner");
  daniel  = await login("0711000000", "fleet_owner");
  carol   = await login("0799000001", "fleet_owner");
  admin   = await login("0700000002", "admin");
  driver  = await login("0733222333", "driver");
}

const newLoad = async (price, who = shipper, { noRoute = false } = {}) => {
  const body = { cargo: "5D test cargo", origin: "Nairobi", destination: "Nakuru", ...(noRoute ? {} : NBO_NKU) };
  if (price !== undefined) body.price = price;
  const r = await api(who.token, "POST", "/api/loads", body);
  assert(r.status === 201, `load create failed: ${JSON.stringify(r.json)}`);
  return r.json;
};
const offer = (who, loadId, amount, extra = {}, headers) => api(who.token, "POST", `/api/loads/${loadId}/offers`, { amount, ...extra }, headers);
const act = (who, offerId, verb, body) => api(who.token, "POST", `/api/offers/${offerId}/${verb}`, body ?? {});
const threadOf = async (who, loadId) => (await api(who.token, "GET", `/api/loads/${loadId}/offers`)).json.offers;
const loadRow = async (loadId) => (await api(shipper.token, "GET", `/api/loads/${loadId}`)).json;
const count = (sql, ...a) => { const d = rawDb(); const n = d.prepare(sql).get(...a).n; d.close(); return n; };

async function main() {
  await setup();

  // ── A. Offers and negotiation ─────────────────────────────────────────
  let L1, o1, o2, bookingA;
  await test("1. transporter offers 110,000 on a 100,000 load → 201 round 1 PENDING; load price unchanged", async () => {
    L1 = await newLoad(100000);
    const r = await offer(james, L1.id, 110000, { note: "fuel is up" });
    assert(r.status === 201, `got ${r.status} ${JSON.stringify(r.json)}`);
    o1 = r.json;
    assert(o1.round === 1 && o1.status === "PENDING" && o1.proposerRole === "transporter" && o1.amount === 110000, JSON.stringify(o1));
    assert(o1.id.startsWith("OFR-") && o1.transporterId === james.user.id && o1.expiresAt, "shape");
    assert((await loadRow(L1.id)).price === 100000, "load price changed");
    const note = (await api(shipper.token, "GET", "/api/notifications?unreadOnly=true")).json.find(n => n.type === "offer_received" && n.relatedEntityId === o1.id);
    assert(note, "shipper was not notified of offer_received");
  });

  await test("2. shipper counters 105,000 → parent COUNTERED, new row round 2 PENDING, proposerRole shipper", async () => {
    const r = await act(shipper, o1.id, "counter", { amount: 105000 });
    assert(r.status === 201, `got ${r.status} ${JSON.stringify(r.json)}`);
    o2 = r.json;
    assert(o2.round === 2 && o2.status === "PENDING" && o2.proposerRole === "shipper" && o2.parentOfferId === o1.id && o2.transporterId === james.user.id, JSON.stringify(o2));
    const rows = await threadOf(shipper, L1.id);
    assert(rows.find(o => o.id === o1.id).status === "COUNTERED", "parent not COUNTERED");
    assert(rows.find(o => o.id === o1.id).closeReason === "SUPERSEDED_BY_COUNTER", "closeReason");
    const note = (await api(james.token, "GET", "/api/notifications?unreadOnly=true")).json.find(n => n.type === "offer_countered" && n.relatedEntityId === o2.id);
    assert(note, "transporter was not notified of offer_countered");
  });

  await test("3. proposer cannot accept/reject/counter their own PENDING offer", async () => {
    for (const [verb, body] of [["accept"], ["reject"], ["counter", { amount: 104000 }]]) {
      const r = await act(shipper, o2.id, verb, body);
      assert(r.status === 403 || r.status === 409, `${verb} by proposer got ${r.status}`);
    }
    assert((await threadOf(shipper, L1.id)).find(o => o.id === o2.id).status === "PENDING", "offer changed state");
  });

  await test("4. third parties cannot read or act on the thread; a competing transporter sees nothing of it", async () => {
    for (const [who, label] of [[daniel, "other transporter"], [mary, "other shipper"], [driver, "driver"], [admin, "admin"]]) {
      for (const verb of ["accept", "reject", "withdraw"]) {
        const r = await act(who, o2.id, verb);
        assert(r.status === 403, `${label} ${verb} got ${r.status}`);
      }
      const c = await act(who, o2.id, "counter", { amount: 100000 });
      assert(c.status === 403, `${label} counter got ${c.status}`);
    }
    assert((await api(mary.token, "GET", `/api/loads/${L1.id}/offers`)).status === 403, "other shipper could read");
    assert((await api(driver.token, "GET", `/api/loads/${L1.id}/offers`)).status === 403, "driver could read");
    const seen = (await api(daniel.token, "GET", `/api/loads/${L1.id}/offers`)).json;
    assert(seen.offers.length === 0, "competitor saw another transporter's offers");
    const adminSee = (await api(admin.token, "GET", `/api/loads/${L1.id}/offers`)).json;
    assert(adminSee.offers.length === 2, "admin read-only view missing");
    const shipperSees = await threadOf(shipper, L1.id);
    assert(shipperSees.length === 2, "owner shipper view");
    assert((await act(james, "OFR-DOES-NOT-EXIST", "accept")).status === 404, "unknown offer id should be 404");
  });

  await test("5/42. five rows max whichever party proposed; counter on row 5 → FINAL_ROUND; schema rejects a sixth", async () => {
    const L = await newLoad(100000);
    let cur = (await offer(james, L.id, 120000)).json;
    const plan = [[shipper, 90000], [james, 115000], [shipper, 95000], [james, 110000]];
    for (const [who, amt] of plan.slice(0, 3)) {
      const r = await act(who, cur.id, "counter", { amount: amt });
      assert(r.status === 201, `round ${cur.round + 1} got ${r.status} ${JSON.stringify(r.json)}`);
      cur = r.json;
    }
    // cur is round 4 (shipper); transporter counters → round 5
    const r5 = await act(james, cur.id, "counter", { amount: 110000 });
    assert(r5.status === 201 && r5.json.round === 5, `round 5 got ${r5.status} ${JSON.stringify(r5.json)}`);
    cur = r5.json;
    const six = await act(shipper, cur.id, "counter", { amount: 100000 });
    assert(six.status === 409 && six.json.code === "FINAL_ROUND", `counter on round 5 got ${six.status} ${JSON.stringify(six.json)}`);
    const rows = await threadOf(shipper, L.id);
    assert(rows.length === 5 && rows.every((o, i) => o.round === i + 1), "thread should hold exactly 5 rounds");
    assert(rows[4].isFinalRound === true, "final round flag");
    // schema-level: CHECK(round BETWEEN 1 AND 5) and UNIQUE(load, transporter, round)
    const db = rawDb();
    const ins = (id, round) => db.prepare(
      "INSERT INTO offers (id, load_id, transporter_id, round, proposer_role, proposer_id, amount, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'shipper', 'x', 1000, 'REJECTED', '2099-01-01T00:00:00.000Z', '2000-01-01', '2000-01-01')"
    ).run(id, L.id, james.user.id, round);
    let checkErr = null; try { ins("OFR-X1", 6); } catch (e) { checkErr = e.message; }
    assert(checkErr && /CHECK/i.test(checkErr), `sixth row not rejected by CHECK: ${checkErr}`);
    let uniqErr = null; try { ins("OFR-X2", 3); } catch (e) { uniqErr = e.message; }
    assert(uniqErr && /UNIQUE/i.test(uniqErr), `duplicate round not rejected by UNIQUE: ${uniqErr}`);
    db.close();
    // row 5's proposer (transporter) may not accept/reject/counter it, but may withdraw it — checked on a dedicated load below
  });

  await test("42. final-round roles: proposer of row 5 can only withdraw; non-proposer accepts or rejects", async () => {
    async function finalThread() {
      const L = await newLoad(100000);
      let cur = (await offer(james, L.id, 120000)).json;
      for (const who of [shipper, james, shipper, james]) {
        cur = (await act(who, cur.id, "counter", { amount: 100000 + cur.round * 1000 })).json;
      }
      assert(cur.round === 5, `expected round 5, got ${cur.round}`);
      return { L, final: cur };
    }
    const A = await finalThread();
    for (const [verb, body] of [["accept"], ["reject"], ["counter", { amount: 99999 }]]) {
      const r = await act(james, A.final.id, verb, body);
      assert(r.status === 403 || r.status === 409, `proposer ${verb} on row 5 got ${r.status}`);
    }
    const w = await act(james, A.final.id, "withdraw");
    assert(w.status === 200 && w.json.status === "WITHDRAWN", `withdraw got ${w.status}`);
    // cap never resets: same transporter cannot open a new thread after the old one died
    const again = await offer(james, A.L.id, 100000);
    assert(again.status === 409 && again.json.code === "THREAD_EXISTS", `reopen got ${again.status} ${JSON.stringify(again.json)}`);

    const B = await finalThread();
    const rej = await act(shipper, B.final.id, "reject", { reason: "too high" });
    assert(rej.status === 200 && rej.json.status === "REJECTED" && rej.json.closeReason === "REJECTED_BY_COUNTERPARTY", JSON.stringify(rej.json));
    const again2 = await offer(james, B.L.id, 100000);
    assert(again2.status === 409 && again2.json.code === "THREAD_EXISTS", "cap reset after rejection");
    assert((await loadRow(B.L.id)).status === "Open", "load should remain Open after a rejection");
  });

  await test("6. shipper may accept the final offer", async () => {
    const L = await newLoad(100000);
    let cur = (await offer(james, L.id, 120000)).json;
    for (const who of [shipper, james, shipper, james]) cur = (await act(who, cur.id, "counter", { amount: 100000 + cur.round * 1000 })).json;
    const r = await act(shipper, cur.id, "accept");
    assert(r.status === 201 && r.json.booking.agreedAmount === cur.amount && r.json.offer.status === "ACCEPTED", JSON.stringify(r.json));
  });

  await test("7. expired offer: accept → 409 OFFER_EXPIRED before the sweeper; sweeper then marks EXPIRED + audit", async () => {
    const L = await newLoad(100000);
    const o = (await offer(james, L.id, 100000)).json;
    const db = rawDb();
    db.prepare("UPDATE offers SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(o.id);
    db.close();
    for (const [who, verb, body] of [[shipper, "accept"], [shipper, "reject"], [shipper, "counter", { amount: 100000 }]]) {
      const r = await act(who, o.id, verb, body);
      assert(r.status === 409 && r.json.code === "OFFER_EXPIRED", `${verb} got ${r.status} ${JSON.stringify(r.json)}`);
    }
    const before = (await threadOf(shipper, L.id))[0];
    assert(before.status === "PENDING" && before.effectiveStatus === "EXPIRED" && before.needsMyAction === false, "lazy view should show EXPIRED while the row is still PENDING");
    assert((await loadRow(L.id)).status === "Open", "load must not have been booked");
    const { expireDueOffers } = await import("../src/services/offers.js");
    const swept = expireDueOffers();
    assert(swept >= 1, "sweeper swept nothing");
    const after = (await threadOf(shipper, L.id))[0];
    assert(after.status === "EXPIRED" && after.closeReason === "EXPIRED" && after.resolvedAt, JSON.stringify(after));
    assert(count("SELECT COUNT(*) n FROM payment_events WHERE entity_type='offer' AND entity_id=? AND event_type='offer_expired'", o.id) === 1, "no offer_expired audit row");
    assert(expireDueOffers() === 0, "sweeper is not idempotent");
  });

  await test("8. withdraw: only the proposer; counterparty then gets 409 on accept", async () => {
    const L = await newLoad(100000);
    const o = (await offer(james, L.id, 100000)).json;
    assert((await act(shipper, o.id, "withdraw")).status === 403, "counterparty withdrew");
    const w = await act(james, o.id, "withdraw");
    assert(w.status === 200 && w.json.status === "WITHDRAWN", JSON.stringify(w.json));
    const a = await act(shipper, o.id, "accept");
    assert(a.status === 409 && a.json.code === "OFFER_NOT_PENDING", `accept got ${a.status} ${JSON.stringify(a.json)}`);
    assert((await act(james, o.id, "withdraw")).status === 409, "double withdraw");
  });

  await test("9. bad amounts → 4xx, never 500; band 0.2x–3x enforced; no thread created by failures", async () => {
    const L = await newLoad(100000);
    const cases = [
      [5000, 422, "AMOUNT_OUT_OF_BAND"], [19999, 422, "AMOUNT_OUT_OF_BAND"], [300001, 422, "AMOUNT_OUT_OF_BAND"],
      [-1, 400, "INVALID_AMOUNT"], [0, 400, "INVALID_AMOUNT"], [1.5, 400, "INVALID_AMOUNT"], [1e12, 400, "INVALID_AMOUNT"],
      ["110000", 400, "INVALID_AMOUNT"], [[110000], 400, "INVALID_AMOUNT"], [{ v: 1 }, 400, "INVALID_AMOUNT"], [null, 400, "INVALID_AMOUNT"], [undefined, 400, "INVALID_AMOUNT"],
    ];
    for (const [amt, status, code] of cases) {
      const r = await offer(james, L.id, amt);
      assert(r.status === status && r.json.code === code, `${JSON.stringify(amt)} → ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert((await offer(james, L.id, 100000, { note: "x".repeat(501) })).status === 400, "oversize note");
    assert((await offer(james, L.id, 100000, { note: 5 })).status === 400, "non-string note");
    assert((await offer(james, L.id, 100000, { ttlHours: 0 })).status === 400, "ttl 0");
    assert((await offer(james, L.id, 100000, { ttlHours: 999 })).status === 400, "ttl 999");
    assert((await threadOf(shipper, L.id)).length === 0, "failed offers must not persist");
    const lo = await offer(james, L.id, 20000); assert(lo.status === 201, `band floor got ${lo.status}`);
    const bad = await act(shipper, lo.json.id, "counter", { amount: 5000 });
    assert(bad.status === 422, `counter out of band got ${bad.status}`);
    assert((await offer(daniel, L.id, 300000)).status === 201, "band ceiling");
    // roles and malformed requests
    assert((await offer(shipper, L.id, 100000)).status === 403, "shipper opened a thread");
    assert((await offer(driver, L.id, 100000)).status === 403, "driver opened a thread");
    assert((await offer(admin, L.id, 100000)).status === 403, "admin opened a thread");
    assert((await offer(james, "BHL-NOPE", 100000)).status === 404, "unknown load");
    assert((await api(null, "POST", `/api/loads/${L.id}/offers`, { amount: 1 })).status === 401, "unauthenticated");
    const dup = await offer(james, L.id, 100000);
    assert(dup.status === 409 && dup.json.code === "THREAD_EXISTS", `duplicate thread got ${dup.status}`);
  });

  await test("9b. offers on a no-price load are free-form positive integers", async () => {
    const L = await newLoad();
    const r = await offer(james, L.id, 7);
    assert(r.status === 201, `got ${r.status} ${JSON.stringify(r.json)}`);
  });

  // ── B. Acceptance and booking immutability ───────────────────────────
  await test("10. accept 105,000 → booking agreedAmount=105,000 source OFFER, load Booked, loads.price still 100,000", async () => {
    const r = await act(james, o2.id, "accept");
    assert(r.status === 201, `got ${r.status} ${JSON.stringify(r.json)}`);
    bookingA = r.json.booking;
    assert(r.json.offer.status === "ACCEPTED", "offer not ACCEPTED");
    assert(bookingA.agreedAmount === 105000 && bookingA.agreementSource === "OFFER" && bookingA.agreedOfferId === o2.id && bookingA.transporterId === james.user.id && bookingA.status === "Accepted", JSON.stringify(bookingA));
    const l = await loadRow(L1.id);
    assert(l.status === "Booked" && l.price === 100000, `load ${JSON.stringify(l)}`);
    assert(count("SELECT COUNT(*) n FROM payment_events WHERE entity_id IN (?, ?) AND event_type IN ('offer_accepted','booking_created')", o2.id, bookingA.id) === 2, "audit rows missing");
    const again = await act(james, o2.id, "accept");
    assert(again.status === 409 && again.json.code === "OFFER_NOT_PENDING", `double accept got ${again.status}`);
    assert(count("SELECT COUNT(*) n FROM bookings WHERE load_id = ?", L1.id) === 1, "double booking");
    const lateOffer = await offer(daniel, L1.id, 100000);
    assert(lateOffer.status === 409 && lateOffer.json.code === "LOAD_NOT_OPEN", `offer on a booked load got ${lateOffer.status}`);
  });

  await test("11. competing PENDING offers from other transporters are REJECTED with COMPETING_OFFER_ACCEPTED", async () => {
    const L = await newLoad(100000);
    const oj = (await offer(james, L.id, 100000)).json;
    const od = (await offer(daniel, L.id, 98000)).json;
    const oc = (await offer(carol, L.id, 97000)).json;
    const r = await act(shipper, oj.id, "accept");
    assert(r.status === 201, `accept got ${r.status}`);
    const rows = await threadOf(shipper, L.id);
    for (const id of [od.id, oc.id]) {
      const o = rows.find(x => x.id === id);
      assert(o.status === "REJECTED" && o.closeReason === "COMPETING_OFFER_ACCEPTED", `${id}: ${JSON.stringify(o)}`);
    }
    assert(rows.filter(o => o.status === "ACCEPTED").length === 1, "exactly one ACCEPTED");
    const lose = await act(shipper, od.id, "accept");
    assert(lose.status === 409, `late accept got ${lose.status}`);
    const n = (await api(daniel.token, "GET", "/api/notifications")).json.find(x => x.type === "offer_rejected" && x.relatedEntityId === od.id);
    assert(n, "loser not notified");
  });

  await test("12. race: two shipper accepts for two different offers → exactly one booking, one ACCEPTED, loser 409, nothing partial", async () => {
    const L = await newLoad(100000);
    const oj = (await offer(james, L.id, 100000)).json;
    const od = (await offer(daniel, L.id, 99000)).json;
    const [a, b] = await Promise.all([act(shipper, oj.id, "accept"), act(shipper, od.id, "accept")]);
    const statuses = [a.status, b.status].sort();
    assert(statuses[0] === 201 && statuses[1] === 409, `statuses ${statuses}`);
    assert(count("SELECT COUNT(*) n FROM bookings WHERE load_id = ?", L.id) === 1, "booking count");
    assert(count("SELECT COUNT(*) n FROM offers WHERE load_id = ? AND status = 'ACCEPTED'", L.id) === 1, "accepted count");
    assert(count("SELECT COUNT(*) n FROM offers WHERE load_id = ? AND status = 'PENDING'", L.id) === 0, "pending left over");
    const winner = a.status === 201 ? a.json : b.json;
    const bk = rawDb().prepare("SELECT * FROM bookings WHERE load_id = ?").get(L.id);
    assert(bk.agreed_offer_id === winner.offer.id && bk.agreed_amount === winner.offer.amount, "booking does not match the winning offer");
    // same offer double-clicked in parallel
    const L2 = await newLoad(100000);
    const o = (await offer(james, L2.id, 100000)).json;
    const [c, d] = await Promise.all([act(shipper, o.id, "accept"), act(shipper, o.id, "accept")]);
    assert([c.status, d.status].sort().join() === "201,409", `double-click ${c.status},${d.status}`);
    assert(count("SELECT COUNT(*) n FROM bookings WHERE load_id = ?", L2.id) === 1, "double-click booking count");
  });

  await test("13. race: transporter posted-price accept vs shipper offer accept → exactly one booking", async () => {
    for (let i = 0; i < 3; i++) {
      const L = await newLoad(100000);
      const od = (await offer(daniel, L.id, 90000)).json;
      const [a, b] = await Promise.all([api(james.token, "POST", `/api/loads/${L.id}/accept`, {}), act(shipper, od.id, "accept")]);
      assert([a.status, b.status].sort().join() === "201,409", `round ${i}: ${a.status},${b.status}`);
      assert(count("SELECT COUNT(*) n FROM bookings WHERE load_id = ?", L.id) === 1, `round ${i}: booking count`);
      const bk = rawDb().prepare("SELECT * FROM bookings WHERE load_id = ?").get(L.id);
      if (a.status === 201) assert(bk.agreed_amount === 100000 && bk.agreement_source === "POSTED_PRICE", "posted-price winner snapshot");
      else assert(bk.agreed_amount === 90000 && bk.agreement_source === "OFFER", "offer winner snapshot");
      assert(count("SELECT COUNT(*) n FROM offers WHERE load_id = ? AND status = 'PENDING'", L.id) === 0, "pending left over");
    }
  });

  await test("15. posted-price accept: agreedAmount = loads.price, source POSTED_PRICE, pending offers rejected", async () => {
    const L = await newLoad(80000);
    const od = (await offer(daniel, L.id, 70000)).json;
    const r = await api(james.token, "POST", `/api/loads/${L.id}/accept`, {});
    assert(r.status === 201, `got ${r.status} ${JSON.stringify(r.json)}`);
    assert(r.json.agreedAmount === 80000 && r.json.agreementSource === "POSTED_PRICE" && r.json.agreedOfferId === null && r.json.transporterId === james.user.id, JSON.stringify(r.json));
    const o = (await threadOf(shipper, L.id)).find(x => x.id === od.id);
    assert(o.status === "REJECTED" && o.closeReason === "ACCEPTED_AT_POSTED_PRICE", JSON.stringify(o));
    const again = await api(daniel.token, "POST", `/api/loads/${L.id}/accept`, {});
    assert(again.status === 409 && again.json.code === "LOAD_NOT_OPEN", `second accept got ${again.status} ${JSON.stringify(again.json)}`);
    assert((await api(shipper.token, "POST", `/api/loads/${L.id}/accept`, {})).status === 403, "shipper accepted a load");
    assert((await api(driver.token, "POST", `/api/loads/${L.id}/accept`, {})).status === 403, "driver accepted a load");
  });

  await test("16. null-price load: posted-price accept → 409 NO_POSTED_PRICE; the offer route works", async () => {
    const L = await newLoad();
    const r = await api(james.token, "POST", `/api/loads/${L.id}/accept`, {});
    assert(r.status === 409 && r.json.code === "NO_POSTED_PRICE", `got ${r.status} ${JSON.stringify(r.json)}`);
    assert((await loadRow(L.id)).status === "Open", "load should stay Open");
    assert(count("SELECT COUNT(*) n FROM bookings WHERE load_id = ?", L.id) === 0, "no booking should exist");
    const o = (await offer(james, L.id, 50000)).json;
    const a = await act(shipper, o.id, "accept");
    assert(a.status === 201 && a.json.booking.agreedAmount === 50000 && a.json.booking.agreementSource === "OFFER", JSON.stringify(a.json));
  });

  await test("19. no stored road distance: posted-price accept AND offer accept → 409 ROAD_DISTANCE_REQUIRED, nothing committed", async () => {
    const L = await newLoad(80000, shipper, { noRoute: true });
    const a1 = await api(james.token, "POST", `/api/loads/${L.id}/accept`, {});
    assert(a1.status === 409 && a1.json.code === "ROAD_DISTANCE_REQUIRED", `posted-price: ${a1.status} ${JSON.stringify(a1.json)}`);
    const o = (await offer(james, L.id, 75000)).json;
    const a2 = await act(shipper, o.id, "accept");
    assert(a2.status === 409 && a2.json.code === "ROAD_DISTANCE_REQUIRED", `offer: ${a2.status} ${JSON.stringify(a2.json)}`);
    assert((await loadRow(L.id)).status === "Open", "load should stay Open");
    assert(count("SELECT COUNT(*) n FROM bookings WHERE load_id = ?", L.id) === 0, "no booking should exist");
    assert(count("SELECT COUNT(*) n FROM offers WHERE id = ? AND status = 'PENDING'", o.id) === 1, "offer must stay PENDING");
  });

  await test("idempotency: same Idempotency-Key replays (200 + header); reuse on another load → 409; counter replay", async () => {
    const L = await newLoad(100000);
    const key = `k-${Date.now()}`;
    const a = await offer(james, L.id, 100000, {}, { "Idempotency-Key": key });
    const b = await offer(james, L.id, 100000, {}, { "Idempotency-Key": key });
    assert(a.status === 201 && b.status === 200 && b.headers.get("idempotent-replay") === "true" && a.json.id === b.json.id, `a=${a.status} b=${b.status}`);
    assert((await threadOf(shipper, L.id)).length === 1, "replay created a second row");
    const L2 = await newLoad(100000);
    const c = await offer(james, L2.id, 100000, {}, { "Idempotency-Key": key });
    assert(c.status === 409 && c.json.code === "IDEMPOTENCY_KEY_REUSED", `reuse got ${c.status} ${JSON.stringify(c.json)}`);
    const ck = `c-${Date.now()}`;
    const c1 = await api(shipper.token, "POST", `/api/offers/${a.json.id}/counter`, { amount: 95000 }, { "Idempotency-Key": ck });
    const c2 = await api(shipper.token, "POST", `/api/offers/${a.json.id}/counter`, { amount: 95000 }, { "Idempotency-Key": ck });
    assert(c1.status === 201 && c2.status === 200 && c1.json.id === c2.json.id, `counter replay ${c1.status},${c2.status}`);
    assert((await offer(james, L2.id, 100000, {}, { "Idempotency-Key": "bad key with spaces" })).status === 400, "bad key accepted");
    // double-click counter without a key: second sees the parent COUNTERED
    const L3 = await newLoad(100000);
    const o = (await offer(james, L3.id, 100000)).json;
    const [x, y] = await Promise.all([act(shipper, o.id, "counter", { amount: 90000 }), act(shipper, o.id, "counter", { amount: 91000 })]);
    assert([x.status, y.status].sort().join() === "201,409", `parallel counter ${x.status},${y.status}`);
    assert((await threadOf(shipper, L3.id)).length === 2, "parallel counter created extra rows");
  });

  await test("inbox: GET /api/offers filters by role/status, scoped to the caller", async () => {
    const L = await newLoad(100000);
    const o = (await offer(james, L.id, 100000)).json;
    const sIn = (await api(shipper.token, "GET", "/api/offers?role=counterparty&status=PENDING")).json.offers;
    assert(sIn.some(x => x.id === o.id && x.needsMyAction === true), "shipper inbox missing the offer");
    const jOut = (await api(james.token, "GET", "/api/offers?role=proposer&status=PENDING")).json.offers;
    assert(jOut.some(x => x.id === o.id && x.mine === true && x.needsMyAction === false), "transporter outbox missing the offer");
    assert(!(await api(daniel.token, "GET", "/api/offers")).json.offers.some(x => x.id === o.id), "other transporter saw the offer");
    assert(!(await api(mary.token, "GET", "/api/offers")).json.offers.some(x => x.id === o.id), "other shipper saw the offer");
    assert((await api(james.token, "GET", "/api/offers?role=bogus")).status === 400, "bad role filter");
    assert((await api(james.token, "GET", "/api/offers?status=bogus")).status === 400, "bad status filter");
    assert((await api(driver.token, "GET", "/api/offers")).status === 403, "driver inbox");
  });

  // ── C. Initial payment and escrow ────────────────────────────────────
  let paymentA;
  await test("17. initial STK amount = agreedAmount (105,000), not loads.price; body amount ignored; purpose INITIAL", async () => {
    const r = await api(shipper.token, "POST", `/api/bookings/${bookingA.id}/payment`, { phoneNumber: "254700111222", amount: 1 });
    assert(r.status === 201, `got ${r.status} ${JSON.stringify(r.json)}`);
    paymentA = r.json;
    assert(paymentA.amount === 105000 && paymentA.purpose === "INITIAL", JSON.stringify(paymentA));
    const other = await api(mary.token, "POST", `/api/bookings/${bookingA.id}/payment`, { phoneNumber: "254700111222" });
    assert(other.status === 403, `other shipper got ${other.status}`);
  });

  await test("18. callback confirms → payment Paid, escrow Held with amount 105,000; loads.price and agreed amount unchanged", async () => {
    const paid = await waitFor(async () => {
      const p = (await api(shipper.token, "GET", `/api/payments/${paymentA.id}`)).json;
      return p.status !== "StkSent" && p.status !== "Pending" ? p : null;
    });
    assert(paid.status === "Paid" && paid.amount === 105000, JSON.stringify(paid));
    const escrow = (await api(admin.token, "GET", `/api/escrows?bookingId=${bookingA.id}`)).json[0];
    assert(escrow && escrow.status === "Held" && escrow.amount === 105000, JSON.stringify(escrow));
    assert((await loadRow(L1.id)).price === 100000, "loads.price drifted");
    const bk = rawDb().prepare("SELECT agreed_amount FROM bookings WHERE id = ?").get(bookingA.id);
    assert(bk.agreed_amount === 105000, "agreed amount drifted");
  });

  await test("17b. booking with no agreed amount → 409 NO_AGREED_AMOUNT, no payment row", async () => {
    const db = rawDb();
    const L = await newLoad(10000);
    const bk = (await api(james.token, "POST", `/api/loads/${L.id}/accept`, {})).json;
    db.prepare("DROP TRIGGER bookings_agreed_amount_immutable").run();
    db.prepare("UPDATE bookings SET agreed_amount = NULL WHERE id = ?").run(bk.id);
    db.prepare(`CREATE TRIGGER bookings_agreed_amount_immutable BEFORE UPDATE OF agreed_amount ON bookings
      FOR EACH ROW WHEN OLD.agreed_amount IS NOT NULL AND NEW.agreed_amount IS NOT OLD.agreed_amount
      BEGIN SELECT RAISE(ABORT, 'bookings.agreed_amount is immutable'); END`).run();
    db.close();
    const r = await api(shipper.token, "POST", `/api/bookings/${bk.id}/payment`, { phoneNumber: "254700111222" });
    assert(r.status === 409 && r.json.code === "NO_AGREED_AMOUNT", `got ${r.status} ${JSON.stringify(r.json)}`);
    assert(count("SELECT COUNT(*) n FROM payments WHERE booking_id = ?", bk.id) === 0, "payment row created");
  });

  await test("14. direct SQL tampering with agreed_amount / price / payment amount / offer amount aborts via triggers", async () => {
    const db = rawDb();
    const tamper = (sql, ...a) => { try { db.prepare(sql).run(...a); return null; } catch (e) { return e.message; } };
    let m;
    m = tamper("UPDATE bookings SET agreed_amount = 1 WHERE id = ?", bookingA.id);
    assert(m && /immutable/.test(m), `bookings: ${m}`);
    m = tamper("UPDATE loads SET price = 1 WHERE id = ?", L1.id);
    assert(m && /immutable/.test(m), `loads: ${m}`);
    m = tamper("UPDATE payments SET amount = 1 WHERE id = ?", paymentA.id);
    assert(m && /immutable/.test(m), `payments: ${m}`);
    m = tamper("UPDATE offers SET amount = 1 WHERE id = ?", o1.id);
    assert(m && /immutable/.test(m), `offers: ${m}`);
    assert(tamper("UPDATE loads SET price = price WHERE id = ?", L1.id) === null, "no-op price update should be allowed");
    assert(tamper("UPDATE loads SET status = status WHERE id = ?", L1.id) === null, "status update should be allowed");
    const row = db.prepare("SELECT (SELECT agreed_amount FROM bookings WHERE id=?) a, (SELECT price FROM loads WHERE id=?) p, (SELECT amount FROM payments WHERE id=?) m").get(bookingA.id, L1.id, paymentA.id);
    assert(row.a === 105000 && row.p === 100000 && row.m === 105000, JSON.stringify(row));
    db.close();
  });

  await test("release guard: escrow whose amount disagrees with confirmed funding is flagged and not released", async () => {
    const { computeLedger } = await import("../src/domain/ledger.js");
    const { evaluateReleaseEligibility } = await import("../src/domain/escrow.js");
    const booking = { agreedAmount: 105000, id: "B" };
    const pays = [{ purpose: "INITIAL", status: "Paid", amount: 105000 }];
    const good = computeLedger({ booking, payments: pays, escrow: { amount: 105000 } });
    assert(good.totalObligation === 105000 && good.confirmedFunding === 105000 && good.outstanding === 0 && good.escrowMatchesFunding === true, JSON.stringify(good));
    const bad = computeLedger({ booking, payments: pays, escrow: { amount: 99999 } });
    assert(bad.escrowMatchesFunding === false, "mismatch not detected");
    const trip = { status: "Delivered" };
    const esc = { status: "Held", amount: 99999, bookingId: "B" };
    const d = evaluateReleaseEligibility({ trip, booking, escrow: esc, ledger: bad });
    assert(d.eligible === false && d.mismatch === true, JSON.stringify(d));
    const ok = evaluateReleaseEligibility({ trip, booking, escrow: { ...esc, amount: 105000 }, ledger: good });
    assert(ok.eligible === true, JSON.stringify(ok));
    const unpriced = computeLedger({ booking: { agreedAmount: null }, payments: [], escrow: null });
    assert(unpriced.totalObligation === null, "null agreed amount must not produce an obligation");
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error("SUITE CRASHED:", e); process.exit(2); });

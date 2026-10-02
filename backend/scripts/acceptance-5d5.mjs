// Phase 5D-5 acceptance — frontend-facing adjustment contract: allowance, both-party ledger view, withdraw rules, payment never takes an amount.
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
async function login(phone, role) {
  const { status, json } = await api(null, "POST", "/api/auth/login", { phone, pin: "1234", role });
  assert(status === 200, `login ${phone}/${role} failed: ${JSON.stringify(json)}`);
  return json;
}
async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(60);
  }
}
const rawDb = () => new Database(DB_PATH);
const row = (sql, ...a) => { const d = rawDb(); const r = d.prepare(sql).get(...a); d.close(); return r; };
const rows = (sql, ...a) => { const d = rawDb(); const r = d.prepare(sql).all(...a); d.close(); return r; };
function rawExec(sql, ...a) {
  const d = rawDb();
  try { d.prepare(sql).run(...a); return null; } catch (e) { return e.message; } finally { d.close(); }
}

let shipper, mary, james, daniel, admin, peter;
let truckId, driverId;

async function setup() {
  shipper = await login("0700000001", "shipper");
  mary    = await login("0700000003", "shipper");
  james   = await login("0722100200", "fleet_owner");
  daniel  = await login("0711000000", "fleet_owner");
  admin   = await login("0700000002", "admin");
  peter   = await login("0733222333", "driver");
  truckId  = (await api(james.token, "GET", "/api/trucks")).json.find(t => t.plate === "KBD 092K").id;
  driverId = (await api(james.token, "GET", "/api/drivers")).json.find(d => d.name === "Peter Otieno").id;
}
function repairPeter() {
  const d = rawDb();
  d.prepare("UPDATE trucks SET current_driver_id = ?, status = 'Assigned' WHERE id = ?").run(driverId, truckId);
  d.prepare("UPDATE drivers SET assigned_truck_id = ?, status = 'Assigned' WHERE id = ?").run(truckId, driverId);
  // Earlier scenarios leave their trips active; free the truck so each scenario starts clean.
  d.prepare("UPDATE trips SET status = 'Cancelled' WHERE truck_id = ? AND status NOT IN ('Delivered', 'Cancelled')").run(truckId);
  d.close();
}

/**
 * Posts a load at `price`; if `agreed` differs, the transporter offers `agreed` and the shipper accepts
 * (booking.agreedAmount = agreed, loads.price stays `price`). Then assign + create-trip, and optionally fund.
 */
async function booked({ price = 100000, agreed = price, fund = true } = {}) {
  repairPeter();
  const load = (await api(shipper.token, "POST", "/api/loads", { cargo: "5D-2 cargo", origin: "Nairobi", destination: "Nakuru", price, ...NBO_NKU })).json;
  let booking;
  if (agreed === price) {
    const a = await api(james.token, "POST", `/api/loads/${load.id}/accept`, {});
    assert(a.status === 201 || a.status === 200, `accept failed ${JSON.stringify(a.json)}`);
    booking = a.json;
  } else {
    const o = await api(james.token, "POST", `/api/loads/${load.id}/offers`, { amount: agreed });
    assert(o.status === 201, `offer failed ${JSON.stringify(o.json)}`);
    const a = await api(shipper.token, "POST", `/api/offers/${o.json.id}/accept`, {});
    assert(a.status === 201, `offer accept failed ${JSON.stringify(a.json)}`);
    booking = a.json.booking;
  }
  assert(booking.agreedAmount === agreed, `agreedAmount ${booking.agreedAmount} != ${agreed}`);
  const asg = await api(james.token, "POST", `/api/bookings/${booking.id}/assign`, { truckId, driverId });
  assert(asg.status === 200, `assign failed ${JSON.stringify(asg.json)}`);
  if (!fund) return { load, booking: asg.json, trip: null }; // 5D-4: no trip without funding
  await pay(booking.id);
  const ct = await api(james.token, "POST", `/api/bookings/${booking.id}/create-trip`, {});
  assert(ct.status === 201, `create-trip failed ${JSON.stringify(ct.json)}`);
  return { load, booking: asg.json, trip: ct.json };
}
async function pay(bookingId, opts = {}) {
  const r = await api(shipper.token, "POST", `/api/bookings/${bookingId}/payment`, { phoneNumber: "254700111222", ...opts });
  assert(r.status === 201, `payment failed ${JSON.stringify(r.json)}`);
  return waitFor(async () => { const p = (await api(shipper.token, "GET", `/api/payments/${r.json.id}`)).json; return p.status !== "StkSent" ? p : null; });
}
async function payAdj(adjId, opts = {}, who = shipper) {
  return api(who.token, "POST", `/api/adjustments/${adjId}/payment`, { phoneNumber: "254700111222", ...opts });
}
async function waitAdjStatus(adjId, status) {
  return waitFor(async () => { const a = (await api(shipper.token, "GET", `/api/adjustments/${adjId}`)).json; return a.status === status ? a : null; });
}
async function deliver(tripId) {
  for (const status of ["Dispatched", "At Pickup", "Loading", "In Transit", "At Delivery"]) {
    const r = await api(peter.token, "POST", `/api/trips/${tripId}/status`, { status });
    assert(r.status === 200, `driver to ${status} failed ${JSON.stringify(r.json)}`);
  }
  const r = await api(shipper.token, "POST", `/api/trips/${tripId}/status`, { status: "Delivered" });
  assert(r.status === 200, `Delivered failed ${JSON.stringify(r.json)}`);
}
const propose = (who, bookingId, amount, reason = "Extra waiting time at the pickup yard", extra = {}) =>
  api(who.token, "POST", `/api/bookings/${bookingId}/adjustments`, { amount, reason, reasonCode: "WAITING_TIME", ...extra });
const decide = (who, id, verb, body) => api(who.token, "POST", `/api/adjustments/${id}/${verb}`, body ?? {});
const ledger = async (who, bookingId) => (await api(who.token, "GET", `/api/bookings/${bookingId}/ledger`)).json;
const escrowOf = async (bookingId) => (await api(admin.token, "GET", `/api/escrows?bookingId=${bookingId}`)).json[0];
async function fundedAdjustment(bookingId, amount) {
  const p = await propose(james, bookingId, amount);
  assert(p.status === 201, `propose ${amount} failed ${JSON.stringify(p.json)}`);
  assert((await decide(shipper, p.json.id, "approve")).status === 200, "approve failed");
  const pr = await payAdj(p.json.id);
  assert(pr.status === 201, `adj payment failed ${JSON.stringify(pr.json)}`);
  await waitAdjStatus(p.json.id, "FUNDED");
  return p.json;
}


async function main() {
  await setup();
  const { load, booking } = await booked({ price: 100000, agreed: 105000 });

  await test("1. ledger exposes backend-computed allowance (25% of 105,000 = 26,250), visible to both parties", async () => {
    for (const who of [shipper, james]) {
      const l = await ledger(who, booking.id);
      assert(l.allowance && l.allowance.max === 26250 && l.allowance.used === 0 && l.allowance.remaining === 26250 && l.allowance.capPct === 25, JSON.stringify(l.allowance));
      assert(l.totalObligation === 105000 && l.confirmedFunding === 105000 && l.outstanding === 0, "baseline ledger");
    }
  });

  let adj;
  await test("2. transporter proposes +10,000; shipper sees it PROPOSED; obligation unchanged until approval", async () => {
    const p = await propose(james, booking.id, 10000);
    assert(p.status === 201 && p.json.status === "PROPOSED", JSON.stringify(p.json));
    adj = p.json;
    const list = (await api(shipper.token, "GET", `/api/bookings/${booking.id}/adjustments`)).json;
    assert(list.some(a => a.id === adj.id && a.status === "PROPOSED"), "shipper cannot see proposal");
    assert((await ledger(shipper, booking.id)).totalObligation === 105000, "proposal must not change obligation");
  });

  await test("3. a second open adjustment is rejected (ADJUSTMENT_ALREADY_OPEN)", async () => {
    const r = await propose(james, booking.id, 1000);
    assert(r.status === 409 && r.json.code === "ADJUSTMENT_ALREADY_OPEN", JSON.stringify(r.json));
  });

  await test("4. approve with a body amount is refused (ADJUSTMENT_IMMUTABLE)", async () => {
    const r = await decide(shipper, adj.id, "approve", { amount: 1 });
    assert(r.status >= 400 && r.json.code === "ADJUSTMENT_IMMUTABLE", JSON.stringify(r.json));
  });

  await test("5. approve -> both parties see 115,000 obligation / 105,000 funded / 10,000 outstanding", async () => {
    assert((await decide(shipper, adj.id, "approve")).status === 200, "approve failed");
    for (const who of [shipper, james]) {
      const l = await ledger(who, booking.id);
      assert(l.totalObligation === 115000 && l.confirmedFunding === 105000 && l.outstanding === 10000 && l.approvedAdjustments === 10000, JSON.stringify(l));
      assert(l.allowance.used === 10000 && l.allowance.remaining === 16250, JSON.stringify(l.allowance));
    }
  });

  await test("6. APPROVED adjustment cannot be withdrawn", async () => {
    const r = await decide(james, adj.id, "withdraw");
    assert(r.status === 409, JSON.stringify(r.json));
  });

  await test("7. adjustment payment rejects a non-Kenyan phone (INVALID_PHONE) and ignores any body amount", async () => {
    const bad = await payAdj(adj.id, { phoneNumber: "12345" });
    assert(bad.status === 400 && bad.json.code === "INVALID_PHONE", JSON.stringify(bad.json));
    const r = await payAdj(adj.id, { amount: 1 });
    assert(r.status === 201 && r.json.amount === 10000, `payable amount must come from the ledger: ${JSON.stringify(r.json)}`);
    await waitAdjStatus(adj.id, "FUNDED");
  });

  await test("8. FUNDED: 115,000 / 115,000, escrow HELD 115,000, agreedAmount 105000 and load.price 100000 unchanged", async () => {
    for (const who of [shipper, james]) {
      const l = await ledger(who, booking.id);
      assert(l.totalObligation === 115000 && l.confirmedFunding === 115000 && l.outstanding === 0 && l.escrowAmount === 115000, JSON.stringify(l));
    }
    assert(row("SELECT agreed_amount a FROM bookings WHERE id = ?", booking.id).a === 105000, "agreedAmount changed");
    assert(row("SELECT price p FROM loads WHERE id = ?", load.id).p === 100000, "load.price changed");
    assert((await escrowOf(booking.id)).status === "Held", "escrow not held");
  });

  await test("9. FUNDED adjustment cannot be withdrawn or re-decided", async () => {
    assert((await decide(james, adj.id, "withdraw")).status === 409, "withdraw FUNDED");
    assert((await decide(shipper, adj.id, "reject")).status === 409, "reject FUNDED");
  });

  await test("10. cap enforced by the backend: remaining 16,250 -> 16,251 refused, 16,250 accepted; PROPOSED can be withdrawn", async () => {
    const over = await propose(james, booking.id, 16251);
    assert(over.status === 422 && over.json.code === "ADJUSTMENT_CAP_EXCEEDED", JSON.stringify(over.json));
    const ok = await propose(james, booking.id, 16250);
    assert(ok.status === 201, JSON.stringify(ok.json));
    const w = await decide(james, ok.json.id, "withdraw");
    assert(w.status === 200 && w.json.status === "WITHDRAWN", JSON.stringify(w.json));
    assert((await ledger(shipper, booking.id)).totalObligation === 115000, "withdrawn must not change obligation");
  });

  await test("11. reject path: PROPOSED -> REJECTED, obligation unchanged, a new request is then allowed", async () => {
    const p = await propose(james, booking.id, 2000);
    assert(p.status === 201, JSON.stringify(p.json));
    const r = await decide(shipper, p.json.id, "reject");
    assert(r.status === 200 && r.json.status === "REJECTED", JSON.stringify(r.json));
    assert((await ledger(james, booking.id)).totalObligation === 115000, "rejected must not change obligation");
    assert((await propose(james, booking.id, 2000)).status === 201, "new request after reject");
  });

  await test("12. only the shipper can approve/pay; only the transporter can propose/withdraw", async () => {
    const open = (await api(shipper.token, "GET", `/api/bookings/${booking.id}/adjustments`)).json.find(a => a.status === "PROPOSED");
    assert((await decide(james, open.id, "approve")).status === 403, "transporter approve");
    assert((await decide(shipper, open.id, "withdraw")).status === 403, "shipper withdraw");
    assert((await propose(shipper, booking.id, 100)).status === 403, "shipper propose");
    assert((await decide(mary, open.id, "approve")).status === 403, "other shipper approve");
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — FAILED: " + failed.map(f => f.name).join("; ") : "."}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });

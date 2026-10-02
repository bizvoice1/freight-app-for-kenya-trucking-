// Phase 5D-2 acceptance — Adjustment Ledger Foundation. Real HTTP against a freshly migrated +
// seeded backend on :4000, plus direct SQLite access to prove the database-level backstops.
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

  let A, adjA;
  await test("1. adjustment is based on booking.agreedAmount (105,000), never load.price (100,000)", async () => {
    A = await booked({ price: 100000, agreed: 105000 });
    // 25% of 105,000 = 26,250. 26,000 exceeds 25% of load.price (25,000) yet must be allowed.
    const over = await propose(james, A.booking.id, 26251);
    assert(over.status === 422 && over.json.code === "ADJUSTMENT_CAP_EXCEEDED", `26,251 got ${over.status} ${JSON.stringify(over.json)}`);
    const ok = await propose(james, A.booking.id, 26000);
    assert(ok.status === 201, `26,000 got ${ok.status} ${JSON.stringify(ok.json)}`);
    adjA = ok.json;
    assert(adjA.agreedAmountSnapshot === 105000, "snapshot is not agreedAmount");
    const load = (await api(shipper.token, "GET", `/api/loads/${A.load.id}`)).json;
    assert(load.price === 100000, "load.price changed");
  });

  await test("2. creation snapshots amount, reason, agreed amount and cap", async () => {
    assert(adjA.id.startsWith("ADJ-") && adjA.status === "PROPOSED", JSON.stringify(adjA));
    assert(adjA.amount === 26000 && adjA.reason === "Extra waiting time at the pickup yard", "amount/reason");
    assert(adjA.agreedAmountSnapshot === 105000 && adjA.capSnapshotPct === 25, `snapshots ${adjA.agreedAmountSnapshot}/${adjA.capSnapshotPct}`);
    assert(adjA.requestedById === james.user.id && adjA.bookingId === A.booking.id && adjA.approvalExpiresAt, "shape");
    assert(row("SELECT COUNT(*) n FROM payment_events WHERE entity_id = ? AND event_type = 'adjustment_proposed'", adjA.id).n === 1, "audit row missing");
  });

  await test("3. commercial fields cannot later change (API and raw SQL)", async () => {
    for (const col of ["amount = 1", "reason = 'a different reason entirely'", "agreed_amount_snapshot = 1", "cap_snapshot_pct = 90", "booking_id = 'BKG-0000'", "reason_code = 'OTHER'"]) {
      const err = rawExec(`UPDATE adjustments SET ${col} WHERE id = ?`, adjA.id);
      assert(err && /ADJ_IMMUTABLE|ADJ_/.test(err), `UPDATE ${col} was not blocked: ${err}`);
    }
    const a = (await api(shipper.token, "GET", `/api/adjustments/${adjA.id}`)).json;
    assert(a.amount === 26000 && a.reason === adjA.reason, "row changed");
  });

  await test("4. a second open adjustment on the same booking is rejected (API and raw SQL)", async () => {
    const r = await propose(james, A.booking.id, 1000);
    assert(r.status === 409 && r.json.code === "ADJUSTMENT_ALREADY_OPEN", `got ${r.status} ${JSON.stringify(r.json)}`);
    const err = rawExec(`INSERT INTO adjustments (id, booking_id, requested_by_id, amount, agreed_amount_snapshot, cap_snapshot_pct, reason_code, reason, status, source, approval_expires_at, created_at, updated_at)
      VALUES ('ADJ-RAW1', ?, ?, 1000, 105000, 25, 'OTHER', 'raw insert second open', 'PROPOSED', 'MANUAL', '2999-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, A.booking.id, james.user.id);
    assert(err && /UNIQUE|one_open/i.test(err), `raw second open not blocked: ${err}`);
  });

  await test("5. cumulative increases cannot exceed 25% (15,000 approved on 100,000 → another 15,000 fails)", async () => {
    const B = await booked({ price: 100000 });
    const first = await fundedAdjustment(B.booking.id, 15000);
    const second = await propose(james, B.booking.id, 15000);
    assert(second.status === 422 && second.json.code === "ADJUSTMENT_CAP_EXCEEDED", `got ${second.status} ${JSON.stringify(second.json)}`);
    // DB backstop: bypass the service entirely.
    const err = rawExec(`INSERT INTO adjustments (id, booking_id, requested_by_id, amount, agreed_amount_snapshot, cap_snapshot_pct, reason_code, reason, status, source, approval_expires_at, created_at, updated_at)
      VALUES ('ADJ-RAW2', ?, ?, 15000, 100000, 25, 'OTHER', 'raw insert over the cap', 'PROPOSED', 'MANUAL', '2999-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, B.booking.id, james.user.id);
    assert(err && /ADJ_CAP_EXCEEDED/.test(err), `raw over-cap insert not blocked: ${err}`);
    const fits = await propose(james, B.booking.id, 10000);
    assert(fits.status === 201, `exact remaining 10,000 got ${fits.status} ${JSON.stringify(fits.json)}`);
    assert(first.status === "PROPOSED", "returned row is the creation snapshot");
  });

  await test("6. unauthorized parties cannot request against another transporter's booking", async () => {
    const B = await booked({ price: 50000 });
    for (const [who, label] of [[daniel, "other transporter"], [shipper, "shipper"], [peter, "driver"], [admin, "admin"]]) {
      const r = await propose(who, B.booking.id, 1000);
      assert(r.status === 403, `${label} got ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert((await propose(james, "BKG-NOPE", 1000)).status === 404, "unknown booking should 404");
    assert(row("SELECT COUNT(*) n FROM adjustments WHERE booking_id = ?", B.booking.id).n === 0, "an adjustment was created");
    assert((await api(mary.token, "GET", `/api/bookings/${B.booking.id}/ledger`)).status === 403, "other shipper read the ledger");
    assert((await api(daniel.token, "GET", `/api/bookings/${B.booking.id}/adjustments`)).status === 403, "other transporter read adjustments");
  });

  await test("7. only the load's shipper approves/rejects; only the transporter withdraws", async () => {
    const B = await booked({ price: 60000 });
    const p = (await propose(james, B.booking.id, 3000)).json;
    for (const verb of ["approve", "reject"]) {
      for (const [who, label] of [[mary, "other shipper"], [james, "requesting transporter"], [daniel, "other transporter"], [admin, "admin"], [peter, "driver"]]) {
        const r = await decide(who, p.id, verb);
        assert(r.status === 403, `${label} ${verb} got ${r.status}`);
      }
    }
    assert((await decide(shipper, "ADJ-9999999", "approve")).status === 404, "unknown adjustment should 404");
    assert((await decide(shipper, p.id, "withdraw")).status === 403, "shipper withdraw should 403");
    assert((await decide(daniel, p.id, "withdraw")).status === 403, "other transporter withdraw should 403");
    const rej = await decide(shipper, p.id, "reject", { rejectReason: "too high" });
    assert(rej.status === 200 && rej.json.status === "REJECTED" && rej.json.rejectedAt, JSON.stringify(rej.json));
    assert((await decide(shipper, p.id, "approve")).status === 409, "approving a REJECTED adjustment should 409");
    const p2 = (await propose(james, B.booking.id, 3000)).json;
    assert(p2 && p2.id, "rejected adjustment should free the open slot");
    const wd = await decide(james, p2.id, "withdraw");
    assert(wd.status === 200 && wd.json.status === "WITHDRAWN", JSON.stringify(wd.json));
  });

  await test("8. approval cannot silently alter the amount", async () => {
    const B = await booked({ price: 80000 });
    const p = (await propose(james, B.booking.id, 4000)).json;
    for (const body of [{ amount: 9999 }, { reason: "changed" }, { agreedAmountSnapshot: 1 }]) {
      const r = await decide(shipper, p.id, "approve", body);
      assert(r.status === 400 && r.json.code === "ADJUSTMENT_IMMUTABLE", `body ${JSON.stringify(body)} got ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert((await api(shipper.token, "GET", `/api/adjustments/${p.id}`)).json.status === "PROPOSED", "state moved on rejected approve");
    const ok = await decide(shipper, p.id, "approve");
    assert(ok.status === 200 && ok.json.status === "APPROVED" && ok.json.amount === 4000 && ok.json.approvedAt && ok.json.fundingDueAt, JSON.stringify(ok.json));
    const bk = row("SELECT agreed_amount FROM bookings WHERE id = ?", B.booking.id);
    assert(bk.agreed_amount === 80000, "booking.agreedAmount changed");
    assert(row("SELECT price FROM loads WHERE id = ?", B.load.id).price === 80000, "load.price changed");
  });

  await test("9. no new adjustment after Delivered (API and raw SQL)", async () => {
    const B = await booked({ price: 70000 });
    await deliver(B.trip.id);
    const r = await propose(james, B.booking.id, 1000);
    assert(r.status === 409 && r.json.code === "ADJUSTMENT_AFTER_DELIVERY", `got ${r.status} ${JSON.stringify(r.json)}`);
    const err = rawExec(`INSERT INTO adjustments (id, booking_id, requested_by_id, amount, agreed_amount_snapshot, cap_snapshot_pct, reason_code, reason, status, source, approval_expires_at, created_at, updated_at)
      VALUES ('ADJ-RAW3', ?, ?, 1000, 70000, 25, 'OTHER', 'raw insert after delivery', 'PROPOSED', 'MANUAL', '2999-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, B.booking.id, james.user.id);
    assert(err && /ADJ_AFTER_DELIVERY/.test(err), `raw insert after delivery not blocked: ${err}`);
  });

  await test("10. a pending adjustment expires at delivery and no longer blocks settlement", async () => {
    const B = await booked({ price: 90000 });
    const p = (await propose(james, B.booking.id, 5000)).json;
    assert((await ledger(shipper, B.booking.id)).blockingAdjustments === 1, "PROPOSED should block before delivery");
    await deliver(B.trip.id);
    const a = (await api(shipper.token, "GET", `/api/adjustments/${p.id}`)).json;
    assert(a.status === "EXPIRED" && a.closeReason === "TRIP_DELIVERED" && a.expiredAt, JSON.stringify(a));
    const l = await ledger(shipper, B.booking.id);
    assert(l.blockingAdjustments === 0 && l.totalObligation === 90000 && l.approvedAdjustments === 0, JSON.stringify(l));
    const e = await waitFor(async () => { const x = await escrowOf(B.booking.id); return x.status === "ReleasePending" ? x : null; });
    assert(e.amount === 90000, "escrow amount");
    assert((await decide(shipper, p.id, "approve")).status === 409, "expired adjustment must not be approvable");
    assert(row("SELECT COUNT(*) n FROM payment_events WHERE entity_id = ? AND event_type = 'adjustment_expired'", p.id).n === 1, "expiry audit row");
  });

  await test("11. an approved adjustment survives delivery, blocks release, and funding it unblocks release", async () => {
    const B = await booked({ price: 100000 });
    const p = (await propose(james, B.booking.id, 10000)).json;
    await decide(shipper, p.id, "approve");
    await deliver(B.trip.id);
    assert((await api(shipper.token, "GET", `/api/adjustments/${p.id}`)).json.status === "APPROVED", "approved adjustment was expired");
    await sleep(200);
    assert((await escrowOf(B.booking.id)).status === "Held", "release became eligible while an approved adjustment is unpaid");
    const l = await ledger(shipper, B.booking.id);
    assert(l.totalObligation === 110000 && l.outstanding === 10000 && l.blockingAdjustments === 1, JSON.stringify(l));
    assert((await payAdj(p.id)).status === 201, "paying an approved adjustment after delivery should work");
    await waitAdjStatus(p.id, "FUNDED");
    const e = await waitFor(async () => { const x = await escrowOf(B.booking.id); return x.status === "ReleasePending" ? x : null; });
    assert(e.amount === 110000, `escrow amount ${e.amount}`);
  });

  await test("11b. an in-flight (FUNDING) adjustment survives delivery; a failed attempt returns to APPROVED and stays payable", async () => {
    const B = await booked({ price: 100000 });
    const p = (await propose(james, B.booking.id, 8000)).json;
    await decide(shipper, p.id, "approve");
    const pr = await payAdj(p.id, { testDelayMs: 1500 });
    assert(pr.status === 201, JSON.stringify(pr.json));
    assert((await api(shipper.token, "GET", `/api/adjustments/${p.id}`)).json.status === "FUNDING", "not FUNDING");
    assert((await payAdj(p.id)).status === 409, "second payment on a FUNDING adjustment should 409");
    await deliver(B.trip.id);
    assert((await api(shipper.token, "GET", `/api/adjustments/${p.id}`)).json.status === "FUNDING", "FUNDING adjustment was expired by delivery");
    await waitAdjStatus(p.id, "FUNDED");

    const C = await booked({ price: 100000 });
    const q = (await propose(james, C.booking.id, 6000)).json;
    await decide(shipper, q.id, "approve");
    const failed = await payAdj(q.id, { testOutcome: "cancelled_by_user" });
    assert(failed.status === 201, JSON.stringify(failed.json));
    await waitAdjStatus(q.id, "APPROVED");
    assert(row("SELECT COUNT(*) n FROM payments WHERE adjustment_id = ? AND status = 'Cancelled'", q.id).n === 1, "cancelled attempt not recorded");
    assert((await escrowOf(C.booking.id)).amount === 100000, "escrow raised by a cancelled payment");
    await deliver(C.trip.id);
    await sleep(200);
    assert((await escrowOf(C.booking.id)).status === "Held", "should still be blocked");
    const wd = await decide(james, q.id, "withdraw");
    assert(wd.status === 409 && wd.json.code === "ADJUSTMENT_NOT_WITHDRAWABLE", `withdraw of APPROVED got ${wd.status}`);
    assert((await payAdj(q.id)).status === 201, "re-pay after failed attempt");
    await waitAdjStatus(q.id, "FUNDED");
    await waitFor(async () => (await escrowOf(C.booking.id)).status === "ReleasePending");
  });

  await test("11c. withdraw is PROPOSED-only: APPROVED, FUNDING and FUNDED adjustments cannot be withdrawn; obligation stays", async () => {
    const B = await booked({ price: 100000 });
    const p = (await propose(james, B.booking.id, 20000)).json;
    await decide(shipper, p.id, "approve");
    let w = await decide(james, p.id, "withdraw");
    assert(w.status === 409 && w.json.code === "ADJUSTMENT_NOT_WITHDRAWABLE", `APPROVED got ${w.status}`);
    let l = await ledger(shipper, B.booking.id);
    assert(l.totalObligation === 120000 && l.confirmedFunding === 100000 && l.outstanding === 20000 && l.blockingAdjustments === 1, JSON.stringify(l));
    await deliver(B.trip.id);
    await sleep(200);
    assert((await escrowOf(B.booking.id)).status === "Held", "release must not be eligible with a 20,000 shortfall");
    await payAdj(p.id, { testDelayMs: 1200 });
    w = await decide(james, p.id, "withdraw");
    assert(w.status === 409, `FUNDING got ${w.status}`);
    await waitAdjStatus(p.id, "FUNDED");
    w = await decide(james, p.id, "withdraw");
    assert(w.status === 409, `FUNDED got ${w.status}`);
    l = await ledger(shipper, B.booking.id);
    assert(l.totalObligation === 120000 && l.confirmedFunding === 120000 && l.outstanding === 0, JSON.stringify(l));
  });

  await test("12. the booking payment and the adjustment payment stay distinguishable", async () => {
    const B = await booked({ price: 100000 });
    const adj = await fundedAdjustment(B.booking.id, 7000);
    const pays = rows("SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at", B.booking.id);
    assert(pays.length === 2, `expected 2 payments, got ${pays.length}`);
    const init = pays.find(p => p.purpose === "INITIAL"), ad = pays.find(p => p.purpose === "ADJUSTMENT");
    assert(init && init.adjustment_id === null && init.amount === 100000 && init.status === "Paid", JSON.stringify(init));
    assert(ad && ad.adjustment_id === adj.id && ad.amount === 7000 && ad.status === "Paid", JSON.stringify(ad));
    assert(rows("SELECT id FROM escrows WHERE booking_id = ?", B.booking.id).length === 1, "adjustment payment created a second escrow");
    // Client-supplied amount is ignored for adjustment payments.
    const C = await booked({ price: 100000 });
    const p = (await propose(james, C.booking.id, 2000)).json;
    await decide(shipper, p.id, "approve");
    const r = await payAdj(p.id, { amount: 1 });
    assert(r.status === 201 && r.json.amount === 2000 && r.json.purpose === "ADJUSTMENT" && r.json.adjustmentId === p.id, JSON.stringify(r.json));
    // DB backstops on the pairing.
    const now = "2026-01-01T00:00:00Z";
    const e1 = rawExec(`INSERT INTO payments (id, booking_id, shipper_id, amount, phone_number, status, purpose, adjustment_id, created_at, updated_at) VALUES ('PAY-RAW1', ?, ?, 5, '254700000000', 'Failed', 'ADJUSTMENT', NULL, ?, ?)`, B.booking.id, shipper.user.id, now, now);
    assert(e1 && /PAY_PURPOSE_MISMATCH|PAY_ADJUSTMENT_INVALID/.test(e1), `ADJUSTMENT without adjustment_id not blocked: ${e1}`);
    const e2 = rawExec(`INSERT INTO payments (id, booking_id, shipper_id, amount, phone_number, status, purpose, adjustment_id, created_at, updated_at) VALUES ('PAY-RAW2', ?, ?, 5, '254700000000', 'Failed', 'INITIAL', ?, ?, ?)`, B.booking.id, shipper.user.id, adj.id, now, now);
    assert(e2 && /PAY_PURPOSE_MISMATCH/.test(e2), `INITIAL with adjustment_id not blocked: ${e2}`);
    const e3 = rawExec(`INSERT INTO payments (id, booking_id, shipper_id, amount, phone_number, status, purpose, adjustment_id, created_at, updated_at) VALUES ('PAY-RAW3', ?, ?, 5, '254700000000', 'Failed', 'ADJUSTMENT', ?, ?, ?)`, B.booking.id, shipper.user.id, adj.id, now, now);
    assert(e3 && /PAY_ADJUSTMENT_INVALID/.test(e3), `wrong-amount adjustment payment not blocked: ${e3}`);
    const e4 = rawExec(`UPDATE payments SET purpose = 'INITIAL', adjustment_id = NULL WHERE id = ?`, ad.id);
    assert(e4, "purpose rewrite was not blocked");
  });

  await test("13. ledger obligation = agreedAmount + qualifying adjustments, from persisted rows", async () => {
    const B = await booked({ price: 100000, agreed: 105000 });
    let l = await ledger(shipper, B.booking.id);
    assert(l.agreedAmount === 105000 && l.approvedAdjustments === 0 && l.totalObligation === 105000 && l.outstanding === 0 && l.confirmedFunding === 105000 && l.escrowAmount === 105000, JSON.stringify(l));
    const p = (await propose(james, B.booking.id, 10000)).json;
    l = await ledger(shipper, B.booking.id);
    assert(l.totalObligation === 105000 && l.proposedAdjustments === 10000 && l.blockingAdjustments === 1, `PROPOSED must not obligate: ${JSON.stringify(l)}`);
    await decide(shipper, p.id, "approve");
    l = await ledger(shipper, B.booking.id);
    assert(l.approvedAdjustments === 10000 && l.totalObligation === 115000 && l.outstanding === 10000 && l.confirmedFunding === 105000, JSON.stringify(l));
    await payAdj(p.id);
    await waitAdjStatus(p.id, "FUNDED");
    l = await ledger(shipper, B.booking.id);
    assert(l.totalObligation === 115000 && l.confirmedFunding === 115000 && l.outstanding === 0 && l.escrowAmount === 115000 && l.escrowMatchesFunding === true && l.blockingAdjustments === 0, JSON.stringify(l));
    for (const who of [james, admin]) assert(JSON.stringify(await ledger(who, B.booking.id)) === JSON.stringify(l), "viewer sees a different ledger");
    const bk = row("SELECT agreed_amount FROM bookings WHERE id = ?", B.booking.id);
    assert(bk.agreed_amount === 105000 && row("SELECT price FROM loads WHERE id = ?", B.load.id).price === 100000, "agreedAmount/load.price rewritten");
  });

  await test("15. concurrency: parallel creates → exactly one open adjustment; parallel approves → one transition", async () => {
    const B = await booked({ price: 100000 });
    const rs = await Promise.all([1000, 2000, 3000, 4000].map(a => propose(james, B.booking.id, a, `parallel request for ${a} shillings`)));
    const created = rs.filter(r => r.status === 201), conflicts = rs.filter(r => r.status === 409);
    assert(created.length === 1 && conflicts.length === 3, `statuses ${rs.map(r => r.status)}`);
    assert(row("SELECT COUNT(*) n FROM adjustments WHERE booking_id = ? AND status IN ('PROPOSED','APPROVED','FUNDING','DISPUTED')", B.booking.id).n === 1, "more than one open row");
    const id = created[0].json.id;
    const ap = await Promise.all([decide(shipper, id, "approve"), decide(shipper, id, "approve"), decide(shipper, id, "reject")]);
    assert(ap.filter(r => r.status === 200).length === 1, `exactly one decision must win: ${ap.map(r => r.status)}`);
    assert(row("SELECT COUNT(*) n FROM payment_events WHERE entity_id = ? AND event_type IN ('adjustment_approved','adjustment_rejected')", id).n === 1, "duplicate decision audit rows");
  });

  await test("16. preconditions and input validation (escrow held, positive amount, reason, no approve after delivery)", async () => {
    const unfunded = await booked({ price: 40000, fund: false });
    const r0 = await propose(james, unfunded.booking.id, 1000);
    assert(r0.status === 409 && r0.json.code === "ESCROW_NOT_HELD", `unfunded got ${r0.status} ${JSON.stringify(r0.json)}`);
    const B = await booked({ price: 40000 });
    for (const [amount, reason, label] of [[0, undefined, "zero"], [-500, undefined, "negative"], ["abc", undefined, "string"], [null, undefined, "null"], [1000, "short", "short reason"], [1000, "", "empty reason"]]) {
      const r = await api(james.token, "POST", `/api/bookings/${B.booking.id}/adjustments`, { amount, reason: reason ?? "A perfectly adequate reason", reasonCode: "OTHER", ...(reason !== undefined ? { reason } : {}) });
      assert(r.status === 400, `${label} got ${r.status} ${JSON.stringify(r.json)}`);
    }
    const x = await api(james.token, "POST", `/api/bookings/${B.booking.id}/adjustments`, { amount: 1000, reason: "Trying the reserved distance code", reasonCode: "EXTRA_DISTANCE" });
    assert(x.status === 400, `manual EXTRA_DISTANCE got ${x.status}`);
    // DB: once expired at delivery the row is terminal and cannot be re-opened even by raw SQL.
    const p = (await propose(james, B.booking.id, 2000)).json;
    await deliver(B.trip.id);
    const a = (await api(shipper.token, "GET", `/api/adjustments/${p.id}`)).json;
    assert(a.status === "EXPIRED", "setup: should have expired at delivery");
    const err2 = rawExec("UPDATE adjustments SET status = 'APPROVED' WHERE id = ?", p.id);
    assert(err2 && /ADJ_TERMINAL/.test(err2), `terminal status reopened: ${err2}`);
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { for (const f of failed) console.log(" -", f.name, "->", f.error); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });

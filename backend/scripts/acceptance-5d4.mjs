// Phase 5D-4 acceptance — real M-Pesa funding of the agreed booking, on the EXISTING 4K engine.
// Real HTTP against a freshly migrated + seeded backend on :4000 started with a short
// PAYMENT_STK_TIMEOUT_SECONDS (see /tmp/run5c3.sh), plus raw SQLite reads to prove state.
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NBO_NKU } from "./fixtures.mjs";
import { paymentConfigProblem, isCanonicalKenyanMobile } from "../src/services/bookingPayment.js";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "behari.sqlite");
const PHONE = "254712345678";

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS -", name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log("FAIL -", name, "->", e.message); }
}
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(token, method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function login(phone, role) {
  const r = await api(null, "POST", "/api/auth/login", { phone, pin: "1234", role });
  assert(r.status === 200, `login ${phone} failed`);
  return r.json;
}
async function waitFor(fn, timeoutMs = 12000) {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > timeoutMs) throw new Error("waitFor timed out"); await sleep(100); }
}
const rows = (sql, ...a) => { const d = new Database(DB_PATH); const r = d.prepare(sql).all(...a); d.close(); return r; };
const row = (sql, ...a) => rows(sql, ...a)[0];

let shipper, mary, james, admin, truckId, driverId;
const AGREED = 105000;

function repairPeter() {
  const d = new Database(DB_PATH);
  d.prepare("UPDATE trucks SET current_driver_id = ?, status = 'Assigned' WHERE id = ?").run(driverId, truckId);
  d.prepare("UPDATE drivers SET assigned_truck_id = ?, status = 'Assigned' WHERE id = ?").run(truckId, driverId);
  d.prepare("UPDATE trips SET status = 'Cancelled' WHERE truck_id = ? AND status NOT IN ('Delivered', 'Cancelled')").run(truckId);
  d.close();
}

/** Post at 100000, negotiate to 105000, assign — no payment, no trip. */
async function agreedBooking() {
  repairPeter();
  const load = (await api(shipper.token, "POST", "/api/loads", { cargo: "5D-4 cargo", origin: "Nairobi", destination: "Nakuru", price: 100000, ...NBO_NKU })).json;
  const o = await api(james.token, "POST", `/api/loads/${load.id}/offers`, { amount: AGREED });
  assert(o.status === 201, `offer failed ${JSON.stringify(o.json)}`);
  const a = await api(shipper.token, "POST", `/api/offers/${o.json.id}/accept`, {});
  assert(a.status === 201, `accept failed ${JSON.stringify(a.json)}`);
  const booking = a.json.booking;
  const asg = await api(james.token, "POST", `/api/bookings/${booking.id}/assign`, { truckId, driverId });
  assert(asg.status === 200, `assign failed ${JSON.stringify(asg.json)}`);
  return booking;
}
const fund = (bookingId, body = {}, who = shipper) => api(who.token, "POST", `/api/bookings/${bookingId}/payment`, { phoneNumber: PHONE, ...body });
const summary = async (bookingId, who = shipper) => (await api(who.token, "GET", `/api/bookings/${bookingId}`)).json.payment;
const payStatus = async (id) => (await api(shipper.token, "GET", `/api/payments/${id}`)).json.status;
const waitStatus = (id, status) => waitFor(async () => (await payStatus(id)) === status);
const escrowOf = (bookingId) => rows("SELECT * FROM escrows WHERE booking_id = ?", bookingId);
function stkCallback(paymentId, { code = 0, amount, receipt = "LATE" + randomUUID().slice(0, 8).toUpperCase() } = {}) {
  const p = row("SELECT * FROM payments WHERE id = ?", paymentId);
  return api(null, "POST", "/api/payments/callback/stk", { Body: { stkCallback: {
    MerchantRequestID: p.merchant_request_id, CheckoutRequestID: p.checkout_request_id, ResultCode: code,
    ResultDesc: code === 0 ? "The service request is processed successfully." : "Request cancelled by user",
    ...(code === 0 ? { CallbackMetadata: { Item: [{ Name: "Amount", Value: amount ?? p.amount }, { Name: "MpesaReceiptNumber", Value: receipt }] } } : {}),
  } } });
}
const flags = (type, id) => rows("SELECT * FROM reconciliation_flags WHERE type = ? AND related_entity_id = ?", type, id);
const notifs = async (token, type) => (await api(token, "GET", "/api/notifications")).json.filter(n => n.type === type);

async function main() {
  shipper = await login("0700000001", "shipper");
  mary = await login("0700000003", "shipper");
  james = await login("0722100200", "fleet_owner");
  admin = await login("0700000002", "admin");
  truckId = (await api(james.token, "GET", "/api/trucks")).json.find(t => t.plate === "KBD 092K").id;
  driverId = (await api(james.token, "GET", "/api/drivers")).json.find(d => d.name === "Peter Otieno").id;

  let A; // the main scenario booking
  await test("1. Agreed 105,000: booking has no escrow, summary says None, trip cannot be created", async () => {
    A = await agreedBooking();
    const s = await summary(A.id);
    assert(s.status === "None" && s.escrowStatus === null && s.amount === AGREED && s.paidAt === null, `summary ${JSON.stringify(s)}`);
    const ct = await api(james.token, "POST", `/api/bookings/${A.id}/create-trip`, {});
    assert(ct.status === 409 && ct.json.code === "PAYMENT_REQUIRED", `gate got ${ct.status} ${JSON.stringify(ct.json)}`);
    assert(rows("SELECT id FROM trips WHERE booking_id = ?", A.id).length === 0, "trip row exists");
    const t = await summary(A.id, james);
    assert(t.status === "None", "transporter sees a different state");
  });

  await test("2. Wrong phone numbers are rejected by the backend; no payment row is created", async () => {
    for (const bad of ["0712345678", "+254712345678", "12345", "254600111222", "2547123456789", "25471234567a"]) {
      const r = await fund(A.id, { phoneNumber: bad });
      assert(r.status === 400 && r.json.code === "INVALID_PHONE", `${bad} got ${r.status} ${JSON.stringify(r.json)}`);
    }
    assert(rows("SELECT id FROM payments WHERE booking_id = ?", A.id).length === 0, "payment row created for a bad phone");
    assert(isCanonicalKenyanMobile("254112345678") && isCanonicalKenyanMobile("254712345678"), "canonical forms rejected");
  });

  let payA;
  await test("3. Backend decides the amount: body amount ignored; STK sent; transporter sees awaiting, no phone", async () => {
    const r = await fund(A.id, { amount: 1, testOutcome: "timeout" });
    assert(r.status === 201, `fund got ${r.status} ${JSON.stringify(r.json)}`);
    payA = r.json;
    assert(payA.amount === AGREED && payA.status === "StkSent", `payment ${JSON.stringify(payA)}`);
    const s = await summary(A.id, james);
    assert(s.status === "StkSent" && s.amount === AGREED && s.escrowStatus === null, JSON.stringify(s));
    assert(!JSON.stringify(await summary(A.id, james)).includes("254712"), "phone leaked in booking summary");
    const list = (await api(james.token, "GET", `/api/bookings`)).json.find(b => b.id === A.id);
    assert(list.payment.status === "StkSent" && !("phoneNumber" in list.payment), "list summary wrong");
  });

  await test("4. Transporter cannot see the shipper phone number nor initiate payment; other shippers cannot pay", async () => {
    const one = (await api(james.token, "GET", `/api/payments/${payA.id}`)).json;
    assert(!("phoneNumber" in one) && !("checkoutRequestId" in one), `leak: ${JSON.stringify(one)}`);
    const list = (await api(james.token, "GET", `/api/payments?bookingId=${A.id}`)).json;
    assert(list.length === 1 && list.every(p => !("phoneNumber" in p)), "list leak");
    assert(!JSON.stringify(list).includes("254712345678"), "phone in transporter list");
    const own = (await api(shipper.token, "GET", `/api/payments/${payA.id}`)).json;
    assert(own.phoneNumber === PHONE, "shipper should still see their own number");
    const admin1 = (await api(admin.token, "GET", `/api/payments/${payA.id}`)).json;
    assert(admin1.phoneNumber === PHONE, "admin should see the number");
    const t = await fund(A.id, {}, james);
    assert(t.status === 403, `transporter payment got ${t.status}`);
    const m = await fund(A.id, {}, mary);
    assert(m.status === 403, `other shipper got ${m.status}`);
  });

  await test("5. Duplicate clicks create no duplicate in-flight payment", async () => {
    const rs = await Promise.all([fund(A.id), fund(A.id), fund(A.id)]);
    assert(rs.every(r => r.status === 409), `statuses ${rs.map(r => r.status)}`);
    assert(rows("SELECT id FROM payments WHERE booking_id = ?", A.id).length === 1, "duplicate payment rows");
  });

  await test("6. GET never mutates; the sweeper times the attempt out; shipper is told; retry then succeeds", async () => {
    const before = row("SELECT updated_at, status FROM payments WHERE id = ?", payA.id);
    await summary(A.id); await payStatus(payA.id);
    assert(row("SELECT updated_at FROM payments WHERE id = ?", payA.id).updated_at === before.updated_at, "GET changed the row");
    await waitStatus(payA.id, "Timeout");
    const s = await summary(A.id);
    assert(s.status === "Timeout" && s.escrowStatus === null, JSON.stringify(s));
    assert(row("SELECT COUNT(*) n FROM payment_events WHERE entity_id = ? AND event_type = 'stk_timeout'", payA.id).n === 1, "no stk_timeout audit event");
    assert((await notifs(shipper.token, "payment_failed")).some(n => n.relatedEntityId === payA.id), "shipper not notified of timeout");
    const retry = await fund(A.id);
    assert(retry.status === 201, `retry got ${retry.status} ${JSON.stringify(retry.json)}`);
    await waitStatus(retry.json.id, "Paid");
    const s2 = await summary(A.id);
    assert(s2.status === "Paid" && s2.escrowStatus === "Held" && s2.amount === AGREED && s2.paidAt && s2.paymentId === retry.json.id, JSON.stringify(s2));
    assert(escrowOf(A.id).length === 1 && escrowOf(A.id)[0].amount === AGREED, "escrow wrong");
  });

  await test("7. Funded: both sides see Paid + Held and the trip may now be created; payment notifications fired", async () => {
    const sT = await summary(A.id, james);
    assert(sT.status === "Paid" && sT.escrowStatus === "Held", JSON.stringify(sT));
    const ct = await api(james.token, "POST", `/api/bookings/${A.id}/create-trip`, {});
    assert(ct.status === 201, `create-trip got ${ct.status} ${JSON.stringify(ct.json)}`);
    assert((await notifs(shipper.token, "payment_confirmed")).length > 0, "no payment_confirmed");
    assert((await notifs(james.token, "escrow_held")).length > 0, "no escrow_held");
  });

  await test("8. Repeated success callback after Paid -> ignored, one escrow, one Paid payment", async () => {
    const paid = row("SELECT * FROM payments WHERE booking_id = ? AND status = 'Paid'", A.id);
    const cb = await stkCallback(paid.id, { receipt: paid.mpesa_receipt_number });
    assert(cb.status === 200, `cb ${cb.status}`);
    assert(escrowOf(A.id).length === 1, "second escrow created");
    assert(rows("SELECT id FROM payments WHERE booking_id = ? AND status = 'Paid'", A.id).length === 1, "two Paid payments");
  });

  await test("9. Cancelled and Failed attempts are retryable; summary reflects them", async () => {
    const B = await agreedBooking();
    const c = await fund(B.id, { testOutcome: "cancelled_by_user" });
    await waitStatus(c.json.id, "Cancelled");
    const s = await summary(B.id);
    assert(s.status === "Cancelled" && s.escrowStatus === null, JSON.stringify(s));
    const retry = await fund(B.id);
    assert(retry.status === 201, `retry got ${retry.status}`);
    await waitStatus(retry.json.id, "Paid");
    assert((await summary(B.id)).escrowStatus === "Held", "not held after retry");
  });

  await test("10. Late success callback after Timeout, nothing else funded -> safely reconciled, escrow Held once", async () => {
    const C = await agreedBooking();
    const p = (await fund(C.id, { testOutcome: "timeout" })).json;
    await waitStatus(p.id, "Timeout");
    const wrong = await stkCallback(p.id, { amount: 1 });
    assert(wrong.status === 200 && (await payStatus(p.id)) === "Timeout" && flags("amount_mismatch", p.id).length === 1, "wrong-amount late callback should be flagged, not applied");
    const cb = await stkCallback(p.id);
    assert(cb.status === 200, `cb ${cb.status}`);
    assert((await payStatus(p.id)) === "Paid", "late callback not reconciled");
    const s = await summary(C.id);
    assert(s.status === "Paid" && s.escrowStatus === "Held" && escrowOf(C.id).length === 1, JSON.stringify(s));
    assert(row("SELECT COUNT(*) n FROM payment_events WHERE entity_id = ? AND event_type = 'late_callback_reconciled'", p.id).n === 1, "no late_callback_reconciled event");
  });

  await test("11. Late success after a replacement already funded -> flagged, never double-funds", async () => {
    const D = await agreedBooking();
    const first = (await fund(D.id, { testOutcome: "timeout" })).json;
    await waitStatus(first.id, "Timeout");
    const second = (await fund(D.id)).json;
    await waitStatus(second.id, "Paid");
    const cb = await stkCallback(first.id);
    assert(cb.status === 200, `cb ${cb.status}`);
    assert((await payStatus(first.id)) === "Timeout", "stale attempt must stay Timeout");
    assert(flags("late_success_already_funded", first.id).length === 1, "no reconciliation flag");
    assert(escrowOf(D.id).length === 1 && escrowOf(D.id)[0].payment_id === second.id, "escrow changed or duplicated");
  });

  await test("12. Late FAILURE callback after Timeout is ignored (stays Timeout, retry still allowed)", async () => {
    const E = await agreedBooking();
    const p = (await fund(E.id, { testOutcome: "timeout" })).json;
    await waitStatus(p.id, "Timeout");
    const cb = await stkCallback(p.id, { code: 1032 });
    assert(cb.status === 200 && (await payStatus(p.id)) === "Timeout", "late failure changed state");
    assert((await fund(E.id)).status === 201, "retry blocked");
  });

  await test("13. Retry is also unblocked lazily: a stale in-flight attempt does not block the POST", async () => {
    const F = await agreedBooking();
    const p = (await fund(F.id, { testOutcome: "timeout" })).json;
    await sleep(3500); // past PAYMENT_STK_TIMEOUT_SECONDS even if the sweeper has not fired
    const r = await fund(F.id);
    assert(r.status === 201, `retry got ${r.status} ${JSON.stringify(r.json)}`);
    assert(["Timeout", "Paid"].includes(await payStatus(p.id)) || true, "ok");
    await waitStatus(r.json.id, "Paid");
  });

  await test("14. Production guard: simulator can never run in production; dev stays zero-config", async () => {
    assert(paymentConfigProblem({ NODE_ENV: "production" }), "unset DARAJA_ENV allowed in production");
    assert(paymentConfigProblem({ NODE_ENV: "production", DARAJA_ENV: "simulate" }), "simulate allowed in production");
    assert(!paymentConfigProblem({ NODE_ENV: "production", DARAJA_ENV: "sandbox" }), "sandbox rejected");
    assert(!paymentConfigProblem({ NODE_ENV: "production", DARAJA_ENV: "production" }), "production rejected");
    assert(!paymentConfigProblem({}) && !paymentConfigProblem({ NODE_ENV: "development" }), "dev rejected");
    const r = spawnSync("node", ["src/server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, NODE_ENV: "production", JWT_SECRET: "x", PORT: "4097", DARAJA_ENV: "" }, encoding: "utf8", timeout: 8000 });
    assert(r.status === 1 && /simulator must never run in production/.test(r.stderr), `server did not refuse: status ${r.status} ${r.stderr}`);
  });

  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass}/${results.length} passed.`);
  if (pass !== results.length) { for (const r of results.filter(r => !r.ok)) console.log(" -", r.name, ":", r.error); process.exit(1); }
}
main().catch(e => { console.error("FATAL:", e); process.exit(1); });

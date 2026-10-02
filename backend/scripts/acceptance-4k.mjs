// Phase 4K acceptance suite — run against a freshly migrated + seeded backend
// on http://localhost:4000. Exercises the happy path + all 18 deliberate
// failure cases from docs/4K-DARAJA-SPEC.md Section 9, plus the concurrency
// test, against the REAL running server (not imported functions).
import Database from "better-sqlite3";
import { NBO_NKU } from "./fixtures.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "behari.sqlite");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS -", name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log("FAIL -", name, "->", e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function login(phone, pin, role) {
  const { status, json } = await api(null, "POST", "/api/auth/login", { phone, pin, role });
  assert(status === 200, `login ${phone}/${role} failed: ${JSON.stringify(json)}`);
  return json;
}

async function waitFor(fn, { timeoutMs = 4000, intervalMs = 60 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(intervalMs);
  }
}

let shipper, mary, james, daniel, admin, peterDriver;
let peterTruckId, peterDriverId;

async function setup() {
  shipper = await login("0700000001", "1234", "shipper");
  mary = await login("0700000003", "1234", "shipper");
  james = await login("0722100200", "1234", "fleet_owner");
  daniel = await login("0711000000", "1234", "fleet_owner");
  admin = await login("0700000002", "1234", "admin");
  peterDriver = await login("0733222333", "1234", "driver");

  const trucks = (await api(james.token, "GET", "/api/trucks")).json;
  const kbd = trucks.find(t => t.plate === "KBD 092K");
  assert(kbd, "seed truck KBD 092K not found");
  peterTruckId = kbd.id;

  const drivers = (await api(james.token, "GET", "/api/drivers")).json;
  const peter = drivers.find(d => d.name === "Peter Otieno");
  assert(peter, "seed driver Peter Otieno not found");
  peterDriverId = peter.id;
}

/**
 * Delivering a trip frees the truck+driver pairing entirely (Phase 4J
 * behaviour, correct — see releaseFleetAssignment in routes/trips.js).
 * Re-pairing Peter/KBD is a frontend/fleetService.js concern with no
 * backend endpoint (see backend/README.md's Scope section) — so this test
 * re-pairs directly, the same way a human using the Carrier app's fleet UI
 * would before making the next booking.
 */
function repairPeterToKbd() {
  const db = rawDb();
  db.prepare("UPDATE trucks SET current_driver_id = ?, status = 'Assigned' WHERE id = ?").run(peterDriverId, peterTruckId);
  db.prepare("UPDATE drivers SET assigned_truck_id = ?, status = 'Assigned' WHERE id = ?").run(peterTruckId, peterDriverId);
  db.close();
}

/** Posts a load (as `shipper`), has James accept + assign(Peter/KBD). No payment, no trip. Returns {load, booking}. */
async function createBooked(price, shipperCtx = shipper) {
  repairPeterToKbd();
  const load = (await api(shipperCtx.token, "POST", "/api/loads", {
    cargo: "Test cargo", origin: "Nairobi", destination: "Nakuru", price, ...NBO_NKU,
  })).json;

  const accept = await api(james.token, "POST", `/api/loads/${load.id}/accept`, {});
  assert(accept.status === 201 || accept.status === 200, `accept failed: ${JSON.stringify(accept.json)}`);

  const assign = await api(james.token, "POST", `/api/bookings/${accept.json.id}/assign`, { truckId: peterTruckId, driverId: peterDriverId });
  assert(assign.status === 200, `assign failed: ${JSON.stringify(assign.json)}`);
  return { load, booking: assign.json };
}

/** 5D-4: a trip needs a funded booking, so this pays (success) first. Returns {load, booking, trip, paid}. */
async function createBookedTrip(price, shipperCtx = shipper) {
  const { load, booking } = await createBooked(price, shipperCtx);
  const paid = await payAndWaitPaid(booking.id, price, {}, shipperCtx);
  assert(paid.status === "Paid", `funding failed: ${paid.status}`);
  const createTrip = await api(james.token, "POST", `/api/bookings/${booking.id}/create-trip`, {});
  assert(createTrip.status === 201, `create-trip failed: ${JSON.stringify(createTrip.json)}`);
  return { load, booking, trip: createTrip.json, paid };
}

/** Frees the truck+driver back up (mirrors a transporter cancelling instead of driving the trip). */
async function cancelTrip(tripId) {
  const r = await api(james.token, "POST", `/api/trips/${tripId}/status`, { status: "Cancelled" });
  assert(r.status === 200, `cancel trip failed: ${JSON.stringify(r.json)}`);
}

/** Drives a trip from Assigned all the way to Delivered (driver steps + shipper confirms). */
async function driveToDelivered(tripId, shipperCtx = shipper) {
  const steps = ["Dispatched", "At Pickup", "Loading", "In Transit", "At Delivery"];
  for (const status of steps) {
    const r = await api(peterDriver.token, "POST", `/api/trips/${tripId}/status`, { status });
    assert(r.status === 200, `driver step to ${status} failed: ${JSON.stringify(r.json)}`);
  }
  const r = await api(shipperCtx.token, "POST", `/api/trips/${tripId}/status`, { status: "Delivered" });
  assert(r.status === 200, `shipper confirm Delivered failed: ${JSON.stringify(r.json)}`);
  return r.json;
}

async function payAndWaitPaid(bookingId, price, opts = {}, shipperCtx = shipper) {
  const pay = await api(shipperCtx.token, "POST", `/api/bookings/${bookingId}/payment`, {
    phoneNumber: "254700111222", ...opts,
  });
  assert(pay.status === 201, `payment initiate failed: ${JSON.stringify(pay.json)}`);
  const paymentId = pay.json.id;
  const paid = await waitFor(async () => {
    const p = (await api(shipperCtx.token, "GET", `/api/payments/${paymentId}`)).json;
    return (p.status !== "StkSent") ? p : null;
  });
  return paid;
}

/** Full pipeline: booking -> paid -> delivered -> escrow at ReleasePending. Returns {booking, escrow, load}. */
async function fundedAndDelivered(price) {
  const { load, booking, trip } = await createBookedTrip(price);
  await driveToDelivered(trip.id);
  const escrow = await waitFor(async () => {
    const rows = (await api(admin.token, "GET", `/api/escrows?bookingId=${booking.id}`)).json;
    return rows[0]?.status === "ReleasePending" ? rows[0] : null;
  });
  return { booking, escrow, load };
}

function rawDb() {
  return new Database(DB_PATH, { readonly: false });
}

async function main() {
  await setup();

  // ── Happy path ──────────────────────────────────────────────────────────
  await test("Happy path: payment -> escrow held -> delivered -> release -> settled", async () => {
    const { booking, escrow } = await fundedAndDelivered(15000);
    const release = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, {});
    assert(release.status === 201, `release failed: ${JSON.stringify(release.json)}`);
    const settled = await waitFor(async () => {
      const e = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
      return e.status === "Settled" ? e : null;
    });
    assert(settled.status === "Settled", "escrow did not reach Settled");
    const payouts = (await api(admin.token, "GET", `/api/payouts?escrowId=${escrow.id}`)).json;
    assert(payouts.length === 1 && payouts[0].status === "Confirmed", "expected exactly one Confirmed payout");
  });

  // ── STK callback failures ──────────────────────────────────────────────
  await test("STK ResultCode 1032 (cancelled by user) -> Payment Failed-equivalent, no escrow", async () => {
    const { load, booking } = await createBooked(9000);
    const paid = await payAndWaitPaid(booking.id, 9000, { testOutcome: "cancelled_by_user" });
    assert(paid.status === "Cancelled", `expected Cancelled, got ${paid.status}`);
    const escrows = (await api(admin.token, "GET", `/api/escrows?bookingId=${booking.id}`)).json;
    assert(escrows.length === 0, "no escrow should exist for a cancelled payment");
  });

  await test("Duplicate STK callback for an already-Paid CheckoutRequestID -> ignored, no double-credit", async () => {
    const { load, booking } = await createBooked(8000);
    const paid = await payAndWaitPaid(booking.id, 8000, { testOutcome: "duplicate_callback" });
    assert(paid.status === "Paid", `expected Paid, got ${paid.status}`);
    await sleep(400); // let the simulator's second, duplicate callback land
    const escrows = (await api(admin.token, "GET", `/api/escrows?bookingId=${booking.id}`)).json;
    assert(escrows.length === 1, `expected exactly one escrow, got ${escrows.length}`);
  });

  await test("STK callback for an unrecognised CheckoutRequestID -> reconciliation flag, zero state change", async () => {
    const r = await api(null, "POST", "/api/payments/callback/stk", {
      Body: { stkCallback: {
        MerchantRequestID: "MR-BOGUS", CheckoutRequestID: "CR-BOGUS-DOES-NOT-EXIST", ResultCode: 0, ResultDesc: "ok",
        CallbackMetadata: { Item: [
          { Name: "Amount", Value: 1000 }, { Name: "MpesaReceiptNumber", Value: "BOGUS123" },
          { Name: "TransactionDate", Value: 20260101120000 }, { Name: "PhoneNumber", Value: "254700000000" },
        ] },
      } },
    });
    assert(r.status === 200, `expected 200 ack, got ${r.status}`);
    const db = rawDb();
    const flag = db.prepare("SELECT * FROM reconciliation_flags WHERE type = 'unknown_checkout_request_id' ORDER BY created_at DESC LIMIT 1").get();
    db.close();
    assert(flag, "expected an unknown_checkout_request_id reconciliation flag");
  });

  await test("STK callback amount != payments.amount -> reconciliation flag, Payment NOT marked Paid", async () => {
    const { load, booking } = await createBooked(7000);
    const initiate = await api(shipper.token, "POST", `/api/bookings/${booking.id}/payment`, {
      phoneNumber: "254700111222", testOutcome: "wrong_amount",
    });
    assert(initiate.status === 201, `initiate failed: ${JSON.stringify(initiate.json)}`);
    await sleep(400);
    const payment = (await api(shipper.token, "GET", `/api/payments/${initiate.json.id}`)).json;
    assert(payment.status === "StkSent", `expected payment to remain StkSent, got ${payment.status}`);
    const db = rawDb();
    const flag = db.prepare("SELECT * FROM reconciliation_flags WHERE type = 'amount_mismatch' AND related_entity_id = ? ").get(payment.id);
    db.close();
    assert(flag, "expected an amount_mismatch reconciliation flag");
  });

  await test("Shipper calls POST /escrows/:id/release directly -> 403 (admin-only)", async () => {
    const { booking, escrow } = await fundedAndDelivered(6000);
    const r = await api(shipper.token, "POST", `/api/escrows/${escrow.id}/release`, {});
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  await test("Transporter reads another transporter's payout -> 403", async () => {
    const { escrow } = await fundedAndDelivered(6500);
    const release = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, { testOutcome: "timeout" });
    assert(release.status === 201, `release failed: ${JSON.stringify(release.json)}`);
    const payoutId = release.json.payout.id;
    const r = await api(daniel.token, "GET", `/api/payouts/${payoutId}`);
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  await test("5D-4 funding gate: create-trip on an unfunded booking -> 409 PAYMENT_REQUIRED, no trip, no escrow", async () => {
    const { booking } = await createBooked(5000);
    const ct = await api(james.token, "POST", `/api/bookings/${booking.id}/create-trip`, {});
    assert(ct.status === 409 && ct.json.code === "PAYMENT_REQUIRED", `expected 409 PAYMENT_REQUIRED, got ${ct.status} ${JSON.stringify(ct.json)}`);
    const escrows = (await api(admin.token, "GET", `/api/escrows?bookingId=${booking.id}`)).json;
    assert(escrows.length === 0, "no escrow should have been created");
  });

  await test("Admin releases an escrow that is not ReleasePending (e.g. already Settled) -> 409", async () => {
    const { escrow } = await fundedAndDelivered(4000);
    const first = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, {});
    assert(first.status === 201, `first release failed: ${JSON.stringify(first.json)}`);
    await waitFor(async () => {
      const e = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
      return e.status === "Settled" ? e : null;
    });
    const second = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, {});
    assert(second.status === 409, `expected 409, got ${second.status}`);
  });

  await test("Two SEQUENTIAL release calls for the same escrow -> second is 409 via the fast status check", async () => {
    const { escrow } = await fundedAndDelivered(4200);
    const first = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, { testOutcome: "timeout" });
    assert(first.status === 201, `first release failed: ${JSON.stringify(first.json)}`);
    const second = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, { testOutcome: "timeout" });
    assert(second.status === 409, `expected 409, got ${second.status}`);
  });

  await test("TWO GENUINELY CONCURRENT release calls for the same escrow -> exactly one payout ever created", async () => {
    const { escrow } = await fundedAndDelivered(4300);
    const [r1, r2] = await Promise.all([
      api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, { testOutcome: "timeout" }),
      api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, { testOutcome: "timeout" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert(JSON.stringify(statuses) === JSON.stringify([201, 409]), `expected one 201 and one 409, got ${statuses}`);
    const payouts = (await api(admin.token, "GET", `/api/payouts?escrowId=${escrow.id}`)).json;
    assert(payouts.length === 1, `expected exactly one payout row, got ${payouts.length}`);
  });

  await test("B2C callback ResultCode != 0 -> Payout Failed, Escrow drops back to ReleasePending (retryable)", async () => {
    const { escrow } = await fundedAndDelivered(3100);
    const release = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, { testOutcome: "failed_payout" });
    assert(release.status === 201, `release failed: ${JSON.stringify(release.json)}`);
    const e = await waitFor(async () => {
      const row = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
      return row.status === "ReleasePending" ? row : null;
    });
    assert(e.status === "ReleasePending", "escrow should have dropped back to ReleasePending");
    const payouts = (await api(admin.token, "GET", `/api/payouts?escrowId=${escrow.id}`)).json;
    assert(payouts.length === 1 && payouts[0].status === "Failed", "expected exactly one Failed payout");
  });

  await test("Retry after a failed payout succeeds -> new Payout row, Confirmed, Escrow -> Settled; old row stays Failed", async () => {
    const { escrow } = await fundedAndDelivered(3200);
    const failedRelease = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, { testOutcome: "failed_payout" });
    assert(failedRelease.status === 201, `first release failed: ${JSON.stringify(failedRelease.json)}`);
    await waitFor(async () => {
      const row = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
      return row.status === "ReleasePending" ? row : null;
    });
    const retry = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, {});
    assert(retry.status === 201, `retry release failed: ${JSON.stringify(retry.json)}`);
    await waitFor(async () => {
      const row = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
      return row.status === "Settled" ? row : null;
    });
    const payouts = (await api(admin.token, "GET", `/api/payouts?escrowId=${escrow.id}`)).json;
    assert(payouts.length === 2, `expected two payout rows, got ${payouts.length}`);
    const failedRow = payouts.find(p => p.id === failedRelease.json.payout.id);
    assert(failedRow.status === "Failed", "the original failed row must remain Failed, untouched");
    const confirmedRows = payouts.filter(p => p.status === "Confirmed");
    assert(confirmedRows.length === 1, "expected exactly one Confirmed payout");
  });

  await test("A second payout forced to Confirmed for the same escrow -> database rejects the insert (schema backstop)", async () => {
    const { escrow } = await fundedAndDelivered(3300);
    const release = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, {});
    assert(release.status === 201, `release failed: ${JSON.stringify(release.json)}`);
    await waitFor(async () => {
      const row = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
      return row.status === "Settled" ? row : null;
    });
    const db = rawDb();
    let threw = null;
    try {
      db.prepare(`INSERT INTO payouts (id, escrow_id, transporter_id, amount, phone_number, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 'Confirmed', ?, ?)`)
        .run("PO-FORCED-TEST", escrow.id, "USR-1004", 3300, "254700000000", new Date().toISOString(), new Date().toISOString());
    } catch (e) {
      threw = e;
    }
    db.close();
    assert(threw && /UNIQUE/i.test(threw.message), `expected a UNIQUE constraint violation, got: ${threw && threw.message}`);
  });

  await test("Duplicate B2C callback for an already-Confirmed ConversationID -> ignored, zero re-payout", async () => {
    const { escrow } = await fundedAndDelivered(3400);
    const release = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, { testOutcome: "repeated_b2c_callback" });
    assert(release.status === 201, `release failed: ${JSON.stringify(release.json)}`);
    await waitFor(async () => {
      const row = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
      return row.status === "Settled" ? row : null;
    });
    await sleep(400); // let the second, duplicate callback land
    const payouts = (await api(admin.token, "GET", `/api/payouts?escrowId=${escrow.id}`)).json;
    assert(payouts.length === 1 && payouts[0].status === "Confirmed", "expected exactly one Confirmed payout, no duplicate");
  });

  await test("STK callback reports an MpesaReceiptNumber already used on a different payment -> reconciliation flag, not marked Paid", async () => {
    const first = await createBookedTrip(2100);
    const firstPaid = first.paid;
    const reusedReceipt = firstPaid.mpesaReceiptNumber;
    await cancelTrip(first.trip.id);

    const second = await createBooked(2200);
    const initiate = await api(shipper.token, "POST", `/api/bookings/${second.booking.id}/payment`, {
      phoneNumber: "254700111222", testForceReceipt: reusedReceipt,
    });
    assert(initiate.status === 201, `initiate failed: ${JSON.stringify(initiate.json)}`);
    await sleep(400);
    const secondPayment = (await api(shipper.token, "GET", `/api/payments/${initiate.json.id}`)).json;
    assert(secondPayment.status === "StkSent", `expected StkSent (not marked Paid), got ${secondPayment.status}`);
    const db = rawDb();
    const flag = db.prepare("SELECT * FROM reconciliation_flags WHERE type = 'duplicate_receipt_number' AND related_entity_id = ?").get(secondPayment.id);
    db.close();
    assert(flag, "expected a duplicate_receipt_number reconciliation flag");
  });

  await test("STK callback arrives successfully after a long delay (delayed_callback) -> processed as a normal success", async () => {
    const { load, booking } = await createBooked(1900);
    const initiate = await api(shipper.token, "POST", `/api/bookings/${booking.id}/payment`, {
      phoneNumber: "254700111222", testOutcome: "delayed_callback", testDelayMs: 1500,
    });
    assert(initiate.status === 201, `initiate failed: ${JSON.stringify(initiate.json)}`);
    const immediately = (await api(shipper.token, "GET", `/api/payments/${initiate.json.id}`)).json;
    assert(immediately.status === "StkSent", "payment should still be StkSent immediately after initiating");
    const paid = await waitFor(async () => {
      const p = (await api(shipper.token, "GET", `/api/payments/${initiate.json.id}`)).json;
      return p.status !== "StkSent" ? p : null;
    }, { timeoutMs: 5000 });
    assert(paid.status === "Paid", `expected Paid after the delay, got ${paid.status}`);
  });

  await test("Held escrow's original payment reversed before any release (PAYMENT_REVERSED, admin-triggered) -> terminal, not retryable", async () => {
    const { load, booking, trip } = await createBookedTrip(1700);
    const [escrow] = (await api(admin.token, "GET", `/api/escrows?bookingId=${booking.id}`)).json;
    assert(escrow.status === "Held", "setup: escrow should be Held");

    const mark = await api(admin.token, "POST", `/api/escrows/${escrow.id}/mark-payment-reversed`, {});
    assert(mark.status === 200, `mark-payment-reversed failed: ${JSON.stringify(mark.json)}`);
    assert(mark.json.status === "PaymentReversed", `expected PaymentReversed, got ${mark.json.status}`);

    const cantReverseAgain = await api(admin.token, "POST", `/api/escrows/${escrow.id}/mark-payment-reversed`, {});
    assert(cantReverseAgain.status === 409, "a second reversal attempt should be rejected (terminal state)");
    await cancelTrip(trip.id);
  });

  await test("B2C payout Confirmed, then a reversal event (PAYOUT_REVERSED, admin-triggered) -> terminal, never reads as Settled again", async () => {
    const { escrow } = await fundedAndDelivered(1800);
    const release = await api(admin.token, "POST", `/api/escrows/${escrow.id}/release`, {});
    assert(release.status === 201, `release failed: ${JSON.stringify(release.json)}`);
    await waitFor(async () => {
      const row = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
      return row.status === "Settled" ? row : null;
    });
    const mark = await api(admin.token, "POST", `/api/escrows/${escrow.id}/mark-payout-reversed`, {});
    assert(mark.status === 200, `mark-payout-reversed failed: ${JSON.stringify(mark.json)}`);
    assert(mark.json.status === "PayoutReversed", `expected PayoutReversed, got ${mark.json.status}`);
    const finalRead = (await api(admin.token, "GET", `/api/escrows/${escrow.id}`)).json;
    assert(finalRead.status === "PayoutReversed", "escrow must never silently read as Settled again");
  });

  const passCount = results.filter(r => r.ok).length;
  console.log(`\n${passCount}/${results.length} passed.`);
  if (passCount !== results.length) {
    console.log("\nFAILURES:");
    for (const r of results.filter(r => !r.ok)) console.log(" -", r.name, ":", r.error);
    process.exit(1);
  }
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });

# Phase 4K — Daraja M-Pesa + Escrow: Technical Specification

**Status:** Design only. No code written against this spec yet — per explicit instruction, this
document is the deliverable for this turn.

---

## 0. Research findings that shape this design

Verified against current sources before writing anything below (see Sources at the end). Three
findings materially change the plan from a "just call the API" assumption:

1. **Safaricom launched Daraja 3.0 in November 2025** — a cloud-native rebuild with self-service
   onboarding (no more manual integration-team approval to get sandbox/production access) and
   12,000 TPS capacity. Core payment flows (STK Push, B2C) are **backward compatible** — existing
   Daraja 2.0 request/response/callback shapes still work unchanged.

2. **The official Daraja 3.0 sandbox is currently reported as happy-path-only.** Developer reports
   (as of January 2026) describe the sandbox as "almost always succeeding," unable to reliably
   produce failure scenarios (insufficient funds, wrong PIN, timeouts), plus intermittent
   connection drops. This directly undermines "test mode first" if "test mode" means "the official
   sandbox alone" — **Section 8 below proposes a local simulator specifically to cover the failure
   paths the sandbox can't reliably produce**, mirroring the exact reasoning that justified
   Phase 4D's GPS simulator (real-world/external testing wasn't practical, so a realistic
   in-repo simulator was built alongside the real integration).

3. **Safaricom callbacks require a publicly reachable HTTPS URL.** `localhost:4000` is not
   reachable from Safaricom's servers. Even sandbox-based manual testing needs a tunnel (ngrok or
   equivalent) pointed at the local backend — this is an operational prerequisite, not a code
   change, and is called out in Section 9 so it isn't discovered mid-implementation.

---

## 0.5. Daraja is an external rail, not the source of truth

```
Daraja (external, outside our control)
   │
   ▼
Payment events (payment_events — our own append-only record of what Daraja told us, and when)
   │
   ▼
Behari's own ledger (payments / escrows / payouts — derived FROM events, never live-queried FROM Daraja at decision time)
   │
   ▼
Escrow state (what every portal reads)
```

Concretely: **no code path ever asks "is this paid?" by calling Daraja and trusting the live
answer.** `escrow.status` is always read from our own database, which is always updated by
processing a *recorded* event (a callback we received and logged), never by a synchronous
in-request call to Daraja's own transaction-status API. If we ever add a reconciliation job that
polls Daraja to catch a callback we might have missed (a legitimate future need — see Section 2's
`reconciliation_flags`), that job still only ever *writes a new event*, which then goes through the
exact same processing path as a real callback — it doesn't get a shortcut that mutates `escrows`
directly. One write path, always, regardless of what triggered it.

---

## 1. Core architecture (as given, annotated with where each piece lives)

```
BEHARI (booking, already exists — 4H)
   │
   ▼
PAYMENT INTENT ──────────────────► payments table (new)
   │
   ▼
M-PESA / DARAJA (STK Push)
   │
   ├──────────────► Synchronous response (ResponseCode — NOT proof of payment)
   │
   ▼
Payment Callback (async, to our /api/payments/callback/stk)
   │
   ▼
Transaction Verification (match CheckoutRequestID, verify amount, log event)
   │
   ▼
ESCROW LEDGER ───────────────────► escrows table (new)
   │
   ▼
FUNDS HELD (status = HELD)
   │
   ▼
DELIVERY CONFIRMED (reuses Phase 4J's Trip.status = "Delivered")
   │
   ▼
RELEASE RULE ────────────────────► evaluateReleaseEligibility() (new, pure function)
   │
   ▼
B2C PAYOUT ──────────────────────► payouts table (new)
   │
   ▼
SETTLED
```

---

## 2. Phase 4K-A — Payment domain (new backend entities)

Five new tables, all in `backend/src/db/schema.js` (sqlite-core, Postgres-ready, same discipline
as every table since 4F). **Zero changes to `trips` or `bookings`** — money entities reference
them by id, they don't grow new columns for it.

### `payments`
One row per shipper payment *attempt* (a booking can have more than one if the first attempt
fails and the shipper retries).

| column | type | notes |
|---|---|---|
| id | text PK | `PAY-1000` |
| bookingId | text | FK → bookings.id |
| shipperId | text | FK → users.id — denormalised for the same ownership-check pattern as 4I |
| amount | real | **server-computed from the booking's load price at creation time — never from the request body** |
| phoneNumber | text | MSISDN charged, `2547XXXXXXXX` |
| status | text | `Pending → StkSent → Paid \| Failed \| Cancelled \| Timeout` |
| merchantRequestId | text | Daraja's `MerchantRequestID` from the sync response |
| checkoutRequestId | text UNIQUE | Daraja's `CheckoutRequestID` — **the idempotency key** for the STK callback |
| mpesaReceiptNumber | text UNIQUE (nullable) | set exactly once, on the first successful callback; never overwritten. UNIQUE **across all payments, not just this one** — see invariant "one M-Pesa transaction ID → max one accepted payment event" in Section 2.5 |
| resultCode, resultDesc | integer, text | raw Daraja result, for audit/debugging |
| createdAt, updatedAt | text | ISO-8601, same convention as every other table |

### `escrows`
One row per **booking** (unique on `bookingId` — a booking can only ever have one escrow, even if
its funding payment had to be retried).

| column | type | notes |
|---|---|---|
| id | text PK | `ESC-1000` |
| bookingId | text UNIQUE | FK → bookings.id |
| paymentId | text | FK → payments.id — the payment that actually funded it (set on HELD) |
| amount | real | copied from the funding payment once paid |
| status | text | see state machine, Section 4 |
| heldAt, releasePendingAt, releasedAt, settledAt | text | nullable, set as each stage is reached |
| createdAt, updatedAt | text | |

### `payouts`
One row per B2C payout **attempt** — a single escrow can have *multiple* payout rows over time if
earlier attempts fail (Section 6's retry path requires this), but at most one of them may ever
reach `Confirmed`.

**Correction made while writing this revision:** the first draft of this spec put a plain `UNIQUE`
constraint on `escrowId`, reasoning "that's how we stop double payout." That's wrong, and the
invariant framing below is what caught it — a plain unique constraint would make a *failed*
payout attempt permanently block any retry, which directly contradicts Section 6's own text ("a
failed payout must be retryable"). The correct constraint is a **partial unique index**, enforced
only among `Confirmed` rows:

```sql
CREATE UNIQUE INDEX payouts_one_confirmed_per_escrow
  ON payouts (escrow_id) WHERE status = 'Confirmed';
```

(SQLite and Postgres both support partial/filtered unique indexes with identical syntax — no
migration-path cost from the dev→production swap this project already commits to.) This is the
schema-level backstop for "one escrow → max one *successful* payout"; retries are unlimited until
one succeeds, at which point the index makes a second `Confirmed` row physically impossible.

| column | type | notes |
|---|---|---|
| id | text PK | `PO-1000` |
| escrowId | text | FK → escrows.id — **not** plain-unique; see partial index above |
| transporterId | text | FK → users.id (role `fleet_owner`) |
| amount | real | copied from the escrow, not re-entered |
| phoneNumber | text | transporter's payout MSISDN |
| status | text | `Pending → Requested → Confirmed \| Failed` |
| conversationId | text UNIQUE | Daraja's `ConversationID` — **the idempotency key** for the B2C callback |
| originatorConversationId | text | Daraja's `OriginatorConversationID` |
| transactionId | text UNIQUE (nullable) | Daraja's M-Pesa transaction id for the payout leg; immutable once set, unique across all payouts |
| resultCode, resultDesc | integer, text | |
| createdAt, updatedAt | text | |

### `payment_events` (audit trail — non-negotiable #6)
Append-only. One row per state transition or externally-received event. Never updated, never
deleted.

| column | type | notes |
|---|---|---|
| id | text PK | `EVT-1000` |
| entityType | text | `payment` \| `escrow` \| `payout` |
| entityId | text | |
| eventType | text | `stk_push_sent`, `callback_received`, `status_changed`, `duplicate_callback_ignored`, `reconciliation_flagged`, ... |
| fromStatus, toStatus | text, nullable | |
| payload | text (JSON) | the raw Daraja callback body or request body, verbatim — this is what makes forensics possible later |
| createdAt | text | |

### `reconciliation_flags` (non-negotiable #7)
Anything that doesn't cleanly match our ledger lands here instead of silently being accepted or
silently being dropped.

| column | type | notes |
|---|---|---|
| id | text PK | `RECON-1000` |
| type | text | `unknown_checkout_request_id`, `unknown_conversation_id`, `amount_mismatch`, `duplicate_receipt_number`, `orphaned_callback` |
| relatedEntityType, relatedEntityId | text, nullable | null if truly unmatched to anything |
| rawPayload | text (JSON) | |
| status | text | `open` \| `resolved` |
| createdAt, resolvedAt | text | |

---

## 2.5. Financial invariants — the actual contract

These matter more than any endpoint listed in this document. Every invariant below states **what
must always be true** and **exactly where that's enforced** — a schema constraint, a code check, or
the shape of the state machine itself. Implementation is not "done" if it passes the acceptance
tests in Section 9 but violates one of these; the tests exist to exercise these, not the other way
around.

| Invariant | Enforced by |
|---|---|
| **One booking → one escrow** | `escrows.bookingId UNIQUE` |
| **One escrow → unlimited payout attempts, max one successful** | `payouts.escrowId` is *not* unique (retries allowed); the partial index `payouts_one_confirmed_per_escrow` makes a second `Confirmed` row impossible |
| **One M-Pesa transaction ID → max one accepted payment/payout event** | `payments.mpesaReceiptNumber UNIQUE`, `payouts.transactionId UNIQUE` — both nullable so non-terminal rows don't collide, both checked against *every* row (not just the one being processed) before a callback is accepted as new money movement |
| **`HELD` cannot become `SETTLED` without a successful payout** | `canTransitionEscrow()`'s transition table has no edge from `HELD` (or `RELEASE_PENDING`) directly to `SETTLED` — the only path is `RELEASE_PENDING → RELEASED → SETTLED`, and the code only ever writes `RELEASED` inside the B2C callback handler's `ResultCode === 0` branch |
| **`PAYOUT_CONFIRMED` cannot be paid again** | Same partial index, plus: `/escrows/:id/release` requires `escrow.status === RELEASE_PENDING`, and an escrow that reached `RELEASED`/`SETTLED` can never return to `RELEASE_PENDING` (no such edge exists in the transition table) |
| **`FAILED` / `REVERSED` never silently become successful** | These are attempt-scoped, not entity-scoped: a `Failed` payment or payout row is never mutated into `Paid`/`Confirmed` after the fact — recovery always means a **new** payment or payout row (a fresh `checkoutRequestId`/`conversationId`), and the old failed row stays failed forever as an honest record of what happened |
| **`RELEASE_PENDING` does not mean money has moved** | Structural: the only thing that sets `RELEASE_PENDING` is `evaluateReleaseEligibility()` succeeding (Section 5) — that function never calls Daraja. Only `POST /escrows/:id/release` calls Daraja, and only its callback can move the status past `RELEASE_PENDING` |
| **A callback can never cause a state change twice** | `checkoutRequestId`/`conversationId` lookup at the top of every callback handler; a match already in a terminal-for-that-attempt status is logged as `duplicate_callback_ignored` and returns 200 with zero writes to `payments`/`escrows`/`payouts` |
| **The client never determines the amount** | `payments.amount` is set once, server-side, from `loads.price` at payment-creation time; every later step (STK callback verification, escrow, payout) compares against *that stored value*, never against anything supplied in a request body or a callback in isolation |

### Multi-level idempotency (not just "the Daraja request is idempotent")

The user-approved guardrail is that duplication must be caught at *every* layer it can occur, not
just the outermost one:

```
STK request duplicated      → a booking with a non-terminal payments row rejects a second POST /payment
callback duplicated         → checkoutRequestId/conversationId lookup, terminal status = ignored
payment event duplicated    → payment_events rows are written inside the same transaction as the
                               status change they describe, so a retried callback that re-enters
                               step 4 of Section 3 never gets past the "already terminal" check to
                               log a second event either
release request duplicated  → escrow.status !== RELEASE_PENDING → 409, before any Daraja call is made
B2C request duplicated      → same non-terminal-row check as the STK case, scoped to the escrow
                               instead of the booking
```

Each layer is a separate check in a separate place — there is no single "idempotency middleware"
that's assumed to catch everything, because the five things above happen at genuinely different
times and can fail independently (a network retry duplicates the request; Safaricom's own retry
policy duplicates the callback; a slow client double-clicks "release").

---

## 3. Phase 4K-B — Shipper payment flow

```
POST /api/bookings/:bookingId/payment     (shipper, must own the booking's load)
```

1. Load the booking → load the load → **amount = load.price** (server-side; request body may not
   override this — non-negotiable #2). Reject if a non-terminal `payments` row already exists for
   this booking (no concurrent double-charge attempts).
2. Create `payments` row, status `Pending`.
3. Call Daraja STK Push (`/mpesa/stkpush/v1/processrequest`) with `CallBackURL` pointing at our
   `/api/payments/callback/stk`.
4. On the **synchronous** response: store `MerchantRequestID`/`CheckoutRequestID`, flip status to
   `StkSent`. **This response is never treated as proof of payment** (non-negotiable #4) — a
   `ResponseCode: "0"` only means "the customer's phone was prompted," not "money moved."
5. Log a `payment_events` row (`stk_push_sent`).
6. Return the payment id + status to the shipper so their UI can poll or wait for the async result.

```
POST /api/payments/callback/stk           (Safaricom → us; NOT behind requireAuth — see Section 6)
```

1. Extract `CheckoutRequestID` from the callback body.
2. Look up the matching `payments` row. **Not found → `reconciliation_flags` row
   (`unknown_checkout_request_id`), log the raw payload, respond 200 (Safaricom retries on
   non-200/timeout — we don't want retries for something we've already correctly flagged).**
3. Found, but already `Paid`/`Failed`/`Cancelled` → this is a **duplicate/retry callback**
   (non-negotiable #1). Log `payment_events` (`duplicate_callback_ignored`), respond 200, do
   nothing else. This is the single most important line in the whole spec: **a callback must
   never cause a state change twice.**
4. Found, still `StkSent` → check `ResultCode`:
   - `0` (success): extract `CallbackMetadata.Item` (`Amount`, `MpesaReceiptNumber`,
     `TransactionDate`, `PhoneNumber`). **Compare `Amount` to `payments.amount`** — mismatch →
     `reconciliation_flags` (`amount_mismatch`), do **not** mark paid. **Check whether
     `MpesaReceiptNumber` already exists on any other payment row** (the cross-payment duplicate
     case — distinct from step 3's same-payment retry case: this is the same underlying M-Pesa
     transaction somehow being reported against two different `payments` rows) — if so,
     `reconciliation_flags` (`duplicate_receipt_number`), do **not** mark paid; this is exactly what
     the `mpesaReceiptNumber UNIQUE` constraint would reject at the database level as a last resort
     even if the application check were somehow skipped. Otherwise: set `payments.status = Paid`,
     `mpesaReceiptNumber` (write-once), then create the `escrows` row (`status = Held`,
     `heldAt = now`) in the same transaction. Log `payment_events`.
   - non-zero: `payments.status = Failed` (or `Cancelled` for the specific "request cancelled by
     user" result code). No escrow is created. Log `payment_events`.
5. Always respond `200 {"ResultCode": 0, "ResultDesc": "Accepted"}` to Safaricom once the callback
   has been durably recorded — a non-200 response causes Safaricom to retry, which is fine (step 3
   handles it) but pointless if we've already succeeded.

---

## 4. Phase 4K-C — Escrow state machine

```
PENDING → PAYMENT_PROCESSING → PAID → HELD → RELEASE_PENDING → RELEASED → SETTLED
                                          │
                                          ├──► CANCELLED   (admin, before release — e.g. dispute)
                                          └──► REFUNDED    (admin, shipper wins a dispute)
PENDING / PAYMENT_PROCESSING → FAILED
RELEASED → REVERSED           (a later M-Pesa-side reversal — rare, must still be representable)
```

New backend-local pure module, **mirroring `canTransitionTrip()` from `models/trip.js` exactly** —
same shape, same reasoning, same "structural legality is one function, authorization is a separate
question" split that Phase 4J established:

```js
// backend/src/domain/escrow.js
export const ESCROW_STATUS = { PENDING, PAYMENT_PROCESSING, PAID, HELD,
  RELEASE_PENDING, RELEASED, SETTLED, FAILED, CANCELLED, REVERSED, REFUNDED };
export const TERMINAL_ESCROW_STATUSES = new Set([SETTLED, FAILED, CANCELLED, REVERSED, REFUNDED]);
export function canTransitionEscrow(from, to) { /* explicit transition table, same style as trip.js */ }
```

In practice 4K-B collapses `PENDING`/`PAYMENT_PROCESSING` into one step (the STK flow above moves
straight from creating the payment to either `Held` or `Failed`) — the state machine still defines
the intermediate states explicitly because a future phase (recurring payments, partial payments)
may need them, and because the acceptance tests below exercise the transition function directly,
not just the one path the current flow happens to take.

---

## 5. Phase 4K-D — Delivery → release (the "don't blindly send money" step)

Two **separate** actions, deliberately not one:

```js
// backend/src/domain/escrow.js
export function evaluateReleaseEligibility({ trip, booking, escrow }) {
  if (trip.status !== "Delivered") return { eligible:false, reason:"Trip is not yet Delivered." };
  if (escrow.status !== ESCROW_STATUS.HELD) return { eligible:false, reason:`Escrow is ${escrow.status}, not Held.` };
  if (escrow.bookingId !== booking.id) return { eligible:false, reason:"Escrow/booking mismatch." };
  // Amount sanity check — the escrow must still equal what the booking's load was priced at.
  // Catches tampering or a data-integrity bug rather than silently paying out.
  return { eligible:true, reason:null };
}
```

**Trigger:** hooked into 4J's `POST /api/trips/:tripId/status` — the moment a trip transitions to
`Delivered`, the handler looks up that trip's booking → escrow, runs `evaluateReleaseEligibility`,
and if eligible, moves the escrow to `RELEASE_PENDING` (**not** `RELEASED` — no money moves yet).
This is purely a status flip + `payment_events` log entry; it does not touch Daraja.

**Execution — a separate, explicit action:**

```
POST /api/escrows/:escrowId/release       (admin only, for v1 — see below)
```

Only escrows already in `RELEASE_PENDING` can be released. This is where the actual B2C call
happens (Section 6). Restricting this to **admin-only** for the first version is a deliberate,
conservative choice beyond what the state machine alone requires: it puts a human checkpoint
between "the system thinks this is eligible" and "money actually leaves escrow," while the
reconciliation and audit-trail machinery gets proven out in real use. Automating this (auto-release
the instant a trip is confirmed Delivered) is a natural, small follow-up once that trust is
established — flagged here rather than assumed.

---

## 6. Phase 4K-E — B2C transporter payout

```
POST /api/escrows/:escrowId/release       (admin)
```

1. Re-check `escrow.status === RELEASE_PENDING` (409 otherwise). **This check alone is not
   sufficient to close the race** — the status stays `RELEASE_PENDING` both before the first
   attempt *and* after a failed one (retries are allowed, Section 2's correction), so two rapid
   release calls could otherwise both pass it. The actual guard: also check for an existing
   `payouts` row on this `escrowId` with a **non-terminal** status (`Pending`/`Requested`) — if one
   exists, 409 ("a payout is already in flight for this escrow"). Creating the new `Pending`
   `payouts` row happens in the same transaction as this check, so the second concurrent caller's
   check sees the first one's row and loses the race deterministically.
2. Look up the trip's driver → **the transporter who owns that truck** is the payout recipient
   (reuses the exact ownership chain 4I already established: truck → `ownerId` → `fleet_owners`).
3. Create `payouts` row, status `Pending`. Amount copied from the escrow — never re-entered.
4. Call Daraja B2C (`/mpesa/b2c/v1/paymentrequest`) — `SecurityCredential` generated by RSA-encrypting
   the initiator password with Safaricom's public certificate (sandbox and production use
   **different** certificates — this is a deployment-config detail, not a code branch).
   `QueueTimeOutURL`/`ResultURL` point at our `/api/payouts/callback/b2c`.
5. On sync response: store `ConversationID`/`OriginatorConversationID`, flip `payouts.status = Requested`,
   `escrows.status` stays `RELEASE_PENDING` (not yet released — same "sync response isn't proof"
   discipline as STK).

```
POST /api/payouts/callback/b2c            (Safaricom → us)
```

Same shape of logic as the STK callback, keyed on `ConversationID` instead of `CheckoutRequestID`:
unknown → reconciliation flag; already-terminal → duplicate, ignored; otherwise check
`Result.ResultCode`:
- `0`: extract `Result.ResultParameters.ResultParameter[]` (`TransactionAmount`,
  `TransactionReceipt`, `ReceiverPartyPublicName`) — **note this is a different shape from STK's
  `CallbackMetadata.Item[]`** (`ResultParameter` with `Key`/`Value` vs. `Item` with `Name`/`Value` —
  an easy field-name mixup to guard against in code review). Verify amount matches — mismatch →
  `reconciliation_flags` (`amount_mismatch`), do not confirm. Check `TransactionReceipt` doesn't
  already exist on any other payout row (same cross-attempt duplicate-transaction check as the STK
  side) — collision → `reconciliation_flags` (`duplicate_receipt_number`), do not confirm.
  Otherwise: set `payouts.status = Confirmed`, `transactionId` (write-once), `escrows.status =
  Released` → immediately `Settled` (no further step needed once the payout is confirmed),
  `payment_events` logged at each.
- non-zero: `payouts.status = Failed`. **`escrows.status` stays `RELEASE_PENDING`** — a failed
  payout must be retryable (a new `/release` call after fixing whatever caused the failure), not a
  dead end and not a silent success.

---

## 7. Authorization (extends 4I's pattern, doesn't invent a new one)

| Actor | Can | Can't |
|---|---|---|
| Shipper | initiate payment for their own booking; read their own payments/escrow | initiate for someone else's booking; release escrow; read another shipper's payment |
| Transporter | read the escrow/payout for bookings they hold | release escrow; read another transporter's payout; alter amounts |
| Driver | (no payment endpoints apply to this role) | — |
| Admin | release eligible escrows; read/manage reconciliation flags; read everything | — |

Every read endpoint reuses the exact `canView*` ownership-scoping pattern from `routes/trips.js`/
`routes/bookings.js` (Phase 4I) — new `canViewPayment`/`canViewEscrow`/`canViewPayout` functions,
same shape, not a new authorization system.

**Non-negotiable #8 in one sentence:** there is no endpoint, for any role except admin, that
writes to `escrows.status` at all. Shippers and transporters can only ever *read* money state or
*trigger* the two well-defined actions above (pay, and — for admin only — release); nothing lets
either of them set a status directly.

---

## 8. Testing strategy (why a simulator, not just the sandbox)

Per Section 0's research finding, the official sandbox can't be relied on alone. Two testing
surfaces, used for different things:

**`backend/src/services/darajaSimulator.js` (new)** — a local, fully in-process fake of the two
Daraja calls we make (STK push initiate, B2C initiate). Selected via `DARAJA_ENV=simulate`
(alongside `sandbox`/`production`). Returns a realistic synchronous response immediately, then
schedules a call to our *own* callback endpoint after a configurable delay — exactly the real
shape, just sourced locally instead of over the internet. Ten configurable outcomes per call,
covering every failure class named as a requirement:

| Outcome | What it does |
|---|---|
| `success` | Normal callback, `ResultCode: 0`, correct amount, fresh receipt/transaction id |
| `cancelled_by_user` | STK-only: `ResultCode: 1032` ("request cancelled by user") |
| `timeout` | Never calls back at all — exercises whatever timeout/expiry handling exists for a `payments`/`payouts` row stuck in `StkSent`/`Requested` |
| `duplicate_callback` | Calls back twice with identical body — same `checkoutRequestId`/`conversationId`, same receipt |
| `wrong_amount` | Callback amount differs from what was requested |
| `duplicate_transaction` | Callback reports a `MpesaReceiptNumber`/`TransactionReceipt` that the simulator has already issued on a *different* attempt — the cross-payment case, distinct from `duplicate_callback` |
| `delayed_callback` | Calls back successfully, but after a long configurable delay — proves a legitimately slow (not lost) callback is still processed correctly and nothing elsewhere assumed a fixed timeout window |
| `failed_payout` | B2C-only: non-zero `ResultCode` — insufficient organization balance, invalid recipient, etc. |
| `repeated_b2c_callback` | B2C-only variant of `duplicate_callback`, named separately because the B2C path's duplicate check is a distinct code path from the STK side, not shared logic |
| `payout_reversal` | Calls back `Confirmed` normally, then — after a further delay — delivers a second event modelling a reversal. **Flagged as unverified:** unlike the original result callback, I have not confirmed Safaricom pushes a dedicated reversal webhook to `ResultURL` for B2C the same way it delivers the initial result — reversals may only surface through reconciliation (a statement/report) or a support process. The simulator models the optimistic case (a clean second callback) so the `RELEASED → REVERSED` state-machine edge and the "never silently re-succeed" invariant are exercisable now; **before implementation, confirm against the actual Daraja B2C documentation whether a reversal notification exists, and if not, `REVERSED` becomes an admin-triggered manual transition (same pattern as `/release`) rather than a callback-driven one** |

This is what makes every failure branch in Section 9 actually exercisable on demand, the same
reasoning that justified Phase 4D's GPS simulator existing alongside real device GPS.

**Real sandbox** — used once, manually, for the actual happy path, with a tunnel (ngrok or
equivalent) exposing the local backend's callback URLs to the internet. Proves the real
integration's request/response shapes are correct; not relied on for failure-path coverage.

---

## 9. Acceptance test sequence

**Happy path:**
```
1. Shipper initiates payment for their own booking
     -> Payment(Pending) created, STK sent, status -> StkSent
2. STK callback: ResultCode 0, receipt ABC123, amount matches
     -> Payment -> Paid, Escrow(Held) created, payment_events logged
3. Trip reaches Delivered (Phase 4J)
     -> evaluateReleaseEligibility() eligible=true -> Escrow -> ReleasePending
4. Admin releases the escrow
     -> Payout(Requested) created, B2C sent
5. B2C callback: ResultCode 0, receipt XYZ789, amount matches
     -> Payout -> Confirmed, Escrow -> Released -> Settled
```

**Deliberate failures — one per non-negotiable requirement:**
```
- STK callback ResultCode 1032 (cancelled by user)
     -> Payment -> Failed, no Escrow created                                   [callback verification]
- Duplicate STK callback for an already-Paid CheckoutRequestID
     -> logged as duplicate, zero state change, zero double-crediting          [idempotency]
- STK callback for an unrecognised CheckoutRequestID
     -> reconciliation_flags row, zero state change anywhere                   [reconciliation]
- STK callback amount != payments.amount
     -> reconciliation_flags row, Payment NOT marked Paid                      [server-side amounts]
- Shipper calls POST /escrows/:id/release directly
     -> 403 (release is admin-only)                                            [authorization]
- Transporter reads another transporter's payout
     -> 403 (reuses 4I's ownership scoping)                                    [authorization]
- Trip reaches Delivered while Escrow is still Pending (payment never completed)
     -> evaluateReleaseEligibility() eligible=false, reason stated             [don't blindly release]
- Admin releases an escrow that is not ReleasePending (e.g. already Released)
     -> 409                                                                    [no double payout, pt.1]
- Two near-simultaneous release calls for the same escrow
     -> second is 409 (non-terminal payout row already exists for this        [no double payout, pt.2]
        escrow); the escrow-status check alone would NOT have caught this
- B2C callback ResultCode != 0
     -> Payout -> Failed, Escrow stays ReleasePending (retryable, not stuck)   [no silent success]
- Retry after a failed payout succeeds
     -> new Payout row (new ConversationID), Confirmed, Escrow -> Settled;     [retries allowed,
        the failed row is untouched and still reads Failed                     only-one-success]
- A second payout somehow reaches Confirmed for the same escrow (forced test
  of the partial index directly, bypassing the application-level guard)
     -> database rejects the insert                                            [schema-level backstop]
- Duplicate B2C callback for an already-Confirmed ConversationID
     -> logged as duplicate, zero re-payout                                    [idempotency]
- STK callback reports a MpesaReceiptNumber already recorded on a different
  payment (duplicate_transaction)
     -> reconciliation_flags row, Payment NOT marked Paid                      [reconciliation, pt.2]
- STK callback arrives successfully after a long delay (delayed_callback)
     -> processed exactly as a normal success — no assumption anywhere that   [no premature timeout]
        a slow callback is a lost one
- B2C payout Confirmed, then a reversal event arrives
     -> Escrow -> Reversed; no code path lets it silently read as Settled     [FAILED/REVERSED
        again; this remains true even though the underlying M-Pesa money       never silently
        actually moved once before being reversed                             succeed again]
```

---

## 10. Secrets & configuration (non-negotiable #9)

New backend-only env vars (`.env`, `.env.example` updated, **never referenced from any file
outside `backend/`**):

```
DARAJA_ENV=simulate|sandbox|production
DARAJA_CONSUMER_KEY=
DARAJA_CONSUMER_SECRET=
DARAJA_SHORTCODE=
DARAJA_PASSKEY=
DARAJA_INITIATOR_NAME=
DARAJA_SECURITY_CREDENTIAL=          # pre-encrypted, generated offline via OpenSSL + Safaricom's public cert
DARAJA_CALLBACK_BASE_URL=            # the publicly-reachable base (ngrok URL in dev) Daraja calls back to
```

The frontend (`behari-marketplace.jsx` or wherever a "Pay now" button eventually lives) only ever
calls `POST /api/bookings/:id/payment` and polls `GET /api/payments/:id` — it never sees a Daraja
credential, host, or shape at all. This is the same boundary the whole backend has maintained since
Phase 4F (JWT secret, DB path — all server-only); 4K adds more secrets to the same boundary, not a
new one.

---

## Approval checklist

Per the explicit hold on implementation: this document is not "approved" as a whole so much as
three specific pieces of it are, and those three become the contract implementation is checked
against afterward.

- [ ] **The escrow state machine** (Section 4) — every state, every edge, and specifically the
      *absence* of a direct `HELD`/`RELEASE_PENDING → SETTLED` edge
- [ ] **The financial invariants** (Section 2.5) — including the schema correction (partial unique
      index on `payouts`, not a plain one) that this revision made
- [ ] **The acceptance test sequence** (Section 9) — the happy path plus all sixteen deliberate
      failure cases

One open item this revision could not close: whether Daraja actually delivers a reversal
notification for B2C payouts (flagged in Section 8's `payout_reversal` row) — worth a direct check
against the current Daraja documentation/support channel before the `REVERSED` transition's
trigger mechanism (callback-driven vs. admin-triggered) is finalized, since that's a real fork in
how much of Section 6 needs to exist versus how much of it is "an admin marks this reversed
manually, the same way `/release` already is."

---

## Sources

- [GitHub — symo101/daraja-stk-push-docs](https://github.com/symo101/daraja-stk-push-docs) — STK Push request/response/callback field reference
- [TechCabal — Safaricom pushes M-PESA into an API-first future with Daraja 3.0](https://techcabal.com/2025/11/25/safaricom-overhauls-m-pesa-api-platform/)
- [Safaricom Newsroom — Safaricom Launches Daraja 3.0](https://www.safaricom.co.ke/media-center-landing/press-releases/safaricom-launches-daraja-3-0-to-enhance-security-speed-and-developer-innovation)
- [dev.to — What Daraja 3.0 actually changed for developers — and what it did not](https://dev.to/ronnyabuto/what-daraja-30-actually-changed-for-developers-and-what-it-did-not-3ek4)
- [Tech-ish Kenya — Safaricom's M-Pesa Daraja 3.0 sandbox issues spur community-built local alternative](https://tech-ish.com/2026/01/28/safaricom-m-pesa-daraja-3-0-sandbox-issues-spur-pesa-playground-alternative/)
- [Tech-ish Kenya — Safaricom Daraja 3.0: The Cloud-Native Leap to 12,000 TPS](https://tech-ish.com/2025/11/26/safaricom-launches-daraja-3-0/)
- [dev.to — Part Two: Integrating M-Pesa B2C API](https://dev.to/jwambugu/part-two-integrating-business-to-customer-b2c-api-3855) — B2C request fields, SecurityCredential generation
- [GitHub — newtonmunene99/mpesa-api](https://github.com/newtonmunene99/mpesa-api) — B2C field reference
- [glama.ai — daraja_docs_v3 directory listing](https://glama.ai/mcp/servers/@JacksCodeVault/mpesa-daraja-mcp/tree/main/daraja_docs_v3/docs) — confirms M-Pesa Express and B2C both present in Daraja 3.0's own doc structure

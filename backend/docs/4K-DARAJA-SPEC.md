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
| mpesaReceiptNumber | text | set exactly once, on the first successful callback; never overwritten |
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
One row per B2C payout **attempt**. `escrowId` is `UNIQUE` — this is where "no double payout" is
enforced at the schema level, not just in application logic: the database physically cannot hold
two payout rows for the same escrow.

| column | type | notes |
|---|---|---|
| id | text PK | `PO-1000` |
| escrowId | text UNIQUE | FK → escrows.id |
| transporterId | text | FK → users.id (role `fleet_owner`) |
| amount | real | copied from the escrow, not re-entered |
| phoneNumber | text | transporter's payout MSISDN |
| status | text | `Pending → Requested → Confirmed \| Failed` |
| conversationId | text UNIQUE | Daraja's `ConversationID` — **the idempotency key** for the B2C callback |
| originatorConversationId | text | Daraja's `OriginatorConversationID` |
| transactionId | text | Daraja's M-Pesa transaction id for the payout leg; immutable once set |
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
     `reconciliation_flags` (`amount_mismatch`), do **not** mark paid. Match → set
     `payments.status = Paid`, `mpesaReceiptNumber` (write-once), then create the `escrows` row
     (`status = Held`, `heldAt = now`) in the same transaction. Log `payment_events`.
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

1. Re-check `escrow.status === RELEASE_PENDING` (409 otherwise — also closes a race: two rapid
   release calls can't both proceed, and the `payouts.escrowId UNIQUE` constraint is the
   belt-and-braces backstop even if the status check somehow raced).
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
  an easy field-name mixup to guard against in code review). Verify amount matches. Set
  `payouts.status = Confirmed`, `transactionId` (write-once), `escrows.status = Released` →
  immediately `Settled` (no further step needed once the payout is confirmed), `payment_events`
  logged at each.
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
schedules a call to our *own* callback endpoint after a short delay — exactly the real shape,
just sourced locally instead of over the internet. Takes a configurable outcome per call
(`success`, `insufficient_funds`, `cancelled_by_user`, `timeout` — never calls back at all,
`duplicate` — calls back twice, `wrong_amount` — deliberately mismatches the expected amount).
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
     -> second is 409; payouts.escrowId UNIQUE is the schema-level backstop    [no double payout, pt.2]
- B2C callback ResultCode != 0
     -> Payout -> Failed, Escrow stays ReleasePending (retryable, not stuck)   [no silent success]
- Duplicate B2C callback for an already-Confirmed ConversationID
     -> logged as duplicate, zero re-payout                                    [idempotency]
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

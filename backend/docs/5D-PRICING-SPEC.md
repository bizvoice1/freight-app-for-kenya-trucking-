# Phase 5D — Pricing, Counter-Offers & Difference Payment: Technical Specification

**Status: LOCKED (approved). Decisions in Section 14 are final; changes need explicit approval.**
Implementation proceeds sub-phase by sub-phase (Section 12). Mirrors the structure of `4K-DARAJA-SPEC.md` and builds on its ledger, idempotency and audit patterns.

## 0. Core principle

> The agreed price becomes immutable financial data once accepted, and any increase after money has
> already been collected is handled as a **separate payment adjustment**, never by rewriting the
> original payment.
>
> **Financial truth belongs to the booking and the ledger, not the mutable load UI.**

Worked example (the acceptance test in Section 11 reproduces it exactly):

| Step | `loads.price` | `bookings.agreedAmount` | Payments (Paid) | `escrows.amount` | Adjustments |
|---|---|---|---|---|---|
| Shipper posts load | 100,000 | – | – | – | – |
| Negotiation: T offers 110,000, S counters 105,000 | 100,000 | – | – | – | – |
| Offer 105,000 ACCEPTED, booking created | **100,000** | **105,000** | – | – | – |
| Initial payment (STK) confirmed | 100,000 | 105,000 | INITIAL 105,000 | 105,000 | – |
| Transporter proposes +10,000, shipper approves | 100,000 | 105,000 | INITIAL 105,000 | 105,000 | ADJ-1 APPROVED 10,000 |
| Separate STK for 10,000 confirmed | 100,000 | 105,000 | INITIAL 105,000 + ADJUSTMENT 10,000 | 115,000 | ADJ-1 FUNDED 10,000 |
| **Result** | unchanged | unchanged | – | **total obligation 115,000 = confirmed funding 115,000** | independently auditable |

`loads.price` is never changed to 115,000. `bookings.agreedAmount` is never changed to 115,000.
The INITIAL payment row is never edited. The +10,000 lives only in its own adjustment row and its own
payment row.

## 1. Current-state findings that drive this design

Surveyed from the code at commit `80ff976`:

1. **Backend has no negotiation.** `POST /api/loads/:loadId/accept` is a one-step transporter accept at
   `loads.price`. `loads.price` is nullable and is the only price that exists.
2. **Payment amount is read from `loads.price` at payment time** (4K, `routes/bookings.js`), and
   `evaluateReleaseEligibility` requires `loadPrice === escrow.amount`. Any price change today would
   either mis-charge or permanently block release. This guard must be redefined (Section 6).
3. **Frontend counter-offers/auction are decorative.** Bids live in `localStorage` key
   `behari_bids_<loadId>` (written in `behari-freight-v2.jsx` BookModal, read/deleted in
   `behari-shipper-v2.jsx` DetailModal). Nothing reaches the backend. "Award" / "Accept" do not create
   a booking.
4. **The frontend never calls `/api/loads`, `/api/bookings`, or any payment endpoint.** The only
   authenticated backend calls are tracking reads and 5C-2's route lookup (`trackingApi.js`). Loads
   posted in the browser exist only in `behari_store_v2`; backend loads exist only via API/seed. These
   are two disconnected worlds today. **This is the largest scope question of 5D — see Section 9.4.**
5. The frontend creates its escrow before any transporter exists; the backend order is
   accept → pay → escrow. 5D follows the backend order. The frontend mock escrow is not touched.
6. One load = one booking = one price = one escrow (`bookings_load_id_unique`,
   `escrows_booking_id_unique`). Multi-truck slots in the frontend share one price.

## 2. Decisions (locked by the user, restated as requirements)

| # | Decision |
|---|---|
| D1 | Bounded two-way negotiation. Both sides may counter. **Cap: 5 offers per negotiation thread, counted across both parties (actor-neutral, Section 4.1).** Every offer carries an expiry. States: `PENDING, COUNTERED, ACCEPTED, REJECTED, EXPIRED, WITHDRAWN`. Acceptance is one transaction: accept offer, close competitors, create booking with the agreed amount. |
| D2 | `loads.price` = shipper's original posted budget, **immutable**. `bookings.agreedAmount` = contractual transport price snapshot, set once at booking creation, **never rewritten**. |
| D3 | A generic **payment-adjustment** mechanism. Each approved increase is a separate adjustment with its own reason, amount, approval, payment lifecycle and Daraja transaction. The original payment is never mutated. |
| D4 | Increases require **shipper approval**. Admin may resolve a *formally disputed* adjustment but may not silently change the commercial agreement (cannot edit `agreedAmount`, cannot edit an adjustment's amount, cannot create one). **No new adjustments once the trip is `Delivered`**; existing approved/in-flight ones finish per their state. |
| D5 | No "auction". Terminology is **"Accept Offers"**: several transporters may offer; the shipper chooses. No lowest-bid-wins logic anywhere. |
| D4a | **Adjustment snapshot invariant** (Section 5.7): an adjustment's amount, reason and the `agreedAmount` basis used for its cap check are frozen when it is created. Totals are always computed from adjustment/payment rows, never from `loads.price` or any mutable UI value. |
| D6 | **Multi-truck pricing is deferred.** One commercial booking and one price agreement per load, as today. The price is never split evenly across slots. Per-slot pricing is a later phase. |
| D7 | 5D owns generic adjustment + payment infrastructure. **5J** owns extra-distance rules and *feeds an approved adjustment into 5D* through the same API/service (Section 5.6). |

## 3. Data model

All new tables and columns are added by one drizzle migration (`drizzle-kit generate`) plus a
hand-written SQL migration for the triggers. Amounts are whole KSh stored as `real` to match the
existing money columns (display and validation treat them as integers; see I13).

### 3.1 `offers` (new)

One row per **offer in a negotiation thread**. A thread is `(loadId, transporterId)`. A counter does
not edit the previous row; it marks it `COUNTERED` and inserts a new row (full history, nothing
rewritten).

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `OFR-1000+` |
| `loadId` | text not null | |
| `transporterId` | text not null | `users.id`, role `fleet_owner` (thread owner) |
| `round` | integer not null | 1..5 |
| `proposerRole` | text not null | `transporter` \| `shipper` |
| `proposerId` | text not null | `users.id` of the actor |
| `amount` | real not null | KSh, positive |
| `note` | text | free text, max 500 chars |
| `status` | text not null | the six states |
| `closeReason` | text | `SUPERSEDED_BY_COUNTER`, `COMPETING_OFFER_ACCEPTED`, `ACCEPTED_AT_POSTED_PRICE`, `LOAD_NOT_OPEN`, `EXPIRED`, `REJECTED_BY_COUNTERPARTY`, `WITHDRAWN_BY_PROPOSER` |
| `expiresAt` | text not null | ISO, server-set |
| `parentOfferId` | text | previous offer in the thread |
| `idempotencyKey` | text | optional client key, Section 7.3 |
| `createdAt`, `updatedAt`, `resolvedAt` | text | |

Constraints (physical, not application-only):

- `UNIQUE(loadId, transporterId, round)` — a round number can exist once.
- `CHECK(round BETWEEN 1 AND 5)` — the cap is a schema fact.
- `offers_one_pending_per_thread` — partial unique on `(loadId, transporterId) WHERE status='PENDING'`.
- `offers_one_accepted_per_load` — partial unique on `(loadId) WHERE status='ACCEPTED'`.
- `UNIQUE(proposerId, idempotencyKey) WHERE idempotencyKey IS NOT NULL`.
- Indexes: `(loadId)`, `(transporterId)`, `(status, expiresAt)` for the expiry sweep.

### 3.2 `bookings` (additive columns)

| Column | Type | Notes |
|---|---|---|
| `agreedAmount` | real | set exactly once at insert; immutable after |
| `agreementSource` | text | `POSTED_PRICE` \| `OFFER` |
| `agreedOfferId` | text | the accepted `offers.id`; null for `POSTED_PRICE` |

`agreedAmount` is **nullable at the schema level only** (SQLite cannot add a NOT NULL column to
populated tables without a default; and legacy loads may have a null price). The application
invariant is: *every booking created after 5D has a non-null, positive `agreedAmount`.*

### 3.3 `payment_adjustments` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `ADJ-1000+` |
| `bookingId` | text not null | |
| `amount` | real not null | positive KSh increase. Decreases/credits are out of scope |
| `agreedAmountSnapshot` | real not null | booking `agreedAmount` at creation (5.7) |
| `capSnapshotPct` | real not null | cap percentage in force at creation (5.7) |
| `reasonCode` | text not null | `EXTRA_DISTANCE` (reserved for 5J), `WAITING_TIME`, `ROUTE_CHANGE`, `ADDITIONAL_CARGO`, `TOLLS_FEES`, `OTHER` |
| `reason` | text not null | 10–500 chars, mandatory human explanation |
| `status` | text not null | Section 4.2 |
| `source` | text not null | `MANUAL` \| `RULE` (5J) |
| `sourceRef` | text | rule-supplied dedupe key (5J); null for manual |
| `requestedById` | text not null | transporter user (or system principal for 5J) |
| `approvedById`, `approvedAt` | text | shipper (or admin on resolution) |
| `approvalVia` | text | `SHIPPER` \| `ADMIN_RESOLUTION` |
| `rejectedById`, `rejectedAt`, `rejectReason` | text | |
| `approvalExpiresAt` | text not null | proposal lapses if unanswered |
| `fundingDueAt` | text | set on approval |
| `disputedAt`, `disputedById`, `disputeReason` | text | |
| `resolvedById`, `resolvedAt`, `resolutionDecision`, `resolutionNote` | text | admin resolution |
| `idempotencyKey` | text | optional |
| `createdAt`, `updatedAt` | text | |

Constraints:

- `adjustments_one_open_per_booking` — partial unique on `(bookingId) WHERE status IN ('PROPOSED','APPROVED','FUNDING','DISPUTED')`.
  One open adjustment per booking at a time. Sequential adjustments are allowed. This makes
  double-submit, concurrent approvals, and "release while an adjustment is open" all
  physically simple.
- `UNIQUE(bookingId, sourceRef) WHERE sourceRef IS NOT NULL` — a 5J rule can never create the same
  adjustment twice.
- `UNIQUE(requestedById, idempotencyKey) WHERE idempotencyKey IS NOT NULL`.
- `CHECK(amount > 0)`.
- Index `(bookingId)`.

### 3.4 `payments` (additive columns)

| Column | Type | Notes |
|---|---|---|
| `purpose` | text not null default `'INITIAL'` | `INITIAL` \| `ADJUSTMENT` |
| `adjustmentId` | text | required iff `purpose='ADJUSTMENT'` |

New constraints:

- `payments_one_paid_initial_per_booking` — partial unique `(bookingId) WHERE purpose='INITIAL' AND status='Paid'`.
- `payments_one_paid_per_adjustment` — partial unique `(adjustmentId) WHERE status='Paid'`.
- The existing `payments_one_inflight_per_booking` already serializes: **at most one in-flight
  payment (any purpose) per booking.** An adjustment payment cannot overlap another STK request.
- `CHECK((purpose='INITIAL' AND adjustmentId IS NULL) OR (purpose='ADJUSTMENT' AND adjustmentId IS NOT NULL))`.

### 3.5 `escrows`

No new columns. Meaning is made precise: **`escrows.amount` = total confirmed funding currently held**
(initial + funded adjustments). It is changed in exactly one place besides initial insert: the
adjustment STK callback transaction (Section 6.2), and only while `status='HELD'`.

### 3.6 Audit

No new audit table. `payment_events` is generic text-typed, so 5D adds entity types `offer` and
`adjustment` and writes every transition with `requestId`, same append-only discipline as 4K.
`reconciliation_flags` gains types listed in Section 6.5.

### 3.7 Immutability triggers (SQL migration)

Defense in depth, so a future code path cannot violate the principle:

- `loads_price_immutable` — `BEFORE UPDATE OF price ON loads WHEN OLD.price IS NOT NEW.price` → `RAISE(ABORT,'loads.price is immutable')`.
- `bookings_agreed_amount_immutable` — `BEFORE UPDATE OF agreed_amount ON bookings WHEN OLD.agreed_amount IS NOT NULL AND NEW.agreed_amount IS NOT OLD.agreed_amount` → abort. (Allows the one-time legacy backfill from NULL.)
- `payments_amount_immutable` — `BEFORE UPDATE OF amount ON payments WHEN NEW.amount IS NOT OLD.amount` → abort.
- `payment_adjustments_amount_immutable` — same for `payment_adjustments.amount`.
- `offers_amount_immutable` — same for `offers.amount`.

## 4. State machines

### 4.1 Offer

```
                    ┌─ counterparty counter ─▶ COUNTERED (terminal for this row; new PENDING row, round+1)
 (new) ─▶ PENDING ──┼─ counterparty accept  ─▶ ACCEPTED  (booking created in the same txn)
                    ├─ counterparty reject  ─▶ REJECTED
                    ├─ proposer withdraw    ─▶ WITHDRAWN
                    ├─ expiresAt reached    ─▶ EXPIRED
                    └─ competitor accepted / posted-price accepted / load not Open ─▶ REJECTED (closeReason set)
```

All five non-PENDING states are terminal. There are no edges out of them.

**Actor-neutral five-offer rule.** The cap is a property of the *thread*, not of a role:

- A thread is `(loadId, transporterId)` and holds **at most 5 offer rows in total**, whichever party
  proposed each one. `round` is simply the 1-based position of the row in the thread
  (`round = count of existing rows + 1`). Nothing in the schema, service or API assumes which role
  proposes an odd or an even round; `proposerRole` / `proposerId` on each row are the only record of
  who proposed it.
- Only the thread-opening row (round 1) has a fixed proposer: a transporter (the shipper cannot open a
  thread, Section 5.1).
- Row 5 is the **final offer**. No counter is allowed on it (409 `FINAL_ROUND`, enforced by the service
  and by `CHECK(round BETWEEN 1 AND 5)`). Only its **non-proposer** may accept or reject it; its
  proposer may still withdraw it.
- The cap never resets. A thread that was rejected, expired, withdrawn or exhausted is dead: the same
  transporter cannot open another thread on the same load (`THREAD_EXISTS`).

Only the **non-proposer** of the current `PENDING` offer may accept, reject, or counter it. Only the
**proposer** may withdraw it. Nobody else (including admin) acts on offers.

### 4.2 Adjustment

```
 PROPOSED ──shipper approve──▶ APPROVED ──shipper starts payment──▶ FUNDING ──callback Paid──▶ FUNDED (terminal)
    │  │  │                       │  ▲                                  │
    │  │  └─approvalExpiresAt─▶ EXPIRED                                 └─callback Failed/Cancelled/Timeout─▶ APPROVED (retryable)
    │  └─transporter withdraw─▶ WITHDRAWN        APPROVED ─transporter withdraw─▶ WITHDRAWN
    └─shipper reject─▶ REJECTED                   APPROVED past fundingDueAt ─transporter dispute─▶ DISPUTED
                          └─transporter dispute (≤ 48h)─▶ DISPUTED
 DISPUTED ──admin UPHOLD──▶ APPROVED (approvalVia=ADMIN_RESOLUTION; shipper still funds; fundingDueAt reset)
 DISPUTED ──admin DISMISS─▶ REJECTED (terminal)
 PROPOSED ──trip reaches Delivered──▶ EXPIRED (closeReason TRIP_DELIVERED)
```

Notes:

- `FUNDING` is in-flight: it cannot be withdrawn or disputed. It resolves only via payment callback.
- A **failed** adjustment STK returns the adjustment to `APPROVED`; the failed `payments` row stays
  `Failed` forever and recovery is a **new** payment row, exactly as in 4K ("Failed never silently
  becomes successful").
- `FUNDED`, `REJECTED`, `WITHDRAWN`, `EXPIRED` are terminal.
- Admin `UPHOLD` approves the **exact amount proposed**. Admin cannot edit amount, reason, or the
  booking. A different amount means the transporter proposes a new adjustment and the shipper approves it.

### 4.3 Interaction with existing machines

Booking, trip and escrow state machines are **unchanged**. The only coupling points are:

1. Booking creation now sets `agreedAmount` (Section 5.2).
2. Initial payment amount comes from `agreedAmount` (Section 6.1).
3. The Delivered hook expires PROPOSED adjustments and evaluates release with the new guard (Section 6.3).
4. The adjustment-payment callback may raise `escrows.amount` while `HELD` (Section 6.2).

## 5. Behaviour rules

### 5.1 Making and answering offers

- Preconditions for any offer action: load `status='Open'`; actor authorized (Section 8); offer not
  expired (re-checked inside the transaction against the **server clock**).
- Submitting: transporter only; no existing thread for this `(load, transporter)` (else 409 "thread
  exists — counter instead"); `amount` validation (Section 5.5).
- Countering: non-proposer of the current `PENDING` offer; `round < 5` (row count in the thread, not a role); new row inserted and parent
  marked `COUNTERED` **in one transaction**.
- The shipper may not open a thread for a transporter who has not offered (no direct invitations in 5D).
- Expiry: default TTL 24h (`OFFER_TTL_HOURS`), request-overridable within 1h–72h, never later than the
  load's `pickupDate` when that parses. Enforcement is **both** lazy (any read/act treats
  `expiresAt <= now` as expired and refuses the action) **and** a sweeper (`expireDueOffers()` on a
  60s interval and at startup) that writes `EXPIRED` + audit event. Lazy enforcement means a late
  sweeper can never let an expired offer be accepted.

### 5.2 Acceptance (the critical transaction)

`POST /api/offers/:id/accept` runs as **one synchronous better-sqlite3 transaction** (no `await`
inside, as in 4K's STK callback):

1. Re-read the offer: must be `PENDING`, not expired, actor is the non-proposer.
2. Re-read the load: must be `Open`.
3. Mark this offer `ACCEPTED` (`offers_one_accepted_per_load` guards).
4. Mark every other `PENDING` offer on the load `REJECTED`, `closeReason=COMPETING_OFFER_ACCEPTED`.
5. Insert the booking: `transporterId = offer.transporterId`, `agreedAmount = offer.amount`,
   `agreementSource='OFFER'`, `agreedOfferId = offer.id`, `status='Accepted'`.
6. Set `loads.status='Booked'`.
7. Write `payment_events` rows for every offer transition and the booking creation.

`bookings_load_id_unique` remains the ultimate guard: if a racing `POST /loads/:id/accept` (posted
price) or another offer acceptance wins, the loser gets 409 `LOAD_NO_LONGER_OPEN` / `OFFER_NOT_PENDING`
and **nothing partial persists**. Notifications are sent after commit.

The existing `POST /api/loads/:loadId/accept` is kept as the **posted-price path**: same transaction
shape, `agreedAmount = loads.price`, `agreementSource='POSTED_PRICE'`, plus closing all `PENDING`
offers (`ACCEPTED_AT_POSTED_PRICE`). A load with `price IS NULL` cannot be accepted at posted price
(409 `NO_POSTED_PRICE`); offers are the only route.

### 5.3 Adjustments

- **Create** (`POST /bookings/:id/adjustments`, the booking's transporter): allowed only when **all** hold:
  1. booking status is `Assigned` or `Trip Created`;
  2. the booking's escrow exists and is `HELD` (initial funding confirmed — before money is collected
     the agreed price simply stands, there is nothing to "adjust");
  3. no trip for the booking is `Delivered` or `Cancelled`;
  4. no other open adjustment on the booking (index above);
  5. amount/limits pass (Section 5.5).
- **Approve / reject** (the load's shipper): `PROPOSED` and `approvalExpiresAt` not passed (default 48h,
  `ADJUSTMENT_APPROVAL_HOURS`). Approving sets `fundingDueAt = now + 48h` (`ADJUSTMENT_FUNDING_HOURS`).
- **Fund** (`POST /adjustments/:id/payment`, the shipper): `APPROVED` only. Creates a `payments` row
  (`purpose='ADJUSTMENT'`, `adjustmentId`, `amount = adjustment.amount` — **never from the body**) and
  sets the adjustment `FUNDING` in one transaction, then calls Daraja exactly as 4K does.
- **Withdraw** (transporter): from `PROPOSED` or `APPROVED`, not `FUNDING`/`FUNDED`.
- **Dispute / resolve**: Section 4.2. Admin resolution requires a `resolutionNote` and is audited.
- **Delivered hook**: in the same transaction as the trip status write, every `PROPOSED` adjustment on
  the booking becomes `EXPIRED` (`TRIP_DELIVERED`). `APPROVED`/`FUNDING`/`DISPUTED` ones continue.
  Rationale: the transporter must not be able to hold payout hostage with an unanswered request, and
  the shipper must not be able to approve a new claim after delivery.
- **Both race orders are deterministic**: shipper-approve vs Delivered are both synchronous
  transactions; whichever commits first wins and the other re-reads and gets 409.

### 5.4 Post-delivery behaviour of open adjustments

Release stays blocked (Section 6.3) while an adjustment is `APPROVED`, `FUNDING`, or `DISPUTED`.
Ways out: shipper funds it; transporter withdraws it (`APPROVED` only); admin resolves a dispute.
`fundingDueAt` passing does not auto-cancel anything. It only unlocks the transporter's **dispute**
option, and raises a reconciliation flag `adjustment_unfunded_blocking_release` (ops visibility).
**Known limitation (explicitly accepted):** an upheld-but-never-funded adjustment keeps the escrow
unreleased; forfeiture/refund/cancellation mechanics belong to the later dispute/refund phases, not 5D.

### 5.5 Validation and guards (all server-side, configurable)

- Offer/adjustment `amount`: finite, integer-valued, `> 0`, and `<= 100,000,000` absolute.
- Offer sanity band: when `loads.price` is set, `0.2 × price <= amount <= 3 × price`, else 422
  `AMOUNT_OUT_OF_BAND` (fat-finger guard; `OFFER_BAND_MIN/MAX`).
- Cumulative cap: `Σ(adjustments in APPROVED/FUNDING/FUNDED) + new <= ADJUSTMENT_MAX_PCT × agreedAmount`
  (default **25%**), else 422 `ADJUSTMENT_CAP_EXCEEDED`. No override in 5D.
- `note`/`reason` trimmed, length-bounded, stored verbatim, rendered as text only (never HTML).

### 5.6 Hand-off contract for 5J (extra-distance charges)

5J must not write money tables itself. It calls a single service function
`proposeAdjustment({ bookingId, amount, reasonCode:'EXTRA_DISTANCE', reason, source:'RULE', sourceRef })`.
`sourceRef` (e.g. `trip:TRIP-1003:extra-km:v1`) makes it idempotent through the unique index. The
result enters the same lifecycle: **shipper approval, cap, one-open-adjustment, no-post-Delivered**.
5J gets no bypass. Whether a rule may *pre*-authorize (shipper opts in at booking) is a 5J decision.

### 5.7 Adjustment snapshot invariant

An adjustment is a **frozen commercial fact**, not a live calculation:

1. At creation the row stores `amount`, `reasonCode`, `reason`, and the **basis snapshot** used for its
   validation: `agreedAmountSnapshot` (the booking's `agreedAmount` at that moment) and
   `capSnapshotPct` (the effective `ADJUSTMENT_MAX_PCT`). Later configuration changes never re-evaluate
   adjustments that already exist.
2. After creation the row is never edited. Only `status` and its lifecycle columns (approval,
   rejection, funding, dispute, resolution timestamps and actors) change, by state transition.
   `payment_adjustments_amount_immutable` backstops the amount; the service exposes no edit endpoint.
3. Every total (`totalObligation`, `outstanding`, cap checks) is computed from `bookings.agreedAmount`
   plus adjustment and payment rows via `computeLedger`. **`loads.price` and any frontend value are
   never an input.**
4. A cap check runs against the persisted rows at transaction time; two racing proposals cannot both
   pass because only one open adjustment per booking can exist.

The `payment_adjustments` table and its enforcement land in 5D-2. 5D-1 ships the invariant's
prerequisite: `agreedAmount` immutability and the ledger function it will read.

## 6. Financial invariants (the contract)

| # | Invariant | Enforced by |
|---|---|---|
| I1 | `loads.price` never changes after insert | trigger `loads_price_immutable` |
| I2 | `bookings.agreedAmount` is set once at booking insert and never rewritten | trigger + only the two accept transactions write it |
| I3 | Initial payment `amount == agreedAmount` at creation; payment amounts never change | server computes it; trigger `payments_amount_immutable` |
| I4 | `totalObligation = agreedAmount + Σ amount(adjustments in APPROVED, FUNDING, FUNDED)` | pure function `computeLedger(bookingId)`, the only definition |
| I5 | `confirmedFunding = Σ amount(payments with status Paid for the booking)` | same function; derived from `payments`, never stored separately |
| I6 | `escrows.amount == confirmedFunding` at all times | the only writers are the initial-callback insert and the adjustment-callback txn (6.2); `computeLedger` asserts it; a violation raises a reconciliation flag and **blocks release** |
| I7 | An escrow is releasable only if `escrows.amount == totalObligation` **and** no adjustment is `PROPOSED/APPROVED/FUNDING/DISPUTED` | redefined `evaluateReleaseEligibility` |
| I8 | Release pays exactly `escrows.amount` (== `totalObligation`) | `POST /escrows/:id/release` unchanged except the guard in I7 |
| I9 | Client never supplies an amount for any payment | amounts derived from `agreedAmount` / `adjustment.amount` |
| I10 | At most one in-flight payment per booking; at most one Paid INITIAL per booking; at most one Paid payment per adjustment | partial unique indexes (3.4) |
| I11 | Payment `Paid` + adjustment `FUNDED` + `escrows.amount` increase + audit events are **atomic** | one synchronous transaction (callback handler must stay non-async) |
| I12 | A callback replay never double-credits | existing `checkoutRequestId` lookup, "ignore if not StkSent", amount-equality check, duplicate-receipt flag — unchanged and applied identically to `purpose='ADJUSTMENT'` |
| I13 | Money values are positive integers of KSh at the API boundary | validation (5.5) |
| I14 | One open adjustment per booking | partial unique index (3.3) |
| I15 | Adjustments cannot be created or approved after `Delivered` | checks in 5.3 + Delivered hook |
| I16 | Admin cannot change a price, an agreed amount, or an adjustment amount | no endpoint exists that accepts them; triggers backstop |
| I17 | Failed/Cancelled/Timeout payments are attempt-scoped and never become Paid | unchanged from 4K |
| I18 | An adjustment's amount, reason and cap basis are frozen after creation; totals derive only from booking/adjustment/payment rows, never `loads.price` | 5.7; trigger; `computeLedger` |
| I19 | A negotiation thread never exceeds 5 offer rows regardless of proposer role | `CHECK(round BETWEEN 1 AND 5)` + `UNIQUE(loadId, transporterId, round)` |

### 6.1 Initial payment (changed source of amount)

`POST /bookings/:id/payment` now derives `amount` from `booking.agreedAmount`. For legacy bookings
whose backfill left it null (load had no price) the endpoint 409s exactly as today. The
`purpose='INITIAL'` column default means 4K code paths keep working unmodified otherwise.

### 6.2 Adjustment payment callback (additive branch in the existing STK handler)

After all existing 4K checks pass and `purpose='ADJUSTMENT'`, in the **same** synchronous transaction:
payment → `Paid` (+ receipt), adjustment `FUNDING → FUNDED`, `escrows.amount += payment.amount`
(only if escrow is `HELD`; otherwise do **not** credit and instead raise
`adjustment_paid_escrow_not_held` for manual reconciliation — money was received, it must be visible),
write `payment_events` for payment, adjustment and escrow. On `Failed/Cancelled/Timeout`: payment →
that status, adjustment `FUNDING → APPROVED`, audit event, notify shipper.

### 6.3 Release-guard replacement

`evaluateReleaseEligibility({ escrow, ledger, openAdjustments, trip })` replaces the
`loadPrice === escrow.amount` comparison. Eligibility requires the I7 conditions plus the existing
ones. `maybeMakeEscrowEligibleForRelease` is also re-evaluated after an adjustment becomes `FUNDED`
or is withdrawn/resolved **if the trip is already Delivered** (so a late-funded adjustment moves
`HELD → RELEASE_PENDING` and notifies admin + transporter, same as today).

### 6.4 `GET /bookings/:id/ledger` is the read model

The frontend never derives money from `load.price`. This endpoint returns
`{ agreedAmount, adjustments[], payments[], escrow, totals:{ agreed, approvedAdjustments,
totalObligation, confirmedFunding, outstanding } }`, where `outstanding = totalObligation −
confirmedFunding`.

### 6.5 New reconciliation flag types

`escrow_ledger_mismatch` (I6 violated), `adjustment_paid_escrow_not_held`,
`adjustment_unfunded_blocking_release`, `adjustment_payment_amount_mismatch` (callback amount ≠
`payment.amount`; same treatment as 4K's wrong-amount case).

## 7. API contracts

All routes: `requireAuth`, `asyncHandler`, per-request id in audit events. Bodies are validated;
amounts are never trusted as "paid". Error body is always `{ error, code }`.

### 7.1 Offers

| Method & path | Actor | Body | Success | Notable errors |
|---|---|---|---|---|
| `POST /api/loads/:loadId/offers` | transporter | `{ amount, note?, ttlHours? }` | 201 offer (round 1) | 409 `LOAD_NOT_OPEN`, 409 `THREAD_EXISTS`, 422 `AMOUNT_OUT_OF_BAND`, 403 |
| `POST /api/offers/:id/counter` | counterparty | `{ amount, note?, ttlHours? }` | 201 new offer (round+1) | 409 `OFFER_NOT_PENDING`, 409 `OFFER_EXPIRED`, 409 `FINAL_ROUND`, 403 |
| `POST /api/offers/:id/accept` | counterparty | – | 201 `{ offer, booking }` | 409 `OFFER_NOT_PENDING` / `OFFER_EXPIRED` / `LOAD_NO_LONGER_OPEN`, 403 |
| `POST /api/offers/:id/reject` | counterparty | `{ reason? }` | 200 offer | 409, 403 |
| `POST /api/offers/:id/withdraw` | proposer | – | 200 offer | 409, 403 |
| `GET /api/loads/:loadId/offers` | shipper (all threads), transporter (own thread only), admin (all, read-only) | – | 200 `{ offers[] }` | 403 |
| `GET /api/offers?role=&status=` | shipper/transporter inbox | – | 200 | – |
| `POST /api/loads/:loadId/accept` (existing) | transporter | – | 201 booking | + 409 `NO_POSTED_PRICE` |

Competitor privacy: a transporter **never** sees another transporter's offers, amounts, or the count of
competing offers. The shipper sees all threads for their own loads.

### 7.2 Adjustments and ledger

| Method & path | Actor | Body | Success |
|---|---|---|---|
| `POST /api/bookings/:id/adjustments` | booking's transporter | `{ amount, reasonCode, reason }` | 201 `PROPOSED` |
| `GET /api/bookings/:id/adjustments`, `GET /api/adjustments/:id` | shipper / transporter of booking, admin | – | 200 |
| `POST /api/adjustments/:id/approve` | load's shipper | – | 200 `APPROVED` |
| `POST /api/adjustments/:id/reject` | load's shipper | `{ reason }` | 200 `REJECTED` |
| `POST /api/adjustments/:id/withdraw` | transporter | – | 200 `WITHDRAWN` |
| `POST /api/adjustments/:id/payment` | load's shipper | `{ phoneNumber? }` (same field handling as `/bookings/:id/payment`) | 202 payment + adjustment `FUNDING` |
| `POST /api/adjustments/:id/dispute` | transporter | `{ reason }` | 200 `DISPUTED` |
| `POST /api/adjustments/:id/resolve` | admin | `{ decision:'UPHOLD'\|'DISMISS', note }` | 200 |
| `GET /api/bookings/:id/ledger` | shipper / transporter of booking, admin | – | 200 (6.4) |

Error codes: `ADJUSTMENT_NOT_ALLOWED_STATE`, `ESCROW_NOT_HELD`, `TRIP_ALREADY_DELIVERED`,
`OPEN_ADJUSTMENT_EXISTS`, `ADJUSTMENT_CAP_EXCEEDED`, `ADJUSTMENT_EXPIRED`, `PAYMENT_IN_FLIGHT`.

### 7.3 Idempotency and concurrency

Layered like 4K (no single middleware is assumed to catch everything):

```
double-click create offer      → UNIQUE(load, transporter, round) + one-PENDING index → 409
double-click counter           → parent already COUNTERED → 409 OFFER_NOT_PENDING
double-click accept            → second sees ACCEPTED → 409 (no second booking: bookings_load_id_unique)
two transporters win at once   → offers_one_accepted_per_load / bookings_load_id_unique; loser 409, nothing partial
offer-accept vs posted-price   → same booking unique index; one winner, loser re-read → 409
double-click propose adjustment→ adjustments_one_open_per_booking → 409 (or replay via Idempotency-Key)
double-click approve           → second sees APPROVED → 409
double-click fund              → payments_one_inflight_per_booking → 409 PAYMENT_IN_FLIGHT
STK callback replayed          → checkoutRequestId lookup, not StkSent → ignored, zero writes
approve vs trip Delivered      → both synchronous txns; second re-reads state → 409
```

Optional `Idempotency-Key` header on offer/adjustment creation: same key by the same actor returns the
original resource with `200` and header `Idempotent-Replay: true` instead of a 409.

## 8. Authorization (extends 4I; anti-enumeration kept)

| Action | shipper (owner of load) | transporter (thread/booking owner) | other shipper/transporter | driver | admin |
|---|---|---|---|---|---|
| Submit offer | – | yes | transporters yes (own new thread); shippers 403 | 403 | 403 |
| Counter/accept/reject offer | if proposer was the transporter | if proposer was the shipper | 403 | 403 | 403 |
| Withdraw offer | if own | if own | 403 | 403 | 403 |
| Read offers | all threads on own load | own thread only | 403 (never reveals existence) | 403 | read-only |
| Propose/withdraw adjustment | – | yes | 403 | 403 | 403 |
| Approve/reject/fund adjustment | yes | – | 403 | 403 | 403 |
| Dispute adjustment | – | yes | 403 | 403 | 403 |
| Resolve dispute | – | – | – | – | yes (UPHOLD/DISMISS only) |
| Read ledger | yes | yes | 403 | 403 | yes |

Out-of-scope ids follow the existing rule: **403, not 404**, so existence is not leaked. Drivers have no
commercial visibility. Admin has no write path to prices, agreed amounts, or adjustment amounts.

## 9. Frontend behaviour

### 9.1 Terminology (D5)
"Auction", "Auction mode", "Highest/Lowest bid" are removed. Shipper post form toggle becomes
**"Accept offers from transporters"**; transporter side says **"Make an offer"**. No UI element ranks
offers by price or auto-selects. Price is shown beside rating, truck type, distance, and ETA; the
shipper picks.

### 9.2 Transporter
Booking sheet offers two actions: **Accept at KSh X** (posted-price path, direct booking) and
**Make an offer** (amount + optional note + expiry display). Thread view shows rounds, who is to act,
remaining rounds (`2 of 5 used`), expiry countdown, and a clear "final offer" state at round 5.
After acceptance the card shows `agreedAmount` (labelled "Agreed price"), never `load.price`, with
"Posted: KSh 100,000" shown as secondary history when different.

### 9.3 Shipper
Detail modal lists offers per transporter thread (offers are never shown to other transporters).
Actions: Accept, Counter (amount), Reject. After booking: "Agreed price" row; **Pay agreed price**;
**Adjustments** panel with proposal cards (amount, reason, reasonCode, expiry), Approve / Reject, and
**Pay adjustment** once approved. A ledger summary row shows Agreed, Approved adjustments,
Total, Paid, Outstanding **from `GET /ledger`**.

### 9.4 Backend-linked loads: the bridge (locked: Option A, delivered in 5D-1, money-free)

Because the frontend currently never touches backend loads (Section 1.4), a bridge is required. It is
delivered in **5D-1** and is strictly money-free:

- Posting a load in the UI also calls `POST /api/loads` (shipper token via the same demo-credential
  bridge used by `trackingApi.js`) and stores the returned `backendLoadId` on the frontend load.
  The frontend load still exists and renders exactly as today; the backend copy is the commercial record.
- The bridge sends the load's descriptive fields and posted price only. It creates **no** offers,
  bookings, payments or escrows, and it changes no existing frontend money display or flow.
- Failure is non-blocking: if the backend is unreachable the load posts locally as today and carries
  no `backendLoadId`; it is treated like a demo load until a later retry/sync.
- Frontend-only seed/demo loads (no `backendLoadId`) render a neutral note
  ("Demo load — negotiation unavailable") where negotiation will later appear and keep today's behaviour.
- The offers UI, adjustments UI, ledger rows and terminology changes remain in **5D-4**.

### 9.5 Failure behaviour
Backend unreachable or 403 for a load: show "Negotiation unavailable" and fall back to read-only
display. **No fallback to localStorage bids**, because that is the exact decorative behaviour 5D
removes. The `behari_bids_*` keys are deleted on first load of the new build.

### 9.6 Safety UX
Every money action shows the exact server-computed amount and phone number before the STK push;
nothing is optimistic. Buttons disable while a request is in flight; 409s are shown as "already
done"/"no longer available" rather than raw errors.

## 10. Migration strategy

1. **Schema**: additive migration (new tables, new nullable columns, indexes). No column drops, no
   rewrites of existing rows beyond step 2.
2. **Backfill** (one idempotent SQL step in the same migration): for every existing booking,
   `agreedAmount = loads.price` (via `bookings.load_id`), `agreementSource = 'POSTED_PRICE'`. Rows
   whose load has a null price stay null and keep today's behaviour (payment 409). Backfill runs
   **before** the immutability trigger on `bookings.agreed_amount` is created.
3. **Existing payments** get `purpose='INITIAL'` (column default). Existing escrows already satisfy
   `escrows.amount == Σ Paid payments`.
4. **Existing in-flight 4K data** needs no change: any booking mid-payment keeps its original payment
   row; the callback handler's new branch only activates for `purpose='ADJUSTMENT'`.
5. **Triggers** (Section 3.7) are created last, in a separate hand-written migration file.
6. **Rollback**: all additions are additive and ignorable by the previous code. Reverting code leaves
   extra tables/columns in place; the one behavioural difference would be `loadPrice === escrow.amount`
   coming back, which is correct for any booking that has no funded adjustments.
7. **Seed**: demo data adds no offers/adjustments by default; test suites create their own.

## 11. Acceptance tests

New suite `backend/scripts/acceptance-5d.mjs` (`npm run test:5d`): real HTTP against a clean seeded DB,
same helpers as `acceptance-4k.mjs`. The six existing suites (`test:4k` 19, `test:4l` 9,
`test:regression` 13, `test:4m` 24, `test:5c1` 8, `test:5c2` 9 — exact scripts per `package.json`) must
stay green **unmodified**; the only permitted edits to them are where an assertion encodes
`loadPrice === escrow.amount` as a *price-change* expectation (expected: none).

**A. Offers and negotiation**
1. Transporter offers 110,000 on a 100,000 load → 201 round 1 PENDING; load price unchanged.
2. Shipper counters 105,000 → parent COUNTERED, new row round 2 PENDING, proposerRole shipper.
3. Proposer cannot accept/reject/counter their own PENDING offer → 403/409.
4. Third-party transporter / other shipper / driver cannot read or act on the thread → 403; a second
   transporter cannot see the first transporter's offers.
5. Rounds 3, 4, 5 succeed; counter on round 5 → 409 `FINAL_ROUND`; sixth offer impossible (schema CHECK
   verified by direct insert attempt in the test harness).
6. Shipper may accept or reject the final offer.
7. Expired offer: set `expiresAt` in the past → accept 409 `OFFER_EXPIRED` even **before** the sweeper
   runs; sweeper then marks EXPIRED + audit event.
8. Withdraw: only proposer; counterparty then gets 409 on accept.
9. Out-of-band amount (e.g. 5,000 on 100,000; negative; NaN; string; array) → 422/400, never 500.

**B. Acceptance and booking immutability**
10. Accept 105,000 → booking `agreedAmount=105,000`, `agreementSource=OFFER`, load Booked; `loads.price`
    still 100,000.
11. Competing PENDING offers from two other transporters are REJECTED with `COMPETING_OFFER_ACCEPTED`.
12. **Race**: two shipper-accept calls for two different offers fired in parallel → exactly one booking,
    one ACCEPTED offer, loser 409, no partial state (assert counts).
13. **Race**: transporter posted-price accept vs shipper offer accept in parallel → exactly one booking.
14. Direct SQL `UPDATE bookings SET agreed_amount=…`, `UPDATE loads SET price=…`,
    `UPDATE payments SET amount=…` all abort via triggers.
15. Posted-price accept sets `agreedAmount = loads.price`, source `POSTED_PRICE`, rejects pending offers.
16. Load with null price: posted-price accept → 409 `NO_POSTED_PRICE`; offer route works.

**C. Initial payment and escrow**
17. Initial STK amount equals `agreedAmount` (105,000), not `loads.price`; body amount ignored.
18. Callback confirms → INITIAL payment Paid, escrow HELD with amount 105,000.

**D. Adjustments (the user's worked example)**
19. Before initial funding: propose adjustment → 409 `ESCROW_NOT_HELD`.
20. After funding: transporter proposes +10,000 → PROPOSED; amounts unchanged everywhere.
21. Shipper cannot be bypassed: transporter/admin/driver cannot approve or fund → 403.
22. Shipper approves → APPROVED, `fundingDueAt` set; `agreedAmount` and `loads.price` still unchanged.
23. Shipper funds → separate payment row `purpose=ADJUSTMENT` amount 10,000 (body amount ignored), adjustment
    FUNDING; second fund click → 409 `PAYMENT_IN_FLIGHT`.
24. Callback success → payment Paid, adjustment FUNDED, `escrows.amount = 115,000`; **INITIAL payment row
    byte-for-byte unchanged**; ledger totals: agreed 105,000, approved adjustments 10,000, obligation
    115,000, confirmed funding 115,000, outstanding 0.
25. Callback replay (same checkoutRequestId), duplicate receipt, wrong amount → no double credit; flags
    raised for wrong amount.
26. Failed adjustment STK → adjustment back to APPROVED, escrow unchanged, retry creates a **new** payment
    row; the failed row stays Failed.
27. Second adjustment while one is open → 409 `OPEN_ADJUSTMENT_EXISTS`; after FUNDED a second adjustment
    is accepted until the 25% cap, then 422 `ADJUSTMENT_CAP_EXCEEDED`.
28. Propose twice rapidly (parallel) → exactly one row; with the same Idempotency-Key → replay returns the
    original.

**E. Release and delivery**
29. Delivered with fully funded adjustments → escrow RELEASE_PENDING; admin release pays **115,000**; payout
    confirmed → SETTLED.
30. Delivered with an `APPROVED` unfunded adjustment → escrow stays HELD (not RELEASE_PENDING); funding it
    later (trip already Delivered) moves HELD → RELEASE_PENDING and notifies admin + transporter.
31. Delivered with a `PROPOSED` adjustment → auto-EXPIRED (`TRIP_DELIVERED`); release proceeds on base
    funding.
32. After Delivered: propose → 409 `TRIP_ALREADY_DELIVERED`; approve of an expired proposal → 409.
33. Race: shipper approve vs trip→Delivered in parallel → consistent outcome (either approved-and-blocking or
    expired-and-releasable), never both.
34. Direct manipulation of `escrows.amount` to mismatch → `computeLedger` flags `escrow_ledger_mismatch`
    and release is refused.

**F. Disputes (5D-5, may ship later)**
35. Transporter disputes a REJECTED proposal (≤48h) → DISPUTED; admin DISMISS → REJECTED; UPHOLD → APPROVED
    via `ADMIN_RESOLUTION`, shipper still has to fund; admin cannot change the amount (field ignored/422).

**G. Frontend (browser click-through, zero unexplained console errors)**
36. Transporter submits an offer in the UI; shipper counters; transporter accepts; booking shows "Agreed
    price".
37. UI never reads price from `load.price` after booking (ledger endpoint drives money rows).
38. Auction labelling gone; localStorage bids gone; demo-only loads show the neutral unavailable note.

**H. Regression**
39. Six existing suites green on a clean seed; `test:5d` green; servers stopped and DB reset to clean seed.

**I. Bridge and actor-neutral cap (5D-1)**
40. Posting a load in the UI creates a backend load with the same posted price and stores `backendLoadId`;
    no offer, booking, payment or escrow row is created by the bridge.
41. Backend unreachable at post time → the load still posts locally, with no `backendLoadId`, and no error
    surfaces; demo-only loads show the neutral note.
42. Actor-neutral cap: a thread holds at most 5 rows whichever party proposed them; a sixth insert is rejected
    by the schema; the cap does not reset after a rejection (`THREAD_EXISTS`); the proposer of row 5 can
    withdraw but cannot accept, and only the non-proposer can accept or reject it.

## 12. Implementation sequence (each separately verifiable and committed)

| Sub-phase | Scope |
|---|---|
| **5D-1** | Schema + migration + backfill + triggers (loads/bookings/payments/offers); `offers` API; transactional acceptance; `bookings.agreedAmount`; posted-price path updated; initial payment from `agreedAmount`; release guard switched to the ledger function (behaviour-equivalent when no adjustments); **money-free frontend bridge (9.4)**; tests A–C, I (40–42) |
| **5D-2** | `payment_adjustments` table, snapshot invariant (5.7), propose/approve/reject/withdraw/expire; Delivered hook; caps; `GET ledger`; tests D (19–22, 27–28), E (31–32) |
| **5D-3** | Adjustment payment (STK) lifecycle, callback branch, release interplay; tests D (23–26), E (29–30, 33–34) |
| **5D-4** | Frontend: offers UI, adjustments UI, ledger rows, terminology, localStorage bids removed; tests G (bridge itself already shipped in 5D-1) |
| **5D-5** | Dispute + admin resolution (explicitly deferred; money safety does not depend on it) |

## 13. Explicit out-of-scope for 5D

- Multi-truck / per-slot commercial pricing; splitting a price across slots (D6).
- Extra-distance rules, GPS-derived charges, or any automatic adjustment generation (5J).
- Price **decreases**, credits, partial refunds, forfeiture, cancellation fees, or refunds of funded
  adjustments (later dispute/refund phase).
- Editing `loads.price`, re-posting, or cancelling-and-reopening a booked load.
- Shipper-initiated invitations to specific transporters; broadcast/"best price" auctions; any
  automatic winner selection.
- Loading advance, milestone escrow, partial releases, per-milestone payouts (5G).
- Platform-fee/commission modelling in the backend ledger (payouts remain `escrow.amount` as today).
- Real-money cutover, Daraja production credentials, real SMS/push for offer notifications
  (in-app notifications via 4L only, new types `offer_received`, `offer_countered`,
  `offer_accepted`, `offer_rejected`, `adjustment_proposed`, `adjustment_approved`,
  `adjustment_funded`, `adjustment_rejected`).
- Admin editing of any commercial term; admin creating offers/adjustments.
- Rate limiting beyond what 4M/5C-2 already provide; pagination (pre-4N checklist).
- Cosmetic redesign; Phases 4A–4M behaviour (frozen) beyond the release-guard definition and the
  additive branches named above.

## 14. Locked decisions (previously open items)

1. **Frontend bridge:** Option A, inside 5D, delivered in 5D-1 and money-free (9.4).
2. **Cumulative adjustment cap = 25% of `agreedAmount`** and **offer sanity band = 0.2×–3× of posted
   price**; both configurable (`ADJUSTMENT_MAX_PCT`, `OFFER_BAND_MIN/MAX`).
3. **PROPOSED adjustments auto-expire when the trip reaches Delivered**; already-approved obligations
   (`APPROVED`/`FUNDING`/`DISPUTED`) remain and continue to block release (5.3, 5.4).
4. **Disputes are deferred to 5D-5.** Until then an approved-but-unfunded adjustment resolves only by the
   shipper funding it or the transporter withdrawing it (5.4 known limitation).
5. **Five-offer rule is actor-neutral** (4.1): at most 5 rows per thread, no role/parity assumption,
   row 5 final.
6. **Adjustment snapshot invariant** (5.7).

## 15. Road distance as a core domain rule (follow-up requirement, added after 5D-1)

Status: **requirement locked, not yet implemented.** It is a road-distance follow-up that builds on 5C-2 and
touches the same commercial inputs 5D prices against. It ships as its own commit before 5D-2 (or as a named
sub-phase the user chooses); it is **not** part of the 5D-1 commit. Before implementation, audit `e8aa123`
and the 5D-1 bridge against every rule below and report any gap.

### 15.1 Rules

1. **Commercial distance is drivable-road distance.** For any load with valid pickup and delivery
   coordinates, `load distance = Google Routes drivable-road distance`. Haversine, straight-line distance
   and hand-estimated city-to-city tables are never the commercial or contracted journey distance.
2. **Hierarchy:** exact pickup coords + exact delivery coords → Google Routes → drivable road distance →
   Behari commercial distance.
3. **Meter precision internally.** Store `distanceMeters` (integer) from Google. Display rounds to 0.1 km
   (`714,638 m` → `714.6 km by road`). Price per km is computed from meters
   (`KSh/km = price ÷ (distanceMeters / 1000)`), never from the rounded display value.
4. **Routes unavailable = estimate only for browsing.** If Google Routes is temporarily unavailable, the UI
   may show a clearly labelled *estimated corridor distance*, flagged `distanceSource = "ESTIMATE"`.
   An estimate **must not lock a commercial booking**: accepting at the posted price, accepting an offer,
   and initiating payment require a stored road-route distance (`distanceSource = "ROAD"`). Server-side
   guard returns 409 `ROAD_DISTANCE_REQUIRED`; the frontend shows "Route distance is being confirmed —
   try again shortly" and never silently proceeds.
3a. **Haversine remains allowed only for** proximity and matching, geofences (5I), and implausible-GPS-jump
   detection. It is never shown or used as freight journey distance.
4a. **Agreed vs actual distance (5J hand-off).** The road distance recorded at agreement is the *agreed
   road distance* and is snapshotted onto the booking alongside `agreedAmount` (immutable like the amount).
   Driver GPS later produces a separate *actual travelled distance*; 5J compares them
   (e.g. agreed 714.638 km, actual 728.421 km, difference +13.783 km) and may feed an approved adjustment
   through Section 5.6. 5D never derives money from GPS distance.
5. **One source of truth.** The distance, polyline and duration come from a single Routes result stored with
   the load. Every consumer (pricing, KSh/km, detail map, shipper view, ledger snapshot) reads that result;
   no second independent distance calculation anywhere, including for the map.

### 15.2 Transporter cargo-detail route map (required feature)

When a transporter opens Cargo Details / View Load, the detail view includes a compact Google map showing:

- Pickup pin and delivery pin (the shipper's Places selections).
- The road route drawn between them, from the **stored** polyline (no new Routes call for the map).
- The map auto-fits both pins and the whole route.
- Road distance as text, e.g. `714.6 km by road`.
- Pickup and delivery names remain visible as text above or beside the map, so the map is never the only
  way to understand the route. Conceptual layout:

  ```
  Nairobi → Garissa
  Road distance: 366.8 km
  Pickup: Industrial Area, Nairobi
  Delivery: Garissa Town
  [ mini-map: 📍 pickup → road route → 📍 delivery ]
  ```
- If the route/polyline is unavailable, show the text block with an "estimated" label and no route line
  (the map degrades to the two pins or is hidden); it must not error.

### 15.3 Privacy before booking

- **Before the load is awarded/booked to this transporter:** show the route, the road distance, and the
  pickup/delivery *area* (locality / town / neighbourhood granularity). Do not expose a specific private
  address when the Places result resolves to one (street number, building, named private premises). Pins
  are shown at coarsened coordinates (rounded to roughly 1 km) and the labels use the area name.
- **After booking:** the assigned transporter and driver receive the exact operational location (full
  address and exact coordinates). Non-assigned transporters never do.
- The distance and polyline used for pricing are computed from the **exact** coordinates server-side even
  when the display is coarsened, so privacy never changes the commercial figure.
- The shipper always sees their own exact selections.

### 15.4 Acceptance tests to add with the implementation

- R1  Route distance stored as integer meters; display rounds to 0.1 km; KSh/km uses meters.
- R2  Estimate-sourced distance blocks accept-at-posted-price, offer acceptance and payment with 409
      `ROAD_DISTANCE_REQUIRED`; a ROAD-sourced load proceeds.
- R3  Routes outage: load still posts and is browsable with an "estimated" label; no booking can lock.
- R4  Detail map and pricing read the same stored result (assert a single Routes call per load).
- R5  Pre-booking transporter response contains coarsened pins and area labels, not exact address/coords;
      post-booking assigned transporter receives exact; a different transporter still does not.
- R6  Agreed road distance snapshot is immutable after acceptance.
- R7  No code path uses Haversine for a displayed or priced journey distance (grep/test guard).
- R8  Browser: transporter detail map fits both pins and route, text names visible, privacy-safe labels.

### 15.5 Out of scope for 15

Actual-GPS distance comparison and charging (5J); geofence logic (5I); changing the 25% adjustment cap or
any other locked 5D decision.

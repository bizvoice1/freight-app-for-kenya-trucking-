# Behari Freight — Backend (Phases 4F–4L)

Real backend: auth, GPS tracking (4F), shared live-tracking reads (4G), the
real Load → Booking → Trip chain (4H), authorization hardening (4I), a
server-authoritative trip lifecycle (4J), Daraja M-Pesa escrow (4K), and
narrow in-app notifications (4L) — Behari controls the payment lifecycle,
not just freight matching and tracking, and every party now has a record of
what happened to their money and their trip. All server-identity-checked,
all in one SQLite (dev)/Postgres-ready database.

## Notifications (Phase 4L)

In-app only, deliberately: one new `notifications` table
(`domain/notification.js`, `services/notifications.js`,
`routes/notifications.js`), no SMS/email/push provider, no new external
dependency or credential — the same low-risk pattern as everything else in
this backend, and the natural place to add a real channel later without
touching the event → recipient decisions below.

| Event | Recipient(s) |
|---|---|
| Shipper posts a load | Every `fleet_owner` (marketplace-wide — there's no backend matching engine yet to target it more precisely) |
| Payment confirmed | The shipper |
| Payment failed / cancelled | The shipper |
| Escrow held (payment confirmed) | The transporter |
| Escrow reaches ReleasePending (Delivered) | The transporter + every admin (admin must act) |
| Payout confirmed | The transporter |
| Payout failed | The transporter + every admin (a retry needs admin action) |
| Any trip status change | The load's shipper + the booking's transporter |

`GET /api/notifications?unreadOnly=true`, `GET /api/notifications/unread-count`,
`POST /api/notifications/:id/read`, `POST /api/notifications/read-all` — all
scoped unconditionally to `req.user.id`; a notification belongs to exactly
the user it was written for, so there's no ownership chain to walk the way
payments/escrows/payouts need. Verified: `npm run test:4l` (9/9) — every
event → recipient mapping above, the read/unread endpoints, and that one
user can't mark another user's notification read (404, not 403 — it isn't
visible to them at all).

## Daraja M-Pesa + escrow (Phase 4K)

Implemented exactly against `docs/4K-DARAJA-SPEC.md` (Revision 3, commit
`6f378ac` — approved: escrow state machine, financial invariants, and
18-case acceptance suite specifically signed off before this was built).
Five new tables (`payments`, `escrows`, `payouts`, `payment_events`,
`reconciliation_flags`), kept strictly separate from `trips`/`bookings` —
zero new columns on either.

**The chain:** Daraja (external rail) → a payment_events row (our own
record of what Daraja said) → payments/escrows/payouts (derived from
events, never live-queried from Daraja) → what every portal reads. Trip
status, payment status, escrow status, and payout status are four separate
state machines — Booking≠Trip already established this pattern in 4H; 4K
extends it to money.

**Escrow states** carry an explicit eligibility → instruction → settlement
split: `ReleasePending` (eligible, nothing sent to Daraja) →
`ReleaseInProgress` (a B2C request is in flight, unconfirmed) → `Settled`
(Daraja confirmed it). A trip reaching `Delivered` only ever flips escrow to
`ReleasePending` — the actual payout is a separate, explicit, admin-only
`POST /api/escrows/:id/release`. `Delivered` never itself moves money.

**Idempotency and concurrency, at the layer that actually needs it:**
- `payments.checkoutRequestId`/`payouts.conversationId` — one Daraja
  request, one callback, ever (a repeat is detected and ignored, not
  reapplied).
- `payments.mpesaReceiptNumber`/`payouts.transactionId` — one M-Pesa
  transaction, one accepted payment/payout, checked cross-attempt (not just
  against the row being updated).
- `payouts_one_confirmed_per_escrow` — a partial unique index (Confirmed
  rows only), not a plain one: a failed payout must stay retryable, so the
  constraint only ever blocks a *second successful* payout.
- `payouts_one_inflight_per_escrow` — a second partial index (Pending/
  Requested rows only) closing a real gap the application check alone
  can't: two genuinely concurrent `/release` calls can both pass a `SELECT`
  before either commits an `INSERT` (Node yields at every `await`, and a
  second in-flight request can run in that gap) — this index is what the
  database actually enforces on the `INSERT` itself.

**Local simulator, not just the sandbox:** the official Daraja 3.0 sandbox
is reported happy-path-only as of this spec's research, so
`services/darajaSimulator.js` fakes STK push/B2C locally and calls back to
Behari's own real callback routes — same code path a real callback would
hit. `services/daraja.js` is the one switch point (`DARAJA_ENV=simulate` by
default); a structurally-complete but **unexercised-in-this-environment**
sandbox/production path lives alongside it, honestly labelled as such — it
needs real Safaricom credentials and a public callback tunnel neither of
which this environment has.

**The two reversal edges** (`PAYMENT_REVERSED` — the original inbound
payment reversed while still Held; `PAYOUT_REVERSED` — a confirmed payout
later reversed) are implemented as explicit **admin-triggered manual
transitions** (`POST /api/escrows/:id/mark-payment-reversed`, `.../mark-
payout-reversed`), not fabricated Daraja callbacks — the spec flagged both
as unverified against real Daraja webhook behavior, and this is the
fallback the spec itself proposed rather than pretending a shape confirmed
nowhere. Treat both as simulator/manual-only until confirmed against the
live sandbox.

**Verified:** `npm run test:4k` — the happy path plus all 18 deliberate
failure cases from the spec's Section 9, including a genuinely concurrent
release test (two real parallel HTTP requests, not sequential retries) that
proves the database constraint — not the application's own check — is what
prevents a double payout. `npm run test:regression` re-verifies every
pre-4K endpoint family (4F–4J) against the same reordered `app.js` (the two
unauthenticated webhook routes had to be mounted before `fleetRoutes`,
whose blanket `router.use(requireAuth)` would otherwise 401 them first).
Both run against a freshly migrated + seeded database and both pass, 19/19
and 13/13 respectively, as of this commit.

## Server-side trip lifecycle (Phase 4J)

`POST /api/trips/:tripId/status` `{ status }` is now the one place a trip
moves through `Assigned → Dispatched → At Pickup → Loading → In Transit →
At Delivery → Delivered` (or `Cancelled`). Two independent questions, both
enforced, in this order:

1. **Who may request this specific move** (`authorizeTransition` in
   `routes/trips.js`) — a role/ownership question this phase adds:

   | Actor | Allowed transitions |
   |---|---|
   | Driver (owns the trip) | the six operational steps, in order — not Cancelled |
   | Transporter (owns the truck) | Cancelled only, from any active state — an operational *exception*, not a substitute for the driver's own reporting |
   | Shipper (owns the load) | At Delivery → Delivered only — confirming receipt, never advancing operational state |
   | Admin | any trip, any structurally-valid move — a "controlled override" |

2. **Whether the move is structurally legal** — reuses `models/trip.js`'s
   existing `canTransitionTrip()` unchanged (no skipping stages, nothing
   after a terminal state). This function already existed and was already
   correct; 4J's job was deciding *who*, not re-deciding *whether*.

Ownership fails closed as `403`, an illegal sequence as `409`, a missing
trip as `404` — checked in that order, so a driver attempting an
out-of-turn move on someone else's trip gets "not authorized," not a
generic "invalid transition."

Reaching a terminal state (`Delivered`/`Cancelled`) frees the truck+driver
back to `Available` (`releaseFleetAssignment`), mirroring exactly what
`tripService.js` already does on the frontend.

Verified: the full happy path end-to-end (driver-driven `Assigned` through
`At Delivery`, shipper-confirmed `Delivered`, fleet correctly freed after),
plus all four named failure cases — stage-skipping, post-terminal changes,
a driver touching another driver's trip, a transporter touching another
transporter's truck — each rejected with the right status code.

## Authenticated ≠ Authorized (Phase 4I)

Every prior phase asked "is this token valid?" That's authentication. 4I
asks the harder question: "does THIS user get to touch THIS resource?"

| Actor | Can | Can't |
|---|---|---|
| Shipper | see/manage their own loads | see another shipper's load, even by direct ID |
| Transporter | browse the marketplace, accept any open load, manage/assign their own trucks | list, assign, or view another transporter's trucks/bookings |
| Driver | see and act on their own trips/GPS | list or view another driver's trips or location |
| Admin | see everything | — |

Enforced in `routes/loads.js` (`GET /:loadId`, `GET /`), `routes/fleet.js`
(`GET /trucks`), `routes/trips.js` (`canViewTrip`/`_visibleTripsFilter` —
GPS location is exactly the kind of data "authenticated" must not imply
"authorized" for), and `routes/bookings.js` (`canViewBooking`). The
existing `/assign`/`/create-trip` ownership checks from 4H already covered
booking mutation; 4I closes the read side and the fleet side.

Verified against a genuine second tenant on each side — `db/seed.js` now
seeds a second shipper (Mary Achieng) and a second transporter (Daniel
Kiplagat, who owns his own truck KDB 700Z, zero overlap with James's
fleet) specifically so these rejections are testable, not just theoretical.
Confirmed: Daniel can't list, see, or assign any of James's trucks/bookings;
Mary can't see Demo Shipper's loads; Peter (driver) can't list or view
James's trips or GPS location by any means — while the legitimate owner in
each case, and admin, still see everything correctly. The Phase 4F/4G demo
trip (`TRP-1000`/`KE-2039`) needed a matching backend `loads` row added
(owned by Demo Shipper) so this hardening didn't lock the shipper out of
their own long-standing tracking demo.

## Scope (deliberately)

**Built across 4F–4H:** phone+PIN auth (backend-issued JWT), GPS
tracking (post/latest/history, start/stop), trip lookup (single + filtered
list), **loads** (post, list, get), **bookings** (accept → assign
truck+driver → create trip), truck/driver listing.

**Not yet built:** a real notification delivery channel (4L is in-app/poll
only — no SMS/email/push provider), WebSockets/realtime (polling only, by
design — see the frontend's `useLiveTrip.js`), production OTP, AI matching,
analytics, cosmetic redesign, and a frontend "Pay now" button or
notifications bell (4K/4L's endpoints exist and are verified; nothing in the
UI calls either yet — see their own sections above). Fleet *assignment*
(which driver currently mans which truck) also
stays a frontend/`fleetService.js` concern — the backend only reads its own
seeded snapshot of that when validating a booking's truck+driver pick.

The frontend's existing demo (`SEED_LOADS`, the escrow-simulated Post
Cargo/Find Loads flows in the Carrier/Shipper/Admin portals) is a
completely separate, untouched dataset — Phase 4H's `loads`/`bookings`
are new entities for the new `behari-marketplace.jsx` surface, not a
backend mirror of the existing demo data. See `src/domain/load.js`'s
header for why.

## Run it

```bash
cd backend
npm install
cp .env.example .env       # override JWT_SECRET for anything beyond local dev
npm run db:migrate         # applies drizzle/*.sql to ./behari.sqlite
npm run db:seed            # seeds fleet/drivers/trip/users from the SAME
                            # data the frontend already uses (src/data/fleetSeed.js)
npm run dev                # http://localhost:4000
```

The frontend's Driver Tracker (`behari-driver-tracker.jsx`) talks to
`http://localhost:4000` by default — override with `VITE_API_BASE_URL` in
the frontend's own `.env` if you run the backend elsewhere.

## Dev logins

Every seeded user shares PIN **`1234`** (dev-only — see `src/db/seed.js`):

| phone        | role         | name           |
|--------------|--------------|----------------|
| 0722100200   | driver       | James Mwangi   |
| 0733222333   | driver       | Peter Otieno   |
| 0700000001   | shipper      | Demo Shipper   |
| 0700000002   | admin        | Demo Admin     |
| 0722100200   | fleet_owner  | James Mwangi   |

(James's phone is intentionally reused for two roles — he's both a driver
and the demo's fleet owner. `login` requires `{ phone, pin, role }`, not
phone alone, exactly because of that — see `schema.js`'s `users` table.)

## Database: SQLite now, Postgres-ready

SQLite is the **development** database, not the target production one —
every table (`src/db/schema.js`) uses only column types with a direct
Postgres equivalent, and every route talks to the database exclusively
through Drizzle's query builder, never a raw SQL string. Moving to Postgres
later is: translate `schema.js`'s column builders from `sqlite-core` to
`pg-core`, swap the driver in `src/db/client.js` from `better-sqlite3` to
`pg`/`postgres.js`, regenerate migrations. No route or business-logic file
changes.

## Identity — the actual point of this phase

`POST /api/trips/:tripId/location` never reads `driverId`/`truckId` from
the request body. It reads the trip's `driverId` from the database and
compares it to `req.user.driverId` — resolved from the verified JWT, set
only at login. A request body can claim anything; only that comparison
(`src/routes/trips.js`'s `ownsTrip`) decides whether a reading is accepted.
Verified directly: a request that includes a spoofed `driverId`/`truckId`
in its body is silently ignored — the stored record always reflects the
authenticated caller's real identity.

## Endpoints

```
POST /api/auth/login                          { phone, pin, role } -> { token, user }

GET  /api/trips?loadId=&truckId=&driverId=&status=
GET  /api/trips/:tripId
POST /api/trips/:tripId/tracking/start        (driver, must own the trip)
POST /api/trips/:tripId/tracking/stop         (driver, must own the trip)
POST /api/trips/:tripId/location              (driver, must own the trip)
GET  /api/trips/:tripId/location/latest
GET  /api/trips/:tripId/location/history

GET  /api/trucks?ownerId=
GET  /api/drivers

POST /api/loads                               (shipper)  { cargo, origin, destination, weight?, truckType?, price?, pickupDate? }
GET  /api/loads?status=&shipperId=
GET  /api/loads/:loadId
POST /api/loads/:loadId/accept                (fleet_owner) -> creates a Booking, load status -> Booked

GET  /api/bookings?transporterId=&loadId=&status=
GET  /api/bookings/:bookingId
POST /api/bookings/:bookingId/assign          (fleet_owner, must own the booking) { truckId, driverId }
POST /api/bookings/:bookingId/create-trip     (fleet_owner, must own the booking) -> creates the Trip
POST /api/bookings/:bookingId/payment         (shipper, must own the booking's load) { phoneNumber } -- Phase 4K

GET  /api/payments/:id
GET  /api/payments?bookingId=
POST /api/payments/callback/stk               (Safaricom/simulator -> us; NOT behind auth)

GET  /api/escrows/:escrowId
GET  /api/escrows?bookingId=
POST /api/escrows/:escrowId/release                  (admin only) -> creates the Payout, sends B2C
POST /api/escrows/:escrowId/mark-payment-reversed    (admin only) -- see Phase 4K's reversal note
POST /api/escrows/:escrowId/mark-payout-reversed     (admin only) -- see Phase 4K's reversal note

GET  /api/payouts/:id
GET  /api/payouts?escrowId=
POST /api/payouts/callback/b2c                (Safaricom/simulator -> us; NOT behind auth)

GET  /api/notifications?unreadOnly=      -- Phase 4L, own notifications only
GET  /api/notifications/unread-count
POST /api/notifications/:id/read
POST /api/notifications/read-all
```

## Load → Booking → Trip: the defining test

```
Shipper logs in -> POST /api/loads -> load appears in GET /api/loads
Transporter logs in -> sees the same load -> POST /api/loads/:id/accept
  -> Booking created (status Accepted), load flips to Booked
Transporter -> POST /api/bookings/:id/assign {truckId, driverId}
  -> only succeeds if that truck's currentDriverId already IS that driver
  -> Booking status -> Assigned
Transporter -> POST /api/bookings/:id/create-trip
  -> same invariants as tripService.createTripFromBooking on the frontend
     (truck/driver still paired; truck/driver/load have no other active trip)
  -> Trip created, Booking status -> Trip Created
Driver logs in -> GET /api/trips?driverId=<self> -> sees the new trip
Driver starts GPS (Driver Tracker) -> POST /api/trips/:id/location
Shipper/Admin/Transporter -> GET /api/trips/:id/location/latest -> sees it move
```

Verified live, twice — once via curl end-to-end, once through the actual
UIs (`behari-marketplace.jsx` for post/accept/assign/create-trip,
`behari-driver-tracker.jsx` for the driver seeing and tracking the new
trip, the Shipper's Marketplace view and Admin's Network tab for watching
it). Booking != Trip is enforced structurally: `/assign` will happily pair
an already-busy truck+driver (e.g. the Phase 4F/4G demo pairing), but
`/create-trip` then correctly rejects with "truck already has an active
trip" — assignment and execution are genuinely separate steps.

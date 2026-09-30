# Behari Freight — Backend (Phases 4F–4H)

Real backend: auth, GPS tracking (4F), shared live-tracking reads (4G), and
now the real Load → Booking → Trip chain (4H) — a shipper posts a load, a
transporter accepts it and assigns a truck+driver, the backend creates the
Trip, the driver tracks from their phone, and any authenticated viewer can
watch it move. All server-identity-checked, all in one SQLite (dev)/
Postgres-ready database.

## Scope (deliberately)

**Built across 4F–4H:** phone+PIN auth (backend-issued JWT), GPS
tracking (post/latest/history, start/stop), trip lookup (single + filtered
list), **loads** (post, list, get), **bookings** (accept → assign
truck+driver → create trip), truck/driver listing.

**Not yet built:** escrow/payment (explicitly deferred to Phase 4K —
`loads`/`bookings` have no financial columns at all), notifications,
WebSockets/realtime (polling only, by design — see the frontend's
`useLiveTrip.js`), production OTP, AI matching, analytics, cosmetic
redesign. Fleet *assignment* (which driver currently mans which truck) also
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

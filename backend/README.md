# Behari Freight — Tracking Backend (Phase 4F)

Real backend for the Driver Tracker (Phase 4E): auth, trip lookup, and
location ingest/read, replacing that one surface's localStorage-only
persistence with an HTTPS API + database.

## Scope (deliberately)

**In this phase:** authentication (phone+PIN, backend-issued JWT), trip
read, location POST/latest/history, tracking start/stop. All served from a
real database, all identity-checked server-side.

**Not in this phase** (unchanged, still frontend/localStorage):
booking/trip *creation* (`tripService.createTripFromBooking`), fleet
assignment (`fleetService.assignDriverToTruck`), the GPS *simulator*
(`gpsService.generateLocationUpdate` — Phase 4D), escrow, M-Pesa,
notifications, WebSockets, production OTP, AI matching, analytics.

That means a trip only tracks end-to-end through the real backend today if
it exists in **both** stores — true for the one seeded demo trip
(`TRP-1000`, James / `KDJ 441Z` / `KE-2039`). Migrating booking/trip
creation to the backend too is a later phase, same as this one deferred
escrow.

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
POST /api/auth/login                        { phone, pin, role } -> { token, user }

GET  /api/trips/:tripId
POST /api/trips/:tripId/tracking/start      (driver, must own the trip)
POST /api/trips/:tripId/tracking/stop       (driver, must own the trip)
POST /api/trips/:tripId/location            (driver, must own the trip)
GET  /api/trips/:tripId/location/latest
GET  /api/trips/:tripId/location/history
```

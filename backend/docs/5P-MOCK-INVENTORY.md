# 5P — Mock-data inventory (read-only audit, nothing changed)

Classes: **REMOVE** · **TEST** (keep for automated tests only) · **DEV-INFRA** (keep, label explicitly) · **REPLACE** (needs a backend-backed equivalent first).

## 0. Headline finding

The product is **two systems side by side**.

| Layer | Real (backend-backed) | Still a localStorage prototype |
|---|---|---|
| Portals | `behari-marketplace.jsx` (Marketplace), `behari-driver-tracker.jsx` (Driver Tracker) | `behari-freight-v2.jsx` (Transporter), `behari-shipper-v2.jsx` (Shipper), `behari-admin-v2.jsx` (Admin), `behari-mpesa-v2.jsx` (Pay) |
| Auth | Marketplace + Tracker log in via `/api/auth/login` | Landing `SignIn` modal (`App.jsx` ~L55-80): **any phone ≥9 digits + any PIN ≥4 is accepted; the OTP is generated client-side and printed on screen; no backend call.** Role chosen from the UI is stored in `localStorage` |
| Loads/offers/booking/payment/adjustments | Shipper/Transporter portals call `commerceApi`/`routeApi` via `backendSession.getSession(role)`, which silently logs in with **hard-coded demo credentials** | Loads list, statuses, escrow, disputes, ratings, milestones, fraud flags come from `loadService` `_store` (`behari_store_v2`) merged with seed arrays |
| Trips / GPS | Real phone GPS via `trackingService` + backend `location_updates` | `tripService`, `gpsService` simulated engine (`source:"simulation"`) still drives Transporter "In Transit" progress |
| Gate (5E) | Backend only | No UI yet |

Consequence: the answer to "is Driver→Trip→Transporter→Shipper→Booking→Load→Payment→GPS one canonical graph?" is **no**. The Marketplace portal is the only UI that reads the backend graph end to end. The Transporter, Shipper and Admin portals read a client-side interpretation plus backend overlays (`isBackend` flag / `DemoBadge`).

**Registration cannot be done:** backend has only `POST /api/auth/login`. There is no register/signup/OTP endpoint. "Create account" in the full cycle is therefore a **missing backend capability**, not just a UI gap. Users exist only via `db:seed`.

## 1. Backend

| Item | Where | Class |
|---|---|---|
| Seed users: USR-1000..1008 (drivers James/Peter, shippers "Demo Shipper"/Mary, "Demo Admin", fleet owners James/Daniel, 2 loading agents), PIN `1234` | `src/db/seed.js` L135-143 | TEST (+ admin bootstrap stays REPLACE with a one-off admin CLI) |
| Seed fleet owners FO-1000/1001, trucks TRK-1000/1001/2000 (KBD 092K, KDB 700Z …), drivers DRV-1000..1002 | `seed.js` L27-80, from `src/data/fleetSeed.js` | TEST / REMOVE from runtime |
| Seed load KE-2039 + trip + `LOC-SEED-1` location (fake GPS fix) | `seed.js` L90-130 | REMOVE from runtime, TEST if suites depend on it |
| Seed loading sites LS-1000/1001 + agent links | `seed.js` L153-160 | TEST; real sites come from admin API |
| `npm run db:seed` populates every one of the above on any DB | `package.json` | Split: `db:seed` (tests) vs `db:bootstrap-admin` (runtime, no demo data) |
| Daraja simulator (`DARAJA_ENV=simulate` default) | `services/darajaSimulator.js`, `services/daraja.js`, `.env.example` | DEV-INFRA. Default should become explicit, and the UI must say "simulated payment" |
| Mock Routes server | `scripts/mock-routes-server.mjs` | TEST |
| Google Routes absent key falls back to corridor/Haversine distance | `.env.example` note, `services/loadRoute.js` | REPLACE: pilot should fail loudly (no canonical route ⇒ not discoverable), not fabricate distance |
| Hard-coded `fixtures.mjs` coordinates (NBO_NKU) | `scripts/fixtures.mjs` | TEST |
| `JWT_SECRET` dev fallback | `auth/jwt.js` | DEV-INFRA (guarded in prod) |
| GPS jump/implausibility checks | backend | KEEP (real validation) |

## 2. Frontend business state in localStorage (all REPLACE or REMOVE)

| Key | File | What it fakes | Class |
|---|---|---|---|
| `behari_store_v2` | `services/loadService.js` | Loads, statuses, **escrow, disputes, ratings, bookings slots, fraud flags, milestones** | REPLACE (backend load/booking/escrow/adjustment already exist; disputes/ratings/fraud have no backend yet, so hide until built) |
| `behari_fleet_v1` | `services/fleetService.js` (+ `data/fleetSeed.js`, `DEMO_FLEET_OWNER`) | Trucks/drivers; used by Tracker, Admin, Marketplace, Transporter | REPLACE with `/api/trucks`, `/api/drivers` |
| `behari_carrier_fleet` | `behari-freight-v2.jsx` L1096-1112 | Second, different fleet store with hard-coded T1/T2/T3 trucks (KDJ 441Z, KBD 092K, KCN 771M) | REMOVE |
| `behari_trip_v1` | `services/tripService.js` | Client trips | REPLACE with backend trips (already used by Tracker/Marketplace) |
| `behari_gps_v1` | `services/gpsService.js` | Simulated GPS store | REMOVE from runtime (see §4) |
| `behari_matching_v1` | `services/matchingService.js` + `data/network.js` | Truck availabilities + match records | REMOVE (feature has no backend; hide or mark roadmap) |
| `behari_carrier_notifs` | `behari-freight-v2.jsx` L1970-2091 | Client-made notifications, written locally on events | REMOVE; use `/api/notifications` (exists, incl. gate types) |
| `behari_chat_<loadId>` | shipper + freight portals | Chat messages that only exist in one browser | REMOVE (no backend chat) |
| `behari_budget_cap` | shipper L1541 | Shipper UI setting | REMOVE or keep as preference (cosmetic) |
| `behari_role`, `behari_active` | `App.jsx` | **Identity**/role selection with no auth | REPLACE with JWT session |
| `behari_marketplace_token/_user`, `behari_driver_token/_user` | `marketplaceService`, `trackingService` | Real JWTs, two separate per-portal sessions | KEEP concept, unify into one session |
| `behari_dark_mode`, `behari_lang_*`, `behari_tour_done` | App/portals | Preferences | KEEP |
| `behari_bids_*` / `behari_bids_purged_5d` | `loadService.js` | Legacy purge shim | REMOVE after one release |
| Service worker cache | `public/sw.js` | Can serve stale app shell | KEEP; note for QA |

## 3. Seed/demo business records in the frontend bundle

| Item | Where | Class |
|---|---|---|
| `MARKETPLACE_LOADS` (legacy marketplace loads) | `src/data/loads.js`, merged in `loadViews.getAllKnownLoads`, `loadService._getLoad`, `App.jsx` matching pool | REMOVE |
| `SEED_LOADS` (KE-2038/2039/2041 …, canonical "demo" loads, escrow/progress) | `src/data/seedLoads.js` | REMOVE (KE-2039 survives in backend seed only for tests) |
| `CARRIER_FLEET_SEED` | `src/data/fleet.js`, `behari-freight-v2.jsx` | REMOVE |
| `FLEET_SEED_TRUCKS/DRIVERS`, `DEMO_FLEET_OWNER` ("James Mwangi") | `src/data/fleetSeed.js` | REMOVE from runtime; the backend seed currently imports it (decouple) |
| `DEMO_TRUCK_AVAILABILITY`, `DEMO_MATCH_CARGO` | `src/data/network.js` | REMOVE; also drives landing "NetworkStats" |
| `CARRIER_ROSTER`, `suspendedAccounts:["C-ELD-004"]`, `CORRIDORS` seeded risk numbers | `services/adminService.js` (895 lines, in-memory, "seed one suspended for demo") | REMOVE data; `CORRIDORS` as reference list is OK |
| Deterministic fake risk scores | `models/risk.js` ("deterministic simulation … stable risk for demo data") | REMOVE until real signals exist |
| Reference lists (CARGO_TYPES, TRUCK_TYPES, CARGO_UNITS, TRUCK_FILTERS) | `src/data/reference.js` | KEEP |
| `isDemo` / `DemoBadge` ("Demo Load — booking unavailable"), `Pill Demo` | `negotiation.jsx`, freight L293/394 | REMOVE with the demo loads |

## 4. Simulated/mock GPS and tracking

| Item | Class |
|---|---|
| `gpsService.js` (499 lines): route waypoints, tick every 4 s, `source:"simulation"`, random noise; `buildTripSnapshot` used by Transporter portal; "advance 0.3 % every second while In Transit" at `behari-freight-v2.jsx` ~L1425 | REMOVE from runtime; Transporter portal must read `/api/trips/:id` + backend location only |
| `trackingService.js` + `useLiveTrip` (real `navigator.geolocation` → backend) | KEEP (real) |
| `models/trip.js` `source: "simulation"` default | REPLACE with `"device"` only |
| Hard-coded `tel:+254712345678` "Call Driver" (shipper L1022/1028/1043) | Left alone per earlier instruction; still a fake number, REPLACE with driver phone from backend |

## 5. Demo credentials and fake auth

| Item | Class |
|---|---|
| `backendSession.DEMO_CREDENTIALS` (0700000001 / 0700000002 / 0722100200, PIN 1234) auto-login in every commerce API call | REMOVE: replace with real login session |
| `App.jsx` SignIn/OTP simulation, "DEMO — SMS from Behari" banner, `Onboarding.jsx` (707 lines, fake upload delay, simulated SMS, no network calls) | REPLACE: needs backend register + OTP/PIN flow |
| Placeholder phones in Tracker/Marketplace login inputs (0722100200 / 0700000001) | REMOVE (generic placeholder) |
| Admin portal ROLE_ACCESS: admin may open driver/shipper/pay portals as themselves | REVIEW |
| `behari-mpesa-v2.jsx` M-Pesa engine/code viewer, "Simulate Timeout" button | DEV-INFRA, move behind a dev flag; not a user portal |

## 6. UI that "succeeds" without a backend operation (silent-success candidates)

- `loadService` actions invoked from `useLoads` (accept, confirmDelivery, releaseEscrow, refund, openDispute, ratings, fraud, forceStatus) mutate only the client store. Admin "Release escrow" in the UI therefore does **not** touch backend `escrows`/`payouts`.
- Admin portal Treasury/Risk/Dispatch/Incidents/KYC: wholly `adminService` memory (`freezePayouts`, `suspendAccount`, `broadcastAlert`), KYC documents are "simulated 1×1 data-URI images".
- Transporter: pickup photo modal, fleet add/remove, milestone/notification writes.
- `commerceApi.js` swallows errors into a result object (`try { return result(...) } catch`); need to verify each caller surfaces failure.
- Landing: "Each view is a live interactive demo", NetworkStats "Simulated network activity".

## 7. Decouple order I would propose (for the cleanup phase, not done)

1. Backend: add register + PIN/OTP + `GET /api/me`; split `db:seed` into test-seed and admin-bootstrap; remove `fleetSeed` import from backend seed.
2. Frontend: one real session (JWT), delete `DEMO_CREDENTIALS`, `behari_role/_active` identity, SignIn simulation.
3. Frontend: delete seed arrays + `loadService` store; Transporter/Shipper/Admin read `/api/*` only; empty states for empty DB.
4. Hide features with no backend (matching, chat, ratings, disputes, fraud, KYC, admin risk/treasury) rather than faking them.
5. Remove GPS simulation; Transporter progress from backend trip + location.

## 8. Not touched / kept

Daraja simulator, mock Routes server, `fixtures.mjs`, all acceptance suites and their seed (for tests), reference lists, dark mode/lang prefs, GPS plausibility checks, `sw.js`.

## 9. 5P-1 status (Real Identity) — updated 2026-10-03

| Item | Status |
|---|---|
| `backendSession.DEMO_CREDENTIALS` auto-login | **REMOVED** — `getSession(role)` rejects with no session or wrong role |
| `App.jsx` SignIn/OTP simulation, "DEMO — SMS" banner | **REMOVED** — replaced by `AuthModal` (backend login/register, dev phone+PIN) |
| `Onboarding.jsx` (fake KYC/SMS wizard) | **REMOVED** (file deleted) |
| `behari_role`, `behari_active` identity keys | **REMOVED** |
| `behari_marketplace_token/_user`, `behari_driver_token/_user` | **REPLACED** by one `behari_session` (`services/session.js`) |
| Registration | **REPLACED** — `POST /api/auth/register` (shipper, fleet_owner only; transactional fleet-owner creation) |
| Canonical identity | **NEW** — `GET /api/me`; the UI session is re-validated against it on load; 401 returns to launcher |
| Placeholder phones in Tracker/Marketplace login inputs | **REMOVED** |
| M-Pesa portal card on launcher | **HIDDEN** (DEV-INFRA) |
| Auth mode | **DEV-ONLY** — `dev-pin`, `phoneVerified=0`, in-memory lockout (5N) |

Still open after 5P-1 (not identity):
- Shipper portal header shows hard-coded "Bamburi Cement / Verified Shipper / KSh 1.2M" and stats for any shipper (`behari-shipper-v2.jsx` ~L1279) — 5P-2.
- Transporter portal shows demo loads and localStorage fleet — 5P-2/3.
- **Missing backend capability:** no endpoints to add trucks/drivers or create driver login accounts — required before 5P-6 (schedule in 5P-3).
- Registration has no IP rate limit; login lockout is in-memory (5N).

---

## 5P-2 — Empty-State Purge (status)

**REMOVED** (runtime): `src/data/{seedLoads,network,fleet,loads}.js`, `src/services/{tripService,matchingService}.js`, `src/hooks/useMatching.js`, `src/components/matching/*`, `src/Onboarding.jsx`; admin Network page; shipper matching/chat/carrier-profile/demo shipments/fake header stats/Analytics chart + "12%"; transporter fake earnings/stats.
**REPLACED** (backend truth): shipper/transporter header + Account from `/api/me` (company via `fleetOwner.company`); Earnings from settled bookings; fleet/driver lists from `GET /api/trucks|drivers` (empty = "No trucks yet."); `adminService` seeds emptied; `getAllKnownLoads` = backend loads only.
**localStorage**: `loadService._purgeLegacyStores()` deletes `behari_store_v2`, `behari_fleet_v1`, `behari_carrier_fleet`, `behari_trip_v1` etc. on load; `_persist` is a no-op. Allowed: `behari_session`, UI prefs (dark mode, lang, tour, budget cap).
**TEST-ONLY**: deterministic fixtures live in `backend/scripts/*` and `backend/src/db/seed.js` (dev/test DB only, not a runtime path).
**KEPT**: `src/models/match.js` (geo helpers dependency), `src/data/reference.js`. **MOVED (TEST-ONLY)**: `src/data/fleetSeed.js` + `fleet.js` -> `backend/src/db/fixtures/` (used only by `db:seed`; the frontend no longer ships them).

### Gaps recorded for 5P-3 (NOT masked with localStorage)
- Add Truck, Add Driver, driver account creation, truck/driver create/update endpoints (currently read-only `GET /api/trucks|drivers`).
- Tracker (driver) portal unreachable on a fresh DB until driver accounts exist.

### Deferred
- 5P-4: `DEMO_OTP` / Demo Photo local delivery flow, admin load feed, Treasury/Risk/KYC/disputes/chat/ratings/local release actions.
- 5P-5: remaining simulation leakage.
- Note: a console 401 on `/api/me` at load occurs only when a stale `behari_session` points at a user absent from the DB (e.g. after DB reset); `restore()` then clears the session as designed.

## 5P-3 — Canonical backend graph (results)

DONE
- `POST /api/trucks` (owner from session, canonical `TRUCK_TYPES`), `POST /api/drivers` (driver row + driver login in one transaction, linked by `driverId`), `PUT /api/trucks/:id/driver` (symmetric pairing, locked during an active trip). `drivers.fleet_owner_id` added (migration 0013). `/api/me` is structurally explicit: `fleetOwner` / `driver` objects or null.
- Transporter UI: Add Truck, Add Driver (+PIN), pairing select, booking AssignTripPanel using backend trucks and drivers only. Driver Tracker shows backend trips only.
- Seed-only fleet fixtures moved to `backend/src/db/fixtures/` (used by `db:seed` only).
- Admin: reduced to a read-only "Status" page. Risk, Treasury, Dispatch, Incidents, Audit, KYC, Disputes, Fraud, Broadcast, Command/GMV and Heatmap are removed from navigation and listed as NOT LIVE. The old component code is still in `behari-admin-v2.jsx` (dead; delete in 5P-4).

STILL FAKE / DEFERRED (5P-4 / 5P-5)
- Shipper dashboard text "Matching transporter…" and a hard-coded "Verified shipper" badge on load cards; "~2 hrs" estimates.
- Landing page "matching network" hero and portal cards.
- `behari-mpesa-v2.jsx` demo (James Mwangi / KDJ 441Z) is a standalone demo, not in the live flow.
- Shipper "Contact phone" is not prefilled from the account.
- Transporter header company only appears after reload for a freshly registered account.
- Admin has no backend feed; admin login needs a seeded admin.

### 5P-3 closing fixes
- `/assign` now accepts Accepted or Assigned bookings (re-assign before a trip exists).
- Location ids were derived from a per-trip count and collided across trips (`LOC-1000`); now derived from the global row count.
- Register/login now re-read `/api/me` (`session.js`), so the transporter company name shows immediately, matching reload.
- Clean proof: Grace's BHL-1001 → Ahmed's second truck (KDB 200B) + driver Mary → TRP-1001 → Mary's own login → GPS LOC-1001 (200); Grace reads it (200), Peter 403, Joseph sees only TRP-1000.
- FIXED in 5P-4: remove dead mock code in `behari-admin-v2.jsx`.

## 5P-2R — Feature restoration (backend state only)

Restored: Transporter My Truck tab (real fleet), My Loads (backend trips + progress + live tracking), History (terminal trips), shared `TripTrackingModal` (real `/location/latest` + `/location/history`, otherwise "Live location unavailable."), Admin Live Trips, Admin read-only Escrow & Payouts, shipper tracking via the same modal (simulated route/position removed). Not Live shells (`src/components/NotLive.jsx`): Cargo Matching, KYC/documents, insurance, chat, SOS/breakdown, advance pay, ratings, disputes.

Verified: `GET /api/trips` as admin returns all trips; other shipper sees `[]`; transporter sees only own trucks' trips (separate test DB, port 4010).

### Future task — rebuild the matching engine
Cargo Matching is a core product idea. Rebuild it against canonical backend data only: declared truck availability (real trucks/drivers) + real loads + road/geospatial data (Routes API polylines, not hand-built corridors). No seeded availability, no fake scores. Needs: an availability endpoint, a match-scoring service, and notifications.

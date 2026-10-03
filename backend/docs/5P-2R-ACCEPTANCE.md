# 5P-2R acceptance — feature inventory, `bc12859` → current tree

Status: uncommitted working tree on top of `bc12859` (5D frozen). Diff vs HEAD: 16 deleted, 35 modified, plus new 5E/5P files.

## Verification evidence

| Check | Result |
|---|---|
| Backend suites, fresh DB each | regression 13/13, 4k 19/19, 4l 9/9, 4m 24/24, 5p1 19/19, **5p3 12/12** (added: re-assign an already-Assigned booking; second trip's driver GPS write with distinct location ids), 5c1 8/8, 5c2 9/9, 5c3 12/12, 5d 25/25, 5d2 17/17, 5d4 14/14, 5d5 12/12, 5e1 28/28, 5e2 27/27 |
| Admin UI, isolated DB (port 4030 + Vite 5299, live DB untouched) | Live Trips = the 3 backend trips (TRP-1000/1001/1002), no extras. Escrows = ESC-1000 (60,000) and ESC-1001 (50,000), payouts 0, matching `escrows`/`payouts` rows exactly. No totals/metrics. Tracking modal opens, 0 console errors. Status page: every old mock area is a "NOT LIVE" row with no actions. |
| Tenant scoping | Admin sees all trips; fleet_owner/shipper/driver scoped (API-proven earlier and by 5p3 test 9). |
| Carrier tracking modal (live DB, Ahmed) | TRP-1001 opens with plate KDB 200B, driver Mary Achieng, real ping, no uncaught errors. |
| Shipper tracking modal (live DB, Grace, BHL-1001) | Title `Nairobi → Nakuru` (was "undefined → undefined"), status, real ping (-0.7172, 36.4310). |
| Maps failure, forced (stubbed `google.maps` to throw) | Modal stays up, no manufactured position, "Last position <real lat,lng> · Open in maps" with link built only from backend coordinates, no uncaught errors / unhandled rejections. |

Fixes made during verification: unhandled rejection when `new Map` throws (`GoogleMap.jsx` now `.catch` → `onUnavailable`); the real-coordinates line is now always shown under the map (previously only after an explicit failure, leaving a blank hole when Maps hangs); shipper header no longer leaks the internal truck id when the plate is unknown (shows "Assigned truck").

## 1. Preserved Real
- Backend: auth/roles, loads, bookings, negotiation, payments/escrow, adjustment ledger (5D), release gate (5E-1/2), notifications, trips + trip lifecycle, GPS ingest/read, 5P identity + fleet (trucks, drivers + driver login, pairing).
- Frontend: sign-in/registration (`AuthModal`, `session.js`), Shipper post-load / negotiation / funding / adjustment UI, shipper shipment detail + price-adjustment ledger, Carrier Find Loads + agreed bookings + funding/adjustment views, notification bell, Driver Tracker (unchanged, 328 lines), Marketplace portal (unchanged), dark mode, language toggle.

## 2. Restored + Backend-Wired
- Carrier **My Truck**: real trucks/drivers (create, pair), AssignTripPanel (assign → create trip).
- Carrier **My Loads**: active trips from `GET /api/trips` + agreed bookings; **History**: terminal trips.
- Trip live tracking (carrier, shipper, admin) via `TripTrackingModal`: real latest location + history, polling 7 s; replaces `TripGPSModal` and the simulated shipper Leaflet route.
- Admin **Live Trips** (all trips, filter, tracking) and read-only **Escrow & Payouts**.
- Shipper "Track Live" now also available at status Booked once a trip exists.

## 3. Intentionally Removed Mock
- Seeded cargo/trucks/network (`data/loads.js`, `fleet.js`, `fleetSeed.js`, `network.js`, `seedLoads.js`), `tripService.js`, `Onboarding.jsx`.
- Matching engine and components (`matchingService`, `useMatching`, 7 `components/matching/*`) — rebuild is a recorded future task against canonical availability + loads + road data.
- Carrier mock modals: `MyFleetLive`, `AddTruckModal`, `TripGPSModal`, `PickupPhotoModal`, `ActionModal`, `MyProfileModal`, `CarrierNotifPanel` (real bell remains), localStorage business state, fake GPS, fake ratings/stats, James Mwangi / KDJ 441Z frontend demo content, "Simulated route" banner.
- Admin simulated: Command Center metrics, heatmap, risk, treasury, dispatch, incidents, audit, KYC, disputes, fraud, broadcast, `NetworkCommand`.

## 4. Planned / Not Live (placeholder only, no data, no actions)
- Carrier Account "Planned modules": KYC & documents, Cargo insurance, Chat, Breakdown/SOS, Advance pay, Ratings, Disputes; My Truck "Cargo Matching".
- Shipper Dashboard: nearby trucks & matching, chat, transporter profiles & ratings, cargo insurance.
- Admin Status page: 11 NOT LIVE rows listed above.

## Items that fit no bucket / flagged (not silently accepted)
1. **Landing page hero** still reads "Kenya's truck ↔ cargo matching network / Find Cargo. Fill Empty Trips." while matching is Not Live. Marketing claim vs. product; needs a copy decision (not a code regression).
2. **Backend dev seed** (`db/seed.js`) still creates James Mwangi / KDJ 441Z and a seeded in-transit trip (seen as TRP-1000 on the isolated admin DB). Backend dev data only, not in the live DB; belongs to 5P-4/5.
3. **Dead admin mock code** remains in `behari-admin-v2.jsx` (unreferenced); 5P-4.
4. **Shipper view can't resolve truck plate / driver name** (trucks/drivers endpoints are tenant-scoped); shows "Assigned truck" / "—". Product gap: trip payload would need denormalised plate/driver for the shipper — not added (no new capability in 5P-2R).
5. When Google Maps hangs, a blank gap appears above the coordinates line (cosmetic).
6. Find Loads map shows Google's gray error overlay in dev (demo key quota) — environment, not app code.

## CORRECTION — Operational Lifecycle Audit (supersedes the line previously here)

The earlier conclusion "No unexplained feature losses found" was wrong. That inventory covered components, not lifecycle stages.

Findings of the read-only lifecycle audit (bc12859 vs working tree):
- The post-assignment backend is intact: trip status machine, GPS, 5E gate (gate tokens, loading sites, loading agents, GATE_IN / LOADING_STARTED / LOADING_COMPLETED), escrow release eligibility, admin release and payout.
- At bc12859 no frontend called `POST /api/trips/:id/status`. Carrier lifecycle buttons (Loading, Start trip, Mark Arrived, Delivery confirm) and the admin `EscrowReleasePanel` drove the localStorage `loadService` mock, so nothing real was lost there, but no real operational UI exists today either.
- Never built as UI: Gate Pass QR / loading-agent scanner (planned 5E-4), Proof of Delivery (planned 5H).
- Real regression: admin cannot call `POST /api/escrows/:id/release` (UI is read-only).
- Invisible (backend present, no UI): Dispatched, At Pickup, GATE_IN, Loading, In Transit control, At Delivery, release, payout.

Decision: build the real Driver / Loading Agent / Admin-release UI against the existing backend (5E-4A..C); do not restore old mock controls; do not expose a plain "Delivered" button before 5H.

## 5P-3 acceptance evidence (live DB, BHL-1002 chain)
- Real operational graph on the live backend: second truck KDC 300C + second driver Peter Otieno (own login), assigned and trip TRP-1002 created, funded ESC-1002 (HELD, 45,000); Shipper (Grace) and Transporter (Ahmed) tracking read the same backend position; a second transporter (Carol) cannot access Ahmed's fleet, driver, trip or GPS.
- Deviation approved by the user: BHL-1002 used instead of BHL-1001.
- **GPS qualification:** the location point (LOC-1002 at -1.2921, 36.8219) was a real authenticated backend location write, but **not a real device geolocation fix**. Actual phone GPS is to be tested during the operational pilot.
- Live DB records are intentionally left in place as pilot-state data.

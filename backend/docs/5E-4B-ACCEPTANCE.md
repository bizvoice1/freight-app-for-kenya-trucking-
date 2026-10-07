# 5E-4B acceptance — Driver Gate Pass + Loading Agent scanner

## Scope
- Driver Tracker (At Pickup / Loading): "Ready for Gate Verification", pickup site, truck plate, SHOW GATE PASS. The QR encodes a backend-issued opaque `behari:gate:<token>`; never shown as text, never built client-side. Auto-refreshes at `refreshAt`; an old QR is cleared once replaced/used/expired. Wording: "Gate verified", "Loading in progress", "Loading complete — trip in transit".
- Loading Agent portal (new role button, `🛂`): assigned site, SCAN GATE PASS (`html5-qrcode`, camera permission/error state, "scan from a photo" fallback), Today's Trucks. Posts to `/api/gate/scan`; result card (truck, driver, trip, site, event, resulting status) is built only from the backend response / agent read model. No price, shipper contact, escrow, negotiation or fleet data.
- Backend: one read-only addition, `GET /api/gate/agent/sites` (id, name, active only).
- Disabled: shipper "Confirm Delivery" (`DeliveryConfirmModal` used a demo OTP and fake GPS and its handler is undefined in `App.jsx`). Replaced by a disabled "awaiting proof of delivery" control until 5H.

## Evidence
API suite `npm run test:5e4b`: 18/18 (sites endpoint + privacy, non-agents denied, agent read-model privacy, agent blocked from commercial endpoints, wrong driver / non-drivers refused a pass, eligible-step enforcement, wrong-site agent refused with nothing recorded, garbage scans, GATE_IN, replay USED, replacement REVOKED, LOADING_STARTED -> Loading, expiry 410, direct status bypass blocked, LOADING_COMPLETED -> In Transit and trip leaves agent list, escrow/payout/payment unchanged).

Browser journey (isolated DB, two origins so two sessions: driver `localhost:5299`, agent `127.0.0.1:5299`, TTL 60s):
1. Driver At Pickup -> pass issued (purpose GATE_IN), agent scans -> "Gate entry recorded", trip still At Pickup.
2. Both sessions fully re-logged-in / reloaded: driver "Gate verified", agent "Next: Start loading".
3. New pass (LOADING_START) -> "Loading started", trip = Loading. Driver tab updated without reload ("Loading in progress", used QR cleared). Reload both: Loading persists.
4. New pass (LOADING_COMPLETE) -> "Loading completed", trip = In Transit, truck gone from agent list. Reload both: driver "Loading complete — trip in transit", agent "No trucks are waiting".
5. DB: exactly 3 gate events (GATE_IN, LOADING_STARTED, LOADING_COMPLETED), trip In Transit, escrow ESC-1000 still Held 60,000, payouts 0.

Failure checks: replayed (used) QR -> "already used", nothing recorded (events stay 3); other driver gets 403 on gate state and pass issue; camera permission denied -> error state, retry button, no fake success; wrong-site agent, expired and revoked QR, and direct status bypass covered by the API suite (not re-driven in the browser).

## Known limits
- No camera in the test pane: scanning exercised through the photo-upload path (same decode + submit code as the camera path). Real camera scanning is for pilot device testing (needs https on phones).
- Real device GPS not exercised (see 5E-4A).
- 5H security requirement stands: backend must refuse At Delivery -> Delivered without PoD evidence.

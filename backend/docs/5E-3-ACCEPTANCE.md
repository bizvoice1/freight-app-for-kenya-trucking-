# 5E-3 acceptance — adversarial Gate Pass security

Suite: `npm run test:5e3` (`scripts/acceptance-5e3.mjs`, 30 tests). Real HTTP + direct SQLite, fresh migrated/seeded DB.
Run the server with `GATE_TOKEN_TTL_SECONDS=4` (the expiry test sleeps past the TTL). Fault injection uses temporary SQLite triggers in the *test* DB only; no production test seam.

| # | Attack | Result |
|---|---|---|
| 1 | 12 concurrent scans of one QR; two authorized agents racing; 8 concurrent issuances | exactly 1 success / 1 `gate_event` / token consumed once; exactly 1 active token |
| 2 | replay (consumed, superseded, expired, admin-revoked), garbage/malformed/injection tokens | `GATE_TOKEN_USED` / `_REVOKED` / 410 `_EXPIRED` / 4xx; no side effects; plaintext token never stored |
| 3 | unauth, shipper, transporter(s), driver(s), admin, other-site agent, agent removed after issuance | all refused; refused scans never burn the token |
| 4 | out-of-sequence issue, GATE_IN bypass, trip leaves state after issue, forged SQL events | refused at API and by DB triggers; status route returns `LOADING_EVIDENCE_REQUIRED` for driver and admin |
| 5 | site moved / deactivated / agent removed / half- and fully-reassigned trip after issuance | refused. **Gap found + fixed (5d)** |
| 6 | escrow leaves HELD after issuance | `GATE_NOT_FUNDED`, no event, same QR works once funding restored |
| 7 | privacy canaries (cargo, price, phones, ids, token hash) in all agent responses | no leak. **Gap found + fixed** |
| 8 | injected failure on trip update / after event insert / on token consume; notification failure | full rollback (no consumed token without event, no event without consumed token); notification failure never undoes evidence; global invariant holds |
| 9 | Trip A QR used for Trip B (even naming B in body) | affects only A |
| 10 | money snapshot (escrows, payments, payouts, adjustments) around a full gate walk + refused attempts | byte-identical |

## Real gaps found and fixed (targeted, no redesign)
1. **Stale QR after driver replacement.** A token issued to driver A stayed redeemable after the trip and booking were reassigned to driver B. `verifyAndRecordGateEvent` now requires the token's `issued_to_user_id` to be a driver user whose `driverId` is the trip's *current* driver (`GATE_ASSIGNMENT_MISMATCH` otherwise). (`src/services/gate.js`)
2. **Loading agents could read commercial data.** `GET /api/loads`, `/api/escrows` etc. returned shipper price, cargo, and contacts to a `loading_agent`. `src/app.js` now fails closed: a loading agent may only reach `/auth`, `/me`, `/notifications`, `/gate`, `/loading-sites`; everything else is 403 `ROLE_NOT_PERMITTED`, including routers added later.
3. Fixture update: `acceptance-5e1.mjs` now issues tokens to the trip's real driver user (the stricter check exposed that it used an unrelated user).

## Regression (fresh DB each)
regression 13, 4k 19, 4l 9, 4m 24, 5c1 8, 5c2 9, 5c3 12, 5d 25, 5d2 17, 5d4 14, 5d5 12, 5e1 28, 5e2 27, 5p1 19, 5p3 12, 5e3 30 — all pass.

## Known limits
- Location is soft evidence only (unchanged design).
- No API exists to reassign a trip's truck/driver after trip creation; tests 5c/5d simulate it with SQL.

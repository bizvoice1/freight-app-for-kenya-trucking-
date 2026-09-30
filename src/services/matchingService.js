/**
 * src/services/matchingService.js
 * --------------------------------
 * The Matching Engine service — mirrors loadService.js's contract exactly:
 * every exported function returns a Promise, the module holds an in-memory
 * store persisted to localStorage, and there are zero React imports.
 *
 * This service owns TWO things only:
 *   - TruckAvailability records (declared by carriers)
 *   - Match records (the scored truck↔cargo pairings) + match notifications
 *
 * It does NOT own cargo — cargo is a Load (see loadService.js /
 * models/load.js). Callers pass in the current cargo pool (marketplace +
 * posted loads) so this service never has to import loadService, keeping
 * the two mock-backend services independent, exactly like adminService.js
 * stays independent of loadService.js today.
 *
 * Matching runs in BOTH directions through the same scoreMatch() function
 * (models/match.js) — findMatchesForTruck() and findMatchesForCargo() are
 * thin wrappers around the identical scoring call.
 */

import {
  scoreMatch,
  createMatch,
  createTruckAvailability,
  TRUCK_AVAILABILITY_STATUS,
  MATCH_STATUS,
} from "../models/match.js";
import { DEMO_TRUCK_AVAILABILITY } from "../data/network.js";

const STORE_KEY = "behari_matching_v1";
const MATCH_THRESHOLD = 40; // below this, a truck/cargo pairing counts as "unmatched"

const _store = {
  declaredAvailabilities: [],   // carrier-declared TruckAvailability records (this session)
  matches: [],                  // Match records created by scoring
  matchNotifications: [],       // simulated "new match found" alerts
  matchesAcceptedCount: 0,
};

function _persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(_store)); } catch { /* ignore */ }
}

function _hydrate() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.declaredAvailabilities) _store.declaredAvailabilities = saved.declaredAvailabilities;
    if (saved.matches)                _store.matches                = saved.matches;
    if (saved.matchNotifications)     _store.matchNotifications     = saved.matchNotifications;
    if (saved.matchesAcceptedCount)   _store.matchesAcceptedCount   = saved.matchesAcceptedCount;
  } catch { /* corrupted storage — start fresh */ }
}
_hydrate();

/* ── Truck availability ──────────────────────────────────────────────────── */

export function getTruckAvailabilities() {
  return Promise.resolve([..._store.declaredAvailabilities, ...DEMO_TRUCK_AVAILABILITY]);
}

export function getActiveTruckAvailabilities() {
  return getTruckAvailabilities().then(list =>
    list.filter(t => t.status === TRUCK_AVAILABILITY_STATUS.ACTIVE)
  );
}

export function declareTruckAvailability(formData) {
  const ta = createTruckAvailability(formData);
  _store.declaredAvailabilities = [ta, ..._store.declaredAvailabilities];
  _persist();
  return Promise.resolve(ta);
}

export function cancelTruckAvailability(truckAvailabilityId) {
  _store.declaredAvailabilities = _store.declaredAvailabilities.map(t =>
    t.id === truckAvailabilityId ? { ...t, status: TRUCK_AVAILABILITY_STATUS.CANCELLED } : t
  );
  _persist();
  return Promise.resolve({ id: truckAvailabilityId });
}

/* ── Matching (both directions, same scoring engine) ────────────────────── */

function _upsertMatch(scoreResult) {
  const existing = _store.matches.find(
    m => m.truckId === scoreResult.truckId && m.cargoId === scoreResult.cargoId
  );
  if (existing) {
    Object.assign(existing, scoreResult, { score: scoreResult.matchScore });
    _persist();
    return existing;
  }
  const match = createMatch(scoreResult);
  _store.matches = [match, ..._store.matches];
  _persist();
  return match;
}

/**
 * TRUCK → FIND CARGO. Scores one truck against every cargo item, ranks by
 * score descending, and records a Match for each (Suggested by default).
 */
export function findMatchesForTruck(truck, cargoPool = [], { minScore = 0 } = {}) {
  const results = cargoPool
    .filter(c => (c.status || "Escrow Held") === "Escrow Held" || c.status === undefined)
    .map(cargo => scoreMatch(truck, cargo))
    .filter(r => r.matchScore >= minScore)
    .sort((a, b) => b.matchScore - a.matchScore)
    .map(r => _upsertMatch(r));
  return Promise.resolve(results);
}

/**
 * CARGO → FIND TRUCK. Same scoring engine, opposite side held fixed —
 * satisfies "matching must work both ways using the same underlying engine."
 */
export function findMatchesForCargo(cargo, truckPool = [], { minScore = 0 } = {}) {
  const results = truckPool
    .filter(t => t.status === TRUCK_AVAILABILITY_STATUS.ACTIVE)
    .map(truck => scoreMatch(truck, cargo))
    .filter(r => r.matchScore >= minScore)
    .sort((a, b) => b.matchScore - a.matchScore)
    .map(r => _upsertMatch(r));
  return Promise.resolve(results);
}

export function getMatches() {
  return Promise.resolve([..._store.matches]);
}

function _setMatchStatus(matchId, status) {
  const match = _store.matches.find(m => m.id === matchId);
  if (match) {
    match.status = status;
    if (status === MATCH_STATUS.ACCEPTED) _store.matchesAcceptedCount += 1;
    _persist();
  }
  return match || null;
}

export function requestMatch(matchId)  { return Promise.resolve(_setMatchStatus(matchId, MATCH_STATUS.REQUESTED)); }
export function acceptMatch(matchId)   { return Promise.resolve(_setMatchStatus(matchId, MATCH_STATUS.ACCEPTED)); }
export function declineMatch(matchId)  { return Promise.resolve(_setMatchStatus(matchId, MATCH_STATUS.DECLINED)); }
export function markMatchViewed(matchId) {
  const match = _store.matches.find(m => m.id === matchId);
  if (match && match.status === MATCH_STATUS.SUGGESTED) _setMatchStatus(matchId, MATCH_STATUS.VIEWED);
  return Promise.resolve(match || null);
}

/* ── Admin views: unmatched capacity / unmatched cargo ──────────────────── */

export function getUnmatchedTrucks(cargoPool = []) {
  return getActiveTruckAvailabilities().then(trucks =>
    trucks.filter(truck => {
      const best = cargoPool.reduce((max, cargo) => {
        const s = scoreMatch(truck, cargo).matchScore;
        return s > max ? s : max;
      }, 0);
      return best < MATCH_THRESHOLD;
    })
  );
}

export function getUnmatchedCargo(truckPool = [], cargoPool = []) {
  const activeTrucks = truckPool.filter(t => t.status === TRUCK_AVAILABILITY_STATUS.ACTIVE);
  return Promise.resolve(
    cargoPool.filter(cargo => {
      const best = activeTrucks.reduce((max, truck) => {
        const s = scoreMatch(truck, cargo).matchScore;
        return s > max ? s : max;
      }, 0);
      return best < MATCH_THRESHOLD;
    })
  );
}

/* ── Network stats ───────────────────────────────────────────────────────── */

export function getNetworkStats(cargoPool = [], truckPool = []) {
  const activeTrucks = truckPool.filter(t => t.status === TRUCK_AVAILABILITY_STATUS.ACTIVE);
  const openCargo     = cargoPool.filter(c => (c.status || "Escrow Held") === "Escrow Held");

  let potentialMatches = 0;
  let emptyReturnOpportunities = 0;
  let estKmSaved = 0;

  activeTrucks.forEach(truck => {
    let bestForTruck = 0;
    openCargo.forEach(cargo => {
      const s = scoreMatch(truck, cargo);
      if (s.matchScore >= MATCH_THRESHOLD) {
        potentialMatches += 1;
        if (s.matchScore > bestForTruck) bestForTruck = s.matchScore;
      }
    });
    if (bestForTruck >= MATCH_THRESHOLD) {
      emptyReturnOpportunities += 1;
      estKmSaved += 80; // rough demo heuristic: one avoided empty leg ≈ 80km
    }
  });

  const today = new Date().toDateString();
  const matchesToday = _store.matches.filter(
    m => new Date(m.createdAt).toDateString() === today
  ).length;

  return Promise.resolve({
    availableTrucks: activeTrucks.length,
    availableCargo:  openCargo.length,
    potentialMatches,
    matchesToday,
    matchesAccepted: _store.matchesAcceptedCount,
    unmatchedTrucks: 0,   // filled in by caller via getUnmatchedTrucks for accuracy
    unmatchedCargo:  0,
    emptyReturnOpportunities,
    estKmSaved,
  });
}

/* ── Flow C: notify active availabilities when new cargo appears ─────────── */

export function checkNewMatchesForActiveAvailabilities(newCargo) {
  return getActiveTruckAvailabilities().then(trucks => {
    const created = [];
    trucks.forEach(truck => {
      const result = scoreMatch(truck, newCargo);
      if (result.matchScore >= 60) {
        const match = _upsertMatch(result);
        const notif = {
          id: `MN-${Date.now().toString(36)}-${truck.id}`,
          truckId: truck.id,
          carrierName: truck.carrierName,
          cargoId: newCargo.id,
          matchId: match.id,
          score: result.matchScore,
          message: `New match: ${newCargo.from} → ${newCargo.to} (${result.matchScore}% match) for your truck near ${truck.currentLocation?.name || "your location"}`,
          createdAt: new Date().toISOString(),
          read: false,
        };
        _store.matchNotifications = [notif, ..._store.matchNotifications];
        created.push(notif);
      }
    });
    if (created.length) _persist();
    return created;
  });
}

export function getMatchNotifications() {
  return Promise.resolve([..._store.matchNotifications]);
}

export function markNotificationRead(notifId) {
  _store.matchNotifications = _store.matchNotifications.map(n =>
    n.id === notifId ? { ...n, read: true } : n
  );
  _persist();
  return Promise.resolve();
}

/* ── Snapshot ─────────────────────────────────────────────────────────────── */

export function getMatchingSnapshot() {
  return {
    declaredAvailabilities: [..._store.declaredAvailabilities],
    matches: [..._store.matches],
    matchNotifications: [..._store.matchNotifications],
    matchesAcceptedCount: _store.matchesAcceptedCount,
  };
}

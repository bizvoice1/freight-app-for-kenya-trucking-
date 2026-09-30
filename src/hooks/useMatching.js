/**
 * src/hooks/useMatching.js
 * -------------------------
 * React bridge for matchingService.js — mirrors useLoads.js / useAdminOps.js.
 *
 * The only file that imports both React and matchingService.js. Portals and
 * App.jsx consume this hook (via FreightContext / sharedProps) and never
 * touch matchingService or models/match.js directly.
 *
 * Cargo lives in loadService, not here, so every matching call takes the
 * current cargo pool as a parameter (passed in by the caller, who already
 * has it from useLoads()) rather than this hook reaching into loadService.
 */

import { useState, useCallback, useEffect } from "react";
import {
  getTruckAvailabilities,
  declareTruckAvailability as svcDeclare,
  cancelTruckAvailability as svcCancelAvailability,
  findMatchesForTruck as svcFindForTruck,
  findMatchesForCargo as svcFindForCargo,
  requestMatch as svcRequestMatch,
  acceptMatch as svcAcceptMatch,
  declineMatch as svcDeclineMatch,
  markMatchViewed as svcMarkViewed,
  getUnmatchedTrucks as svcUnmatchedTrucks,
  getUnmatchedCargo as svcUnmatchedCargo,
  getNetworkStats as svcNetworkStats,
  checkNewMatchesForActiveAvailabilities as svcCheckNewMatches,
  getMatchNotifications,
  markNotificationRead as svcMarkNotifRead,
  getMatchingSnapshot,
} from "../services/matchingService.js";

export function useMatching() {
  const [truckAvailabilities, setTruckAvailabilities] = useState([]);
  const [matches, setMatches]                         = useState([]);
  const [matchNotifications, setMatchNotifications]   = useState([]);
  const [networkStats, setNetworkStats]                = useState({
    availableTrucks: 0, availableCargo: 0, potentialMatches: 0,
    matchesToday: 0, matchesAccepted: 0, unmatchedTrucks: 0,
    unmatchedCargo: 0, emptyReturnOpportunities: 0, estKmSaved: 0,
  });

  const sync = useCallback(() => {
    getTruckAvailabilities().then(setTruckAvailabilities);
    const snap = getMatchingSnapshot();
    setMatches(snap.matches);
    setMatchNotifications(snap.matchNotifications);
  }, []);

  useEffect(() => { sync(); }, [sync]);

  const declareAvailability = useCallback((formData) =>
    svcDeclare(formData).then(ta => { sync(); return ta; }), [sync]);

  const cancelAvailability = useCallback((id) =>
    svcCancelAvailability(id).then(r => { sync(); return r; }), [sync]);

  const findMatchesForTruck = useCallback((truck, cargoPool, opts) =>
    svcFindForTruck(truck, cargoPool, opts).then(r => { sync(); return r; }), [sync]);

  const findMatchesForCargo = useCallback((cargo, truckPool, opts) =>
    svcFindForCargo(cargo, truckPool, opts).then(r => { sync(); return r; }), [sync]);

  const requestMatch = useCallback((id) => svcRequestMatch(id).then(r => { sync(); return r; }), [sync]);
  const acceptMatch  = useCallback((id) => svcAcceptMatch(id).then(r  => { sync(); return r; }), [sync]);
  const declineMatch = useCallback((id) => svcDeclineMatch(id).then(r => { sync(); return r; }), [sync]);
  const markMatchViewed = useCallback((id) => svcMarkViewed(id).then(r => { sync(); return r; }), [sync]);

  const getUnmatchedTrucks = useCallback((cargoPool) => svcUnmatchedTrucks(cargoPool), []);
  const getUnmatchedCargo  = useCallback((truckPool, cargoPool) => svcUnmatchedCargo(truckPool, cargoPool), []);

  /**
   * Recomputes network-wide stats given the live cargo pool (from useLoads)
   * and current truck availabilities. Mirrors useAdminOps.refreshHealth().
   */
  const refreshNetworkStats = useCallback((cargoPool = []) => {
    return getTruckAvailabilities().then(trucks =>
      svcNetworkStats(cargoPool, trucks).then(stats =>
        Promise.all([svcUnmatchedTrucks(cargoPool), svcUnmatchedCargo(trucks, cargoPool)]).then(
          ([unmatchedTrucks, unmatchedCargo]) => {
            const full = {
              ...stats,
              unmatchedTrucks: unmatchedTrucks.length,
              unmatchedCargo: unmatchedCargo.length,
            };
            setNetworkStats(full);
            return full;
          }
        )
      )
    );
  }, []);

  /**
   * Flow C — call this after new cargo is posted; re-scores it against every
   * Active truck availability and surfaces a simulated in-session
   * notification for any strong match (not a real push service).
   */
  const checkNewCargoForMatches = useCallback((newCargo) =>
    svcCheckNewMatches(newCargo).then(created => { sync(); return created; }), [sync]);

  const markNotificationRead = useCallback((id) =>
    svcMarkNotifRead(id).then(() => { getMatchNotifications().then(setMatchNotifications); }), []);

  return {
    truckAvailabilities,
    matches,
    matchNotifications,
    networkStats,

    declareAvailability,
    cancelAvailability,
    findMatchesForTruck,
    findMatchesForCargo,
    requestMatch,
    acceptMatch,
    declineMatch,
    markMatchViewed,
    getUnmatchedTrucks,
    getUnmatchedCargo,
    refreshNetworkStats,
    checkNewCargoForMatches,
    markNotificationRead,
  };
}

/**
 * src/hooks/useLiveTrip.js
 * ---------------------------
 * Phase 4G.5 — polling, not WebSockets, on purpose: "once real usage
 * demonstrates sub-second updates or hundreds/thousands of simultaneously
 * watched trips are needed, introduce realtime infrastructure." One trip,
 * one shipper, one browser tab does not need that yet.
 *
 * This is the only place that knows the poll interval — every portal using
 * live tracking goes through here, not its own setInterval.
 */

import { useState, useEffect, useRef } from "react";
import { findTripByLoadId, findTripsByTruckId, listTrips, getLatestLocation } from "../services/trackingApi.js";
import { ACTIVE_TRIP_STATUSES } from "../models/trip.js";

export const POLL_MS = 7000; // within the agreed 5-10s window — every live-tracking consumer shares this

/**
 * Live-tracks whichever backend trip corresponds to a Load id — the
 * Shipper portal's entry point (a shipment doesn't know its own tripId).
 * Resolves to { trip:null, location:null, loading:false, error:null } if
 * that load has no backend-tracked trip yet (most loads, today — see
 * backend/README.md's scope note).
 */
export function useLiveTripByLoadId(loadId, role = "shipper") {
  return _usePoll(() => (loadId ? findTripByLoadId(loadId, role) : Promise.resolve(null)), [loadId, role]);
}

/**
 * Live-tracks whichever ACTIVE backend trip a Truck is currently running —
 * the Transporter/Fleet portal's entry point (a truck, not a load, is what
 * a fleet owner clicks on).
 */
export function useLiveTripByTruckId(truckId, role = "fleet_owner") {
  return _usePoll(async () => {
    if (!truckId) return null;
    const trips = await findTripsByTruckId(truckId, role);
    return trips.find(t => ACTIVE_TRIP_STATUSES.has(t.status)) || null;
  }, [truckId, role]);
}

function _usePoll(fetchTrip, deps) {
  const [state, setState] = useState({ trip: null, location: null, loading: true, error: null });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setState(s => ({ ...s, loading: true, error: null }));

    async function tick() {
      try {
        const trip = await fetchTrip();
        if (cancelledRef.current) return;
        if (!trip) { setState({ trip: null, location: null, loading: false, error: null }); return; }
        const location = await getLatestLocation(trip.id);
        if (cancelledRef.current) return;
        setState({ trip, location, loading: false, error: null });
      } catch (err) {
        if (!cancelledRef.current) setState(s => ({ ...s, loading: false, error: err.message }));
      }
    }

    tick();
    const intervalId = setInterval(tick, POLL_MS);
    return () => { cancelledRef.current = true; clearInterval(intervalId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

/**
 * Live-polls every backend trip — Admin's operations view (4G.4). Each
 * trip is enriched with its own latest location (fetched in parallel), so
 * the list is ready to render without a second round of per-row fetching.
 */
export function useAllLiveTrips(role = "admin") {
  const [state, setState] = useState({ trips: [], loading: true, error: null });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    async function tick() {
      try {
        const trips = await listTrips({}, role);
        if (cancelledRef.current) return;
        const withLocations = await Promise.all(
          trips.map(async trip => ({ trip, location: await getLatestLocation(trip.id, role).catch(() => null) }))
        );
        if (cancelledRef.current) return;
        setState({ trips: withLocations, loading: false, error: null });
      } catch (err) {
        if (!cancelledRef.current) setState(s => ({ ...s, loading: false, error: err.message }));
      }
    }

    tick();
    const intervalId = setInterval(tick, POLL_MS);
    return () => { cancelledRef.current = true; clearInterval(intervalId); };
  }, [role]);

  return state;
}

/** Polls the role-scoped trip list (GET /api/trips). Transporter: own trucks' trips. Admin: all. */
export function useTripList(role) {
  const [state, setState] = useState({ trips: [], loading: true, error: null });
  const cancelledRef = useRef(false);
  const tickRef = useRef(null);
  useEffect(() => {
    cancelledRef.current = false;
    async function tick() {
      try {
        const trips = await listTrips({}, role);
        if (!cancelledRef.current) setState({ trips, loading: false, error: null });
      } catch (err) {
        if (!cancelledRef.current) setState(s => ({ ...s, loading: false, error: err.message }));
      }
    }
    tickRef.current = tick;
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelledRef.current = true; clearInterval(id); };
  }, [role]);
  return { ...state, refresh: () => tickRef.current && tickRef.current() };
}

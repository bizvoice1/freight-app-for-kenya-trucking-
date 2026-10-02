/**
 * src/services/loadViews.js
 * --------------------------
 * Read-only view derivation over the canonical load set — Phase 2 of the
 * seed-data unification plan.
 *
 * Wired into all three portals (behari-freight-v2.jsx, behari-shipper-v2.jsx,
 * behari-admin-v2.jsx), which import these functions instead of maintaining
 * their own merge logic. data/shipments.js (SHIPMENTS_SEED/SHIPMENT_HISTORY_SEED)
 * and data/loads.js's MY_TRIPS_SEED have been removed — they had no remaining
 * consumers once every portal read from getAllKnownLoads() instead.
 *
 * getAllKnownLoads() is the one shared list every view function reads from:
 *   MARKETPLACE_LOADS (legacy carrier marketplace) ∪ SEED_LOADS (the
 *   resolved canonical set — see data/seedLoads.js) ∪ postedLoads (session-
 *   created, from loadService's live store), deduplicated by ID with
 *   postedLoads taking priority (a session can never be shadowed by seed
 *   data), and with any loadStatuses override applied on top.
 */

import { getStoreSnapshot } from "./loadService.js";
import { withSeedGeo, ratePerKm } from "../models/geo.js";


/**
 * The single merged, de-duplicated, status-corrected load list. Every
 * portal-specific view function below starts from this.
 *
 * Priority when the same ID appears in more than one source:
 * postedLoads (live, session-created) > SEED_LOADS (resolved canonical demo
 * data) > MARKETPLACE_LOADS (legacy — kept only for fields SEED_LOADS
 * doesn't carry, e.g. a marketplace listing not yet promoted into the
 * resolved set).
 */
export function getAllKnownLoads() {
  const snap = getStoreSnapshot();
  const known = new Map();
  snap.postedLoads.map(withSeedGeo).forEach(l => known.set(l.id, l));
  return [...known.values()].map(l => ({
    ...l,
    status: snap.loadStatuses[l.id] ?? l.status,
  }));
}

/** Finds the live booking notification for a load, if one exists. */
function findBooking(loadId, bookings) {
  return bookings.find(b => b.loadId === loadId) || null;
}

/**
 * Fallback progress-by-status, used only when a load record doesn't already
 * carry an explicit `progress` value. SEED_LOADS entries all set progress
 * directly; freshly-posted loads (from createLoadFromForm) don't — the old
 * per-portal merge logic derived it from status inline, so that behaviour is
 * preserved here instead of being silently dropped by centralization.
 */
const STATUS_PROGRESS_FALLBACK = {
  "Escrow Held":5, "Accepted":15, "Loading":25, "In Transit":55,
  "Arrived":80, "Delivery Confirmed":95, "Paid Out":100, "Delivered":100,
  "Cancelled":0, "Disputed":50, "Dispute Resolved":90,
};

/**
 * Shape for the Carrier "Find Loads" marketplace — adds the rate-per-km and
 * facility-rating fields that view expects, deriving them if missing rather
 * than requiring every canonical record to carry every optional field.
 */
export function toCarrierMarketplaceView(load) {
  return {
    ...load,
    rateKm: load.rateKm || ratePerKm(load.pay || 0, load.dist || 0),
    facilRating: load.facilRating ?? load.rating ?? 0,
    urgent: !!load.urgent,
  };
}

/**
 * Shape for the Carrier "My Loads" trip list — booking (if any) overrides
 * the canonical record's driver-side fields, since a live booking is always
 * more current than a static seed value.
 */
export function toCarrierTripView(load, bookings = []) {
  const booking = findBooking(load.id, bookings);
  return {
    ...load,
    driver: booking?.carrier || load.driver || "—",
    plate: booking?.plate || load.plate || "—",
    truckType: booking?.truckType || load.truckType || load.truck,
    progress: load.progress ?? STATUS_PROGRESS_FALLBACK[load.status] ?? 0,
    eta: load.eta || load.delD || "TBD",
  };
}

/**
 * Shape for the Shipper "Dashboard"/"Shipments" — same booking-override
 * pattern, plus the shipper-facing "ping" (last known location string).
 */
export function toShipperShipmentView(load, bookings = []) {
  const booking = findBooking(load.id, bookings);
  const isDone = load.status === "Delivered" || load.status === "Paid Out";
  const plate = booking?.plate || load.plate;
  return {
    ...load,
    driver: booking?.carrier || load.driver || "Matching transporter…",
    plate: plate || "—",
    truck: booking?.truckType || load.truck || "Any Available",
    progress: load.progress ?? STATUS_PROGRESS_FALLBACK[load.status] ?? 0,
    route: load.route || `${load.from} → ${load.to}`,
    // Priority matters here, not just presence: a SEED_LOADS record's static
    // `ping` reflects its *authored* status (e.g. "Nakuru Bypass" while In
    // Transit, or "Awaiting transporter" while Escrow Held) and goes stale the
    // moment reality changes — either the load reaches a done state, or a
    // LIVE booking gets created for it (found a second instance of this same
    // bug during Phase 3C testing: booking KE-2046 still showed the seed's
    // stale "Awaiting transporter" instead of "Transporter dispatched" because
    // `load.ping` was checked before the live booking). Live signals
    // (isDone, then an actual booking) must always outrank the static value.
    ping: isDone
      ? "Delivered ✓"
      : booking
      ? `Transporter dispatched · ${plate}`
      : (load.ping || "Awaiting transporter"),
    eta: load.eta || load.delD || "TBD",
  };
}

/**
 * Shape for Admin's load lists (Command Center, Heatmap, Dispatch, etc.) —
 * adds the combined "route" string those views render directly.
 */
export function toAdminLoadView(load, bookings = []) {
  const booking = findBooking(load.id, bookings);
  return {
    ...load,
    route: load.route || `${load.from} → ${load.to}`,
    driver: booking?.carrier || load.driver || "Unassigned",
    date: load.date || load.pickD || "—",
  };
}

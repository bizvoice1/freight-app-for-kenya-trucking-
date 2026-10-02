/**
 * src/services/loadService.js
 * ---------------------------
 * The Load Management Service — the boundary between the UI and the backend.
 *
 * ARCHITECTURE NOTE:
 *   Every function in this file returns a Promise. In mock mode the Promise
 *   resolves immediately with in-memory data. In production, replace the
 *   function body with a fetch() call and the rest of the codebase changes
 *   nothing — because the callers already await the result.
 *
 *   RULE: This file has zero React imports. No useState, no useEffect.
 *   It is plain JavaScript that can run in Node, a test runner, or React Native.
 *
 *   The in-memory store below (`_store`) simulates a database table.
 *   It is module-scoped — the same instance lives for the entire app session,
 *   so state persists across component mount/unmount cycles.
 *
 * Functions exported:
 *   READ:
 *     createLoad(formData)          → shipper posts a new load
 *     assignCarrier(bookingData)    → carrier accepts a load + picks a truck
 *     updateLoadStatus(id, status)  → mark as Delivered, Cancelled, etc.
 *     getLoadById(id)               → look up a single load by ID
 *     getEscrowData(loadId)         → escrow record for a load
 *     getMilestones(loadId)         → ordered milestone events for a load
 *     getDispute(loadId)            → dispute record for a load
 *     getStoreSnapshot()            → full store dump for React state sync
 *
 *   SHIPMENT ACTIONS (Step 2):
 *     acceptLoad(loadId)
 *     rejectLoad(loadId, reason)
 *     cancelShipment(loadId, reason)
 *     reassignTruck(loadId, truckData)
 *     confirmLoading(loadId)
 *     startTrip(loadId)
 *     markBorderCrossing(loadId, location)
 *     markDelay(loadId, reason, penaltyKsh)
 *     markArrived(loadId)
 *     confirmDelivery(loadId, deliveryData)   ← Step 3 (OTP + photo + sig + GPS)
 *     releaseEscrow(loadId, opts)             ← Step 4
 *     openDispute(loadId, disputeData)
 *     closeDispute(loadId, resolution)
 */

import { MARKETPLACE_LOADS } from "../data/loads.js";
import { SEED_LOADS } from "../data/seedLoads.js";
import {
  createLoadFromForm,
  createBookingNotification,
  LOAD_STATUS,
  ESCROW_STATUS,
  calculateEscrowRelease,
} from "../models/load.js";
import { metersToKm, ratePerKmFromMeters } from "../models/geo.js";
import { createRatingRecord, aggregateRatings } from "../models/rating.js";

/* ── Helpers ────────────────────────────────────────────────────────────── */

function nowStamp() {
  const now   = new Date();
  const date  = now.toLocaleDateString("en-KE", { day:"numeric", month:"short" });
  const time  = now.toLocaleTimeString("en-KE", { hour:"2-digit", minute:"2-digit" });
  return `${date}, ${time}`;
}

/* ── In-memory store (mock database) ───────────────────────────────────── */

/**
 * _store holds the mutable runtime state for this service.
 * It is hydrated from localStorage on first import and persisted after
 * every mutation, so data survives page refreshes without a backend.
 */
const STORE_KEY = "behari_store_v2";

function _persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      ..._store,
      deliveredIds: [..._store.deliveredIds],  // Set → Array for JSON
    }));
  } catch { /* storage full or private mode — silently skip */ }
}

function _hydrate() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.postedLoads)    _store.postedLoads    = saved.postedLoads;
    if (saved.bookings)       _store.bookings       = saved.bookings;
    if (saved.deliveredIds)   _store.deliveredIds   = new Set(saved.deliveredIds);
    if (saved.loadStatuses)   _store.loadStatuses   = saved.loadStatuses;
    if (saved.milestones)     _store.milestones     = saved.milestones;
    if (saved.escrowData)     _store.escrowData     = saved.escrowData;
    if (saved.disputes)       _store.disputes       = saved.disputes;
    if (saved.bookingSlots)   _store.bookingSlots   = saved.bookingSlots;
    if (saved.ratings)        _store.ratings        = saved.ratings;
    if (saved.carrierRatings) _store.carrierRatings = saved.carrierRatings;
    if (saved.shipperRatings) _store.shipperRatings = saved.shipperRatings;
    if (saved.fraudFlags)     _store.fraudFlags     = saved.fraudFlags;
  } catch { /* corrupted storage — start fresh */ }
}

const _store = {
  postedLoads:   [],
  bookings:      [],
  deliveredIds:  new Set(),
  loadStatuses:  {},    // { loadId → LOAD_STATUS value }
  milestones:    {},    // { loadId → [{icon, text, at}] }
  escrowData:    {},    // { loadId → EscrowRecord }
  disputes:      {},    // { loadId → DisputeRecord }
  bookingSlots:  {},    // { loadId → BookingSlot[] }  ← Step 5: multi-truck
  ratings:       {},    // { loadId → RatingRecord[] } ← Step 8: reputation
  carrierRatings:{},    // { carrierId → RatingRecord[] }
  shipperRatings:{},    // { shipperId → RatingRecord[] }
  fraudFlags:    {},    // { userId → FraudFlag[] }    ← Step 9: admin
};

// Restore saved state immediately on module load
_hydrate();

/* ── Internal helpers ────────────────────────────────────────────────────── */

function _getLoad(loadId) {
  return (
    _store.postedLoads.find(l => l.id === loadId) ||
    MARKETPLACE_LOADS.find(l => l.id === loadId) ||
    // Canonical demo-load set (src/data/seedLoads.js) — Phase 2 of the
    // seed-data unification: lets any service action (confirmDelivery,
    // releaseEscrow, ratings, disputes) resolve a correct record for IDs
    // that previously existed only in a single portal's own hardcoded
    // array (e.g. KE-2038, KE-2039, KE-2041), instead of silently
    // defaulting fields like escrow.baseAmount to 0.
    SEED_LOADS.find(l => l.id === loadId) ||
    null
  );
}

function _setStatus(loadId, status) {
  _store.loadStatuses[loadId] = status;
  // Mirror into postedLoads so status stays consistent across reads
  _store.postedLoads = _store.postedLoads.map(l =>
    l.id === loadId ? { ...l, status } : l
  );
  if (status === LOAD_STATUS.PAID_OUT || status === LOAD_STATUS.DELIVERY_CONFIRMED || status === LOAD_STATUS.DELIVERED) {
    _store.deliveredIds = new Set([..._store.deliveredIds, loadId]);
  }
  _persist();
}

function _addMilestone(loadId, icon, text) {
  if (!_store.milestones[loadId]) _store.milestones[loadId] = [];
  _store.milestones[loadId] = [
    ..._store.milestones[loadId],
    { icon, text, at: nowStamp() },
  ];
  _persist();
}

function _initEscrow(loadId) {
  if (!_store.escrowData[loadId]) {
    const load = _getLoad(loadId);
    _store.escrowData[loadId] = {
      status:       ESCROW_STATUS.HELD,
      baseAmount:   load?.pay || 0,
      latePenalty:  0,
      adminFee:     null,   // computed on release
      partialRefund:0,
      heldAt:       nowStamp(),
      releasedAt:   null,
    };
  }
}

/* ── READ operations ────────────────────────────────────────────────────── */

/**
 * Returns a single load by ID, searching both posted and marketplace loads.
 * Status override from _store.loadStatuses is applied.
 */
export function getLoadById(loadId) {
  const load = _getLoad(loadId);
  if (!load) return Promise.resolve(null);
  return Promise.resolve({
    ...load,
    status: _store.loadStatuses[loadId] ?? load.status,
  });
}

/**
 * Returns the escrow record for a load.
 */
export function getEscrowData(loadId) {
  return Promise.resolve(_store.escrowData[loadId] || null);
}

/**
 * Returns the ordered milestone log for a load.
 */
export function getMilestones(loadId) {
  return Promise.resolve(_store.milestones[loadId] || []);
}

/**
 * Returns the dispute record for a load.
 */
export function getDispute(loadId) {
  return Promise.resolve(_store.disputes[loadId] || null);
}

/* ── WRITE operations (legacy) ──────────────────────────────────────────── */

export function createLoad(formData) {
  const newLoad = createLoadFromForm(formData, _store.postedLoads.length);
  _store.postedLoads = [newLoad, ..._store.postedLoads];
  // Initialise escrow immediately on load creation
  _initEscrow(newLoad.id);
  _addMilestone(newLoad.id, "🔒", `Escrow locked — KSh ${newLoad.pay.toLocaleString()} held`);
  return Promise.resolve(newLoad);
}

/** Copies the backend's stored road route (and canonical id) onto the local load. Estimates are never promoted: source must be ROAD. */
export function linkBackendLoad(loadId, view) {
  const l = _store.postedLoads.find(x => x.id === loadId);
  if (!l || !view?.id) return Promise.resolve(l || null);
  const road = view.distanceSource === "ROAD" && view.distanceMeters > 0;
  const next = { ...l, backendLoadId: view.id };
  if (road) {
    next.distanceMeters = view.distanceMeters;
    next.routePolyline  = view.routePolyline || null;
    next.dist           = metersToKm(view.distanceMeters);
    next.distSource     = "route";
    next.rateKm         = ratePerKmFromMeters(l.pay, view.distanceMeters);
    next.etaMin         = view.routeDurationMin || l.etaMin;
  }
  _store.postedLoads = _store.postedLoads.map(x => x.id === loadId ? next : x);
  _persist();
  return Promise.resolve(next);
}

export function assignCarrier({ loadId, cargo, carrier, plate, truckType }) {
  const notification = createBookingNotification({
    loadId, cargo, carrier, plate, truckType,
  });
  _store.bookings = [notification, ..._store.bookings];

  // ── Multi-truck partial fulfillment ──────────────────────────────────────
  // Initialise slot array for this load if not yet done.
  if (!_store.bookingSlots[loadId]) _store.bookingSlots[loadId] = [];

  const load         = _getLoad(loadId);
  const trucksNeeded = load?.truckCount || 1;
  const slotIndex    = _store.bookingSlots[loadId].length;

  _store.bookingSlots[loadId] = [
    ..._store.bookingSlots[loadId],
    {
      slotId:    `${loadId}-S${slotIndex + 1}`,
      carrier,
      plate,
      truckType,
      status:    "Booked",
      bookedAt:  nowStamp(),
    },
  ];

  const slotsBooked = _store.bookingSlots[loadId].length;

  // Update trucksRemaining on the posted load object
  _store.postedLoads = _store.postedLoads.map(l =>
    l.id === loadId
      ? { ...l, trucksRemaining: Math.max(0, (l.trucksRemaining ?? trucksNeeded) - 1) }
      : l
  );

  _initEscrow(loadId);

  if (slotsBooked >= trucksNeeded) {
    // All trucks filled — fully accepted
    _setStatus(loadId, LOAD_STATUS.ACCEPTED);
    _addMilestone(loadId, "✅", `All ${trucksNeeded} trucks booked — load fully accepted`);
  } else {
    // Partial fulfillment
    _addMilestone(
      loadId, "🚛",
      `${carrier} booked slot ${slotsBooked}/${trucksNeeded} — truck ${plate}`
    );
  }

  return Promise.resolve(notification);
}

/**
 * Returns the booking slots for a load (multi-truck fulfillment).
 */
export function getBookingSlots(loadId) {
  return Promise.resolve(_store.bookingSlots[loadId] || []);
}

export function updateLoadStatus(loadId, status) {
  _setStatus(loadId, status);
  return Promise.resolve({ loadId, status });
}

/* ── SHIPMENT ACTIONS (Step 2) ──────────────────────────────────────────── */

/**
 * Carrier accepts an open load.
 */
export function acceptLoad(loadId) {
  _initEscrow(loadId);
  _setStatus(loadId, LOAD_STATUS.ACCEPTED);
  _addMilestone(loadId, "✅", "Load accepted by carrier");
  return Promise.resolve({ loadId, status: LOAD_STATUS.ACCEPTED });
}

/**
 * Carrier rejects a load they previously accepted.
 */
export function rejectLoad(loadId, reason = "No reason given") {
  _setStatus(loadId, LOAD_STATUS.CANCELLED);
  _addMilestone(loadId, "❌", `Load rejected by carrier — ${reason}`);
  // Trigger escrow refund to shipper
  if (_store.escrowData[loadId]) {
    _store.escrowData[loadId].status     = ESCROW_STATUS.REFUNDED;
    _store.escrowData[loadId].releasedAt = nowStamp();
  }
  return Promise.resolve({ loadId, status: LOAD_STATUS.CANCELLED });
}

/**
 * Cancel a shipment (shipper or admin action).
 */
export function cancelShipment(loadId, reason = "Cancelled by operator") {
  _setStatus(loadId, LOAD_STATUS.CANCELLED);
  _addMilestone(loadId, "🚫", `Shipment cancelled — ${reason}`);
  if (_store.escrowData[loadId]) {
    _store.escrowData[loadId].status     = ESCROW_STATUS.REFUNDED;
    _store.escrowData[loadId].releasedAt = nowStamp();
  }
  return Promise.resolve({ loadId, status: LOAD_STATUS.CANCELLED });
}

/**
 * Admin reassigns a truck on an active load.
 */
export function reassignTruck(loadId, { plate, truckType, carrier }) {
  _addMilestone(loadId, "🔄", `Truck reassigned → ${plate} (${carrier})`);
  // Update booking record if it exists
  _store.bookings = _store.bookings.map(b =>
    b.loadId === loadId
      ? { ...b, plate: plate || b.plate, truckType: truckType || b.truckType }
      : b
  );
  return Promise.resolve({ loadId, plate, truckType, carrier });
}

/**
 * Carrier confirms goods are loaded onto the truck.
 */
export function confirmLoading(loadId) {
  _setStatus(loadId, LOAD_STATUS.LOADING);
  _addMilestone(loadId, "📦", "Goods loaded onto truck — ready for departure");
  return Promise.resolve({ loadId, status: LOAD_STATUS.LOADING });
}

/**
 * Carrier starts the trip.
 */
export function startTrip(loadId) {
  _setStatus(loadId, LOAD_STATUS.IN_TRANSIT);
  _addMilestone(loadId, "🚛", "Trip started — truck is on the road");
  return Promise.resolve({ loadId, status: LOAD_STATUS.IN_TRANSIT });
}

/**
 * Carrier records a border crossing checkpoint.
 */
export function markBorderCrossing(loadId, location = "Border checkpoint") {
  _addMilestone(loadId, "🌍", `Border crossing recorded — ${location}`);
  return Promise.resolve({ loadId, location });
}

/**
 * Carrier marks a delay and applies an optional penalty.
 */
export function markDelay(loadId, reason = "Traffic", penaltyKsh = 0) {
  _addMilestone(loadId, "⏱", `Delay reported — ${reason}${penaltyKsh ? ` · KSh ${penaltyKsh.toLocaleString()} penalty applied` : ""}`);
  if (penaltyKsh && _store.escrowData[loadId]) {
    _store.escrowData[loadId].latePenalty =
      (_store.escrowData[loadId].latePenalty || 0) + penaltyKsh;
  }
  return Promise.resolve({ loadId, reason, penaltyKsh });
}

/**
 * Carrier marks arrival at the destination.
 */
export function markArrived(loadId) {
  _setStatus(loadId, LOAD_STATUS.ARRIVED);
  _addMilestone(loadId, "📍", "Truck arrived at destination — awaiting receiver confirmation");
  return Promise.resolve({ loadId, status: LOAD_STATUS.ARRIVED });
}

/* ── DELIVERY CONFIRMATION (Step 3) ─────────────────────────────────────── */

/**
 * Full delivery confirmation flow.
 *
 * @param {string} loadId
 * @param {Object} deliveryData
 * @param {string} deliveryData.otp          - 6-digit code entered by receiver
 * @param {string} deliveryData.receiverName - printed name of receiver
 * @param {string} deliveryData.photoDataUrl - base64 photo (or file name in prod)
 * @param {string} deliveryData.signatureDataUrl - canvas signature
 * @param {Object} deliveryData.gps          - { lat, lng, accuracy }
 * @returns {Promise<Object>} confirmation record
 */
export function confirmDelivery(loadId, deliveryData = {}) {
  _setStatus(loadId, LOAD_STATUS.DELIVERY_CONFIRMED);
  _addMilestone(loadId, "✅", `Delivery confirmed by ${deliveryData.receiverName || "receiver"} — OTP verified`);
  _addMilestone(loadId, "📸", "Proof of delivery photo uploaded");
  _addMilestone(loadId, "✍", "Signature captured");
  if (deliveryData.gps) {
    const { lat, lng } = deliveryData.gps;
    _addMilestone(loadId, "📍", `GPS confirmed at ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
  }

  // Move escrow to Ready for Release
  _initEscrow(loadId);
  _store.escrowData[loadId].status = ESCROW_STATUS.READY_FOR_RELEASE;

  // Store proof of delivery
  if (!_store.deliveryProofs) _store.deliveryProofs = {};
  _store.deliveryProofs[loadId] = {
    ...deliveryData,
    confirmedAt: nowStamp(),
  };
  _persist(); // escrow status + proof-of-delivery must survive a reload —
              // admin release now happens later/elsewhere in the workflow.

  return Promise.resolve({
    loadId,
    status: LOAD_STATUS.DELIVERY_CONFIRMED,
    escrowStatus: ESCROW_STATUS.READY_FOR_RELEASE,
    confirmedAt: nowStamp(),
  });
}

/* ── ESCROW ACTIONS (Step 4) ─────────────────────────────────────────────── */

/**
 * Release escrow to carrier after delivery confirmation.
 *
 * @param {string} loadId
 * @param {Object} [opts]
 * @param {number} [opts.latePenalty]   - additional penalty to deduct
 * @param {number} [opts.partialRefund] - amount to refund to shipper
 * @param {number} [opts.adminFee]      - override platform fee
 * @param {number} [opts.baseAmount]    - correct the locked amount if it was
 *                                        initialised at 0 (e.g. a load that
 *                                        only exists in a portal's own seed
 *                                        data, outside _getLoad()'s lookup)
 */
export function releaseEscrow(loadId, opts = {}) {
  _initEscrow(loadId);
  const escrow = _store.escrowData[loadId];

  // Apply any admin overrides
  if (opts.latePenalty  != null) escrow.latePenalty   = opts.latePenalty;
  if (opts.partialRefund != null) escrow.partialRefund = opts.partialRefund;
  if (opts.adminFee     != null) escrow.adminFee      = opts.adminFee;
  if (opts.baseAmount   != null && !escrow.baseAmount) escrow.baseAmount = opts.baseAmount;

  const breakdown = calculateEscrowRelease(escrow);

  escrow.status     = ESCROW_STATUS.RELEASED;
  escrow.releasedAt = nowStamp();
  escrow.breakdown  = breakdown;

  _setStatus(loadId, LOAD_STATUS.PAID_OUT);
  _addMilestone(loadId, "💸", `Escrow released — KSh ${breakdown.toCarrier.toLocaleString()} sent to carrier via M-Pesa`);
  if (breakdown.latePenalty) {
    _addMilestone(loadId, "⚠", `Late penalty deducted — KSh ${breakdown.latePenalty.toLocaleString()}`);
  }
  if (breakdown.partialRefund) {
    _addMilestone(loadId, "↩", `Partial refund KSh ${breakdown.partialRefund.toLocaleString()} returned to shipper`);
  }

  return Promise.resolve({
    loadId,
    status:      LOAD_STATUS.PAID_OUT,
    escrow:      { ...escrow, breakdown },
  });
}

/**
 * Refund full escrow to shipper (e.g. carrier no-show, cancellation).
 */
export function refundEscrow(loadId, reason = "Refund requested") {
  _initEscrow(loadId);
  const escrow = _store.escrowData[loadId];
  escrow.status     = ESCROW_STATUS.REFUNDED;
  escrow.releasedAt = nowStamp();
  _setStatus(loadId, LOAD_STATUS.CANCELLED);
  _addMilestone(loadId, "↩", `Full escrow refunded to shipper — ${reason}`);
  return Promise.resolve({ loadId, escrowStatus: ESCROW_STATUS.REFUNDED });
}

/**
 * Admin holds escrow (freeze during dispute investigation).
 */
export function adminHoldEscrow(loadId, reason = "Under review") {
  _initEscrow(loadId);
  _store.escrowData[loadId].status = ESCROW_STATUS.ADMIN_HOLD;
  _addMilestone(loadId, "🔒", `Escrow frozen by admin — ${reason}`);
  return Promise.resolve({ loadId, escrowStatus: ESCROW_STATUS.ADMIN_HOLD });
}

/* ── DISPUTE ACTIONS ─────────────────────────────────────────────────────── */

const TERMINAL_STATUSES = new Set([
  LOAD_STATUS.PAID_OUT,
  LOAD_STATUS.CANCELLED,
]);

/**
 * Open a dispute on a load.
 */
export function openDispute(loadId, { raisedBy, reason, evidence = "" }) {
  const current = _store.loadStatuses[loadId];
  if (TERMINAL_STATUSES.has(current)) {
    return Promise.reject(new Error(`Cannot dispute a ${current} load.`));
  }
  if (_store.disputes[loadId]?.status === "Open") {
    return Promise.reject(new Error("A dispute is already open for this load."));
  }
  _setStatus(loadId, LOAD_STATUS.DISPUTED);
  _store.disputes[loadId] = {
    id:         `DSP-${loadId}`,
    raisedBy,
    reason,
    evidence,
    status:     "Open",
    openedAt:   nowStamp(),
    closedAt:   null,
    resolution: null,
  };
  // Freeze escrow
  adminHoldEscrow(loadId, "Dispute opened");
  _addMilestone(loadId, "⚖", `Dispute opened by ${raisedBy} — ${reason}`);
  return Promise.resolve(_store.disputes[loadId]);
}

/**
 * Close/resolve a dispute.
 */
export function closeDispute(loadId, { resolution, favor }) {
  if (_store.disputes[loadId]) {
    _store.disputes[loadId].status     = "Resolved";
    _store.disputes[loadId].resolution = resolution;
    _store.disputes[loadId].favor      = favor;
    _store.disputes[loadId].closedAt   = nowStamp();
  }
  _setStatus(loadId, LOAD_STATUS.DISPUTE_RESOLVED);
  _addMilestone(loadId, "✅", `Dispute resolved — ${resolution} (favour: ${favor})`);
  return Promise.resolve(_store.disputes[loadId]);
}

/* ── RATING ACTIONS (Step 8) ─────────────────────────────────────────────── */

/**
 * Submit a rating after delivery.
 *
 * @param {Object} params
 * @param {string} params.loadId
 * @param {string} params.raterRole  - "shipper" | "carrier"
 * @param {string} params.rateeId    - who is being rated (carrier name or shipper name)
 * @param {Object} params.scores     - { dimension: 1..5 }
 * @param {string} [params.comment]
 */
export function submitRating({ loadId, raterRole, rateeId, scores, comment }) {
  if (hasRated(loadId, raterRole)) {
    return Promise.reject(new Error(`${raterRole} has already rated load ${loadId}.`));
  }
  const record = createRatingRecord({ loadId, raterRole, rateeId, scores, comment });

  // Store per load
  if (!_store.ratings[loadId]) _store.ratings[loadId] = [];
  _store.ratings[loadId] = [..._store.ratings[loadId], record];

  // Store per entity (carrier or shipper)
  if (raterRole === "shipper") {
    // Shipper rating a carrier
    if (!_store.carrierRatings[rateeId]) _store.carrierRatings[rateeId] = [];
    _store.carrierRatings[rateeId] = [..._store.carrierRatings[rateeId], record];
  } else {
    // Carrier rating a shipper
    if (!_store.shipperRatings[rateeId]) _store.shipperRatings[rateeId] = [];
    _store.shipperRatings[rateeId] = [..._store.shipperRatings[rateeId], record];
  }

  _addMilestone(loadId, "⭐", `${raterRole === "shipper" ? "Shipper" : "Carrier"} rated ${rateeId} — ${record.average}/5`);

  return Promise.resolve(record);
}

/**
 * Get aggregated rating stats for a carrier or shipper.
 */
export function getEntityRatings(entityId, entityType = "carrier") {
  const pool  = entityType === "carrier"
    ? (_store.carrierRatings[entityId] || [])
    : (_store.shipperRatings[entityId] || []);
  return Promise.resolve(aggregateRatings(pool));
}

/**
 * Returns all raw rating records for a load.
 */
export function getLoadRatings(loadId) {
  return Promise.resolve(_store.ratings[loadId] || []);
}

/**
 * Check if a role has already submitted a rating for a load.
 */
export function hasRated(loadId, raterRole) {
  const records = _store.ratings[loadId] || [];
  return records.some(r => r.raterRole === raterRole);
}

/* ── ADMIN FRAUD / INTERVENTION (Step 9) ────────────────────────────────── */

/**
 * Flag a user for suspicious activity.
 */
export function flagFraud(userId, reason, severity = "Medium") {
  if (!_store.fraudFlags[userId]) _store.fraudFlags[userId] = [];
  _store.fraudFlags[userId] = [
    ..._store.fraudFlags[userId],
    { id:`fraud_${Date.now()}`, userId, reason, severity, flaggedAt: nowStamp(), resolved: false },
  ];
  _persist();
  return Promise.resolve(_store.fraudFlags[userId]);
}

/**
 * Resolve a fraud flag.
 */
export function resolveFraudFlag(userId, flagId) {
  if (_store.fraudFlags[userId]) {
    _store.fraudFlags[userId] = _store.fraudFlags[userId].map(f =>
      f.id === flagId ? { ...f, resolved: true, resolvedAt: nowStamp() } : f
    );
  }
  _persist();
  return Promise.resolve(_store.fraudFlags[userId] || []);
}

/**
 * Admin force-sets a load status (intervention).
 */
export function adminForceStatus(loadId, status, note = "Admin override") {
  _setStatus(loadId, status);
  _addMilestone(loadId, "⚙", `Admin override → ${status} — ${note}`);
  return Promise.resolve({ loadId, status });
}

/* ── Store snapshot ──────────────────────────────────────────────────────── */

/**
 * Returns the current in-memory store state.
 * Used by App.jsx to sync React state with the service store after mutations.
 */
export function getStoreSnapshot() {
  return {
    postedLoads:    [..._store.postedLoads],
    bookings:       [..._store.bookings],
    deliveredIds:   new Set(_store.deliveredIds),
    loadStatuses:   { ..._store.loadStatuses },
    milestones:     { ..._store.milestones },
    escrowData:     { ..._store.escrowData },
    disputes:       { ..._store.disputes },
    bookingSlots:   { ..._store.bookingSlots },   // Step 5: multi-truck
    ratings:        { ..._store.ratings },         // Step 8: reputation
    carrierRatings: { ..._store.carrierRatings },
    shipperRatings: { ..._store.shipperRatings },
    fraudFlags:     { ..._store.fraudFlags },      // Step 9: admin
  };
}

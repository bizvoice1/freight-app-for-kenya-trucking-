/**
 * src/hooks/useLoads.js
 * ----------------------
 * React hook — the bridge between the Load Service and React components.
 *
 * ARCHITECTURE NOTE:
 *   This is the ONLY file that imports from both React and the service layer.
 *   It translates service Promises into React state that components can render.
 *
 *   RULE: Components must NOT import from services directly.
 *         Components must NOT import from data files directly.
 *         Components call this hook and get back plain values + callbacks.
 *
 *   The hook exposes every shipment lifecycle action (Steps 2, 3, 4) as a
 *   stable callback. Each callback calls the service, then updates the three
 *   shared state atoms that portals observe:
 *     • loadStatuses  — per-load status map (powers all status chips)
 *     • escrowData    — per-load escrow records (powers escrow panels)
 *     • milestones    — per-load event logs (powers timeline views)
 *
 * Usage in App.jsx:
 *   const {
 *     postedLoads, notifications, deliveredLoadIds,
 *     loadStatuses, escrowData, milestones, disputes,
 *     postLoad, bookLoad,
 *     acceptLoad, rejectLoad, cancelShipment, reassignTruck,
 *     confirmLoading, startTrip, markBorderCrossing, markDelay,
 *     markArrived, confirmDelivery, releaseEscrow, refundEscrow,
 *     openDispute, closeDispute,
 *   } = useLoads();
 */

import { useState, useCallback, useEffect } from "react";
import {
  createLoad,
  assignCarrier,
  updateLoadStatus,
  getStoreSnapshot,
  acceptLoad         as svcAccept,
  rejectLoad         as svcReject,
  cancelShipment     as svcCancel,
  reassignTruck      as svcReassign,
  confirmLoading     as svcConfirmLoading,
  startTrip          as svcStartTrip,
  markBorderCrossing as svcBorderCrossing,
  markDelay          as svcDelay,
  markArrived        as svcArrived,
  confirmDelivery    as svcConfirmDelivery,
  releaseEscrow      as svcReleaseEscrow,
  refundEscrow       as svcRefundEscrow,
  adminHoldEscrow    as svcAdminHold,
  openDispute        as svcOpenDispute,
  closeDispute       as svcCloseDispute,
  // Step 8: Ratings
  submitRating       as svcSubmitRating,
  hasRated           as svcHasRated,
  // Step 9: Admin tools
  flagFraud          as svcFlagFraud,
  resolveFraudFlag   as svcResolveFraudFlag,
  adminForceStatus   as svcAdminForce,
} from "../services/loadService.js";

/**
 * Sync helper — after any service mutation, pull the full snapshot and
 * update all React state atoms in one pass. This ensures that all portals
 * (carrier, shipper, admin) see consistent data without prop-drilling
 * fine-grained updates.
 */
function useSyncStore() {
  const [postedLoads,      setPostedLoads]      = useState([]);
  const [notifications,    setNotifications]    = useState([]);
  const [deliveredLoadIds, setDeliveredLoadIds] = useState(new Set());
  const [loadStatuses,     setLoadStatuses]     = useState({});
  const [escrowData,       setEscrowData]       = useState({});
  const [milestones,       setMilestones]       = useState({});
  const [disputes,         setDisputes]         = useState({});
  // Step 5 — multi-truck
  const [bookingSlots,     setBookingSlots]     = useState({});
  // Step 8 — ratings
  const [ratings,          setRatings]          = useState({});
  const [carrierRatings,   setCarrierRatings]   = useState({});
  const [shipperRatings,   setShipperRatings]   = useState({});
  // Step 9 — fraud flags
  const [fraudFlags,       setFraudFlags]       = useState({});

  const sync = useCallback(() => {
    const snap = getStoreSnapshot();
    setPostedLoads(snap.postedLoads);
    setNotifications(snap.bookings);
    setDeliveredLoadIds(snap.deliveredIds);
    setLoadStatuses(snap.loadStatuses);
    setEscrowData(snap.escrowData);
    setMilestones(snap.milestones);
    setDisputes(snap.disputes);
    setBookingSlots(snap.bookingSlots || {});
    setRatings(snap.ratings || {});
    setCarrierRatings(snap.carrierRatings || {});
    setShipperRatings(snap.shipperRatings || {});
    setFraudFlags(snap.fraudFlags || {});
  }, []);

  return {
    postedLoads, notifications, deliveredLoadIds,
    loadStatuses, escrowData, milestones, disputes,
    bookingSlots, ratings, carrierRatings, shipperRatings, fraudFlags,
    setPostedLoads, setNotifications, setDeliveredLoadIds,
    sync,
  };
}

/**
 * useLoads — manages the full load lifecycle in React state.
 */
export function useLoads() {
  const {
    postedLoads, notifications, deliveredLoadIds,
    loadStatuses, escrowData, milestones, disputes,
    bookingSlots, ratings, carrierRatings, shipperRatings, fraudFlags,
    setPostedLoads, setNotifications, setDeliveredLoadIds,
    sync,
  } = useSyncStore();

  // Hydrate React state from _store on mount.
  // _hydrate() in loadService runs synchronously when the module loads,
  // restoring persisted data into _store before any React render. This
  // effect pulls that restored _store into React state so components see
  // persisted loads immediately after a page refresh.
  useEffect(() => { sync(); }, [sync]);

  /* ── Legacy actions (kept for backward compat) ── */

  const postLoad = useCallback(async (formData) => {
    const newLoad = await createLoad(formData);
    setPostedLoads(prev => [newLoad, ...prev]);
    sync();
    return newLoad;
  }, [sync]);

  const bookLoad = useCallback(async (bookingData) => {
    const notification = await assignCarrier(bookingData);
    setNotifications(prev => [notification, ...prev]);
    sync();
    return notification;
  }, [sync]);

  // Legacy confirmDelivery — kept for Shipper portal backward compat.
  // Internally routes to the new full confirmDelivery with minimal data.
  const confirmDelivery_legacy = useCallback(async (loadId) => {
    await updateLoadStatus(loadId, "Delivered");
    setDeliveredLoadIds(prev => new Set([...prev, loadId]));
    sync();
  }, [sync]);

  /* ── Step 2: Shipment Actions ── */

  const acceptLoad = useCallback(async (loadId) => {
    await svcAccept(loadId);
    sync();
  }, [sync]);

  const rejectLoad = useCallback(async (loadId, reason) => {
    await svcReject(loadId, reason);
    sync();
  }, [sync]);

  const cancelShipment = useCallback(async (loadId, reason) => {
    await svcCancel(loadId, reason);
    sync();
  }, [sync]);

  const reassignTruck = useCallback(async (loadId, truckData) => {
    await svcReassign(loadId, truckData);
    sync();
  }, [sync]);

  const confirmLoading = useCallback(async (loadId) => {
    await svcConfirmLoading(loadId);
    sync();
  }, [sync]);

  const startTrip = useCallback(async (loadId) => {
    await svcStartTrip(loadId);
    sync();
  }, [sync]);

  const markBorderCrossing = useCallback(async (loadId, location) => {
    await svcBorderCrossing(loadId, location);
    sync();
  }, [sync]);

  const markDelay = useCallback(async (loadId, reason, penaltyKsh) => {
    await svcDelay(loadId, reason, penaltyKsh);
    sync();
  }, [sync]);

  const markArrived = useCallback(async (loadId) => {
    await svcArrived(loadId);
    sync();
  }, [sync]);

  /* ── Step 3: Full Delivery Confirmation ── */

  const confirmDelivery = useCallback(async (loadId, deliveryData) => {
    if (!deliveryData) {
      // Backward-compat: called with just loadId from old shipper UI
      await updateLoadStatus(loadId, "Delivered");
      setDeliveredLoadIds(prev => new Set([...prev, loadId]));
    } else {
      await svcConfirmDelivery(loadId, deliveryData);
    }
    sync();
  }, [sync]);

  /* ── Step 4: Escrow Actions ── */

  const releaseEscrow = useCallback(async (loadId, opts) => {
    await svcReleaseEscrow(loadId, opts);
    sync();
  }, [sync]);

  const refundEscrow = useCallback(async (loadId, reason) => {
    await svcRefundEscrow(loadId, reason);
    sync();
  }, [sync]);

  const adminHoldEscrow = useCallback(async (loadId, reason) => {
    await svcAdminHold(loadId, reason);
    sync();
  }, [sync]);

  /* ── Dispute Actions ── */

  const openDispute = useCallback(async (loadId, disputeData) => {
    await svcOpenDispute(loadId, disputeData);
    sync();
  }, [sync]);

  const closeDispute = useCallback(async (loadId, resolution) => {
    await svcCloseDispute(loadId, resolution);
    sync();
  }, [sync]);

  /* ── Step 8: Ratings ── */

  const submitRating = useCallback(async (ratingData) => {
    const result = await svcSubmitRating(ratingData);
    sync();
    return result;
  }, [sync]);

  const checkHasRated = useCallback((loadId, role) => {
    return svcHasRated(loadId, role);
  }, []);

  /* ── Step 9: Admin tools ── */

  const flagFraud = useCallback(async (userId, reason, severity) => {
    await svcFlagFraud(userId, reason, severity);
    sync();
  }, [sync]);

  const resolveFraudFlag = useCallback(async (userId, flagId) => {
    await svcResolveFraudFlag(userId, flagId);
    sync();
  }, [sync]);

  const adminForceStatus = useCallback(async (loadId, status, note) => {
    await svcAdminForce(loadId, status, note);
    sync();
  }, [sync]);

  return {
    // State values
    postedLoads,
    notifications,
    deliveredLoadIds,
    loadStatuses,
    escrowData,
    milestones,
    disputes,

    // Legacy callbacks (old prop names — portals not yet updated still work)
    postLoad,
    bookLoad,
    confirmDelivery: confirmDelivery,  // overloaded — accepts (loadId) or (loadId, deliveryData)

    // Step 2: Shipment lifecycle actions
    acceptLoad,
    rejectLoad,
    cancelShipment,
    reassignTruck,
    confirmLoading,
    startTrip,
    markBorderCrossing,
    markDelay,
    markArrived,

    // Step 3: Delivery confirmation
    // (confirmDelivery above handles both old and new call signatures)

    // Step 4: Escrow actions
    releaseEscrow,
    refundEscrow,
    adminHoldEscrow,

    // Dispute actions
    openDispute,
    closeDispute,

    // Step 5: multi-truck
    bookingSlots,

    // Step 8: ratings
    ratings,
    carrierRatings,
    shipperRatings,
    submitRating,
    checkHasRated,

    // Step 9: admin tools
    fraudFlags,
    flagFraud,
    resolveFraudFlag,
    adminForceStatus,
  };
}

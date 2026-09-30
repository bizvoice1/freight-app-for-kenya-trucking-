/**
 * src/hooks/useAdminOps.js
 * ------------------------
 * React bridge for adminService — National Command Center state.
 *
 * Imported DIRECTLY by BehariAdmin. Never passes through App.jsx.
 * Admin-only state is completely isolated from carrier/shipper portals.
 *
 * Sync pattern (matches useLoads.js):
 *   mutation() → adminService mutates _adminStore → calls sync()
 *   sync() calls getAdminSnapshot() and updates all React state atoms.
 *
 * All returned callbacks are stable Promise-based wrappers that:
 *   1. Call the service function
 *   2. Call sync() to push updated state to React
 *   3. Optionally call logAuditAction for cross-cutting audit concerns
 */

import { useState, useCallback, useEffect } from "react";
import {
  getAdminSnapshot,
  createIncidentRecord,
  updateIncidentStatus,
  resolveIncident,
  logAuditAction,
  getCarrierRiskProfile,
  getShipperRiskProfile,
  getAllRiskProfiles,
  getDispatchRecommendations,
  computeOperationalHealth,
  generateAlerts,
  freezePayouts,
  unfreezePayouts,
  suspendAccount,
  reinstateAccount,
  broadcastAlert,
  deactivateBroadcastAlert,
  CORRIDORS,
  CARRIER_ROSTER,
} from "../services/adminService.js";

export function useAdminOps() {
  /* ── State atoms ──────────────────────────────────────────────────────── */

  const [incidents,           setIncidents]           = useState([]);
  const [auditLog,            setAuditLog]            = useState([]);
  const [carrierRiskProfiles, setCarrierRiskProfiles] = useState([]);
  const [shipperRiskProfiles, setShipperRiskProfiles] = useState([]);
  const [frozenPayouts,       setFrozenPayouts]       = useState(false);
  const [frozenPayoutsReason, setFrozenPayoutsReason] = useState(null);
  const [suspendedAccounts,   setSuspendedAccounts]   = useState([]);
  const [broadcastAlerts,     setBroadcastAlerts]     = useState([]);
  const [healthScore,         setHealthScore]         = useState(null);
  const [networkAlerts,       setNetworkAlerts]       = useState([]);
  const [dispatchRecs,        setDispatchRecs]        = useState([]);

  /* ── Sync helper ──────────────────────────────────────────────────────── */

  const sync = useCallback(() => {
    const snap = getAdminSnapshot();
    setIncidents(snap.incidents);
    setAuditLog(snap.auditLog);
    setCarrierRiskProfiles(snap.carrierRiskProfiles);
    setShipperRiskProfiles(snap.shipperRiskProfiles);
    setFrozenPayouts(snap.frozenPayouts);
    setFrozenPayoutsReason(snap.frozenPayoutsReason);
    setSuspendedAccounts(snap.suspendedAccounts);
    setBroadcastAlerts(snap.broadcastAlerts);
  }, []);

  /* ── Initialise on mount ──────────────────────────────────────────────── */

  useEffect(() => {
    sync();
    getAllRiskProfiles(); // pre-warm risk store
  }, [sync]);

  /* ── Health & alerts (recalculated externally with live load data) ────── */

  /**
   * Recalculate health score and alerts using current load state.
   * Called by BehariAdmin whenever postedLoads / disputes / fraudFlags change.
   */
  const refreshHealth = useCallback((allLoads = [], openDisputes = 0, fraudFlagCount = 0) => {
    const snap    = getAdminSnapshot();
    const health  = computeOperationalHealth({ allLoads, openDisputes, fraudFlagCount, incidents: snap.incidents });
    const alerts  = generateAlerts(allLoads, openDisputes, fraudFlagCount);
    setHealthScore(health);
    setNetworkAlerts(alerts);
  }, []);

  /* ── Incident callbacks ───────────────────────────────────────────────── */

  const handleCreateIncident = useCallback((data) => {
    return createIncidentRecord(data).then((incident) => {
      sync();
      logAuditAction("INCIDENT_CREATED", incident.id, `${data.type} at ${data.location}`, "Admin");
      return incident;
    });
  }, [sync]);

  const handleUpdateIncidentStatus = useCallback((id, status, note) => {
    return updateIncidentStatus(id, status, note).then((incident) => {
      sync();
      return incident;
    });
  }, [sync]);

  const handleResolveIncident = useCallback((id, resolution) => {
    return resolveIncident(id, resolution).then((incident) => {
      sync();
      logAuditAction("INCIDENT_RESOLVED", id, resolution, "Admin");
      return incident;
    });
  }, [sync]);

  /* ── Risk callbacks ───────────────────────────────────────────────────── */

  const handleGetCarrierRisk = useCallback((carrierId, history) => {
    return getCarrierRiskProfile(carrierId, history).then((profile) => {
      sync();
      return profile;
    });
  }, [sync]);

  const handleGetShipperRisk = useCallback((shipperId, history) => {
    return getShipperRiskProfile(shipperId, history).then((profile) => {
      sync();
      return profile;
    });
  }, [sync]);

  /* ── Dispatch callbacks ───────────────────────────────────────────────── */

  const handleGetDispatchRecs = useCallback((load) => {
    return getDispatchRecommendations(load).then((recs) => {
      setDispatchRecs(recs);
      return recs;
    });
  }, []);

  /* ── Audit callback ───────────────────────────────────────────────────── */

  const handleLogAudit = useCallback((action, entity, detail, admin) => {
    return logAuditAction(action, entity, detail, admin).then((entry) => {
      sync();
      return entry;
    });
  }, [sync]);

  /* ── Emergency ops callbacks ──────────────────────────────────────────── */

  const handleFreezePayouts = useCallback((reason) => {
    return freezePayouts(reason, "Admin").then(() => sync());
  }, [sync]);

  const handleUnfreezePayouts = useCallback(() => {
    return unfreezePayouts("Admin").then(() => sync());
  }, [sync]);

  const handleSuspendAccount = useCallback((userId, reason) => {
    return suspendAccount(userId, reason, "Admin").then(() => sync());
  }, [sync]);

  const handleReinstateAccount = useCallback((userId) => {
    return reinstateAccount(userId, "Admin").then(() => sync());
  }, [sync]);

  const handleBroadcastAlert = useCallback((message, severity, affected) => {
    return broadcastAlert(message, severity, affected, "Admin").then((alert) => {
      sync();
      return alert;
    });
  }, [sync]);

  const handleDeactivateBroadcastAlert = useCallback((alertId) => {
    return deactivateBroadcastAlert(alertId).then(() => sync());
  }, [sync]);

  /* ── Return ───────────────────────────────────────────────────────────── */

  return {
    // State
    incidents,
    auditLog,
    carrierRiskProfiles,
    shipperRiskProfiles,
    frozenPayouts,
    frozenPayoutsReason,
    suspendedAccounts,
    broadcastAlerts,
    healthScore,
    networkAlerts,
    dispatchRecs,

    // Static data (no state needed — CORRIDORS and CARRIER_ROSTER are immutable in demo)
    corridors:     CORRIDORS,
    carrierRoster: CARRIER_ROSTER,

    // Actions
    refreshHealth,
    createIncident:           handleCreateIncident,
    updateIncidentStatus:     handleUpdateIncidentStatus,
    resolveIncident:          handleResolveIncident,
    getCarrierRisk:           handleGetCarrierRisk,
    getShipperRisk:           handleGetShipperRisk,
    getDispatchRecs:          handleGetDispatchRecs,
    logAudit:                 handleLogAudit,
    freezePayouts:            handleFreezePayouts,
    unfreezePayouts:          handleUnfreezePayouts,
    suspendAccount:           handleSuspendAccount,
    reinstateAccount:         handleReinstateAccount,
    broadcastAlert:           handleBroadcastAlert,
    deactivateBroadcastAlert: handleDeactivateBroadcastAlert,
    sync,
  };
}

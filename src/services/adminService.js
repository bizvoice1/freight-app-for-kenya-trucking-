/**
 * src/services/adminService.js
 * ----------------------------
 * Admin-only singleton service — National Operations Command Center.
 *
 * Consumed ONLY by useAdminOps.js → BehariAdmin.
 * Never imported by App.jsx, loadService, or any carrier/shipper component.
 *
 * Architecture contract:
 *   • Every exported function returns a Promise (backend migration = swap to fetch()).
 *   • Mutations update `_adminStore` then resolve with the updated entity.
 *   • getAdminSnapshot() returns a shallow-copied snapshot for React diffing.
 *
 * Backend API shape (each function maps 1:1):
 *   POST   /api/v1/admin/incidents
 *   PATCH  /api/v1/admin/incidents/:id
 *   POST   /api/v1/admin/audit/log
 *   GET    /api/v1/admin/dispatch/recommend?loadId=
 *   GET    /api/v1/admin/risk/carrier/:carrierId
 *   GET    /api/v1/admin/health
 *   POST   /api/v1/admin/ops/freeze-payouts
 *   POST   /api/v1/admin/ops/broadcast-alert
 *   POST   /api/v1/admin/ops/suspend/:userId
 */

import { createIncident, INCIDENT_STATUS } from "../models/incident.js";
import { buildCarrierRiskProfile, buildShipperRiskProfile } from "../models/risk.js";

/* ── Corridor definitions ─────────────────────────────────────────────────── */

export const CORRIDORS = [
  {
    id: "NBI-MSA",
    name: "Nairobi → Mombasa",
    shortName: "NBI–MSA",
    km: 486,
    avgHours: 9,
    congestion: "Medium",
    congestionPct: 52,
    activeTrucks: 34,
    color: "#276EF1",
    waypoints: [
      { lat: -1.2921, lng: 36.8219, label: "Nairobi" },
      { lat: -2.8530, lng: 37.3396, label: "Voi" },
      { lat: -3.3684, lng: 37.5797, label: "Mariakani" },
      { lat: -4.0435, lng: 39.6682, label: "Mombasa" },
    ],
  },
  {
    id: "NBI-KSM",
    name: "Nairobi → Kisumu",
    shortName: "NBI–KSM",
    km: 348,
    avgHours: 7,
    congestion: "High",
    congestionPct: 74,
    activeTrucks: 22,
    color: "#C0392B",
    waypoints: [
      { lat: -1.2921, lng: 36.8219, label: "Nairobi" },
      { lat: -0.4167, lng: 36.9500, label: "Nakuru" },
      { lat: -0.1000, lng: 35.0000, label: "Kericho" },
      { lat: -0.1022, lng: 34.7617, label: "Kisumu" },
    ],
  },
  {
    id: "NBI-ELD",
    name: "Nairobi → Eldoret",
    shortName: "NBI–ELD",
    km: 310,
    avgHours: 6,
    congestion: "Low",
    congestionPct: 28,
    activeTrucks: 18,
    color: "#06C167",
    waypoints: [
      { lat: -1.2921, lng: 36.8219, label: "Nairobi" },
      { lat: -0.4167, lng: 36.9500, label: "Nakuru" },
      { lat: 0.5167, lng: 35.2698, label: "Eldoret" },
    ],
  },
  {
    id: "MSA-DAR",
    name: "Mombasa → Dar es Salaam",
    shortName: "MSA–DAR",
    km: 568,
    avgHours: 14,
    congestion: "Medium",
    congestionPct: 45,
    activeTrucks: 12,
    color: "#9B59B6",
    waypoints: [
      { lat: -4.0435, lng: 39.6682, label: "Mombasa" },
      { lat: -4.2833, lng: 39.5833, label: "Lunga Lunga Border" },
      { lat: -6.7924, lng: 39.2083, label: "Dar es Salaam" },
    ],
  },
  {
    id: "NBI-KLA",
    name: "Nairobi → Kampala",
    shortName: "NBI–KLA",
    km: 670,
    avgHours: 16,
    congestion: "High",
    congestionPct: 68,
    activeTrucks: 9,
    color: "#E07B39",
    waypoints: [
      { lat: -1.2921, lng: 36.8219, label: "Nairobi" },
      { lat: -0.4167, lng: 36.9500, label: "Nakuru" },
      { lat: 0.5167, lng: 35.2698, label: "Eldoret" },
      { lat: 0.4500, lng: 34.1182, label: "Malaba Border" },
      { lat: 0.3476, lng: 32.5825, label: "Kampala" },
    ],
  },
  {
    id: "NBI-ADD",
    name: "Nairobi → Addis Ababa",
    shortName: "NBI–ADD",
    km: 1280,
    avgHours: 38,
    congestion: "Low",
    congestionPct: 18,
    activeTrucks: 5,
    color: "#1ABC9C",
    waypoints: [
      { lat: -1.2921, lng: 36.8219, label: "Nairobi" },
      { lat: 0.4667, lng: 38.0000, label: "Isiolo" },
      { lat: 3.9167, lng: 41.8500, label: "Moyale Border" },
      { lat: 9.0320, lng: 38.7470, label: "Addis Ababa" },
    ],
  },
];

/* ── Carrier roster (available for smart dispatch) ────────────────────────── */

export const CARRIER_ROSTER = [];

/* ── Seed data ────────────────────────────────────────────────────────────── */

function _ts(offsetMinutes = 0) {
  const d = new Date(Date.now() - offsetMinutes * 60_000);
  return (
    d.toLocaleDateString("en-KE", { day: "numeric", month: "short" }) +
    ", " +
    d.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })
  );
}

const SEED_INCIDENTS = [];

const SEED_AUDIT = [];

const SEED_CARRIER_RISK = CARRIER_ROSTER.map((c) =>
  buildCarrierRiskProfile(c.id, {
    disputes:    c.disputes,
    fraudFlags:  c.fraudFlags,
    trips:       c.trips,
    gpsAnomalies: c.gpsAnomalies,
  })
);

/* ── Internal store ───────────────────────────────────────────────────────── */

const _adminStore = {
  incidents:         [...SEED_INCIDENTS],
  auditLog:          [...SEED_AUDIT],
  carrierRiskProfiles: [...SEED_CARRIER_RISK],
  shipperRiskProfiles: [],
  frozenPayouts:     false,
  frozenPayoutsReason: null,
  suspendedAccounts: [],
  broadcastAlerts:   [
    { id: "BA-001", message: "Gilgil–Naivasha B3 closure — use C73 diversion", severity: "MEDIUM", affected: "NBI-KSM corridor", at: _ts(145), active: false },
  ],
  lastSyncAt:        Date.now(),
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function _auditId() {
  return `AUD-${Date.now().toString().slice(-6)}`;
}

function _incidentIdx(id) {
  const idx = _adminStore.incidents.findIndex((i) => i.id === id);
  if (idx < 0) throw new Error(`Incident ${id} not found`);
  return idx;
}

/* ── Incident management ─────────────────────────────────────────────────── */

/**
 * Create a new operational incident.
 * @param {Object} data  - same shape as createIncident() params
 * @returns {Promise<Object>} created incident
 */
export function createIncidentRecord(data) {
  return new Promise((resolve) => {
    const incident = createIncident(data);
    _adminStore.incidents.unshift(incident);
    _adminStore.lastSyncAt = Date.now();
    resolve({ ...incident });
  });
}

/**
 * Update incident status and append a timeline event.
 * @param {string} id
 * @param {string} status  - key from INCIDENT_STATUS
 * @param {string} note    - timeline note text
 * @returns {Promise<Object>} updated incident
 */
export function updateIncidentStatus(id, status, note) {
  return new Promise((resolve) => {
    const idx = _incidentIdx(id);
    const now = new Date().toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" });
    _adminStore.incidents[idx] = {
      ..._adminStore.incidents[idx],
      status,
      timeline: [..._adminStore.incidents[idx].timeline, { event: note, at: now }],
    };
    _adminStore.lastSyncAt = Date.now();
    resolve({ ..._adminStore.incidents[idx] });
  });
}

/**
 * Resolve an incident with a resolution note.
 * @param {string} id
 * @param {string} resolution
 * @returns {Promise<Object>} resolved incident
 */
export function resolveIncident(id, resolution) {
  return new Promise((resolve) => {
    const idx = _incidentIdx(id);
    const now = new Date().toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" });
    _adminStore.incidents[idx] = {
      ..._adminStore.incidents[idx],
      status: INCIDENT_STATUS.RESOLVED,
      resolvedAt: _ts(),
      resolution,
      timeline: [
        ..._adminStore.incidents[idx].timeline,
        { event: `Resolved: ${resolution}`, at: now },
      ],
    };
    _adminStore.lastSyncAt = Date.now();
    resolve({ ..._adminStore.incidents[idx] });
  });
}

/* ── Audit trail ──────────────────────────────────────────────────────────── */

/**
 * Log an admin action to the immutable audit trail.
 * @param {string} action   - e.g. "ESCROW_RELEASE", "FORCE_STATUS"
 * @param {string} entity   - load ID, carrier ID, or "NETWORK"
 * @param {string} detail   - human-readable description
 * @param {string} [admin]  - admin name (default "Admin")
 * @returns {Promise<Object>} audit entry
 */
export function logAuditAction(action, entity, detail, admin = "Admin") {
  return new Promise((resolve) => {
    const entry = {
      id:     _auditId(),
      action,
      entity,
      detail,
      admin,
      at:     _ts(),
    };
    _adminStore.auditLog.unshift(entry);
    _adminStore.lastSyncAt = Date.now();
    resolve({ ...entry });
  });
}

/* ── Risk intelligence ────────────────────────────────────────────────────── */

/**
 * Compute or retrieve a carrier risk profile.
 * In production: fetches from ML inference endpoint.
 * @param {string} carrierId
 * @param {Object} [history] - overrides seed data for live computation
 * @returns {Promise<Object>} risk profile
 */
export function getCarrierRiskProfile(carrierId, history = null) {
  return new Promise((resolve) => {
    const existing = _adminStore.carrierRiskProfiles.find((p) => p.entityId === carrierId);
    if (existing && !history) return resolve({ ...existing });

    // Merge with roster data if available
    const roster  = CARRIER_ROSTER.find((c) => c.id === carrierId);
    const h = history || (roster ? {
      disputes:    roster.disputes,
      fraudFlags:  roster.fraudFlags,
      trips:       roster.trips,
      gpsAnomalies: roster.gpsAnomalies,
    } : {});

    const profile = buildCarrierRiskProfile(carrierId, h);

    // Upsert in store
    const idx = _adminStore.carrierRiskProfiles.findIndex((p) => p.entityId === carrierId);
    if (idx >= 0) _adminStore.carrierRiskProfiles[idx] = profile;
    else _adminStore.carrierRiskProfiles.push(profile);

    _adminStore.lastSyncAt = Date.now();
    resolve({ ...profile });
  });
}

/**
 * Compute or retrieve a shipper risk profile.
 * @param {string} shipperId
 * @param {Object} [history] - { disputes, cancellations, totalLoads }
 * @returns {Promise<Object>} risk profile
 */
export function getShipperRiskProfile(shipperId, history = {}) {
  return new Promise((resolve) => {
    const existing = _adminStore.shipperRiskProfiles.find((p) => p.entityId === shipperId);
    if (existing && !Object.keys(history).length) return resolve({ ...existing });

    const profile = buildShipperRiskProfile(shipperId, history);

    const idx = _adminStore.shipperRiskProfiles.findIndex((p) => p.entityId === shipperId);
    if (idx >= 0) _adminStore.shipperRiskProfiles[idx] = profile;
    else _adminStore.shipperRiskProfiles.push(profile);

    _adminStore.lastSyncAt = Date.now();
    resolve({ ...profile });
  });
}

/**
 * Fetch all stored risk profiles (carrier + shipper).
 * @returns {Promise<{carriers: Array, shippers: Array}>}
 */
export function getAllRiskProfiles() {
  return Promise.resolve({
    carriers: _adminStore.carrierRiskProfiles.map((p) => ({ ...p })),
    shippers: _adminStore.shipperRiskProfiles.map((p) => ({ ...p })),
  });
}

/* ── Smart dispatch ───────────────────────────────────────────────────────── */

/**
 * Returns the truck-type compatibility score for a given cargo + truck pairing.
 *
 * Rules (applied to lowercase strings):
 *   • Temperature-sensitive cargo (flowers, fresh, perishable, dairy, frozen)
 *     → Refrigerated truck: +20 pts | any other type: -15 pts
 *   • Liquid/hazmat cargo (fuel, petroleum, liquid, chemical, lpg)
 *     → Tanker: +20 pts | any other: -15 pts
 *   • Heavy steel / coils / metal
 *     → Flatbed or Curtainsider: +15 pts | others: 0 pts
 *   • All other cargo
 *     → Any truck: +5 pts (no penalty, general compatibility bonus)
 *
 * Max contribution: +20 pts (replaces the old flat 5 pts from experience alone)
 */
function truckCompatScore(cargo, truckType, reasons) {
  const cl = (cargo    || "").toLowerCase();
  const tl = (truckType|| "").toLowerCase();

  const needsCold  = /flower|fresh|perishab|dairy|frozen|chilled/.test(cl);
  const needsTank  = /fuel|petroleum|liquid|chemical|lpg|gas/.test(cl);
  const needsFlat  = /steel|metal|coil|pipe|timber|lumber/.test(cl);
  const isRefrig   = tl.includes("refrigerat");
  const isTanker   = tl.includes("tanker");
  const isFlat     = tl.includes("flatbed") || tl.includes("curtain");

  if (needsCold) {
    if (isRefrig) { reasons.push("✓ Refrigerated — required for perishables"); return 20; }
    reasons.push("⚠ Truck not refrigerated — cargo may spoil"); return -15;
  }
  if (needsTank) {
    if (isTanker) { reasons.push("✓ Tanker — required for liquid/hazmat cargo"); return 20; }
    reasons.push("⚠ Tanker required for this cargo type"); return -15;
  }
  if (needsFlat) {
    if (isFlat) { reasons.push("✓ Flatbed/Curtainsider — ideal for steel/bulk"); return 15; }
    return 0; // usable but not ideal
  }
  return 5; // general cargo — small compatibility bonus for any truck
}

/**
 * Score and rank available carriers for a given load.
 *
 * Scoring formula (max ≈ 100 pts):
 *   - Proximity match  : 30 pts (same corridor = 30, adjacent = 15, other = 5)
 *   - Rating           : 25 pts (rating/5 * 25)
 *   - Availability     : 20 pts (available = 20, else 0)
 *   - Truck compat     : up to +20 / down to -15 pts (cargo/truck type match)
 *   - Risk penalty     : -25 pts max (riskScore/100 * 25)
 *   - Experience       : 5 pts  (min(trips,200)/200 * 5)
 *
 * @param {Object} load - load object from loadService store
 * @returns {Promise<Array>} ranked carrier matches with matchScore, reasons[]
 */
export function getDispatchRecommendations(load) {
  return new Promise((resolve) => {
    const corridor = CORRIDORS.find(
      (c) =>
        (load.from  || load.pickup  || "").toLowerCase().includes(c.waypoints[0]?.label.split(",")[0].toLowerCase()) ||
        (load.to    || load.delivery|| "").toLowerCase().includes(c.waypoints[c.waypoints.length - 1]?.label.split(",")[0].toLowerCase())
    );

    const results = CARRIER_ROSTER.map((carrier) => {
      const riskProfile = _adminStore.carrierRiskProfiles.find((p) => p.entityId === carrier.id);
      const riskScore   = riskProfile ? riskProfile.riskScore : 30;

      // Corridor match
      const exactMatch  = corridor && carrier.corridors.includes(corridor.id);
      const nearbyMatch = corridor && carrier.corridors.some((c) =>
        CORRIDORS.find((cor) => cor.id === c)?.waypoints.some((wp) =>
          corridor.waypoints.some((cw) => Math.abs(cw.lat - wp.lat) < 1.5 && Math.abs(cw.lng - wp.lng) < 1.5)
        )
      );

      const reasons = [];
      const proximityPts = exactMatch ? 30 : nearbyMatch ? 15 : 5;
      const ratingPts    = (carrier.rating / 5) * 25;
      const availPts     = carrier.available ? 20 : 0;
      const riskPenalty  = (riskScore / 100) * 25;
      const expPts       = (Math.min(carrier.trips, 200) / 200) * 5;
      // New: truck-type/cargo compatibility bonus or penalty
      const compatPts    = truckCompatScore(load.cargo, carrier.truckType, reasons);

      const matchScore   = Math.round(Math.max(0, proximityPts + ratingPts + availPts + compatPts - riskPenalty + expPts));

      if (exactMatch)            reasons.unshift(`Operates ${corridor?.shortName} corridor`);
      if (carrier.available)     reasons.push("Available now");
      if (carrier.rating >= 4.7) reasons.push(`Top-rated (${carrier.rating}★)`);
      if (riskScore < 35)        reasons.push("Low risk profile");
      if (carrier.trips > 100)   reasons.push(`${carrier.trips} completed trips`);
      if (!carrier.available)    reasons.push("⚠ Currently assigned");
      if (riskScore >= 65)       reasons.push("⚠ Elevated risk score");

      return {
        ...carrier,
        matchScore,
        riskScore,
        riskSeverity: riskProfile?.severity || "Low",
        reasons,
      };
    });

    // Sort by matchScore desc
    results.sort((a, b) => b.matchScore - a.matchScore);
    resolve(results);
  });
}

/* ── Operational health ───────────────────────────────────────────────────── */

/**
 * Compute network operational health score (0–100).
 *
 * Formula:
 *   Start at 100, deduct:
 *   - 3 pts per open dispute (max -30)
 *   - 4 pts per unresolved fraud flag (max -20)
 *   - 5 pts per OPEN/IN_PROGRESS critical incident (max -25)
 *   - 1 pt per 10% corridor congestion above 50% (max -10)
 *   - 15 pts if payouts frozen
 *
 * @param {Object} params
 * @param {Array}  params.allLoads      - from loadService
 * @param {number} params.openDisputes  - count
 * @param {number} params.fraudFlagCount
 * @param {Array}  params.incidents     - from adminStore
 * @returns {{ score: number, label: string, color: string, bg: string }}
 */
export function computeOperationalHealth({ allLoads = [], openDisputes = 0, fraudFlagCount = 0, incidents = [] }) {
  const openIncidentCount = incidents.filter(
    (i) => i.status !== INCIDENT_STATUS.RESOLVED && (i.severity === "CRITICAL" || i.severity === "HIGH")
  ).length;

  const avgCongestion = CORRIDORS.reduce((sum, c) => sum + c.congestionPct, 0) / CORRIDORS.length;
  const congestionDeduct = Math.max(0, ((avgCongestion - 50) / 10)) * 1;

  let score = 100;
  score -= Math.min(30, openDisputes * 3);
  score -= Math.min(20, fraudFlagCount * 4);
  score -= Math.min(25, openIncidentCount * 5);
  score -= Math.min(10, congestionDeduct);
  if (_adminStore.frozenPayouts) score -= 15;

  score = Math.max(0, Math.round(score));

  let label, color, bg;
  if (score >= 85)      { label = "Excellent"; color = "#06C167"; bg = "#E6F9F0"; }
  else if (score >= 70) { label = "Good";      color = "#1ABC9C"; bg = "#E8F8F5"; }
  else if (score >= 55) { label = "Fair";      color = "#E07B39"; bg = "#FFF3E0"; }
  else if (score >= 35) { label = "Poor";      color = "#C0392B"; bg = "#FDE8E3"; }
  else                  { label = "Critical";  color = "#C0392B"; bg = "#FDE8E3"; }

  return { score, label, color, bg };
}

/* ── Alert generation ─────────────────────────────────────────────────────── */

/**
 * Generate system alerts from live network state.
 * Returns an array sorted by priority (CRITICAL first).
 *
 * @param {Array}  allLoads
 * @param {number} openDisputes
 * @param {number} fraudFlagCount
 * @returns {Array<{ id, type, severity, message, loadId, at }>}
 */
export function generateAlerts(allLoads = [], openDisputes = 0, fraudFlagCount = 0) {
  const alerts = [];

  // Open incidents
  _adminStore.incidents
    .filter((i) => i.status !== INCIDENT_STATUS.RESOLVED)
    .forEach((inc) => {
      alerts.push({
        id:       `ALT-INC-${inc.id}`,
        type:     "INCIDENT",
        severity: inc.severity,
        message:  `${inc.type} at ${inc.location}${inc.loadId ? ` (${inc.loadId})` : ""}`,
        loadId:   inc.loadId,
        at:       inc.createdAt,
      });
    });

  // Payout freeze
  if (_adminStore.frozenPayouts) {
    alerts.push({
      id:       "ALT-FREEZE",
      type:     "OPS",
      severity: "CRITICAL",
      message:  `Payouts frozen — ${_adminStore.frozenPayoutsReason || "reason not specified"}`,
      loadId:   null,
      at:       _ts(),
    });
  }

  // High fraud flags
  if (fraudFlagCount >= 3) {
    alerts.push({
      id:       "ALT-FRAUD",
      type:     "FRAUD",
      severity: "HIGH",
      message:  `${fraudFlagCount} unresolved fraud flag${fraudFlagCount > 1 ? "s" : ""} require review`,
      loadId:   null,
      at:       _ts(),
    });
  }

  // High disputes
  if (openDisputes >= 4) {
    alerts.push({
      id:       "ALT-DISP",
      type:     "DISPUTE",
      severity: "MEDIUM",
      message:  `${openDisputes} open disputes — above threshold of 3`,
      loadId:   null,
      at:       _ts(),
    });
  }

  // Active broadcast alerts
  _adminStore.broadcastAlerts
    .filter((a) => a.active)
    .forEach((ba) => {
      alerts.push({
        id:       `ALT-BC-${ba.id}`,
        type:     "BROADCAST",
        severity: ba.severity,
        message:  ba.message,
        loadId:   null,
        at:       ba.at,
      });
    });

  // Sort: CRITICAL → HIGH → MEDIUM → LOW
  const pri = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  alerts.sort((a, b) => (pri[a.severity] ?? 9) - (pri[b.severity] ?? 9));

  return alerts;
}

/* ── Emergency operations ─────────────────────────────────────────────────── */

/**
 * Freeze all carrier payouts across the network.
 * @param {string} reason
 * @param {string} [admin]
 * @returns {Promise<void>}
 */
export function freezePayouts(reason, admin = "Admin") {
  return new Promise((resolve) => {
    _adminStore.frozenPayouts       = true;
    _adminStore.frozenPayoutsReason = reason;
    _adminStore.lastSyncAt          = Date.now();
    logAuditAction("PAYOUT_FREEZE", "NETWORK", `Payouts frozen: ${reason}`, admin);
    resolve();
  });
}

/**
 * Unfreeze carrier payouts.
 * @param {string} [admin]
 * @returns {Promise<void>}
 */
export function unfreezePayouts(admin = "Admin") {
  return new Promise((resolve) => {
    _adminStore.frozenPayouts       = false;
    _adminStore.frozenPayoutsReason = null;
    _adminStore.lastSyncAt          = Date.now();
    logAuditAction("PAYOUT_UNFREEZE", "NETWORK", "Payout freeze lifted", admin);
    resolve();
  });
}

/**
 * Suspend a carrier or shipper account.
 * @param {string} userId
 * @param {string} reason
 * @param {string} [admin]
 * @returns {Promise<void>}
 */
export function suspendAccount(userId, reason, admin = "Admin") {
  return new Promise((resolve) => {
    if (!_adminStore.suspendedAccounts.includes(userId)) {
      _adminStore.suspendedAccounts.push(userId);
    }
    _adminStore.lastSyncAt = Date.now();
    logAuditAction("ACCOUNT_SUSPENDED", userId, `Account suspended: ${reason}`, admin);
    resolve();
  });
}

/**
 * Reinstate a previously suspended account.
 * @param {string} userId
 * @param {string} [admin]
 * @returns {Promise<void>}
 */
export function reinstateAccount(userId, admin = "Admin") {
  return new Promise((resolve) => {
    _adminStore.suspendedAccounts = _adminStore.suspendedAccounts.filter((id) => id !== userId);
    _adminStore.lastSyncAt = Date.now();
    logAuditAction("ACCOUNT_REINSTATED", userId, "Account reinstated by admin", admin);
    resolve();
  });
}

/**
 * Broadcast a network-wide alert to all carriers and shippers.
 * @param {string} message
 * @param {string} severity   - CRITICAL | HIGH | MEDIUM | LOW
 * @param {string} affected   - free text, e.g. "NBI-MSA corridor"
 * @param {string} [admin]
 * @returns {Promise<Object>} broadcast alert record
 */
export function broadcastAlert(message, severity, affected, admin = "Admin") {
  return new Promise((resolve) => {
    const alert = {
      id:       `BA-${Date.now().toString().slice(-5)}`,
      message,
      severity,
      affected,
      at:       _ts(),
      active:   true,
    };
    _adminStore.broadcastAlerts.unshift(alert);
    _adminStore.lastSyncAt = Date.now();
    logAuditAction("BROADCAST_ALERT", "NETWORK", `Alert: ${message} (${affected})`, admin);
    resolve({ ...alert });
  });
}

/**
 * Deactivate a broadcast alert.
 * @param {string} alertId
 * @returns {Promise<void>}
 */
export function deactivateBroadcastAlert(alertId) {
  return new Promise((resolve) => {
    const idx = _adminStore.broadcastAlerts.findIndex((a) => a.id === alertId);
    if (idx >= 0) _adminStore.broadcastAlerts[idx].active = false;
    _adminStore.lastSyncAt = Date.now();
    resolve();
  });
}

/* ── Snapshot ─────────────────────────────────────────────────────────────── */

/**
 * Return a shallow-copied snapshot of the entire admin store for React diffing.
 * Components call this after any mutation to trigger re-render.
 *
 * @returns {Object} snapshot
 */
export function getAdminSnapshot() {
  return {
    incidents:            [..._adminStore.incidents],
    auditLog:             [..._adminStore.auditLog],
    carrierRiskProfiles:  [..._adminStore.carrierRiskProfiles],
    shipperRiskProfiles:  [..._adminStore.shipperRiskProfiles],
    frozenPayouts:        _adminStore.frozenPayouts,
    frozenPayoutsReason:  _adminStore.frozenPayoutsReason,
    suspendedAccounts:    [..._adminStore.suspendedAccounts],
    broadcastAlerts:      [..._adminStore.broadcastAlerts],
    lastSyncAt:           _adminStore.lastSyncAt,
  };
}

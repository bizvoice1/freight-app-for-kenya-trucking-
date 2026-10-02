/**
 * src/models/load.js
 * ------------------
 * Domain model for a freight Load.
 *
 * ARCHITECTURE NOTE:
 *   A "model" in this context means two things:
 *
 *   1. SHAPE — the canonical set of fields every Load object must have.
 *      This acts as a living specification. When the backend team builds the
 *      API, they can look here to know what the frontend expects.
 *
 *   2. FACTORY FUNCTIONS — pure functions that create properly-shaped objects
 *      from raw inputs (form data, API responses, seed data). All defaults,
 *      derivations, and ID-generation rules live here — not in components.
 *
 *   This file has zero React imports. It's plain JavaScript and can be used
 *   in Node.js server code, tests, or a React Native app without changes.
 */

/* ── Load Status values ─────────────────────────────────────────────────── */

/**
 * All valid Load status strings, in lifecycle order.
 *
 * Flow (happy path):
 *   ESCROW_HELD → ACCEPTED → LOADING → IN_TRANSIT → ARRIVED
 *     → DELIVERY_CONFIRMED → PAID_OUT
 *
 * Branching:
 *   Any active state → CANCELLED
 *   Any active state → DISPUTED → DISPUTE_RESOLVED
 *
 * @example
 *   import { LOAD_STATUS } from '../models/load.js';
 *   if (load.status === LOAD_STATUS.DELIVERED) { ... }
 */
import { makePlace, resolveDistance, ratePerKm } from "./geo.js";

export const LOAD_STATUS = {
  ESCROW_HELD:          "Escrow Held",          // Posted; payment locked; no carrier yet
  ACCEPTED:             "Accepted",              // Carrier accepted; awaiting loading
  LOADING:              "Loading",               // Goods being loaded onto truck
  IN_TRANSIT:           "In Transit",            // Truck on route
  ARRIVED:              "Arrived",               // Truck at destination; awaiting OTP
  DELIVERY_CONFIRMED:   "Delivery Confirmed",    // OTP + photo verified by receiver
  PAID_OUT:             "Paid Out",              // M-Pesa released to carrier
  CANCELLED:            "Cancelled",             // Load cancelled before completion
  DISPUTED:             "Disputed",              // Dispute raised
  DISPUTE_RESOLVED:     "Dispute Resolved",      // Dispute closed with resolution
  // Legacy alias kept for backward compat with seed data
  DELIVERED:            "Delivered",
};

/* ── Escrow Status values ───────────────────────────────────────────────── */

export const ESCROW_STATUS = {
  HELD:               "Held",               // Funds locked; delivery not confirmed
  READY_FOR_RELEASE:  "Ready for Release",  // Delivery confirmed; awaiting release
  RELEASED:           "Released",           // Funds sent to carrier
  REFUNDED:           "Refunded",           // Funds returned to shipper
  ADMIN_HOLD:         "Admin Hold",         // Frozen pending dispute resolution
};

/* ── Available actions per status / role ────────────────────────────────── */

/**
 * Returns the list of action IDs a given role can perform on a load in a
 * given status. Used by carrier and admin portals to render the correct
 * action buttons.
 *
 * @param {string} status - current LOAD_STATUS value
 * @param {string} role   - "carrier" | "shipper" | "admin"
 * @returns {string[]}    - list of action IDs
 */
export function getAvailableActions(status, role) {
  const A = {
    carrier: {
      [LOAD_STATUS.ESCROW_HELD]:        ["accept", "reject"],
      [LOAD_STATUS.ACCEPTED]:           ["confirm_loading", "cancel"],
      [LOAD_STATUS.LOADING]:            ["start_trip", "cancel"],
      [LOAD_STATUS.IN_TRANSIT]:         ["mark_border", "mark_delay", "mark_arrived"],
      [LOAD_STATUS.ARRIVED]:            [],   // carrier waits for shipper OTP
      [LOAD_STATUS.DELIVERY_CONFIRMED]: [],
      [LOAD_STATUS.PAID_OUT]:           [],
      [LOAD_STATUS.CANCELLED]:          [],
      [LOAD_STATUS.DISPUTED]:           [],
      [LOAD_STATUS.DISPUTE_RESOLVED]:   [],
      [LOAD_STATUS.DELIVERED]:          [],
    },
    shipper: {
      [LOAD_STATUS.ESCROW_HELD]:        [],
      [LOAD_STATUS.ACCEPTED]:           ["cancel"],
      [LOAD_STATUS.LOADING]:            [],
      [LOAD_STATUS.IN_TRANSIT]:         ["open_dispute"],
      [LOAD_STATUS.ARRIVED]:            ["confirm_delivery"],
      [LOAD_STATUS.DELIVERY_CONFIRMED]: ["release_escrow"],
      [LOAD_STATUS.PAID_OUT]:           [],
      [LOAD_STATUS.CANCELLED]:          [],
      [LOAD_STATUS.DISPUTED]:           [],
      [LOAD_STATUS.DISPUTE_RESOLVED]:   [],
      [LOAD_STATUS.DELIVERED]:          ["release_escrow"],
    },
    admin: {
      [LOAD_STATUS.ESCROW_HELD]:        ["cancel", "reassign"],
      [LOAD_STATUS.ACCEPTED]:           ["cancel", "reassign"],
      [LOAD_STATUS.LOADING]:            ["cancel", "reassign"],
      [LOAD_STATUS.IN_TRANSIT]:         ["cancel", "open_dispute", "reassign"],
      [LOAD_STATUS.ARRIVED]:            ["open_dispute"],
      [LOAD_STATUS.DELIVERY_CONFIRMED]: ["release_escrow", "open_dispute"],
      [LOAD_STATUS.PAID_OUT]:           [],
      [LOAD_STATUS.CANCELLED]:          [],
      [LOAD_STATUS.DISPUTED]:           ["close_dispute", "release_escrow", "refund_escrow"],
      [LOAD_STATUS.DISPUTE_RESOLVED]:   ["release_escrow", "refund_escrow"],
      [LOAD_STATUS.DELIVERED]:          ["release_escrow", "open_dispute"],
    },
  };
  return (A[role] || {})[status] || [];
}

/* ── Escrow calculation ─────────────────────────────────────────────────── */

const PLATFORM_FEE_RATE = 0.02; // 2 % platform fee

/**
 * Calculates escrow release amounts given an escrow data record.
 *
 * @param {Object} escrow
 * @param {number} escrow.baseAmount    - original locked amount (load.pay)
 * @param {number} [escrow.latePenalty] - penalty deducted from carrier (KSh)
 * @param {number} [escrow.adminFee]    - override platform fee (KSh); computed if absent
 * @param {number} [escrow.partialRefund] - partial refund amount to shipper (KSh)
 * @returns {Object} breakdown object with all figures
 */
export function calculateEscrowRelease(escrow = {}) {
  const base        = Number(escrow.baseAmount)    || 0;
  const penalty     = Number(escrow.latePenalty)   || 0;
  const partialRef  = Number(escrow.partialRefund) || 0;
  const adminFee    = escrow.adminFee != null
                        ? Number(escrow.adminFee)
                        : Math.round(base * PLATFORM_FEE_RATE);

  const toCarrier   = Math.max(0, base - penalty - adminFee - partialRef);

  return {
    baseAmount:     base,
    latePenalty:    penalty,
    adminFee,
    partialRefund:  partialRef,
    toCarrier,
    toShipper:      partialRef,   // shipper gets back the partial refund portion
    platformRevenue:adminFee,
  };
}

/* ── ID generation ──────────────────────────────────────────────────────── */

/**
 * Business rule: Behari load IDs start at KE-2100 and increment.
 * Keeping this in the model ensures the rule is enforced consistently
 * regardless of which part of the app creates a load.
 *
 * The starting offset is deliberately well above the highest ID used by any
 * seed/demo data (data/loads.js, data/shipments.js, src/data/seedLoads.js,
 * and behari-admin-v2.jsx's inline LOADS all top out at KE-2048) so a
 * freshly-created load can never collide with a demo one. It was previously
 * 2050 — only a 2-ID gap above the marketplace seed's highest ID — which the
 * seed-data collision audit flagged as fragile.
 *
 * @param {number} existingPostedCount - how many loads have already been posted
 *                                       in the current session
 */
export function generateLoadId(existingPostedCount) {
  return `KE-${2100 + existingPostedCount}`;
}

/* ── Corridor distance/rate lookup table ────────────────────────────────── */
/**
 * Maps known Kenya/East-Africa corridor pairs to their distance, ETA and
 * per-km rate. Key format: "ORIGIN_KEYWORD→DEST_KEYWORD" (lowercase, partial).
 * The lookup normalises city names to lowercase and checks for substring
 * inclusion, so "Nairobi Industrial Area" matches "nairobi".
 *
 * distKm  — road distance in kilometres
 * etaHrs  — realistic transit hours (including typical delays)
 * rateKm  — KSh per km benchmark rate
 */
const CORRIDOR_DISTANCES = [
  // NBI ↔ MSA
  { from:"nairobi",  to:"mombasa",   distKm:485, etaHrs:8,  rateKm:175 },
  { from:"mombasa",  to:"nairobi",   distKm:485, etaHrs:8,  rateKm:175 },
  // NBI ↔ KSM/ELD
  { from:"nairobi",  to:"kisumu",    distKm:340, etaHrs:6,  rateKm:160 },
  { from:"nairobi",  to:"eldoret",   distKm:310, etaHrs:5,  rateKm:155 },
  { from:"kisumu",   to:"nairobi",   distKm:340, etaHrs:6,  rateKm:160 },
  { from:"eldoret",  to:"nairobi",   distKm:310, etaHrs:5,  rateKm:155 },
  // NBI ↔ Kampala/KLA
  { from:"nairobi",  to:"kampala",   distKm:670, etaHrs:12, rateKm:180 },
  { from:"kampala",  to:"nairobi",   distKm:670, etaHrs:12, rateKm:180 },
  // NBI ↔ Dar es Salaam/DAR
  { from:"nairobi",  to:"dar",       distKm:1280,etaHrs:22, rateKm:190 },
  { from:"dar",      to:"nairobi",   distKm:1280,etaHrs:22, rateKm:190 },
  // NBI ↔ Addis Ababa/ADD
  { from:"nairobi",  to:"addis",     distKm:1700,etaHrs:28, rateKm:200 },
  { from:"addis",    to:"nairobi",   distKm:1700,etaHrs:28, rateKm:200 },
  // NBI ↔ Nakuru
  { from:"nairobi",  to:"nakuru",    distKm:160, etaHrs:3,  rateKm:145 },
  { from:"nakuru",   to:"nairobi",   distKm:160, etaHrs:3,  rateKm:145 },
  // NBI ↔ Naivasha/Gilgil
  { from:"nairobi",  to:"naivasha",  distKm:90,  etaHrs:2,  rateKm:135 },
  { from:"naivasha", to:"nairobi",   distKm:90,  etaHrs:2,  rateKm:135 },
  // MSA ↔ Mombasa Port (short haul)
  { from:"mombasa",  to:"mombasa port", distKm:12, etaHrs:1, rateKm:120 },
  { from:"mombasa port", to:"mombasa",  distKm:12, etaHrs:1, rateKm:120 },
  // Athi River / Industrial Area to MSA
  { from:"athi",     to:"mombasa",   distKm:490, etaHrs:8,  rateKm:175 },
  { from:"industrial",to:"mombasa",  distKm:488, etaHrs:8,  rateKm:175 },
  // ELD ↔ KSM
  { from:"eldoret",  to:"kisumu",    distKm:110, etaHrs:2,  rateKm:130 },
  { from:"kisumu",   to:"eldoret",   distKm:110, etaHrs:2,  rateKm:130 },
  // Nakuru ↔ ELD
  { from:"nakuru",   to:"eldoret",   distKm:150, etaHrs:3,  rateKm:140 },
  { from:"eldoret",  to:"nakuru",    distKm:150, etaHrs:3,  rateKm:140 },
  // NBI ↔ JKIA
  { from:"nairobi",  to:"jkia",      distKm:18,  etaHrs:1,  rateKm:120 },
  { from:"jkia",     to:"nairobi",   distKm:18,  etaHrs:1,  rateKm:120 },
];

/**
 * Look up corridor distance/rate for a from→to pair.
 * Normalises to lowercase and checks for partial substring matches.
 * @returns {{ distKm:number, etaHrs:number, rateKm:number }|null}
 */
function lookupCorridor(from, to) {
  if (!from || !to) return null;
  const fl = from.toLowerCase();
  const tl = to.toLowerCase();
  return CORRIDOR_DISTANCES.find(c =>
    fl.includes(c.from) && tl.includes(c.to)
  ) || null;
}

/* ── Factory: shipper form → Load ───────────────────────────────────────── */

/**
 * Creates a normalised Load object from the raw data coming out of the
 * shipper's PostModal form.
 *
 * WHY THIS EXISTS:
 *   Previously App.jsx did `{ ...formData, id, postedAt: today }` — a raw
 *   spread that kept form field names (pickup, cargoType, truckCount) mixed
 *   in with display field names (from, cargo, truck). This caused the carrier
 *   portal to do its own mapping to turn "pickup" → "from" etc.
 *
 *   Now the model is the single point of that translation. Both sides speak
 *   the same Load shape.
 *
 * @param {Object} formData      - raw form values from PostModal
 * @param {number} existingCount - existing posted load count (for ID)
 * @returns {Object}             - a complete, normalised Load object
 */
export function createLoadFromForm(formData, existingCount) {
  const id      = generateLoadId(existingCount);
  const today   = new Date().toLocaleDateString("en-KE", { day:"numeric", month:"short" });
  const fromStr = formData.pickup      || "";
  const toStr   = formData.destination || "";

  // 5C-1 — places + distance hierarchy (route → corridor → unresolved).
  // formData.pickupPlace / deliveryPlace carry {name,placeId,lat,lng} once Places
  // autocomplete exists (5C-2); formData.routeKm carries a real road distance.
  const pickup   = makePlace(fromStr, formData.pickupPlace);
  const delivery = makePlace(toStr,   formData.deliveryPlace);
  const corridor = lookupCorridor(fromStr, toStr);
  const { km: distKm, source: distSource } = resolveDistance({
    pickup, delivery, distanceMeters: Number(formData.distanceMeters), corridorKm: corridor?.distKm,
  });
  const etaHrs   = corridor ? corridor.etaHrs : 0;
  const routeEtaMin = 0;
  const budget   = Math.max(0, Number(formData.budget) || 0);
  const rateKm   = ratePerKm(budget, distKm);

  return {
    // Identity
    id,
    postedAt:       today,
    createdAt:      Date.now(),

    // Cargo
    cargo:          formData.cargoType  || "",
    description:    formData.description || "",
    weight:         formData.weight
                      ? `${formData.weight} ${formData.unit || "Tonnes"}`
                      : "TBD",

    // Route
    from:           fromStr,
    to:             toStr,
    pickup,                       // {name, placeId, lat, lng}
    delivery,                     // {name, placeId, lat, lng}
    dist:           distKm,       // km — 0 only if unresolved
    distSource,                   // "route" | "corridor" | "unresolved"
    rateKm,                       // KSh/km = pay ÷ dist
    etaMin:         etaHrs ? etaHrs * 60 : routeEtaMin, // minutes — corridor first, else provider duration
    distanceMeters: null,         // set only by the backend's stored Routes result (5C-3)
    routePolyline:  null,         // server polyline, exact only for the owning shipper
    backendLoadId:  null,         // canonical backend load (BHL-…) once linked

    // Equipment
    truck:          formData.truckType  || "Any Available",
    truckCount:     Number(formData.truckCount) || 1,
    trucksRemaining:Number(formData.truckCount) || 1,

    // Schedule
    pickD:          formData.pickupDate || "TBD",
    pickT:          "TBD",
    delD:           formData.deadline   || "TBD",
    delT:           "TBD",

    // Financials — negative/zero budget clamped to 0 at model boundary
    pay:            budget,
    penalty:        Math.max(0, Number(formData.penalty) || 0),

    // Matching engine fields (additive — optional, default to safe values)
    readyAt:            formData.readyAt || formData.pickupDate || null,
    partialLoadAllowed: !!formData.partialLoadAllowed,

    // Shipper metadata (replaced by auth session in production)
    shipper:        "Your Company",
    phone:          formData.phone || "",
    rating:         0,
    facilRating:    0,

    // Status lifecycle
    status:         LOAD_STATUS.ESCROW_HELD,
    urgent:         false,
  };
}

/* ── Factory: booking event → Notification ──────────────────────────────── */

/**
 * Creates a booking notification object when a carrier accepts a load.
 *
 * This lives in the Load model (rather than a separate Notification model)
 * because a booking notification is intrinsically about a load — it captures
 * the moment a carrier commits to a specific load.
 *
 * In production: POST /api/v1/bookings creates this on the server,
 * and the result is pushed to the shipper via websocket or polling.
 *
 * @param {Object} params
 * @param {string} params.loadId    - the load being booked
 * @param {string} params.cargo     - cargo description (denormalised for display)
 * @param {string} params.carrier   - carrier's name
 * @param {string} params.plate     - truck plate assigned
 * @param {string} params.truckType - truck type
 * @returns {Object}                - notification ready to push into state
 */
export function createBookingNotification({ loadId, cargo, carrier, plate, truckType }) {
  const now   = new Date().toLocaleTimeString("en-KE", { hour:"2-digit", minute:"2-digit" });
  const today = new Date().toLocaleDateString("en-KE", { day:"numeric", month:"short" });

  return {
    id:        `notif_${Date.now()}`,
    loadId,
    cargo,
    carrier,
    plate,
    truckType,
    timestamp: `${today}, ${now}`,
    read:      false,
  };
}

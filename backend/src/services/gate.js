/**
 * backend/src/services/gate.js
 * --------------------------------
 * Phase 5E-1 — gate / loading evidence services.
 *
 * issueGateToken: mints a single-purpose, single-use opaque token (only its
 * SHA-256 is stored) for one trip, superseding any earlier active token.
 * verifyAndRecordGateEvent: the whole scan in ONE synchronous better-sqlite3
 * transaction — verify, consume the token, append the immutable event, apply
 * the trip transition. The migration-0011 triggers are the backstop.
 *
 * Authorization of WHO may call these (the assigned driver issues; a
 * loading_agent scans) belongs to the 5E-2 routes; callers pass identities
 * the auth middleware established. FINANCIAL BOUNDARY: this module only READS
 * escrows to check the booking is funded. It never writes payments, escrows
 * or payouts — loading evidence is not a payment trigger (that is 5G).
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { trips, bookings, loads, escrows, users, drivers, trucks, locationUpdates, loadingSites, loadingAgentSites, gateTokens, gateEvents } from "../db/schema.js";
import { ESCROW_STATUS } from "../domain/escrow.js";
import {
  GATE_PURPOSE, PURPOSE_TO_EVENT, EVENT_RULES, gateConfig, generateGateToken, hashGateToken, parseScannedToken, evaluateLocation,
} from "../domain/gate.js";

export class GateError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new GateError(status, code, message); };

let seq = 0;
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${(seq++ % 1296).toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

const DB_ERRORS = {
  GATE_SITE_NOT_FOUND: [404, "Loading site not found."],
  GATE_NOT_AN_AGENT: [422, "That user is not a loading agent."],
  GATE_ASSIGNMENT_MISMATCH: [409, "Event does not match the trip's assignment."],
  GATE_BAD_TRANSITION: [409, "That event cannot move the trip between those statuses."],
  GATE_TRIP_STATE_MISMATCH: [409, "The trip is not in the expected status."],
  GATE_TOKEN_INVALID: [409, "Token is not valid for this event."],
  GATE_TOKEN_CLOSED: [409, "Token is already consumed or revoked."],
  GATE_TOKEN_INVALID_CONSUME: [409, "Token cannot be consumed."],
  GATE_SITE_MISMATCH: [409, "The trip's pickup site does not match."],
  GATE_SITE_INACTIVE: [409, "The loading site is not active."],
  GATE_AGENT_NOT_AUTHORIZED: [403, "This agent is not authorized for that site."],
  GATE_NOT_FUNDED: [409, "The booking is not funded."],
  GATE_SEQUENCE: [409, "A prerequisite gate event is missing."],
  GATE_LOCATION_INCONSISTENT: [500, "Inconsistent location evidence."],
  GATE_EVENT_IMMUTABLE: [409, "Gate events are immutable."],
  GATE_SITE_FROZEN: [409, "The site cannot change once gate evidence exists."],
  GATE_SITE_INVALID: [422, "Site name, coordinates and radius are not valid."],
  GATE_ASSIGNMENT_IMMUTABLE: [409, "Agent-site assignments cannot be edited; remove and re-add."],
};
function mapDbError(err) {
  const msg = String(err?.message || "");
  for (const [code, [status, text]] of Object.entries(DB_ERRORS)) if (msg.includes(code)) fail(status, code, text);
  if (msg.includes("gate_events_one_type_per_trip") || msg.includes("gate_events.trip_id")) fail(409, "GATE_DUPLICATE_EVENT", "That gate event is already recorded for this trip.");
  if (msg.includes("loading_agent_sites_pk") || msg.includes("loading_agent_sites.agent_user_id")) fail(409, "GATE_ASSIGNMENT_EXISTS", "That agent is already assigned to the site.");
  if (msg.includes("gate_events_token_unique") || msg.includes("gate_events.token_id")) fail(409, "GATE_TOKEN_USED", "Token already used.");
  throw err;
}
function guarded(fn) {
  try { return fn(); } catch (err) { if (err instanceof GateError) throw err; return mapDbError(err); }
}

/** The trip's canonical assignment context, or a GateError. */
function loadTripContext(tx, tripId) {
  const trip = tx.select().from(trips).where(eq(trips.id, tripId)).get();
  if (!trip) fail(404, "TRIP_NOT_FOUND", "Trip not found.");
  if (!trip.bookingId || !trip.loadId) fail(409, "GATE_TRIP_UNLINKED", "Trip has no booking/load.");
  const booking = tx.select().from(bookings).where(eq(bookings.id, trip.bookingId)).get();
  const load = tx.select().from(loads).where(eq(loads.id, trip.loadId)).get();
  if (!booking || !load) fail(409, "GATE_TRIP_UNLINKED", "Trip has no booking/load.");
  if (!load.pickupSiteId) fail(409, "GATE_SITE_REQUIRED", "This load has no authorized loading site.");
  const site = tx.select().from(loadingSites).where(eq(loadingSites.id, load.pickupSiteId)).get();
  if (!site) fail(409, "GATE_SITE_REQUIRED", "This load has no authorized loading site.");
  return { trip, booking, load, site };
}

const hasEvent = (tx, tripId, type) =>
  !!tx.select().from(gateEvents).where(and(eq(gateEvents.tripId, tripId), eq(gateEvents.eventType, type))).get();

/** Which purpose (if any) the trip is currently eligible to display a QR for. */
export function nextGatePurposeSync(tx, tripId) {
  const trip = tx.select().from(trips).where(eq(trips.id, tripId)).get();
  if (!trip) return null;
  const has = (t) => hasEvent(tx, tripId, t);
  if (trip.status === "At Pickup" && !has("GATE_IN")) return GATE_PURPOSE.GATE_IN;
  if (trip.status === "At Pickup" && has("GATE_IN") && !has("LOADING_STARTED")) return GATE_PURPOSE.LOADING_START;
  if (trip.status === "Loading" && has("LOADING_STARTED") && !has("LOADING_COMPLETED")) return GATE_PURPOSE.LOADING_COMPLETE;
  return null;
}

export function revokeActiveGateTokensSync(tx, tripId, reason, nowIso) {
  return tx.update(gateTokens).set({ revokedAt: nowIso, revokeReason: reason })
    .where(and(eq(gateTokens.tripId, tripId), isNull(gateTokens.consumedAt), isNull(gateTokens.revokedAt))).run().changes;
}

/**
 * Issue a token for `purpose`. Returns the PLAINTEXT token exactly once; only its hash is stored.
 * Any earlier active token for the trip is revoked (SUPERSEDED).
 * @returns {{tokenId:string, token:string, qrText:string, purpose:string, expiresAt:string, refreshAt:string}}
 */
export function issueGateToken({ tripId, purpose = null, issuedToUserId, now = new Date(), driverId = null, requireFunded = false }) {
  return guarded(() => db.transaction((tx) => {
    if (purpose !== null && !Object.values(GATE_PURPOSE).includes(purpose)) fail(400, "GATE_BAD_PURPOSE", "Unknown token purpose.");
    const { trip, booking, site } = loadTripContext(tx, tripId);
    if (!site.active) fail(409, "GATE_SITE_INACTIVE", "The loading site is not active.");
    if (driverId !== null) {
      if (trip.driverId !== driverId || booking.driverId !== driverId || booking.truckId !== trip.truckId) {
        fail(403, "GATE_NOT_YOUR_TRIP", "This trip is not assigned to the authenticated driver.");
      }
    }
    if (requireFunded) {
      const escrow = tx.select().from(escrows).where(eq(escrows.bookingId, booking.id)).get();
      if (!escrow || escrow.status !== ESCROW_STATUS.HELD) fail(409, "GATE_NOT_FUNDED", "The booking is not funded.");
    }
    const eligible = nextGatePurposeSync(tx, tripId);
    if (!eligible) fail(409, "GATE_PURPOSE_NOT_ELIGIBLE", "This trip is not eligible for any gate step right now.");
    if (purpose !== null && eligible !== purpose) fail(409, "GATE_PURPOSE_NOT_ELIGIBLE", `This trip is currently eligible for ${eligible}, not ${purpose}.`);
    purpose = eligible;
    const cfg = gateConfig();
    const issuedAt = now.toISOString();
    revokeActiveGateTokensSync(tx, tripId, "SUPERSEDED", issuedAt);
    const token = generateGateToken();
    const id = newId("GTK");
    const expiresAt = new Date(now.getTime() + cfg.tokenTtlSeconds * 1000).toISOString();
    tx.insert(gateTokens).values({ id, tripId, purpose, tokenHash: hashGateToken(token), issuedToUserId, issuedAt, expiresAt }).run();
    const refreshAt = new Date(now.getTime() + Math.max(0, cfg.tokenTtlSeconds - cfg.refreshWindowSeconds) * 1000).toISOString();
    return { tokenId: id, token, qrText: `behari:gate:${token}`, purpose, expiresAt, refreshAt };
  }));
}

/**
 * Verify a scan and record the evidence atomically.
 * Check order: token (404/410/409) -> agent & site authority (403) -> trip/funding/state (409).
 * @param {{scanned:string, agentUserId:string, now?:Date}} p
 * @returns the inserted gate_events row
 */
export function verifyAndRecordGateEvent({ scanned, agentUserId, now = new Date() }) {
  const token = parseScannedToken(scanned);
  if (!token) fail(404, "GATE_TOKEN_INVALID", "Unrecognised token.");
  return guarded(() => db.transaction((tx) => {
    const nowIso = now.toISOString();
    const row = tx.select().from(gateTokens).where(eq(gateTokens.tokenHash, hashGateToken(token))).get();
    if (!row) fail(404, "GATE_TOKEN_INVALID", "Unrecognised token.");
    if (row.consumedAt) fail(409, "GATE_TOKEN_USED", "This token was already used.");
    if (row.revokedAt) fail(409, "GATE_TOKEN_REVOKED", "This token is no longer valid.");
    if (row.expiresAt < nowIso) fail(410, "GATE_TOKEN_EXPIRED", "This token has expired.");

    const agent = tx.select().from(users).where(eq(users.id, agentUserId)).get();
    if (!agent || agent.role !== "loading_agent") fail(403, "GATE_AGENT_NOT_AUTHORIZED", "Only a loading agent can record gate events.");

    const { trip, booking, load, site } = loadTripContext(tx, row.tripId);
    const assigned = tx.select().from(loadingAgentSites)
      .where(and(eq(loadingAgentSites.agentUserId, agentUserId), eq(loadingAgentSites.siteId, site.id))).get();
    if (!assigned) fail(403, "GATE_AGENT_NOT_AUTHORIZED", "This agent is not authorized for that site.");
    if (!site.active) fail(409, "GATE_SITE_INACTIVE", "The loading site is not active.");

    const eventType = PURPOSE_TO_EVENT[row.purpose];
    const rule = EVENT_RULES[eventType];
    if (!booking.truckId || !booking.driverId || booking.truckId !== trip.truckId || booking.driverId !== trip.driverId) {
      fail(409, "GATE_ASSIGNMENT_MISMATCH", "Trip and booking assignment disagree.");
    }
    const escrow = tx.select().from(escrows).where(eq(escrows.bookingId, booking.id)).get();
    const funded = !!escrow && escrow.status === ESCROW_STATUS.HELD;
    if (!funded) fail(409, "GATE_NOT_FUNDED", "The booking is not funded.");
    if (trip.status !== rule.before) fail(409, "GATE_WRONG_TRIP_STATE", `Trip is "${trip.status}"; ${eventType} needs "${rule.before}".`);
    if (hasEvent(tx, trip.id, eventType)) fail(409, "GATE_DUPLICATE_EVENT", "That gate event is already recorded for this trip.");
    if (rule.requires && !hasEvent(tx, trip.id, rule.requires)) fail(409, "GATE_SEQUENCE", `${rule.requires} must be recorded first.`);

    const cfg = gateConfig();
    const fix = trip.latestLocationId ? tx.select().from(locationUpdates).where(eq(locationUpdates.id, trip.latestLocationId)).get() : null;
    const loc = evaluateLocation(site, fix, now.getTime(), cfg.locationMaxAgeSeconds);

    const consumed = tx.update(gateTokens).set({ consumedAt: nowIso, consumedByUserId: agentUserId })
      .where(and(eq(gateTokens.id, row.id), isNull(gateTokens.consumedAt), isNull(gateTokens.revokedAt))).run();
    if (consumed.changes !== 1) fail(409, "GATE_TOKEN_USED", "This token was already used.");

    const snapshot = {
      tripStatus: trip.status, bookingFunded: true, escrowStatus: escrow.status,
      assignedDriverId: trip.driverId, assignedTruckId: trip.truckId, scanningAgentId: agentUserId,
      siteId: site.id, siteName: site.name, siteRadiusMeters: site.radiusMeters,
      tokenPurpose: row.purpose, tokenIssuedAt: row.issuedAt, tokenExpiresAt: row.expiresAt, tokenIssuedToUserId: row.issuedToUserId,
      location: { available: !!loc.available, stale: loc.stale, distanceFromSiteMeters: loc.distanceMeters, insideGeofence: loc.inside === null ? null : loc.inside === 1,
                  ageSeconds: loc.ageSeconds, maxAgeSeconds: cfg.locationMaxAgeSeconds, locationId: fix ? fix.id : null },
      verifiedAt: nowIso,
    };
    const event = {
      id: newId("GEV"), tripId: trip.id, bookingId: booking.id, truckId: trip.truckId, driverId: trip.driverId,
      siteId: site.id, agentUserId, eventType, tokenId: row.id, tokenPurpose: row.purpose,
      tripStatusBefore: rule.before, tripStatusAfter: rule.after, bookingFunded: 1,
      driverLocationAvailable: loc.available, driverDistanceFromSiteMeters: loc.distanceMeters,
      insideSiteGeofence: loc.inside, locationAgeSeconds: loc.ageSeconds,
      snapshot: JSON.stringify(snapshot), createdAt: nowIso,
    };
    tx.insert(gateEvents).values(event).run();
    if (rule.after !== rule.before) {
      const moved = tx.update(trips).set({ status: rule.after, updatedAt: nowIso })
        .where(and(eq(trips.id, trip.id), eq(trips.status, rule.before))).run();
      if (moved.changes !== 1) fail(409, "GATE_TRIP_STATE_MISMATCH", "The trip changed while recording the event.");
    }
    return event;
  }));
}

// ── 5E-2: canonical state + read models ─────────────────────────────────────

const PURPOSE_LABEL = {
  GATE_IN: "Show the gate-entry QR to the loading agent",
  LOADING_START: "Show the start-loading QR to the loading agent",
  LOADING_COMPLETE: "Show the loading-complete QR to the loading agent",
};

/** Backend-computed gate state for one trip; clients render it and never infer the workflow. */
function gateStateSync(tx, trip, site) {
  const events = tx.select().from(gateEvents).where(eq(gateEvents.tripId, trip.id)).all()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((e) => ({ eventType: e.eventType, at: e.createdAt }));
  const purpose = site ? nextGatePurposeSync(tx, trip.id) : null;
  return {
    events,
    nextPurpose: purpose,
    nextEventType: purpose ? PURPOSE_TO_EVENT[purpose] : null,
    blockedReason: !site ? "NO_LOADING_SITE" : null,
  };
}

/** Driver/admin view of a trip's gate status. No token plaintext, no money. */
export function getDriverGateState(tripId) {
  return db.transaction((tx) => {
    const trip = tx.select().from(trips).where(eq(trips.id, tripId)).get();
    if (!trip) fail(404, "TRIP_NOT_FOUND", "Trip not found.");
    const load = trip.loadId ? tx.select().from(loads).where(eq(loads.id, trip.loadId)).get() : null;
    const site = load?.pickupSiteId ? tx.select().from(loadingSites).where(eq(loadingSites.id, load.pickupSiteId)).get() : null;
    const st = gateStateSync(tx, trip, site);
    const active = tx.select().from(gateTokens)
      .where(and(eq(gateTokens.tripId, trip.id), isNull(gateTokens.consumedAt), isNull(gateTokens.revokedAt))).get();
    return {
      tripId: trip.id, tripStatus: trip.status,
      site: site ? { id: site.id, name: site.name } : null,
      events: st.events,
      nextAction: st.nextPurpose ? { purpose: st.nextPurpose, resultingEvent: st.nextEventType, instruction: PURPOSE_LABEL[st.nextPurpose] } : null,
      blockedReason: st.blockedReason,
      activeToken: active ? { purpose: active.purpose, expiresAt: active.expiresAt } : null,
    };
  });
}

/**
 * Loading Agent read model. Operational verification data ONLY: gate state, the driver's name and
 * licence (what a gate guard checks), the truck registration and the site. Deliberately has no
 * price, escrow, shipper, booking, load, GPS history or delivery data — and is scoped to the
 * agent's assigned sites, so an unassigned trip is indistinguishable from a missing one.
 */
export function listAgentTrips(agentUserId, tripId = null) {
  return db.transaction((tx) => {
    const siteIds = tx.select().from(loadingAgentSites).where(eq(loadingAgentSites.agentUserId, agentUserId)).all().map((a) => a.siteId);
    if (!siteIds.length) return [];
    const siteRows = tx.select().from(loadingSites).where(inArray(loadingSites.id, siteIds)).all();
    const siteById = new Map(siteRows.map((x) => [x.id, x]));
    const loadRows = tx.select().from(loads).where(inArray(loads.pickupSiteId, siteIds)).all();
    if (!loadRows.length) return [];
    const siteByLoad = new Map(loadRows.map((l) => [l.id, siteById.get(l.pickupSiteId)]));
    let tripRows = tx.select().from(trips).where(inArray(trips.loadId, loadRows.map((l) => l.id))).all();
    tripRows = tripId ? tripRows.filter((t) => t.id === tripId) : tripRows.filter((t) => t.status === "At Pickup" || t.status === "Loading");
    return tripRows.map((t) => {
      const site = siteByLoad.get(t.loadId);
      const driver = t.driverId ? tx.select().from(drivers).where(eq(drivers.id, t.driverId)).get() : null;
      const truck = t.truckId ? tx.select().from(trucks).where(eq(trucks.id, t.truckId)).get() : null;
      const st = gateStateSync(tx, t, site);
      return {
        tripId: t.id, status: t.status,
        site: { id: site.id, name: site.name, active: !!site.active },
        truck: { registration: truck?.plate ?? null },
        driver: { name: driver?.name ?? null, licenseNumber: driver?.licenseNumber ?? null },
        gate: { events: st.events, allowedAction: site.active ? st.nextEventType : null },
      };
    });
  });
}

// ── 5E-2: admin site management ─────────────────────────────────────────────

export function createSite({ name, lat, lng, radiusMeters, now = new Date() }) {
  const id = newId("LS");
  const t = now.toISOString();
  guarded(() => db.insert(loadingSites).values({ id, name, lat, lng, radiusMeters, active: 1, createdAt: t, updatedAt: t }).run());
  return db.select().from(loadingSites).where(eq(loadingSites.id, id)).get();
}

export function updateSite(id, patch, now = new Date()) {
  const cur = db.select().from(loadingSites).where(eq(loadingSites.id, id)).get();
  if (!cur) fail(404, "GATE_SITE_NOT_FOUND", "Loading site not found.");
  guarded(() => db.update(loadingSites).set({ ...patch, updatedAt: now.toISOString() }).where(eq(loadingSites.id, id)).run());
  return db.select().from(loadingSites).where(eq(loadingSites.id, id)).get();
}

export function assignAgentToSite({ agentUserId, siteId, createdById, now = new Date() }) {
  guarded(() => db.insert(loadingAgentSites).values({ agentUserId, siteId, createdById, createdAt: now.toISOString() }).run());
}

export function removeAgentFromSite({ agentUserId, siteId }) {
  return db.delete(loadingAgentSites).where(and(eq(loadingAgentSites.agentUserId, agentUserId), eq(loadingAgentSites.siteId, siteId))).run().changes;
}

export function setLoadPickupSite(loadId, siteId) {
  const load = db.select().from(loads).where(eq(loads.id, loadId)).get();
  if (!load) fail(404, "LOAD_NOT_FOUND", "Load not found.");
  guarded(() => db.update(loads).set({ pickupSiteId: siteId }).where(eq(loads.id, loadId)).run());
  return db.select().from(loads).where(eq(loads.id, loadId)).get();
}

/**
 * backend/src/routes/gate.js
 * -----------------------------
 * Phase 5E-2 — loading-gate API. Authorization matrix (identity always from the JWT, never the body):
 *
 *   GET    /api/trips/:tripId/gate               driver (own trip) | admin   gate state + next permitted action
 *   POST   /api/trips/:tripId/gate-token         driver (own trip)           issue a QR token for the ONE eligible step
 *   POST   /api/gate/scan                        loading_agent               verify + record evidence (+ transition)
 *   GET    /api/gate/agent/sites                 loading_agent               the agent's assigned sites (id, name, active)
 *   GET    /api/gate/agent/trips[/:tripId]       loading_agent               scoped read model (no money / commercial data)
 *   GET    /api/loading-sites                    any authenticated role      active sites (id, name) for choosing a pickup site
 *   POST   /api/loading-sites                    admin                       create site
 *   PATCH  /api/loading-sites/:siteId            admin                       edit / deactivate site
 *   GET    /api/loading-sites/:siteId/agents     admin
 *   POST   /api/loading-sites/:siteId/agents     admin                       { agentUserId }
 *   DELETE /api/loading-sites/:siteId/agents/:agentUserId   admin
 *   PUT    /api/loads/:loadId/pickup-site        admin                       { siteId } (frozen once gate evidence exists)
 *
 * FINANCIAL BOUNDARY: nothing here writes payments, escrows or payouts.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { trips, bookings, loads, users, loadingSites, loadingAgentSites } from "../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { NOTIFICATION_TYPE } from "../domain/notification.js";
import { notifyUsers } from "../services/notifications.js";
import {
  GateError, issueGateToken, verifyAndRecordGateEvent, getDriverGateState, listAgentTrips,
  createSite, updateSite, assignAgentToSite, removeAgentFromSite, setLoadPickupSite,
} from "../services/gate.js";

const router = Router();
router.use(requireAuth);

function sendGateError(res, err) {
  if (err instanceof GateError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}
const guard = (fn) => asyncHandler(async (req, res) => { try { await fn(req, res); } catch (e) { sendGateError(res, e); } });

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ── driver ──────────────────────────────────────────────────────────────────

function loadOwnedTrip(req, res) {
  const trip = db.select().from(trips).where(eq(trips.id, req.params.tripId)).get();
  if (!trip) { res.status(404).json({ error: `No trip found with id ${req.params.tripId}.`, code: "TRIP_NOT_FOUND" }); return null; }
  const isOwner = req.user.role === "driver" && req.user.driverId && req.user.driverId === trip.driverId;
  if (!isOwner && req.user.role !== "admin") {
    res.status(403).json({ error: "This trip is not assigned to the authenticated driver.", code: "GATE_NOT_YOUR_TRIP" });
    return null;
  }
  return trip;
}

router.get("/trips/:tripId/gate", requireRole("driver", "admin"), guard((req, res) => {
  const trip = loadOwnedTrip(req, res);
  if (!trip) return;
  res.json(getDriverGateState(trip.id));
}));

router.post("/trips/:tripId/gate-token", requireRole("driver"), guard((req, res) => {
  const trip = loadOwnedTrip(req, res);
  if (!trip) return;
  const requested = req.body?.purpose ?? null; // optional; a mismatch with the eligible step is refused, never honoured
  if (requested !== null && typeof requested !== "string") return res.status(400).json({ error: "purpose must be a string.", code: "GATE_BAD_PURPOSE" });
  const issued = issueGateToken({ tripId: trip.id, purpose: requested, issuedToUserId: req.user.id, driverId: req.user.driverId, requireFunded: true });
  res.status(201).json({
    tokenId: issued.tokenId, qrText: issued.qrText, purpose: issued.purpose,
    expiresAt: issued.expiresAt, refreshAt: issued.refreshAt,
    gate: getDriverGateState(trip.id),
  });
}));

// ── loading agent ───────────────────────────────────────────────────────────

const EVENT_NOTIFICATION = {
  GATE_IN: [NOTIFICATION_TYPE.GATE_IN, "Truck verified at loading site", (t, s) => `Truck for trip ${t} was verified at ${s}. Loading has not started.`],
  LOADING_STARTED: [NOTIFICATION_TYPE.LOADING_STARTED, "Loading started", (t, s) => `Loading started at ${s} for trip ${t}.`],
  LOADING_COMPLETED: [NOTIFICATION_TYPE.LOADING_COMPLETED, "Loading completed — truck in transit", (t, s) => `Loading completed at ${s}; trip ${t} is now In Transit.`],
};

/** Runs AFTER the gate transaction has committed; a notification failure never undoes evidence. */
async function notifyGateEvent(event) {
  try {
    const [type, title, body] = EVENT_NOTIFICATION[event.eventType];
    const [trip] = await db.select().from(trips).where(eq(trips.id, event.tripId));
    const [load] = trip?.loadId ? await db.select().from(loads).where(eq(loads.id, trip.loadId)) : [null];
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, event.bookingId));
    const driverUsers = await db.select().from(users).where(eq(users.driverId, event.driverId));
    const [site] = await db.select().from(loadingSites).where(eq(loadingSites.id, event.siteId));
    const recipients = [...new Set([load?.shipperId, booking?.transporterId, ...driverUsers.map((u) => u.id)].filter(Boolean))];
    await notifyUsers(recipients, type, title, body(event.tripId, site?.name ?? "the loading site"), "trip", event.tripId);
  } catch (err) {
    console.error(`[gate] notification failed for ${event.id}:`, err.message);
  }
}

router.post("/gate/scan", requireRole("loading_agent"), guard(async (req, res) => {
  const scanned = req.body?.token;
  if (typeof scanned !== "string" || !scanned) return res.status(400).json({ error: "token is required.", code: "GATE_TOKEN_INVALID" });
  const event = verifyAndRecordGateEvent({ scanned, agentUserId: req.user.id });
  await notifyGateEvent(event);
  const [view] = listAgentTrips(req.user.id, event.tripId);
  res.status(201).json({
    event: {
      id: event.id, eventType: event.eventType, tripId: event.tripId, createdAt: event.createdAt,
      tripStatusBefore: event.tripStatusBefore, tripStatusAfter: event.tripStatusAfter,
      location: {
        available: !!event.driverLocationAvailable, insideGeofence: event.insideSiteGeofence === null ? null : event.insideSiteGeofence === 1,
        distanceFromSiteMeters: event.driverDistanceFromSiteMeters, ageSeconds: event.locationAgeSeconds,
      },
    },
    trip: view ?? null,
  });
}));

router.get("/gate/agent/sites", requireRole("loading_agent"), guard((req, res) => {
  const siteIds = db.select().from(loadingAgentSites).where(eq(loadingAgentSites.agentUserId, req.user.id)).all().map((a) => a.siteId);
  const rows = siteIds.length ? db.select().from(loadingSites).all().filter((s) => siteIds.includes(s.id)) : [];
  res.json(rows.map((s) => ({ id: s.id, name: s.name, active: !!s.active })));
}));

router.get("/gate/agent/trips", requireRole("loading_agent"), guard((req, res) => {
  res.json(listAgentTrips(req.user.id));
}));

router.get("/gate/agent/trips/:tripId", requireRole("loading_agent"), guard((req, res) => {
  const [view] = listAgentTrips(req.user.id, req.params.tripId);
  if (!view) return res.status(404).json({ error: "No such trip at your loading sites.", code: "TRIP_NOT_FOUND" });
  res.json(view);
}));

// ── sites (admin manages; everyone may list active sites) ───────────────────

router.get("/loading-sites", guard((req, res) => {
  const rows = db.select().from(loadingSites).all().filter((s) => req.user.role === "admin" || s.active);
  res.json(rows.map((s) => req.user.role === "admin" ? s : { id: s.id, name: s.name, lat: s.lat, lng: s.lng, radiusMeters: s.radiusMeters }));
}));

router.post("/loading-sites", requireRole("admin"), guard((req, res) => {
  const { name, lat, lng, radiusMeters } = req.body || {};
  if (typeof name !== "string" || !name.trim() || num(lat) === null || num(lng) === null || num(radiusMeters) === null) {
    return res.status(400).json({ error: "name, lat, lng and radiusMeters are required.", code: "GATE_SITE_INVALID" });
  }
  res.status(201).json(createSite({ name: name.trim(), lat, lng, radiusMeters }));
}));

router.patch("/loading-sites/:siteId", requireRole("admin"), guard((req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) { if (typeof b.name !== "string" || !b.name.trim()) return res.status(400).json({ error: "name is invalid.", code: "GATE_SITE_INVALID" }); patch.name = b.name.trim(); }
  for (const k of ["lat", "lng", "radiusMeters"]) if (b[k] !== undefined) { if (num(b[k]) === null) return res.status(400).json({ error: `${k} is invalid.`, code: "GATE_SITE_INVALID" }); patch[k] = b[k]; }
  if (b.active !== undefined) { if (typeof b.active !== "boolean") return res.status(400).json({ error: "active must be boolean.", code: "GATE_SITE_INVALID" }); patch.active = b.active ? 1 : 0; }
  if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update.", code: "GATE_SITE_INVALID" });
  res.json(updateSite(req.params.siteId, patch));
}));

router.get("/loading-sites/:siteId/agents", requireRole("admin"), guard((req, res) => {
  res.json(db.select().from(loadingAgentSites).where(eq(loadingAgentSites.siteId, req.params.siteId)).all());
}));

router.post("/loading-sites/:siteId/agents", requireRole("admin"), guard((req, res) => {
  const agentUserId = req.body?.agentUserId;
  if (typeof agentUserId !== "string" || !agentUserId) return res.status(400).json({ error: "agentUserId is required.", code: "GATE_NOT_AN_AGENT" });
  assignAgentToSite({ agentUserId, siteId: req.params.siteId, createdById: req.user.id });
  res.status(201).json({ agentUserId, siteId: req.params.siteId });
}));

router.delete("/loading-sites/:siteId/agents/:agentUserId", requireRole("admin"), guard((req, res) => {
  const n = removeAgentFromSite({ agentUserId: req.params.agentUserId, siteId: req.params.siteId });
  if (!n) return res.status(404).json({ error: "Assignment not found.", code: "GATE_ASSIGNMENT_NOT_FOUND" });
  res.json({ removed: true });
}));

router.put("/loads/:loadId/pickup-site", requireRole("admin"), guard((req, res) => {
  const siteId = req.body?.siteId;
  if (typeof siteId !== "string" || !siteId) return res.status(400).json({ error: "siteId is required.", code: "GATE_SITE_NOT_FOUND" });
  const load = setLoadPickupSite(req.params.loadId, siteId);
  res.json({ loadId: load.id, pickupSiteId: load.pickupSiteId });
}));

export default router;

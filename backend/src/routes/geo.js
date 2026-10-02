/**
 * backend/src/routes/geo.js
 * ----------------------------
 * Phase 5C-2 — POST /api/geo/route: road distance between two coordinates via
 * the Google Routes API. Authenticated (any role) and rate-limited per user so
 * the endpoint can't be used to burn the paid API quota.
 */

import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { parsePlace } from "../domain/load.js";
import { computeRoadRoute, routesConfigured, metersToKm } from "../services/googleRoutes.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
router.use(requireAuth);

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map(); // userId -> number[]

function allow(userId) {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) { hits.set(userId, recent); return false; }
  recent.push(now);
  hits.set(userId, recent);
  return true;
}

export function _resetGeoRateLimit() { hits.clear(); }

router.post("/route", asyncHandler(async (req, res) => {
  const { origin, destination } = req.body || {};
  const o = parsePlace(origin, "origin");
  if (!o.ok) return res.status(400).json({ error: o.error });
  const d = parsePlace(destination, "destination");
  if (!d.ok) return res.status(400).json({ error: d.error });
  if (o.place.lat == null || d.place.lat == null) {
    return res.status(400).json({ error: "origin and destination need lat and lng." });
  }
  if (!routesConfigured()) {
    return res.status(503).json({ error: "Route distance is not configured.", code: "ROUTES_UNCONFIGURED" });
  }
  if (!allow(req.user.id)) {
    return res.status(429).json({ error: "Too many route requests. Try again shortly." });
  }

  try {
    const route = await computeRoadRoute(o.place, d.place);
    res.json({ distanceMeters: route.distanceMeters, distanceKm: metersToKm(route.distanceMeters), durationMin: Math.round(route.durationSec / 60), polyline: route.polyline, source: "route" });
  } catch (e) {
    if (e.code === "NO_ROUTE") return res.status(422).json({ error: e.message, code: e.code });
    if (e.code === "ROUTES_UPSTREAM") return res.status(502).json({ error: e.message, code: e.code });
    throw e;
  }
}));

export default router;

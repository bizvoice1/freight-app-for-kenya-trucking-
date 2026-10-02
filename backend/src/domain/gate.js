/**
 * backend/src/domain/gate.js
 * -----------------------------
 * Phase 5E-1 — pure rules for gate / loading evidence. No database, no clock
 * beyond what callers pass in. The QR carries only an opaque random token;
 * everything below is decided server-side.
 */

import { randomBytes, createHash } from "node:crypto";

export const GATE_PURPOSE = { GATE_IN: "GATE_IN", LOADING_START: "LOADING_START", LOADING_COMPLETE: "LOADING_COMPLETE" };
export const GATE_EVENT_TYPE = { GATE_IN: "GATE_IN", LOADING_STARTED: "LOADING_STARTED", LOADING_COMPLETED: "LOADING_COMPLETED" };

/** One purpose per event; a token for one step can never claim another. */
export const PURPOSE_TO_EVENT = {
  GATE_IN: "GATE_IN",
  LOADING_START: "LOADING_STARTED",
  LOADING_COMPLETE: "LOADING_COMPLETED",
};

/**
 * before/after are trip statuses. GATE_IN deliberately does not change the trip.
 * requires = an event type that must already exist for the trip.
 */
export const EVENT_RULES = {
  GATE_IN:           { before: "At Pickup", after: "At Pickup", requires: null },
  LOADING_STARTED:   { before: "At Pickup", after: "Loading",   requires: "GATE_IN" },
  LOADING_COMPLETED: { before: "Loading",   after: "In Transit", requires: "LOADING_STARTED" },
};

export function gateConfig(env = process.env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    tokenTtlSeconds: num(env.GATE_TOKEN_TTL_SECONDS, 300),
    // Advisory for clients: ask for a fresh token when this many seconds remain.
    refreshWindowSeconds: num(env.GATE_TOKEN_REFRESH_WINDOW_SECONDS, 60),
    locationMaxAgeSeconds: num(env.GATE_LOCATION_MAX_AGE_SECONDS, 600),
  };
}

export const TOKEN_PREFIX = "behari:gate:";

/** 32 bytes from the OS CSPRNG, base64url. */
export function generateGateToken() {
  return randomBytes(32).toString("base64url");
}

export function hashGateToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/** Accepts the raw token or the QR text `behari:gate:<token>`. */
export function parseScannedToken(input) {
  if (typeof input !== "string") return null;
  const t = input.trim();
  const raw = t.startsWith(TOKEN_PREFIX) ? t.slice(TOKEN_PREFIX.length) : t;
  return /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
}

export function distanceMeters(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Soft location evidence. Never throws and never blocks.
 * No fix            -> available 0, everything else null (NOT a pass).
 * Stale fix         -> available 1, distance + age recorded, inside null (not evaluated).
 * Fresh fix         -> available 1, inside 1|0.
 */
export function evaluateLocation(site, fix, nowMs, maxAgeSeconds) {
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng) || !fix.timestamp || Number.isNaN(Date.parse(fix.timestamp))) {
    return { available: 0, distanceMeters: null, inside: null, ageSeconds: null, stale: false };
  }
  const ageSeconds = Math.max(0, Math.round((nowMs - Date.parse(fix.timestamp)) / 1000));
  const dist = Math.round(distanceMeters({ lat: fix.lat, lng: fix.lng }, { lat: site.lat, lng: site.lng }));
  const stale = ageSeconds > maxAgeSeconds;
  return { available: 1, distanceMeters: dist, inside: stale ? null : (dist <= site.radiusMeters ? 1 : 0), ageSeconds, stale };
}

/**
 * src/services/trackingService.js
 * ---------------------------------
 * Phase 4E — the ONLY file in the app that touches navigator.geolocation.
 * Wraps the browser Geolocation API into the exact same LocationUpdate
 * contract gpsService.js's simulator already produces (Phase 4D):
 *
 *   navigator.geolocation.watchPosition()
 *           ↓
 *   GPS coordinates
 *           ↓
 *   gpsService.recordDeviceLocation()   (quality guards, source:"device")
 *           ↓
 *   the same LocationUpdate store simulation writes to
 *
 * IDENTITY — there is no real authentication system yet. A driver
 * "identifies" themselves once, on this device, by picking their name in
 * the Driver Tracker screen; that choice is stored under CURRENT_DRIVER_KEY,
 * the same temporary localStorage-identity pattern App.jsx already uses for
 * behari_role/behari_active. startDriverTracking(tripId) resolves BOTH:
 *   - the trip's ACTUAL driverId, read from the Trip record via tripService
 *     (never accepted as a parameter — nothing here lets a caller just pass
 *     driverId:"someone-else")
 *   - the driver currently identified on this device
 * and refuses to start unless they match. That is what makes "James cannot
 * send GPS for Peter's trip" a rejection instead of a client-trusted field.
 *
 * NOT BUILT YET (deliberately, per phase scope):
 *   - offline queueing (capture-while-offline, upload-on-reconnect) — noted
 *     in 4E's own scope as "build once the real tracking workflow works,"
 *     so this only handles the online case for now.
 *   - a real background-location service for when the phone is locked or
 *     the browser/PWA is suspended — watchPosition() is a development-test
 *     stand-in, not the production architecture (that's a native/Capacitor/
 *     React Native concern for a later phase).
 */

import { getTripById } from "./tripService.js";
import { recordDeviceLocation } from "./gpsService.js";
import { ACTIVE_TRIP_STATUSES } from "../models/trip.js";

const CURRENT_DRIVER_KEY = "behari_current_driver_id";

/** Sets which driver is "signed in" on this device. No password — see file header. */
export function setCurrentDriverId(driverId) {
  try { localStorage.setItem(CURRENT_DRIVER_KEY, driverId); } catch { /* ignore */ }
}

export function getCurrentDriverId() {
  try { return localStorage.getItem(CURRENT_DRIVER_KEY); } catch { return null; }
}

export function clearCurrentDriverId() {
  try { localStorage.removeItem(CURRENT_DRIVER_KEY); } catch { /* ignore */ }
}

// Runtime-only — a browser watch handle cannot survive reload, and
// shouldn't: reopening the Driver Tracker screen should re-request a fresh
// GPS lock, not silently resume against a stale one.
const _watches = new Map(); // tripId -> { watchId }

const _idleState = { status: "idle", lastUpdate: null, error: null };
const _stateByTrip = new Map(); // tripId -> state snapshot for getTrackingState()

function _setState(tripId, patch) {
  const next = { ..._stateByTrip.get(tripId) ?? _idleState, ...patch };
  _stateByTrip.set(tripId, next);
}

/** Current tracking status for a trip — for the UI to render Ready/Tracking/Error. */
export function getTrackingState(tripId) {
  return { ..._stateByTrip.get(tripId) ?? _idleState };
}

/**
 * Starts sharing this device's location for a trip. Resolves identity from
 * the Trip record itself (see file header) rather than trusting a caller-
 * supplied driverId.
 *
 * @returns {Promise<{started:boolean, reason:string|null}>}
 */
export async function startDriverTracking(tripId) {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    const reason = "Geolocation is not available on this device/browser.";
    _setState(tripId, { status: "error", error: reason });
    return { started: false, reason };
  }

  const currentDriverId = getCurrentDriverId();
  if (!currentDriverId) {
    return { started: false, reason: "No driver identified on this device yet." };
  }

  const trip = await getTripById(tripId);
  if (!trip) {
    return { started: false, reason: `No trip found with id ${tripId}.` };
  }
  if (trip.driverId !== currentDriverId) {
    // The exact rejection the phase is built around: whoever is holding
    // this device is not the driver this trip is bound to.
    return { started: false, reason: "This trip is not assigned to the currently identified driver." };
  }
  if (!ACTIVE_TRIP_STATUSES.has(trip.status)) {
    return { started: false, reason: `Trip ${tripId} is not active (status: ${trip.status}).` };
  }

  stopDriverTracking(tripId); // clear any stale watch before starting a fresh one
  _setState(tripId, { status: "requesting-permission", error: null });

  const watchId = navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude, accuracy, speed, heading } = position.coords;
      const result = recordDeviceLocation({
        tripId,
        truckId:  trip.truckId,
        driverId: trip.driverId,
        lat: latitude,
        lng: longitude,
        accuracy: accuracy ?? undefined,
        speed:   (typeof speed === "number" && !Number.isNaN(speed)) ? speed * 3.6 : 0, // m/s -> km/h
        heading: (typeof heading === "number" && !Number.isNaN(heading)) ? heading : 0,
        deviceTimestamp: position.timestamp,
      });
      _setState(tripId, result.accepted
        ? { status: "tracking", lastUpdate: result.update, error: null }
        : { status: "tracking", error: result.reason } // stay tracking; surface the flagged reading
      );
    },
    (err) => {
      _setState(tripId, { status: "error", error: err?.message || "Location permission denied." });
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );

  _watches.set(tripId, { watchId });
  return { started: true, reason: null };
}

/** Stops sharing this device's location for a trip. Safe to call if nothing is running. */
export function stopDriverTracking(tripId) {
  const entry = _watches.get(tripId);
  if (entry && typeof navigator !== "undefined" && navigator.geolocation) {
    navigator.geolocation.clearWatch(entry.watchId);
  }
  _watches.delete(tripId);
  _setState(tripId, { status: "stopped" });
}

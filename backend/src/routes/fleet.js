/**
 * backend/src/routes/fleet.js
 * ------------------------------
 * Phase 4H — read-only truck/driver listing, needed by the booking
 * assignment step (a transporter must see their own trucks to pick one).
 * Fleet assignment itself (which driver is currently on which truck)
 * stays a frontend/fleetService.js concern, same boundary 4F/4G drew —
 * this just exposes the backend's own (seeded) snapshot of that data for
 * the booking flow to read.
 */

import { Router } from "express";
import bcrypt from "bcryptjs";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { trucks, drivers, users, trips } from "../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { normalizePhone, newId } from "./auth.js";
import { TRUCK_TYPES } from "../../../src/data/reference.js";
import { ACTIVE_TRIP_STATUSES } from "../../../src/models/trip.js";

const router = Router();
router.use(requireAuth);

/**
 * GET /api/trucks?ownerId=
 * Phase 4I: a transporter has no legitimate reason to browse another
 * transporter's fleet — unlike loads, there's no marketplace case for it.
 * A fleet_owner's query is always forced to their own fleetOwnerId,
 * regardless of what they pass; a mismatched explicit request is rejected
 * outright so it's visibly a permissions error, not silently ignored.
 */
router.get("/trucks", asyncHandler(async (req, res) => {
  const { ownerId } = req.query;

  if (req.user.role === "fleet_owner") {
    if (ownerId && ownerId !== req.user.fleetOwnerId) {
      return res.status(403).json({ error: "Transporters may only list their own fleet." });
    }
    const rows = await db.select().from(trucks).where(eq(trucks.ownerId, req.user.fleetOwnerId));
    return res.json(rows);
  }

  // 5P-1: only fleet owners (own fleet) and admin (all) may list trucks. Shippers/agents have no use for it.
  if (req.user.role === "driver") {
    return res.json(await db.select().from(trucks).where(eq(trucks.currentDriverId, req.user.driverId ?? "")));
  }
  if (req.user.role !== "admin") return res.status(403).json({ error: "Not permitted to list trucks." });
  const rows = ownerId
    ? await db.select().from(trucks).where(eq(trucks.ownerId, ownerId))
    : await db.select().from(trucks);
  res.json(rows);
}));

/** GET /api/drivers — a transporter sees only drivers on their own trucks; a driver sees themself; admin sees all. */
router.get("/drivers", asyncHandler(async (req, res) => {
  if (req.user.role === "admin") return res.json(await db.select().from(drivers));
  if (req.user.role === "driver") return res.json(await db.select().from(drivers).where(eq(drivers.id, req.user.driverId ?? "")));
  if (req.user.role === "fleet_owner") {
    return res.json(await db.select().from(drivers).where(eq(drivers.fleetOwnerId, req.user.fleetOwnerId ?? "")));
  }
  return res.status(403).json({ error: "Not permitted to list drivers." });
}));

const bad = (res, code, error, status = 400) => res.status(status).json({ error, code });
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** An active trip pins its truck and driver; fleet pairing must not change under it. */
async function hasActiveTrip(field, id) {
  const rows = await db.select().from(trips).where(eq(trips[field], id));
  return rows.some((t) => ACTIVE_TRIP_STATUSES.has(t.status));
}

/** Pair (or unpair, driver=null) inside a transaction: truck.currentDriverId and driver.assignedTruckId stay symmetric. */
function pairInTx(tx, truck, driver) {
  if (truck.currentDriverId && truck.currentDriverId !== driver?.id) {
    tx.update(drivers).set({ assignedTruckId: null, status: "Available" }).where(eq(drivers.id, truck.currentDriverId)).run();
  }
  if (driver?.assignedTruckId && driver.assignedTruckId !== truck.id) {
    tx.update(trucks).set({ currentDriverId: null, status: "Available" }).where(eq(trucks.id, driver.assignedTruckId)).run();
  }
  tx.update(trucks).set({ currentDriverId: driver?.id ?? null, status: driver ? "Assigned" : "Available" }).where(eq(trucks.id, truck.id)).run();
  if (driver) tx.update(drivers).set({ assignedTruckId: truck.id, status: "Assigned" }).where(eq(drivers.id, driver.id)).run();
}

/** POST /api/trucks { plate, truckType, capacity? } — ownership comes from the authenticated fleet owner ONLY. */
router.post("/trucks", requireRole("fleet_owner"), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const plate = text(b.plate, 20).toUpperCase().replace(/\s+/g, " ");
  if (!/^[A-Z0-9][A-Z0-9 -]{3,14}$/.test(plate)) return bad(res, "INVALID_PLATE", "Enter a valid number plate, e.g. KDJ 441Z.");
  if (typeof b.truckType !== "string" || !TRUCK_TYPES.includes(b.truckType)) return bad(res, "INVALID_TRUCK_TYPE", "Choose a truck type from the list.");
  const capacity = text(b.capacity, 40) || null;
  const [dup] = await db.select().from(trucks).where(eq(trucks.plate, plate));
  if (dup) return bad(res, "PLATE_TAKEN", `A truck with plate ${plate} is already registered.`, 409);
  const truck = { id: newId("TRK"), plate, truckType: b.truckType, capacity, ownerId: req.user.fleetOwnerId, currentDriverId: null, status: "Available", currentLat: null, currentLng: null };
  await db.insert(trucks).values(truck);
  res.status(201).json(truck);
}));

/**
 * POST /api/drivers { name, phone, pin, licenseNumber?, truckId? }
 * Creates the driver record AND the driver's login (users row, role "driver", users.driverId) in ONE transaction.
 * Public driver registration does not exist; this is the only path.
 */
router.post("/drivers", requireRole("fleet_owner"), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const name = text(b.name, 80);
  if (name.length < 2) return bad(res, "INVALID_NAME", "Enter the driver's name (2-80 characters).");
  const phone = normalizePhone(b.phone);
  if (!phone) return bad(res, "INVALID_PHONE", "Enter a Kenyan mobile number, e.g. 0712345678.");
  if (typeof b.pin !== "string" || !/^\d{4,6}$/.test(b.pin)) return bad(res, "INVALID_PIN", "PIN must be 4 to 6 digits.");
  const licenseNumber = text(b.licenseNumber, 40) || null;
  let truck = null;
  if (b.truckId) {
    [truck] = await db.select().from(trucks).where(and(eq(trucks.id, String(b.truckId)), eq(trucks.ownerId, req.user.fleetOwnerId)));
    if (!truck) return bad(res, "TRUCK_NOT_FOUND", "No such truck in your fleet.", 404);
    if (await hasActiveTrip("truckId", truck.id)) return bad(res, "TRUCK_ON_TRIP", "That truck is on an active trip.", 409);
  }
  const [taken] = await db.select().from(users).where(and(eq(users.phone, phone), eq(users.role, "driver")));
  if (taken) return bad(res, "PHONE_TAKEN", "A driver account with this phone number already exists.", 409);

  const pinHash = await bcrypt.hash(b.pin, 10);
  const driver = { id: newId("DRV"), name, phone, licenseNumber, assignedTruckId: null, status: "Available", fleetOwnerId: req.user.fleetOwnerId };
  const user = { id: newId("USR"), phone, pinHash, role: "driver", name, driverId: driver.id, fleetOwnerId: null, phoneVerified: 0, createdAt: new Date().toISOString() };
  try {
    db.transaction((tx) => {
      tx.insert(drivers).values(driver).run();
      tx.insert(users).values(user).run();
      if (truck) pairInTx(tx, truck, driver);
    });
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return bad(res, "PHONE_TAKEN", "A driver account with this phone number already exists.", 409);
    throw e;
  }
  const [row] = await db.select().from(drivers).where(eq(drivers.id, driver.id));
  res.status(201).json({ ...row, userId: user.id });
}));

/** PUT /api/trucks/:truckId/driver { driverId | null } — pair or unpair a driver within the caller's own fleet. */
router.put("/trucks/:truckId/driver", requireRole("fleet_owner"), asyncHandler(async (req, res) => {
  const [truck] = await db.select().from(trucks).where(and(eq(trucks.id, req.params.truckId), eq(trucks.ownerId, req.user.fleetOwnerId)));
  if (!truck) return bad(res, "TRUCK_NOT_FOUND", "No such truck in your fleet.", 404);
  const { driverId } = req.body || {};
  let driver = null;
  if (driverId !== null && driverId !== undefined) {
    if (typeof driverId !== "string") return bad(res, "INVALID_DRIVER", "driverId must be a string or null.");
    [driver] = await db.select().from(drivers).where(and(eq(drivers.id, driverId), eq(drivers.fleetOwnerId, req.user.fleetOwnerId)));
    if (!driver) return bad(res, "DRIVER_NOT_FOUND", "No such driver in your fleet.", 404);
    if (await hasActiveTrip("driverId", driver.id)) return bad(res, "DRIVER_ON_TRIP", "That driver is on an active trip.", 409);
  }
  if (await hasActiveTrip("truckId", truck.id)) return bad(res, "TRUCK_ON_TRIP", "That truck is on an active trip.", 409);
  db.transaction((tx) => pairInTx(tx, truck, driver));
  const [row] = await db.select().from(trucks).where(eq(trucks.id, truck.id));
  res.json(row);
}));

export default router;

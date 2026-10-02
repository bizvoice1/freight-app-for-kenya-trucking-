import { Router } from "express";
import bcrypt from "bcryptjs";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, fleetOwners, drivers } from "../db/schema.js";
import { signToken } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

/**
 * 5P-1 identity. Dev auth mode = phone + PIN, NO phone verification (no SMS provider yet).
 * Everything the client may know about "who am I" comes from /api/me; the browser never
 * generates or validates any verification code.
 */
export const AUTH_MODE = { mode: "dev-pin", phoneVerification: false, note: "Development authentication: phone + PIN only. The phone number is NOT verified." };

// Roles anyone may self-register. driver / loading_agent / admin are created by controlled paths only.
const PUBLIC_ROLES = new Set(["shipper", "fleet_owner"]);

/** Canonical local form 07XXXXXXXX / 01XXXXXXXX, or null when it is not a Kenyan mobile number. */
export function normalizePhone(input) {
  if (typeof input !== "string") return null;
  let p = input.replace(/[\s\-()]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (/^254[17]\d{8}$/.test(p)) p = "0" + p.slice(3);
  return /^0[17]\d{8}$/.test(p) ? p : null;
}

export const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

// Brute-force guard for a 4-6 digit PIN: failures per phone+role, in memory (5N: move to shared store).
const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILURES) || 5;
const LOCK_MS = Number(process.env.LOGIN_LOCK_MS) || 15 * 60 * 1000;
const fails = new Map(); // key -> { n, until }
function lockedFor(key) {
  const f = fails.get(key);
  if (f && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
  if (f && f.until) fails.delete(key);
  return 0;
}
function recordFailure(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  fails.set(key, f);
}

const sessionUser = (u) => ({
  id: u.id, name: u.name, role: u.role, driverId: u.driverId ?? null, fleetOwnerId: u.fleetOwnerId ?? null,
});

router.get("/config", (_req, res) => res.json({ ...AUTH_MODE, publicRoles: [...PUBLIC_ROLES] }));

/** POST /api/auth/register { name, phone, pin, role: "shipper"|"fleet_owner", company? } */
router.post("/register", asyncHandler(async (req, res) => {
  const { name, phone, pin, role, company } = req.body || {};
  if (typeof role !== "string" || !PUBLIC_ROLES.has(role)) {
    return res.status(400).json({ error: "Registration is open to shippers and transporters only.", code: "ROLE_NOT_REGISTERABLE" });
  }
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (cleanName.length < 2 || cleanName.length > 80) return res.status(400).json({ error: "Enter your name (2-80 characters).", code: "INVALID_NAME" });
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return res.status(400).json({ error: "Enter a Kenyan mobile number, e.g. 0712345678.", code: "INVALID_PHONE" });
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: "PIN must be 4 to 6 digits.", code: "INVALID_PIN" });
  const cleanCompany = typeof company === "string" && company.trim() ? company.trim().slice(0, 120) : null;

  const [existing] = await db.select().from(users).where(and(eq(users.phone, cleanPhone), eq(users.role, role)));
  if (existing) return res.status(409).json({ error: "An account with this phone number already exists for that role.", code: "PHONE_TAKEN" });

  const pinHash = await bcrypt.hash(pin, 10);
  const user = { id: newId("USR"), phone: cleanPhone, pinHash, role, name: cleanName, driverId: null, fleetOwnerId: null, phoneVerified: 0, createdAt: new Date().toISOString() };
  try {
    // Transporter: users row + fleet_owners row + users.fleetOwnerId, atomically.
    db.transaction((tx) => {
      if (role === "fleet_owner") {
        user.fleetOwnerId = newId("FO");
        tx.insert(fleetOwners).values({ id: user.fleetOwnerId, name: cleanName, phone: cleanPhone, company: cleanCompany }).run();
      }
      tx.insert(users).values(user).run();
    });
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return res.status(409).json({ error: "An account with this phone number already exists for that role.", code: "PHONE_TAKEN" });
    throw e;
  }
  res.status(201).json({ token: signToken(user), user: sessionUser(user), authMode: AUTH_MODE });
}));

/** POST /api/auth/login { phone, pin, role } */
router.post("/login", asyncHandler(async (req, res) => {
  const { phone, pin, role } = req.body || {};
  if (typeof phone !== "string" || typeof pin !== "string" || typeof role !== "string" || !phone || !pin || !role) {
    return res.status(400).json({ error: "phone, pin and role are all required." });
  }
  const cleanPhone = normalizePhone(phone) ?? phone;
  const key = `${cleanPhone}|${role}`;
  const wait = lockedFor(key);
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, code: "LOGIN_LOCKED" });

  const [user] = await db.select().from(users).where(and(eq(users.phone, cleanPhone), eq(users.role, role)));
  // Same answer for unknown account and wrong PIN: no account enumeration.
  const ok = user ? await bcrypt.compare(pin, user.pinHash) : (await bcrypt.compare(pin, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi"), false);
  if (!ok) {
    recordFailure(key);
    return res.status(401).json({ error: "Incorrect phone number, PIN or role.", code: "INVALID_CREDENTIALS" });
  }
  fails.delete(key);
  res.json({ token: signToken(user), user: sessionUser(user), authMode: AUTH_MODE });
}));

/** GET /api/me — the canonical identity, read from the database (not the token's claims). */
export const meRouter = Router();
meRouter.get("/", requireAuth, asyncHandler(async (req, res) => {
  const [u] = await db.select().from(users).where(eq(users.id, req.user.id));
  if (!u) return res.status(401).json({ error: "This account no longer exists.", code: "ACCOUNT_GONE" });
  let fleetOwner = null;
  if (u.fleetOwnerId) {
    const [fo] = await db.select().from(fleetOwners).where(eq(fleetOwners.id, u.fleetOwnerId));
    if (fo) fleetOwner = { id: fo.id, name: fo.name, company: fo.company ?? null };
  }
  let driver = null;
  if (u.driverId) {
    const [d] = await db.select().from(drivers).where(eq(drivers.id, u.driverId));
    if (d) driver = { id: d.id, fleetOwnerId: d.fleetOwnerId ?? null, assignedTruckId: d.assignedTruckId ?? null, licenseNumber: d.licenseNumber ?? null };
  }
  // Role-agnostic fields are top-level and always present; role-specific objects are null unless the role applies.
  res.json({
    ...sessionUser(u), phone: u.phone, phoneVerified: !!u.phoneVerified,
    company: fleetOwner?.company ?? null, fleetOwner, driver, authMode: AUTH_MODE,
  });
}));

export default router;

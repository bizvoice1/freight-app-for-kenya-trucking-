import { Router } from "express";
import bcrypt from "bcryptjs";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { signToken } from "../auth/jwt.js";

const router = Router();

/**
 * POST /api/auth/login
 * body: { phone, pin, role }
 *
 * role is required because one phone number can hold more than one
 * identity in this demo (the fleet owner is also a driver) — see
 * schema.js's users table note. Returns a signed token; the phone never
 * appears in the token itself, only the resolved user id/role/driverId.
 */
router.post("/login", async (req, res) => {
  const { phone, pin, role } = req.body || {};
  if (!phone || !pin || !role) {
    return res.status(400).json({ error: "phone, pin and role are all required." });
  }

  const [user] = await db.select().from(users).where(and(eq(users.phone, phone), eq(users.role, role)));
  if (!user) {
    return res.status(401).json({ error: "No account found for that phone number and role." });
  }

  const pinOk = await bcrypt.compare(pin, user.pinHash);
  if (!pinOk) {
    return res.status(401).json({ error: "Incorrect PIN." });
  }

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, driverId: user.driverId },
  });
});

export default router;

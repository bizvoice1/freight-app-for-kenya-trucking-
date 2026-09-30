/**
 * backend/src/auth/jwt.js
 * -------------------------
 * Phase 4F's "lightweight backend-issued tokens" — real enough that the
 * server, not the client, decides identity, without building the full
 * production auth stack (SMS/OTP delivery, refresh-token rotation,
 * password reset) this phase deliberately deferred.
 *
 * JWT_SECRET MUST be overridden via env in anything beyond local dev — the
 * fallback here exists only so `npm run dev` works out of the box.
 */

import jwt from "jsonwebtoken";

const JWT_SECRET  = process.env.JWT_SECRET || "behari-dev-only-secret-do-not-use-in-production";
const TOKEN_TTL   = "12h";

/** @param {{id:string, role:string, name:string, driverId:string|null}} user */
export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name, driverId: user.driverId ?? null },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

/** @returns {{sub:string, role:string, name:string, driverId:string|null}} */
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

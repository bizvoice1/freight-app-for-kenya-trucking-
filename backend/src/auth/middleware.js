/**
 * backend/src/auth/middleware.js
 * ---------------------------------
 * requireAuth attaches req.user from a verified JWT — the ONLY source of
 * identity every route downstream is allowed to trust. This is the
 * enforcement point for the whole phase's core rule: a request body can
 * say whatever it wants about who's driving; only req.user, derived here
 * from a signed token, decides who the backend believes the caller is.
 */

import { verifyToken } from "./jwt.js";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }
  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, role: payload.role, name: payload.name, driverId: payload.driverId, fleetOwnerId: payload.fleetOwnerId };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

/** Restricts a route to one or more roles, e.g. requireRole("driver"). */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `This action requires role: ${roles.join(" or ")}.` });
    }
    next();
  };
}

/**
 * backend/src/routes/notifications.js
 * ------------------------------------------
 * Phase 4L — read-only + mark-read. Every route here is scoped to
 * req.user.id unconditionally, no role branching: a notification belongs to
 * exactly the user it was written for (see services/notifications.js), so
 * there's no ownership chain to walk the way payments/escrows/payouts need.
 */

import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { notifications } from "../db/schema.js";
import { requireAuth } from "../auth/middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();
router.use(requireAuth);

/** GET /api/notifications?unreadOnly=true — newest first. */
router.get("/", asyncHandler(async (req, res) => {
  const { unreadOnly } = req.query;
  const conditions = [eq(notifications.userId, req.user.id)];
  if (unreadOnly === "true") conditions.push(eq(notifications.read, false));

  const rows = await db.select().from(notifications).where(and(...conditions)).orderBy(desc(notifications.createdAt));
  res.json(rows);
}));

/** GET /api/notifications/unread-count — for a badge, without shipping the full list. */
router.get("/unread-count", asyncHandler(async (req, res) => {
  const rows = await db.select().from(notifications).where(and(eq(notifications.userId, req.user.id), eq(notifications.read, false)));
  res.json({ count: rows.length });
}));

async function getOwnNotificationOr404(req, res) {
  const [n] = await db.select().from(notifications).where(eq(notifications.id, req.params.id));
  if (!n || n.userId !== req.user.id) {
    res.status(404).json({ error: `No notification found with id ${req.params.id}.` });
    return null;
  }
  return n;
}

/** POST /api/notifications/:id/read */
router.post("/:id/read", asyncHandler(async (req, res) => {
  const n = await getOwnNotificationOr404(req, res);
  if (!n) return;
  await db.update(notifications).set({ read: true }).where(eq(notifications.id, n.id));
  const [updated] = await db.select().from(notifications).where(eq(notifications.id, n.id));
  res.json(updated);
}));

/** POST /api/notifications/read-all */
router.post("/read-all", asyncHandler(async (req, res) => {
  await db.update(notifications).set({ read: true }).where(and(eq(notifications.userId, req.user.id), eq(notifications.read, false)));
  res.json({ ok: true });
}));

export default router;

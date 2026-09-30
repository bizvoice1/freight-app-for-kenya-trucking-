/**
 * backend/src/routes/payments.js
 * -----------------------------------
 * Phase 4K — read-only endpoints for payments. Creation lives on
 * routes/bookings.js's POST /:bookingId/payment (a booking action, not a
 * payments-collection action); the callback lives in routes/darajaWebhooks.js
 * and is deliberately NOT behind requireAuth — Safaricom has no JWT.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { payments, bookings } from "../db/schema.js";
import { requireAuth } from "../auth/middleware.js";

const router = Router();
router.use(requireAuth);

/**
 * Same ownership shape as routes/bookings.js's canViewBooking: a shipper
 * sees only their own payments; a transporter sees payments for bookings
 * they hold (read-only — they never initiate or control one); admin sees
 * everything.
 */
async function canViewPayment(req, payment) {
  if (req.user.role === "admin") return true;
  if (req.user.role === "shipper") return payment.shipperId === req.user.id;
  if (req.user.role === "fleet_owner") {
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, payment.bookingId));
    return !!booking && booking.transporterId === req.user.id;
  }
  return false;
}

router.get("/:id", async (req, res) => {
  const [payment] = await db.select().from(payments).where(eq(payments.id, req.params.id));
  if (!payment) return res.status(404).json({ error: `No payment found with id ${req.params.id}.` });
  if (!(await canViewPayment(req, payment))) {
    return res.status(403).json({ error: "You are not authorized to view this payment." });
  }
  res.json(payment);
});

router.get("/", async (req, res) => {
  const { bookingId } = req.query;
  let rows = bookingId
    ? await db.select().from(payments).where(eq(payments.bookingId, bookingId))
    : await db.select().from(payments);

  if (req.user.role === "shipper") {
    rows = rows.filter(p => p.shipperId === req.user.id);
  } else if (req.user.role === "fleet_owner") {
    const own = await db.select().from(bookings).where(eq(bookings.transporterId, req.user.id));
    const ownBookingIds = new Set(own.map(b => b.id));
    rows = rows.filter(p => ownBookingIds.has(p.bookingId));
  } else if (req.user.role === "driver") {
    rows = [];
  }
  res.json(rows);
});

export default router;

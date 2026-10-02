import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { sqlite } from "./db/client.js";
import authRoutes, { meRouter } from "./routes/auth.js";
import tripRoutes from "./routes/trips.js";
import loadRoutes from "./routes/loads.js";
import offerRoutes from "./routes/offers.js";
import bookingRoutes from "./routes/bookings.js";
import fleetRoutes from "./routes/fleet.js";
import paymentRoutes from "./routes/payments.js";
import escrowRoutes from "./routes/escrows.js";
import payoutRoutes from "./routes/payouts.js";
import darajaWebhookRoutes from "./routes/darajaWebhooks.js";
import notificationRoutes from "./routes/notifications.js";
import geoRoutes from "./routes/geo.js";
import adjustmentRoutes from "./routes/adjustments.js";
import gateRoutes from "./routes/gate.js";

export const app = express();

/**
 * Phase 4M — CORS allow-list. `ALLOWED_ORIGINS` (comma-separated) restricts
 * which origins may call this API; left unset, `cors({})` behaves exactly
 * like the old bare `cors()` (reflects any origin) so local dev stays
 * zero-config. Only meaningful once this is deployed somewhere with a real
 * frontend origin to name.
 */
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map(s => s.trim()).filter(Boolean);
app.use(cors(allowedOrigins ? {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
} : {}));

app.use(express.json());

/**
 * Phase 4M — a short per-request id (not a security token, just a
 * correlation handle) attached to req.id, logged on every request's
 * completion and echoed on error responses. Structured but dependency-free:
 * one line per request, upgradeable to Winston/Pino later without touching
 * call sites. logPaymentEvent (services/ledger.js) accepts the same id as
 * an optional field so a payment's audit trail can be traced back to the
 * request that produced it.
 */
app.use((req, res, next) => {
  req.id = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(`[${req.id}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

/** Liveness — the process is up. No dependency check; a load balancer's "don't restart me" signal. */
app.get("/health", (_req, res) => res.json({ ok: true }));

/** Readiness — the process is up AND can actually reach the database. A load balancer's "don't route to me yet" signal. */
app.get("/ready", (_req, res) => {
  try {
    sqlite.prepare("SELECT 1").get();
    res.json({ ready: true });
  } catch {
    res.status(503).json({ ready: false, error: "Database not reachable." });
  }
});

// Phase 4K — mounted FIRST and deliberately: fleetRoutes below applies
// `router.use(requireAuth)` unconditionally to every request that reaches
// it, including ones that don't match its own "/trucks"/"/drivers" routes,
// because that's ALSO mounted at "/api". A blanket, path-less router.use()
// intercepts before Express ever checks a later router's specific paths —
// so the two unauthenticated Daraja callbacks must claim their paths before
// any "/api"-prefixed router with a blanket auth check gets a turn, not
// merely be defined without requireAuth themselves.
app.use("/api", darajaWebhookRoutes); // POST /api/payments/callback/stk, POST /api/payouts/callback/b2c

app.use("/api/auth", authRoutes);
app.use("/api/me", meRouter);
app.use("/api/trips", tripRoutes);
app.use("/api/loads", loadRoutes);
app.use("/api/offers", offerRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/adjustments", adjustmentRoutes);
app.use("/api", fleetRoutes); // GET /api/trucks, GET /api/drivers
app.use("/api/payments", paymentRoutes);
app.use("/api/escrows", escrowRoutes);
app.use("/api/payouts", payoutRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/geo", geoRoutes);
app.use("/api", gateRoutes); // 5E-2: /api/trips/:id/gate*, /api/gate/*, /api/loading-sites*, PUT /api/loads/:id/pickup-site

/**
 * Phase 4M — every async route handler is now wrapped in asyncHandler
 * (utils/asyncHandler.js), which forwards a rejected promise to this
 * middleware instead of the request hanging forever (the real gap this
 * phase closes — Express 4 does not do that forwarding on its own). Never
 * leaks a stack trace or error message to the client; `requestId` is safe
 * to return (it's just a correlation handle) and lets a report from the
 * field be matched back to a specific server-side log line.
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON body.", requestId: req.id });
  }
  console.error(`[${req.id || "-"}]`, err);
  res.status(500).json({ error: "Internal server error.", requestId: req.id });
});

import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import tripRoutes from "./routes/trips.js";
import loadRoutes from "./routes/loads.js";
import bookingRoutes from "./routes/bookings.js";
import fleetRoutes from "./routes/fleet.js";
import paymentRoutes from "./routes/payments.js";
import escrowRoutes from "./routes/escrows.js";
import payoutRoutes from "./routes/payouts.js";
import darajaWebhookRoutes from "./routes/darajaWebhooks.js";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

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
app.use("/api/trips", tripRoutes);
app.use("/api/loads", loadRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api", fleetRoutes); // GET /api/trucks, GET /api/drivers
app.use("/api/payments", paymentRoutes);
app.use("/api/escrows", escrowRoutes);
app.use("/api/payouts", payoutRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

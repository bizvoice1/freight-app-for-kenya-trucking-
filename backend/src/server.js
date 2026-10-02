/**
 * backend/src/server.js
 * ------------------------
 * Phase 4M — startup safety and graceful shutdown, on top of 4F's plain
 * `app.listen`. Two changes, both deliberately minimal:
 *
 *   1. Fail fast if this is a production boot with no real JWT_SECRET —
 *      auth/jwt.js falls back to a hardcoded dev secret in ANY environment
 *      (by design, so `npm run dev` needs zero config locally); this is the
 *      one place that fallback becomes dangerous instead of convenient, so
 *      it's the one place it gets refused. Development stays zero-config —
 *      this check does nothing unless NODE_ENV is actually "production".
 *   2. Stop accepting new connections and close the database handle on
 *      SIGTERM/SIGINT instead of the process just dying mid-request.
 */
import "dotenv/config";
import { app } from "./app.js";
import { sqlite } from "./db/client.js";
import { expireDueOffers } from "./services/offers.js";
import { expireStalePayments, notifyExpired, paymentConfigProblem } from "./services/bookingPayment.js";

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  console.error(
    "FATAL: NODE_ENV=production but JWT_SECRET is not set. Refusing to start " +
    "with the hardcoded development secret in production. Set JWT_SECRET and retry."
  );
  process.exit(1);
}

const payProblem = paymentConfigProblem();
if (payProblem) {
  console.error(`FATAL: ${payProblem}`);
  process.exit(1);
}

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => console.log(`Behari Freight backend listening on http://localhost:${PORT}`));

// 5D-1 — lazy expiry already refuses expired offers; the sweeper only records EXPIRED + audit.
const sweepOffers = () => {
  try {
    const n = expireDueOffers();
    if (n) console.log(`Offer sweeper: expired ${n} offer(s).`);
  } catch (err) {
    console.error("Offer sweeper failed:", err?.message);
  }
};
sweepOffers();
const sweeper = setInterval(sweepOffers, 60_000);
sweeper.unref();

// 5D-4 — StkSent -> Timeout after PAYMENT_STK_TIMEOUT_SECONDS; GET endpoints never mutate.
const sweepPayments = async () => {
  try {
    const expired = expireStalePayments();
    if (expired.length) {
      console.log(`Payment sweeper: timed out ${expired.length} payment(s).`);
      await notifyExpired(expired);
    }
  } catch (err) {
    console.error("Payment sweeper failed:", err?.message);
  }
};
const paySweeper = setInterval(sweepPayments, Math.max(1, Number(process.env.PAYMENT_SWEEP_INTERVAL_SECONDS) || 15) * 1000);
paySweeper.unref();

function shutdown(signal) {
  console.log(`${signal} received: closing server...`);
  clearInterval(sweeper);
  clearInterval(paySweeper);
  server.close(() => {
    sqlite.close();
    console.log("Server and database closed.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

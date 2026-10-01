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

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  console.error(
    "FATAL: NODE_ENV=production but JWT_SECRET is not set. Refusing to start " +
    "with the hardcoded development secret in production. Set JWT_SECRET and retry."
  );
  process.exit(1);
}

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => console.log(`Behari Freight backend listening on http://localhost:${PORT}`));

function shutdown(signal) {
  console.log(`${signal} received: closing server...`);
  server.close(() => {
    sqlite.close();
    console.log("Server and database closed.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

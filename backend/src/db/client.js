/**
 * backend/src/db/client.js
 * --------------------------
 * The ONLY file that knows which database engine we're actually running.
 * Every route/service imports `db` from here and talks to it exclusively
 * through Drizzle's query builder — never a raw SQL string — so that
 * swapping the driver below (better-sqlite3 -> pg/postgres.js) plus
 * schema.js's column builders (sqlite-core -> pg-core) is the entire
 * Postgres migration. See schema.js's own header for the full note.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const DB_PATH = process.env.DATABASE_PATH || "./behari.sqlite";

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { sqlite };

/**
 * Phase 4K — the one place that knows what a unique-constraint violation
 * looks like on THIS driver (better-sqlite3's `.code`). Routes that rely on
 * a partial unique index as their real concurrency guard (see
 * payouts_one_inflight_per_escrow in schema.js) catch their INSERT with
 * this, not a Postgres-specific check — keeps the Postgres migration path
 * schema.js already promises intact.
 */
export function isUniqueConstraintError(err) {
  return err && typeof err.code === "string" && err.code.startsWith("SQLITE_CONSTRAINT");
}

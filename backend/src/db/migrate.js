/** Phase 4F — applies drizzle/*.sql migrations to the local SQLite file. */
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite } from "./client.js";

migrate(db, { migrationsFolder: "./drizzle" });
console.log("Migrations applied to", process.env.DATABASE_PATH || "./behari.sqlite");
sqlite.close();

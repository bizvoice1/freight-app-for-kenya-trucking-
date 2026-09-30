/** Phase 4F — SQLite dev database, Postgres-ready. See src/db/schema.js. */
export default {
  schema: "./src/db/schema.js",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_PATH || "./behari.sqlite",
  },
};

/**
 * backend/src/db/schema.js
 * -------------------------
 * Phase 4F — database schema, written against drizzle-orm's sqlite-core
 * dialect since SQLite is today's DEVELOPMENT database (per the explicit
 * 4F decision — not the eventual production one).
 *
 * POSTGRES MIGRATION PATH: Drizzle doesn't have one dialect-agnostic schema
 * DSL that runs unmodified against both SQLite and Postgres — the column
 * builders differ (sqlite-core vs pg-core). What keeps this migration
 * mechanical rather than a redesign is discipline elsewhere, not this file
 * alone:
 *   - every column here uses a type with a direct Postgres equivalent
 *     (text -> text/varchar, real -> real/double precision, integer
 *     timestamps avoided in favour of ISO text — see below) — nothing
 *     SQLite-specific (no JSON1 functions, no ROWID tricks).
 *   - every route/service in this backend talks to the database ONLY
 *     through Drizzle's query builder (db.select()/.insert()/.where(eq(...))),
 *     never a raw SQL string — see src/db/client.js's own note. Swapping to
 *     Postgres later means: translate this one file's column builders to
 *     pg-core, swap the driver in client.js from better-sqlite3 to
 *     pg/postgres.js, done. No other file changes.
 *   - timestamps are stored as ISO-8601 TEXT (not SQLite's native unixepoch
 *     integer mode) specifically so the same string format works
 *     identically once the column type becomes Postgres `timestamptz`.
 */

import { sqliteTable, text, real, unique } from "drizzle-orm/sqlite-core";

export const fleetOwners = sqliteTable("fleet_owners", {
  id:      text("id").primaryKey(),
  name:    text("name").notNull(),
  phone:   text("phone"),
  company: text("company"),
});

export const trucks = sqliteTable("trucks", {
  id:               text("id").primaryKey(),
  plate:            text("plate").notNull(),
  truckType:        text("truck_type"),
  capacity:         text("capacity"),
  ownerId:          text("owner_id").references(() => fleetOwners.id),
  currentDriverId:  text("current_driver_id"),
  status:           text("status").notNull(),
  currentLat:       real("current_lat"),
  currentLng:       real("current_lng"),
});

export const drivers = sqliteTable("drivers", {
  id:              text("id").primaryKey(),
  name:            text("name").notNull(),
  phone:           text("phone"),
  licenseNumber:   text("license_number"),
  assignedTruckId: text("assigned_truck_id"),
  status:          text("status").notNull(),
});

export const trips = sqliteTable("trips", {
  id:               text("id").primaryKey(),
  loadId:           text("load_id"),
  bookingId:        text("booking_id"),
  truckId:          text("truck_id").notNull(),
  driverId:         text("driver_id").notNull(),
  status:           text("status").notNull(),
  pickup:           text("pickup"),
  delivery:         text("delivery"),
  startedAt:        text("started_at"),
  completedAt:      text("completed_at"),
  latestLocationId: text("latest_location_id"),
  createdAt:        text("created_at").notNull(),
  updatedAt:        text("updated_at").notNull(),
});

export const locationUpdates = sqliteTable("location_updates", {
  id:        text("id").primaryKey(),
  tripId:    text("trip_id").notNull(),
  truckId:   text("truck_id").notNull(),
  driverId:  text("driver_id").notNull(),
  lat:       real("lat").notNull(),
  lng:       real("lng").notNull(),
  accuracy:  real("accuracy"),
  speed:     real("speed"),
  heading:   real("heading"),
  source:    text("source").notNull(), // "simulation" | "device"
  timestamp: text("timestamp").notNull(),
});

/**
 * Phase 4F's lightweight auth: one row per login identity. `driverId` is
 * set only for role:"driver" accounts — it's what lets the backend resolve
 * "which driver is this authenticated request" without ever trusting a
 * client-supplied id (see src/auth/middleware.js).
 *
 * Unique on (phone, role) rather than phone alone: the demo's own fleet
 * owner (James) is also one of its drivers — one real person, two distinct
 * login identities on the same phone number, exactly like the frontend
 * already lets one demo login pick driver/shipper/admin as separate roles.
 * A phone+PIN login therefore also needs to say which role it's signing
 * into (see routes/auth.js).
 */
export const users = sqliteTable("users", {
  id:           text("id").primaryKey(),
  phone:        text("phone").notNull(),
  pinHash:      text("pin_hash").notNull(),
  role:         text("role").notNull(), // "driver" | "shipper" | "admin" | "fleet_owner"
  name:         text("name").notNull(),
  driverId:     text("driver_id"),      // set only for role:"driver"
  fleetOwnerId: text("fleet_owner_id"), // set only for role:"fleet_owner" — Phase 4H needs this to resolve "which trucks can this transporter assign to a booking"
}, (table) => ({
  phoneRoleUnique: unique().on(table.phone, table.role),
}));

/**
 * Phase 4H — the missing bridge between a Load and a Trip. A Booking means
 * "this transporter has accepted this load"; it does NOT mean a truck and
 * driver are executing it yet — that's only true once truckId+driverId are
 * both set (status Assigned) and, later, tripId is set (status TripCreated).
 * Booking != Trip is deliberate: a booking can exist with no truck/driver
 * chosen yet, and (in a future phase) a fallen-through trip could in
 * principle be re-attempted under the same booking with a new Trip.
 */
export const bookings = sqliteTable("bookings", {
  id:            text("id").primaryKey(),
  loadId:        text("load_id").notNull(),
  transporterId: text("transporter_id").notNull(), // users.id, role fleet_owner
  truckId:       text("truck_id"),  // null until assigned
  driverId:      text("driver_id"), // null until assigned
  tripId:        text("trip_id"),   // null until the trip is created
  status:        text("status").notNull(), // "Accepted" | "Assigned" | "Trip Created" | "Cancelled"
  createdAt:     text("created_at").notNull(),
  updatedAt:     text("updated_at").notNull(),
});

/**
 * Phase 4H — deliberately NOT the frontend's rich models/load.js LOAD_STATUS
 * (Escrow Held -> ... -> Paid Out): this phase explicitly excludes
 * escrow/payment, so a backend Load only needs Open/Booked/Cancelled. That
 * richer lifecycle is the frontend demo's own, separate, frozen model —
 * this table is a new, simpler entity, not a backend mirror of it. See
 * routes/loads.js's header for the full note.
 */
export const loads = sqliteTable("loads", {
  id:          text("id").primaryKey(),
  shipperId:   text("shipper_id").notNull(), // users.id, role shipper
  cargo:       text("cargo").notNull(),
  origin:      text("origin").notNull(),
  destination: text("destination").notNull(),
  weight:      text("weight"),
  truckType:   text("truck_type"),
  price:       real("price"),
  pickupDate:  text("pickup_date"),
  status:      text("status").notNull(), // "Open" | "Booked" | "Cancelled"
  createdAt:   text("created_at").notNull(),
  updatedAt:   text("updated_at").notNull(),
});

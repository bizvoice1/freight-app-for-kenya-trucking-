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

import { sqliteTable, text, real, integer, unique, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

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
}, (table) => ({
  loadIdIdx:   index("trips_load_id_idx").on(table.loadId),
  truckIdIdx:  index("trips_truck_id_idx").on(table.truckId),
  driverIdIdx: index("trips_driver_id_idx").on(table.driverId),
  // Phase 4M — same reasoning as bookings.loadId above: two concurrent
  // create-trip calls for the same booking could otherwise both insert a
  // trip. bookingId is nullable (a trip predating Phase 4H's booking flow),
  // and SQLite's unique index treats multiple NULLs as non-conflicting, so
  // this only constrains rows that actually have one.
  bookingIdUnique: uniqueIndex("trips_booking_id_unique").on(table.bookingId),
}));

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
  // Phase 5C-3 — immutable snapshot of loads.distance_meters at booking time.
  agreedRoadDistanceMeters: integer("agreed_road_distance_meters"),
  status:        text("status").notNull(), // "Accepted" | "Assigned" | "Trip Created" | "Cancelled"
  // Phase 5D-1 — the agreed price is financial truth, snapshotted once at
  // booking insert (immutable by trigger). Nullable at the schema level only:
  // a legacy booking whose load had no price keeps null. Every booking created
  // after 5D has a positive value.
  agreedAmount:    real("agreed_amount"),
  agreementSource: text("agreement_source"), // "POSTED_PRICE" | "OFFER"
  agreedOfferId:   text("agreed_offer_id"),  // offers.id; null for POSTED_PRICE
  createdAt:     text("created_at").notNull(),
  updatedAt:     text("updated_at").notNull(),
}, (table) => ({
  transporterIdIdx: index("bookings_transporter_id_idx").on(table.transporterId),
  // Phase 4M — a real gap the attack suite surfaced: two transporters
  // accepting the same load at the same instant could otherwise both
  // insert a booking (the `load.status !== OPEN` check alone is the same
  // check-then-act race as 4K's release endpoint). This is the real guard;
  // routes/loads.js's POST /:loadId/accept catches the violation.
  loadIdUnique: uniqueIndex("bookings_load_id_unique").on(table.loadId),
}));

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
  // Phase 5C-1 — nullable so pre-existing rows and text-only posts stay valid.
  pickupName:       text("pickup_name"),
  pickupPlaceId:    text("pickup_place_id"),
  pickupLat:        real("pickup_lat"),
  pickupLng:        real("pickup_lng"),
  deliveryName:     text("delivery_name"),
  deliveryPlaceId:  text("delivery_place_id"),
  deliveryLat:      real("delivery_lat"),
  deliveryLng:      real("delivery_lng"),
  // Phase 5C-3 — the ONE canonical Google Routes result for this load. Computed
  // server-side from the exact coordinates, stored once, immutable afterwards
  // (trigger in migration 0005). distance_meters is an integer; null until a
  // real drivable-road route exists. An estimate is never stored here.
  distanceMeters:   integer("distance_meters"),
  routePolyline:    text("route_polyline"),
  routeDurationSec: integer("route_duration_sec"),
  distanceSource:   text("distance_source"), // "ROAD" or null
  status:      text("status").notNull(), // "Open" | "Booked" | "Cancelled"
  createdAt:   text("created_at").notNull(),
  updatedAt:   text("updated_at").notNull(),
}, (table) => ({
  shipperIdIdx: index("loads_shipper_id_idx").on(table.shipperId),
}));

/**
 * Phase 4K — Daraja M-Pesa + escrow. Five new tables, per
 * docs/4K-DARAJA-SPEC.md (Revision 3, approved) Section 2. Zero changes to
 * `trips`/`bookings` above — money entities reference them by id.
 *
 * checkoutRequestId/conversationId are nullable at the SCHEMA level even
 * though the spec's table doesn't say so explicitly: both are set only
 * after the synchronous Daraja response (Section 3 step 4 / Section 6 step
 * 5), so the row briefly exists without one. SQLite's default unique-index
 * behaviour treats multiple NULLs as non-conflicting, so this costs nothing
 * against the "idempotency key" invariant — the constraint still holds for
 * every row once its id IS set.
 */
export const payments = sqliteTable("payments", {
  id:                 text("id").primaryKey(),
  bookingId:          text("booking_id").notNull(),
  shipperId:          text("shipper_id").notNull(),
  amount:             real("amount").notNull(),
  phoneNumber:        text("phone_number").notNull(),
  status:             text("status").notNull(), // Pending|StkSent|Paid|Failed|Cancelled|Timeout
  merchantRequestId:  text("merchant_request_id"),
  checkoutRequestId:  text("checkout_request_id"),
  mpesaReceiptNumber: text("mpesa_receipt_number"),
  resultCode:         integer("result_code"),
  resultDesc:         text("result_desc"),
  purpose:            text("purpose").notNull().default("INITIAL"), // Phase 5D-1 — "INITIAL" now; "ADJUSTMENT" arrives in 5D-3
  createdAt:          text("created_at").notNull(),
  updatedAt:          text("updated_at").notNull(),
}, (table) => ({
  checkoutRequestIdUnique:  uniqueIndex("payments_checkout_request_id_unique").on(table.checkoutRequestId),
  mpesaReceiptNumberUnique: uniqueIndex("payments_mpesa_receipt_number_unique").on(table.mpesaReceiptNumber),
  // Phase 4M — same check-then-act race as bookings/trips above: two rapid
  // POST /bookings/:id/payment calls could otherwise both insert a
  // Pending row before either's non-terminal check sees the other. At most
  // one Pending/StkSent payment per booking at a time; bookings.js catches
  // the violation and returns 409.
  oneInflightPerBooking: uniqueIndex("payments_one_inflight_per_booking")
    .on(table.bookingId)
    .where(sql`${table.status} in ('Pending', 'StkSent')`),
}));

export const escrows = sqliteTable("escrows", {
  id:                  text("id").primaryKey(),
  bookingId:           text("booking_id").notNull(),
  paymentId:           text("payment_id"),
  amount:              real("amount"),
  status:              text("status").notNull(), // see domain/escrow.js
  heldAt:              text("held_at"),
  releasePendingAt:    text("release_pending_at"),
  releaseInProgressAt: text("release_in_progress_at"),
  settledAt:           text("settled_at"),
  createdAt:           text("created_at").notNull(),
  updatedAt:           text("updated_at").notNull(),
}, (table) => ({
  bookingIdUnique: uniqueIndex("escrows_booking_id_unique").on(table.bookingId),
}));

/**
 * One row per B2C payout ATTEMPT — unlimited attempts per escrow, but two
 * partial unique indexes make certain outcomes physically impossible rather
 * than merely application-checked (see 4K-DARAJA-SPEC.md Section 2's two
 * "Correction" notes):
 *   - one_confirmed: at most one row per escrow may ever reach Confirmed.
 *   - one_inflight:  at most one row per escrow may be Pending/Requested at
 *     once — this is what actually closes the genuinely-concurrent release
 *     race; the application's own check-then-insert cannot, by itself.
 */
export const payouts = sqliteTable("payouts", {
  id:                       text("id").primaryKey(),
  escrowId:                 text("escrow_id").notNull(), // deliberately NOT unique — see above
  transporterId:            text("transporter_id").notNull(),
  amount:                   real("amount").notNull(),
  phoneNumber:              text("phone_number").notNull(),
  status:                   text("status").notNull(), // Pending|Requested|Confirmed|Failed
  conversationId:           text("conversation_id"),
  originatorConversationId: text("originator_conversation_id"),
  transactionId:            text("transaction_id"),
  resultCode:               integer("result_code"),
  resultDesc:               text("result_desc"),
  createdAt:                text("created_at").notNull(),
  updatedAt:                text("updated_at").notNull(),
}, (table) => ({
  conversationIdUnique: uniqueIndex("payouts_conversation_id_unique").on(table.conversationId),
  transactionIdUnique:  uniqueIndex("payouts_transaction_id_unique").on(table.transactionId),
  oneConfirmedPerEscrow: uniqueIndex("payouts_one_confirmed_per_escrow")
    .on(table.escrowId)
    .where(sql`${table.status} = 'Confirmed'`),
  oneInflightPerEscrow: uniqueIndex("payouts_one_inflight_per_escrow")
    .on(table.escrowId)
    .where(sql`${table.status} in ('Pending', 'Requested')`),
}));

/** Append-only audit trail — never updated, never deleted. */
export const paymentEvents = sqliteTable("payment_events", {
  id:         text("id").primaryKey(),
  entityType: text("entity_type").notNull(), // "payment" | "escrow" | "payout"
  entityId:   text("entity_id").notNull(),
  eventType:  text("event_type").notNull(),
  fromStatus: text("from_status"),
  toStatus:   text("to_status"),
  payload:    text("payload"), // JSON, verbatim
  requestId:  text("request_id"), // Phase 4M — the app.js-assigned req.id that triggered this event, nullable (not every event has an inbound HTTP request behind it)
  createdAt:  text("created_at").notNull(),
});

/** Anything that doesn't cleanly match the ledger lands here instead of being silently accepted or dropped. */
export const reconciliationFlags = sqliteTable("reconciliation_flags", {
  id:                 text("id").primaryKey(),
  type:               text("type").notNull(),
  relatedEntityType:  text("related_entity_type"),
  relatedEntityId:    text("related_entity_id"),
  rawPayload:         text("raw_payload"),
  status:             text("status").notNull(), // "open" | "resolved"
  createdAt:          text("created_at").notNull(),
  resolvedAt:         text("resolved_at"),
});

/**
 * Phase 4L — in-app only (no SMS/email/push provider yet, deliberately: see
 * domain/notification.js's header). One row per recipient per event — a
 * "new load" notification going to five transporters is five rows, not one
 * row with five recipients, so each transporter's read state is independent.
 */
export const notifications = sqliteTable("notifications", {
  id:                text("id").primaryKey(),
  userId:            text("user_id").notNull(), // users.id — the recipient
  type:              text("type").notNull(),    // see domain/notification.js's NOTIFICATION_TYPE
  title:             text("title").notNull(),
  body:              text("body").notNull(),
  relatedEntityType: text("related_entity_type"), // "load" | "booking" | "payment" | "escrow" | "payout" | "trip"
  relatedEntityId:   text("related_entity_id"),
  read:              integer("read", { mode: "boolean" }).notNull().default(false),
  createdAt:         text("created_at").notNull(),
}, (table) => ({
  userIdIdx: index("notifications_user_id_idx").on(table.userId),
}));


/**
 * Phase 5D-1 — one row per offer in a negotiation thread (loadId,
 * transporterId). A counter never edits a row: it marks the parent COUNTERED
 * and inserts the next. Actor-neutral cap: a thread holds at most 5 rows
 * whichever party proposed them (CHECK + UNIQUE below make that physical).
 * See docs/5D-PRICING-SPEC.md Section 3.1 / 4.1.
 */
export const offers = sqliteTable("offers", {
  id:             text("id").primaryKey(),
  loadId:         text("load_id").notNull(),
  transporterId:  text("transporter_id").notNull(),
  round:          integer("round").notNull(),
  proposerRole:   text("proposer_role").notNull(), // "transporter" | "shipper"
  proposerId:     text("proposer_id").notNull(),
  amount:         real("amount").notNull(),
  note:           text("note"),
  status:         text("status").notNull(), // PENDING|COUNTERED|ACCEPTED|REJECTED|EXPIRED|WITHDRAWN
  closeReason:    text("close_reason"),
  expiresAt:      text("expires_at").notNull(),
  parentOfferId:  text("parent_offer_id"),
  idempotencyKey: text("idempotency_key"),
  createdAt:      text("created_at").notNull(),
  updatedAt:      text("updated_at").notNull(),
  resolvedAt:     text("resolved_at"),
}, (table) => ({
  roundRange:      check("offers_round_range", sql`${table.round} between 1 and 5`),
  threadRoundUnique: uniqueIndex("offers_thread_round_unique").on(table.loadId, table.transporterId, table.round),
  onePendingPerThread: uniqueIndex("offers_one_pending_per_thread")
    .on(table.loadId, table.transporterId)
    .where(sql`${table.status} = 'PENDING'`),
  oneAcceptedPerLoad: uniqueIndex("offers_one_accepted_per_load")
    .on(table.loadId)
    .where(sql`${table.status} = 'ACCEPTED'`),
  idempotencyUnique: uniqueIndex("offers_proposer_idempotency_unique")
    .on(table.proposerId, table.idempotencyKey)
    .where(sql`${table.idempotencyKey} is not null`),
  loadIdIdx:        index("offers_load_id_idx").on(table.loadId),
  transporterIdIdx: index("offers_transporter_id_idx").on(table.transporterId),
  statusExpiryIdx:  index("offers_status_expires_idx").on(table.status, table.expiresAt),
}));

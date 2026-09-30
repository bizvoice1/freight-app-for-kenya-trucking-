/**
 * src/data/reference.js
 * ----------------------
 * Static lookup / reference data used across multiple portals.
 * These are the "enum values" of the system — they change rarely and are
 * never computed; they're just agreed-upon lists.
 *
 * ARCHITECTURE NOTE:
 *   In production these come from GET /api/v1/reference (a single cached
 *   endpoint). Keeping them separate from domain data (loads, fleet) makes
 *   that future migration obvious — you delete this file and add one fetch.
 */

/** Pre-defined origin→destination corridors shown in the shipper PostModal. */
export const CORRIDORS = [
  "Mombasa → Nairobi",
  "Nairobi → Kisumu",
  "Eldoret → Nairobi",
  "Nairobi → Kampala",
  "Nairobi → Dar es Salaam",
  "Custom Route",
];

/** Cargo categories accepted on the platform. */
export const CARGO_TYPES = [
  "Bagged Grain",
  "FMCG Goods",
  "Steel & Metals",
  "Building Materials",
  "Fresh Produce",
  "Perishable Goods",
  "Loose Cargo",
  "Bulk",
  "Petroleum",
  "Container Cargo",
  "Other",
];

/** Truck / equipment types available for booking. */
export const TRUCK_TYPES = [
  "33-Tonne Flatbed",
  "Tipper",
  "Open Truck",
  "Box Truck",
  "Lowbed",
  "Reefer Van (Refrigerated)",
  "Tanker",
  "Semi-Trailer / Container",
  "Curtainsider",
  "Any Available",
];

/** Weight/volume unit options for cargo specification. */
export const CARGO_UNITS = [
  "Tonnes",
  "Cubic Metres",
  "Pallets",
  "Pieces",
];

/** Number-of-trucks options for a multi-truck load post. */
export const TRUCK_COUNT_OPTIONS = [
  "1","2","3","4","5","6","7","8","9","10","10+",
];

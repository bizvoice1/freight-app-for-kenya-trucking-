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
  "General Cargo",
  "FMCG",
  "Building Materials",
  "Steel",
  "Machinery",
  "Agricultural Produce",
  "Fresh Produce",
  "Flowers",
  "Furniture",
  "Electronics",
  "Chemicals",
  "Vehicle",
  "Other",
];

/** Truck / equipment types available for booking. */
export const TRUCK_TYPES = [
  "Pickup",
  "Canter",
  "3-Ton",
  "5-Ton",
  "7-Ton",
  "10-Ton",
  "15-Ton",
  "20-Ton",
  "25-Ton",
  "Trailer",
  "Flatbed",
  "Low Loader",
  "Car Carrier",
  "Tipper",
  "Tanker",
  "Refrigerated Truck",
  "Curtain-Sider",
  "Container Carrier",
];

/** Weight/volume/count unit options for cargo specification. */
export const CARGO_UNITS = [
  "Pieces",
  "Boxes",
  "Sacks",
  "KGs",
  "Tonnes",
  "Pallets",
  "Containers",
  "Vehicles",
  "Other",
];

/** Number-of-trucks options for a multi-truck load post. */
export const TRUCK_COUNT_OPTIONS = [
  "1","2","3","4","5","6","7","8","9","10","10+",
];

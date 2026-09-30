/**
 * src/data/fleet.js
 * -----------------
 * Mock seed data for a carrier's registered truck fleet.
 *
 * ARCHITECTURE NOTE:
 *   In production this comes from GET /api/v1/carriers/:id/fleet
 *   The shape here must match what that endpoint will return.
 *
 *   "Available" means the truck is idle and can be assigned to a new load.
 *   "On Trip"   means it is currently executing an active booking.
 */

export const CARRIER_FLEET_SEED = [
  {
    id:     "T1",
    plate:  "KDJ 441Z",
    type:   "33-Tonne Flatbed",
    year:   2019,
    status: "Available",
  },
  {
    id:     "T2",
    plate:  "KBD 092K",
    type:   "Box Truck",
    year:   2021,
    status: "Available",
  },
  {
    id:     "T3",
    plate:  "KCN 771M",
    type:   "Open Truck",
    year:   2018,
    status: "On Trip",
  },
];

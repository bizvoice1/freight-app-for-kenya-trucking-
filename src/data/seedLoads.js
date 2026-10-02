/**
 * src/data/seedLoads.js
 * ----------------------
 * The canonical demo-load dataset — ONE record per load ID, in the full
 * Load shape documented in models/load.js.
 *
 * WHY THIS FILE EXISTS:
 *   Before this file, the same handful of load IDs (KE-2038, KE-2039,
 *   KE-2041, KE-2044, KE-2045, …) were independently re-authored in four
 *   places — data/loads.js (twice), data/shipments.js, and an inline array
 *   in behari-admin-v2.jsx — with genuinely conflicting facts (different
 *   drivers, transposed cargo/route pairs, a payout amount off by ~2x).
 *   See the seed-data collision audit for the full comparison.
 *
 *   This file is the single resolved source of truth for those IDs. Each
 *   record below states which conflicting sources it reconciles and how.
 *
 * MIGRATION STATUS (see the phased plan):
 *   Phase 1 (this file) + Phase 2 (loadService._getLoad() + loadViews.js) are
 *   DONE. Phase 3 (swapping each portal's own hardcoded array to render from
 *   this file) and Phase 4 (deleting the old arrays) have NOT happened yet —
 *   MARKETPLACE_LOADS, MY_TRIPS_SEED, SHIPMENTS_SEED, SHIPMENT_HISTORY_SEED,
 *   and behari-admin-v2.jsx's inline LOADS are all still untouched and still
 *   what each portal actually renders. This file currently only powers
 *   loadService's internal lookups (_getLoad, getAllKnownLoads), so that any
 *   service action against one of these IDs — confirmDelivery, releaseEscrow,
 *   ratings, disputes — now finds a real, correctly-priced record instead of
 *   silently defaulting to 0.
 *
 * Deliberately EXCLUDED from this file (see collision audit):
 *   KE-2019, KE-2025, KE-2031, KE-2036 — referenced only by a single dispute
 *   or treasury demo line each, with no route/cargo/driver identity to draw
 *   on. Inventing one would be authoring new demo content, not reconciling
 *   existing data — left for a follow-up decision.
 */

export const SEED_LOADS = [
  /* ── KE-2037 — carrier history only, no cross-portal conflict ─────────── */
  {
    id:"KE-2037", cargo:"Bagged Sugar", description:"",
    weight:"—", from:"Kisumu", to:"Nairobi", dist:340, rateKm:112,
    truck:"33-Tonne Flatbed", truckCount:1, trucksRemaining:0,
    pickD:"May 9", pickT:"—", delD:"May 9", delT:"—",
    pay:38000, penalty:0, shipper:"—", phone:"", rating:4.6, facilRating:4.4, urgent:false,
    status:"Delivered", progress:100, driver:"James Mwangi", plate:"KDJ 441Z", truckType:"33-Tonne Flatbed",
    eta:"Delivered May 9", ping:"Delivered ✓", date:"May 9",
  },

  /* ── KE-2038 — RESOLVED: cargo (Steel Coils, not "FMCG goods" per the
     incident text) and pay (68,500, not 145,000 per the audit log). ─────── */
  {
    id:"KE-2038", cargo:"Steel Coils", description:"",
    weight:"22T", from:"Mombasa Port", to:"Nairobi ICD", dist:485, rateKm:141,
    truck:"Lowbed", truckCount:1, trucksRemaining:0,
    pickD:"May 12", pickT:"—", delD:"May 12", delT:"—",
    pay:68500, penalty:0, shipper:"Bamburi Cement", phone:"", rating:4.9, facilRating:4.6, urgent:false,
    status:"Paid Out", progress:100, driver:"Samuel Kamau", plate:"KDA 114W", truckType:"Lowbed",
    eta:"Delivered May 12", ping:"Delivered ✓", date:"May 12",
  },

  /* ── KE-2039 — no real conflict; SHIPMENTS_SEED's version was already a
     strict superset of MY_TRIPS_SEED's. ─────────────────────────────────── */
  {
    id:"KE-2039", cargo:"FMCG Goods", description:"",
    weight:"18T", from:"Nairobi EPZ", to:"Kampala", dist:680, rateKm:140,
    truck:"Box Truck", truckCount:1, trucksRemaining:0,
    pickD:"May 15", pickT:"—", delD:"May 15", delT:"—",
    pay:95000, penalty:0, shipper:"Bamburi Cement", phone:"", rating:4.8, facilRating:4.5, urgent:false,
    status:"In Transit", progress:62, driver:"James Mwangi", plate:"KDJ 441Z", truckType:"Box Truck",
    eta:"Today, 8:30 PM", ping:"Nakuru Bypass", date:"May 15",
  },

  /* ── KE-2041 — RESOLVED: driver is James Mwangi / KDJ 441Z (2-1 consensus
     across admin + the M-Pesa viewer's hardcoded constant, overriding
     SHIPMENTS_SEED's "Peter Otieno"); status resolved to In Transit
     (the load is mid-lifecycle in the demo narrative, not still bookable —
     MARKETPLACE_LOADS's "still available" listing for this same ID is a
     pre-existing narrative inconsistency this file does not paper over;
     that's a Phase 3 concern once the marketplace stops being its own
     independent array). ────────────────────────────────────────────────── */
  {
    id:"KE-2041", cargo:"Bagged Maize", description:"",
    weight:"28T", from:"Eldoret", to:"Nairobi", dist:312, rateKm:135,
    truck:"33-Tonne Flatbed", truckCount:1, trucksRemaining:0,
    pickD:"May 16", pickT:"8:00 AM", delD:"May 16", delT:"4:30 PM",
    pay:42000, penalty:0, shipper:"Unga Group Ltd", phone:"", rating:4.8, facilRating:4.2, urgent:true,
    status:"In Transit", progress:55, driver:"James Mwangi", plate:"KDJ 441Z", truckType:"33-Tonne Flatbed",
    eta:"Today, 4:30 PM", ping:"Nakuru Bypass", date:"May 16",
  },

  /* ── KE-2042 — RESOLVED (found during Phase 3C testing): admin's original
     inline LOADS array had status "Escrow Held" (by the Load model's own
     definition: "posted; payment locked; no carrier yet") while ALSO
     assigning driver "Samuel Kamau" — a genuine pre-existing contradiction
     that had no visible consequence until Find Loads started trusting the
     canonical record's bookability. A truly unbooked load has no driver/
     plate yet and 1 truck still remaining, matching the pattern already used
     for KE-2046/2047/2048. Also fixes the shipper-name disagreement (Treasury's
     demo transaction said "Bamburi Cement", marketplace says "Steel & Tube" —
     kept marketplace's, since it's the more detailed original source). ──── */
  {
    id:"KE-2042", cargo:"Steel Coils", description:"",
    weight:"22T", from:"Mombasa Port", to:"Nairobi ICD", dist:485, rateKm:141,
    truck:"Lowbed", truckCount:1, trucksRemaining:1,
    pickD:"May 24", pickT:"6:00 AM", delD:"May 24", delT:"8:00 PM",
    pay:68500, penalty:0, shipper:"Steel & Tube", phone:"", rating:4.9, facilRating:4.6, urgent:false,
    status:"Escrow Held", progress:5, driver:null, plate:null, truckType:"Lowbed",
    eta:"TBD", ping:"Awaiting transporter", date:"May 16",
  },

  /* ── KE-2043 — clean, complementary fields only. ───────────────────────── */
  {
    id:"KE-2043", cargo:"Fresh Flowers", description:"",
    weight:"4T", from:"Naivasha", to:"JKIA Cargo", dist:94, rateKm:191,
    truck:"Reefer Van", truckCount:1, trucksRemaining:0,
    pickD:"May 23", pickT:"11:00 PM", delD:"May 24", delT:"3:00 AM",
    pay:18000, penalty:0, shipper:"Oserian Farm", phone:"", rating:4.7, facilRating:4.4, urgent:true,
    status:"Delivered", progress:100, driver:"Grace Wanjiku", plate:"KCJ 889P", truckType:"Reefer Van",
    eta:"Delivered May 15", ping:"Delivered ✓", date:"May 15",
  },

  /* ── KE-2044 — RESOLVED: admin's inline LOADS array had 2044 and 2045
     transposed relative to MARKETPLACE_LOADS. This keeps marketplace's
     cargo/route mapping for 2044 (Building Mats) and re-attaches the status
     admin had filed under the wrong number. ─────────────────────────────── */
  {
    id:"KE-2044", cargo:"Building Mats", description:"",
    weight:"30T", from:"Athi River", to:"Kisumu", dist:398, rateKm:138,
    truck:"Open Truck", truckCount:1, trucksRemaining:0,
    pickD:"May 25", pickT:"7:00 AM", delD:"May 25", delT:"5:00 PM",
    pay:55000, penalty:0, shipper:"Bamburi Cement", phone:"", rating:4.6, facilRating:3.9, urgent:false,
    status:"Cancelled", progress:0, driver:"David Mutua", plate:"KBR 774F", truckType:"Open Truck",
    eta:"—", ping:"Shipment cancelled", date:"May 13",
  },

  /* ── KE-2045 — RESOLVED: the other half of the 2044/2045 transposition;
     marketplace's cargo/route mapping kept, admin's status re-attached. ─── */
  {
    id:"KE-2045", cargo:"FMCG Goods", description:"",
    weight:"18T", from:"Nairobi EPZ", to:"Kampala, UG", dist:680, rateKm:140,
    truck:"Box Truck", truckCount:1, trucksRemaining:0,
    pickD:"May 26", pickT:"5:00 AM", delD:"May 27", delT:"2:00 PM",
    pay:95000, penalty:0, shipper:"Unilever Kenya", phone:"", rating:5.0, facilRating:4.8, urgent:false,
    status:"Paid Out", progress:100, driver:"Peter Otieno", plate:"KBZ 228T", truckType:"Box Truck",
    eta:"Delivered May 14", ping:"Delivered ✓", date:"May 14",
  },

  /* ── KE-2046 / 2047 / 2048 — marketplace-only, no conflict; carried over
     verbatim so the canonical set is complete. ──────────────────────────── */
  {
    id:"KE-2046", cargo:"Quarry Ballast", description:"",
    weight:"30T", from:"Mlolongo", to:"Thika Road Site", dist:48, rateKm:458,
    truck:"Tipper", truckCount:1, trucksRemaining:1,
    pickD:"May 23", pickT:"7:00 AM", delD:"May 23", delT:"10:00 AM",
    pay:22000, penalty:0, shipper:"China Wu Yi", phone:"", rating:4.5, facilRating:4.0, urgent:true,
    status:"Escrow Held", progress:0, driver:null, plate:null, truckType:"Tipper",
    eta:"TBD", ping:"Awaiting transporter", date:"May 23",
  },
  {
    id:"KE-2047", cargo:"Red Murram", description:"",
    weight:"28T", from:"Athi River", to:"Karen, Nairobi", dist:35, rateKm:514,
    truck:"Tipper", truckCount:1, trucksRemaining:1,
    pickD:"May 24", pickT:"6:00 AM", delD:"May 24", delT:"8:30 AM",
    pay:18000, penalty:0, shipper:"Mombasa Cement", phone:"", rating:4.3, facilRating:3.8, urgent:false,
    status:"Escrow Held", progress:0, driver:null, plate:null, truckType:"Tipper",
    eta:"TBD", ping:"Awaiting transporter", date:"May 24",
  },
  {
    id:"KE-2048", cargo:"Sand & Hardcore", description:"",
    weight:"25T", from:"Machakos", to:"Syokimau", dist:62, rateKm:403,
    truck:"Tipper", truckCount:1, trucksRemaining:1,
    pickD:"May 25", pickT:"5:30 AM", delD:"May 25", delT:"9:00 AM",
    pay:25000, penalty:0, shipper:"KenGen Ltd", phone:"", rating:4.7, facilRating:4.1, urgent:false,
    status:"Escrow Held", progress:0, driver:null, plate:null, truckType:"Tipper",
    eta:"TBD", ping:"Awaiting transporter", date:"May 25",
  },

  /* ── KE-2030 / 2021 / 2015 — shipper history only; no driver/shipper
     detail existed anywhere, so those fields are left generic. ──────────── */
  {
    id:"KE-2030", cargo:"Bagged Cement", description:"",
    weight:"—", from:"Athi River", to:"Kisumu", dist:398, rateKm:138,
    truck:"Open Truck", truckCount:1, trucksRemaining:0,
    pickD:"Apr 28", pickT:"—", delD:"Apr 28", delT:"—",
    pay:55000, penalty:0, shipper:"Bamburi Cement", phone:"", rating:4.6, facilRating:3.9, urgent:false,
    status:"Paid Out", progress:100, driver:null, plate:null, truckType:"Open Truck",
    eta:"Delivered Apr 28", ping:"Delivered ✓", date:"Apr 28",
    rated:true, // field only SHIPMENT_HISTORY_SEED had — added here per Phase 3B
  },
  {
    id:"KE-2021", cargo:"FMCG Pallets", description:"",
    weight:"—", from:"Nairobi", to:"Kampala", dist:680, rateKm:140,
    truck:"Box Truck", truckCount:1, trucksRemaining:0,
    pickD:"Apr 12", pickT:"—", delD:"Apr 12", delT:"—",
    pay:95000, penalty:0, shipper:"Bamburi Cement", phone:"", rating:4.8, facilRating:4.5, urgent:false,
    status:"Paid Out", progress:100, driver:null, plate:null, truckType:"Box Truck",
    eta:"Delivered Apr 12", ping:"Delivered ✓", date:"Apr 12",
    rated:true,
  },
  {
    id:"KE-2015", cargo:"Steel Coils", description:"",
    weight:"22T", from:"Mombasa", to:"Nairobi", dist:485, rateKm:141,
    truck:"Lowbed", truckCount:1, trucksRemaining:0,
    pickD:"Mar 30", pickT:"—", delD:"Mar 30", delT:"—",
    pay:68500, penalty:0, shipper:"Bamburi Cement", phone:"", rating:4.9, facilRating:4.6, urgent:false,
    status:"Paid Out", progress:100, driver:null, plate:null, truckType:"Lowbed",
    eta:"Delivered Mar 30", ping:"Delivered ✓", date:"Mar 30",
    rated:false,
  },
];

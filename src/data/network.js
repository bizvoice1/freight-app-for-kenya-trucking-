/**
 * src/data/network.js
 * --------------------
 * Demo seed data for the Truck ↔ Cargo Matching Engine.
 *
 * ARCHITECTURE NOTE: purely additive "mock database" data, same contract as
 * data/loads.js — raw arrays, nothing computed. Deliberately constructed to
 * demonstrate every matching scenario the product needs to show:
 *   1. Exact match       — TA-SEED-1 (Nakuru→Nairobi) vs KE-3001
 *   2. Along-route match — TA-SEED-2 (Eldoret→Nairobi) vs KE-3002 (Eldoret→Nakuru)
 *   3. Small-detour match— TA-SEED-3 (Nairobi→Kisumu)  vs KE-3003 (Athi River→Kisumu)
 *   4. Partial-load match— TA-SEED-4 (Eldoret→Nairobi, 10T) vs KE-3004 (18T, partial ok)
 *   5. Unmatched truck   — TA-SEED-5 (Kisumu Tanker, tight radius, nothing nearby)
 *   6. Unmatched cargo   — KE-3005 (needs a Tanker in Malaba — none declared there)
 *   7. Future availability (Flow C) — TA-SEED-6 (Eldoret, available tomorrow)
 *
 * Existing data/loads.js, data/shipments.js, data/fleet.js, data/reference.js
 * are untouched — this file is additive only.
 */

function tomorrowAt(hour) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function todayAt(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** Declared truck availability records — the "empty return" supply side. */
export const DEMO_TRUCK_AVAILABILITY = [
  {
    id: "TA-SEED-1",
    carrierId: "C-NKR-006", carrierName: "Faith Wanjiku Njoroge",
    plate: "KCG 556T", truckType: "22-Tonne Flatbed", capacity: "22T",
    currentLocation: { name: "Nakuru", lat: -0.3031, lng: 36.0800 },
    currentTripFrom: "Nairobi", currentTripTo: "Nakuru",
    availableFrom: todayAt(16), goingToward: "Nairobi",
    acceptsPartial: false, maxDetourKm: 25, acceptedCargoTypes: [],
    status: "Active", createdAt: todayAt(9),
  },
  {
    id: "TA-SEED-2",
    carrierId: "C-ELD-004", carrierName: "Peter Rotich Sang",
    plate: "KDD 321M", truckType: "22-Tonne Curtainsider", capacity: "22T",
    currentLocation: { name: "Eldoret", lat: 0.5143, lng: 35.2698 },
    currentTripFrom: "Kampala", currentTripTo: "Eldoret",
    availableFrom: todayAt(15), goingToward: "Nairobi",
    acceptsPartial: true, maxDetourKm: 30, acceptedCargoTypes: [],
    status: "Active", createdAt: todayAt(8),
  },
  {
    id: "TA-SEED-3",
    carrierId: "C-NBI-005", carrierName: "David Mwenda Gitau",
    plate: "KCA 007X", truckType: "15-Tonne Box Truck", capacity: "15T",
    currentLocation: { name: "Nairobi", lat: -1.2921, lng: 36.8219 },
    currentTripFrom: "Mombasa", currentTripTo: "Nairobi",
    availableFrom: todayAt(14), goingToward: "Kisumu",
    acceptsPartial: false, maxDetourKm: 30, acceptedCargoTypes: [],
    status: "Active", createdAt: todayAt(7),
  },
  {
    id: "TA-SEED-4",
    carrierId: "C-ELD-004b", carrierName: "Samuel Kipruto",
    plate: "KCB 445Z", truckType: "10-Tonne Flatbed", capacity: "10T",
    currentLocation: { name: "Eldoret", lat: 0.5143, lng: 35.2698 },
    currentTripFrom: "Nairobi", currentTripTo: "Eldoret",
    availableFrom: todayAt(17), goingToward: "Nairobi",
    acceptsPartial: true, maxDetourKm: 25, acceptedCargoTypes: [],
    status: "Active", createdAt: todayAt(9),
  },
  {
    id: "TA-SEED-5",
    carrierId: "C-KSM-003", carrierName: "Grace Atieno Oduya",
    plate: "KCJ 889P", truckType: "20-Tonne Tanker", capacity: "20T",
    currentLocation: { name: "Kisumu", lat: -0.0917, lng: 34.7680 },
    currentTripFrom: "Eldoret", currentTripTo: "Kisumu",
    availableFrom: todayAt(18), goingToward: "Eldoret",
    acceptsPartial: false, maxDetourKm: 8, acceptedCargoTypes: [],
    status: "Active", createdAt: todayAt(10),
  },
  {
    id: "TA-SEED-6",
    carrierId: "C-ELD-004", carrierName: "Peter Rotich Sang",
    plate: "KDD 321M", truckType: "22-Tonne Curtainsider", capacity: "22T",
    currentLocation: { name: "Eldoret", lat: 0.5143, lng: 35.2698 },
    currentTripFrom: "", currentTripTo: "",
    availableFrom: tomorrowAt(14), goingToward: "Nairobi",
    acceptsPartial: true, maxDetourKm: 30, acceptedCargoTypes: [],
    status: "Active", createdAt: todayAt(11),
    isFuture: true,
  },
];

/** Companion cargo demonstrating each matching scenario above. */
export const DEMO_MATCH_CARGO = [
  {
    id:"KE-3001", cargo:"Bagged Potatoes", from:"Nakuru", to:"Nairobi",
    dist:160, weight:"18T", truck:"22-Tonne Flatbed", pay:24000, rateKm:150,
    pickD:"Today", pickT:"5:00 PM", delD:"Today", delT:"8:30 PM",
    shipper:"Rift Valley Produce", rating:4.6, urgent:false, facilRating:4.1,
    partialLoadAllowed:false, status:"Escrow Held",
  },
  {
    id:"KE-3002", cargo:"Dairy Equipment", from:"Eldoret", to:"Nakuru",
    dist:150, weight:"9T", truck:"22-Tonne Curtainsider", pay:19500, rateKm:130,
    pickD:"Today", pickT:"6:00 PM", delD:"Today", delT:"9:00 PM",
    shipper:"Brookside Dairy", rating:4.7, urgent:false, facilRating:4.3,
    partialLoadAllowed:false, status:"Escrow Held",
  },
  {
    id:"KE-3003", cargo:"Bottled Water", from:"Athi River", to:"Kisumu",
    dist:400, weight:"12T", truck:"15-Tonne Box Truck", pay:52000, rateKm:130,
    pickD:"Today", pickT:"3:00 PM", delD:"Tomorrow", delT:"6:00 AM",
    shipper:"Mount Kenya Bottlers", rating:4.5, urgent:true, facilRating:4.0,
    partialLoadAllowed:false, status:"Escrow Held",
  },
  {
    id:"KE-3004", cargo:"Bagged Cement", from:"Eldoret", to:"Nairobi",
    dist:310, weight:"18T", truck:"10-Tonne Flatbed", pay:41000, rateKm:132,
    pickD:"Today", pickT:"6:00 PM", delD:"Today", delT:"11:00 PM",
    shipper:"North Rift Cement", rating:4.4, urgent:false, facilRating:3.9,
    partialLoadAllowed:true, status:"Escrow Held",
  },
  {
    id:"KE-3005", cargo:"Petroleum Products", from:"Malaba", to:"Kampala",
    dist:130, weight:"20T", truck:"Tanker", pay:28000, rateKm:215,
    pickD:"Today", pickT:"2:00 PM", delD:"Today", delT:"5:00 PM",
    shipper:"Total Energies KE", rating:4.8, urgent:true, facilRating:4.5,
    partialLoadAllowed:false, status:"Escrow Held",
  },
];

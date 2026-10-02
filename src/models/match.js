/**
 * src/models/match.js
 * --------------------
 * Domain model for the Behari Matching Engine — the core of the product.
 *
 * ARCHITECTURE NOTE (same contract as models/load.js):
 *   Pure JavaScript. Zero React imports, zero imports from data/ or services/.
 *   Everything here is a plain function that takes plain objects and returns
 *   plain objects, so it can run in Node, a test runner, or a future backend
 *   without changes.
 *
 * Two entities are introduced:
 *   TruckAvailability — a carrier declaring "my truck is free here, at this
 *     time, and I'm willing to go this way" (see createTruckAvailability()).
 *   Match — the result of scoring one TruckAvailability against one Cargo
 *     (an existing Load object — see models/load.js). See scoreMatch()/
 *     createMatch().
 *
 * The matching engine works in BOTH directions (truck→cargo and cargo→truck)
 * because both directions call the exact same scoreMatch() function — see
 * services/matchingService.js findMatchesForTruck()/findMatchesForCargo().
 */

/* ── Status enums ────────────────────────────────────────────────────────── */

export const TRUCK_AVAILABILITY_STATUS = {
  ACTIVE:    "Active",     // watching for matches
  MATCHED:   "Matched",    // accepted a match, booking created
  EXPIRED:   "Expired",    // availability window passed unused
  CANCELLED: "Cancelled",  // carrier withdrew it
};

export const MATCH_STATUS = {
  SUGGESTED: "Suggested",
  VIEWED:    "Viewed",
  INTERESTED:"Interested",
  REQUESTED: "Requested",
  ACCEPTED:  "Accepted",
  DECLINED:  "Declined",
  EXPIRED:   "Expired",
  BOOKED:    "Booked",
};

/* ── Geography — reused/consolidated town coordinates ───────────────────────
 * These coordinates already exist scattered across gpsService.ROUTES
 * waypoints and adminService.CORRIDORS waypoints. They're centralised here,
 * once, purely for matching lookups (distance + corridor-chain membership) —
 * not a new data source, just a shared reference for this layer.
 */
export const TOWN_COORDS = {
  "mombasa":     { lat:-4.0435, lng:39.6682 },
  "mariakani":   { lat:-3.8671, lng:39.4771 },
  "voi":         { lat:-3.3960, lng:38.5593 },
  "athi river":  { lat:-1.4537, lng:36.9775 },
  "machakos":    { lat:-1.5221, lng:37.2634 },
  "nairobi":     { lat:-1.2921, lng:36.8219 },
  "jkia":        { lat:-1.3192, lng:36.9275 },
  "thika":       { lat:-1.0333, lng:37.0693 },
  "mlolongo":    { lat:-1.3887, lng:36.9385 },
  "syokimau":    { lat:-1.3567, lng:36.9347 },
  "naivasha":    { lat:-0.7132, lng:36.4313 },
  "nakuru":      { lat:-0.3031, lng:36.0800 },
  "kericho":     { lat:-0.3664, lng:35.2836 },
  "kisumu":      { lat:-0.0917, lng:34.7680 },
  "eldoret":     { lat: 0.5143, lng:35.2698 },
  "malaba":      { lat: 0.6231, lng:34.2678 },
  "kampala":     { lat: 0.3476, lng:32.5825 },
};

/** Ordered trunk-road chains used to classify "along my route" matches. */
export const CORRIDOR_CHAINS = [
  ["mombasa", "athi river", "nairobi", "nakuru", "eldoret", "malaba", "kampala"],
  ["nairobi", "nakuru", "kericho", "kisumu"],
];

/**
 * Resolves a free-text location name (e.g. "Nairobi EPZ", "Mombasa Port")
 * to a canonical town key ("nairobi", "mombasa"), via substring matching —
 * same technique already used by lookupCorridor() in models/load.js.
 */
function resolveTownKey(name = "") {
  const nl = String(name).toLowerCase();
  // Prefer the longest matching key so "athi river" wins over a shorter
  // false-positive substring.
  let best = null;
  for (const key of Object.keys(TOWN_COORDS)) {
    if (nl.includes(key) && (!best || key.length > best.length)) best = key;
  }
  return best;
}

export function resolveTownCoord(name = "") {
  const key = resolveTownKey(name);
  return key ? TOWN_COORDS[key] : null;
}

function chainIndexOf(chain, name) {
  const key = resolveTownKey(name);
  if (!key) return null;
  const idx = chain.indexOf(key);
  return idx === -1 ? null : idx;
}

/** Haversine distance in km between two {lat,lng} points. */
export function distanceKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s1), Math.sqrt(1 - s1));
}

/* ── Route classification — the "along my route" core logic ────────────────
 *
 * NOT a real routing engine. It walks the two small hand-built trunk-road
 * chains above and checks whether the cargo's pickup→drop segment sits
 * inside the truck's declared origin→direction segment on the same chain
 * (same order of travel). This is enough to demonstrate:
 *   exact       — cargo segment === truck segment
 *   along_route — cargo segment is a sub-range of the truck's segment
 *   detour      — cargo pickup is within the truck's maxDetourKm of its
 *                 current location, but not on a shared chain
 *   none        — neither
 */
export function classifyRouteMatch(truck, cargo) {
  const originName = truck?.currentLocation?.name || truck?.currentTripTo || "";
  const towardName = truck?.goingToward || "";
  const cargoFrom   = cargo?.from || "";
  const cargoTo     = cargo?.to   || "";

  for (const chain of CORRIDOR_CHAINS) {
    const oi  = chainIndexOf(chain, originName);
    const ti  = chainIndexOf(chain, towardName);
    const cfi = chainIndexOf(chain, cargoFrom);
    const cti = chainIndexOf(chain, cargoTo);
    if (oi == null || ti == null || cfi == null || cti == null) continue;
    if (oi === ti) continue;

    const dir      = ti > oi ? 1 : -1;
    const cargoDir = cti > cfi ? 1 : -1;
    if (cargoDir !== dir) continue; // cargo runs the opposite way — not usable

    const lo = Math.min(oi, ti), hi = Math.max(oi, ti);
    const cflo = Math.min(cfi, cti), cfhi = Math.max(cfi, cti);
    if (cflo >= lo && cfhi <= hi) {
      const isExact = cfi === oi && cti === ti;
      return { type: isExact ? "exact" : "along_route", detourKm: 0, chain };
    }
  }

  // No shared chain — fall back to straight-line distance from the truck's
  // current position to the cargo's pickup point as a detour proxy.
  const cargoFromCoord = resolveTownCoord(cargoFrom);
  const detourKm = cargoFromCoord && truck?.currentLocation
    ? distanceKm(truck.currentLocation, cargoFromCoord)
    : null;

  const maxDetour = truck?.maxDetourKm ?? 40;
  if (detourKm != null && detourKm <= maxDetour) {
    return { type: "detour", detourKm, chain: null };
  }
  return { type: "none", detourKm, chain: null };
}

/* ── Sub-scores ──────────────────────────────────────────────────────────── */

function parseTonnage(str = "") {
  const m = String(str).match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/**
 * Cargo/truck-type compatibility — mirrors the intent of
 * adminService.js's truckCompatScore(), reimplemented locally here so this
 * model stays free of any service-layer import.
 */
export function cargoTruckCompatibility(cargoType = "", truckType = "") {
  const cl = cargoType.toLowerCase();
  const tl = truckType.toLowerCase();
  const needsCold = /flower|fresh|perishab|dairy|frozen|chilled/.test(cl);
  const needsTank = /fuel|petroleum|liquid|chemical|lpg|gas/.test(cl);
  const needsFlat = /steel|metal|coil|pipe|timber|lumber|building|cement|maize|grain/.test(cl);
  const isRefrig  = tl.includes("refrigerat") || tl.includes("reefer");
  const isTanker  = tl.includes("tanker");
  const isFlat    = tl.includes("flatbed") || tl.includes("curtain") || tl.includes("open");

  if (needsCold) return isRefrig
    ? { pts:15, ok:true,  reason:"✓ Refrigerated — required for perishables" }
    : { pts:0,  ok:false, reason:"⚠ Truck isn't refrigerated for this cargo" };
  if (needsTank) return isTanker
    ? { pts:15, ok:true,  reason:"✓ Tanker — required for liquid/hazmat cargo" }
    : { pts:0,  ok:false, reason:"⚠ Tanker required for this cargo type" };
  if (needsFlat) return isFlat
    ? { pts:15, ok:true,  reason:"✓ Correct truck type" }
    : { pts:5,  ok:true,  reason:null };
  return { pts:10, ok:true, reason:null };
}

function capacityCompatibility(truckCapacity, cargoWeight) {
  const cap = parseTonnage(truckCapacity);
  const w   = parseTonnage(cargoWeight);
  if (cap == null || w == null) return { pts:5, ok:true, reason:null };
  if (cap >= w) return { pts:10, ok:true, reason: w > 0 ? `✓ ${cap}T truck covers ${w}T load` : null };
  return { pts:2, ok:false, reason:`⚠ ${cap}T truck may be short for ${w}T load` };
}

function availabilityCompatibility(availableFromISO, cargo) {
  if (!availableFromISO) return { pts:5, ok:true };
  const availAt = new Date(availableFromISO).getTime();
  if (Number.isNaN(availAt)) return { pts:5, ok:true };
  // Demo cargo dates are free-text ("May 23", "TBD", "Today") — treat any
  // non-"TBD" pickup date as "now-ish" for scoring purposes, since this is
  // a prototype without a real shared calendar.
  const pickD = (cargo?.pickD || "").toLowerCase();
  if (!pickD || pickD === "tbd") return { pts:8, ok:true };
  const now = Date.now();
  // Available now or in the past relative to "today" → good window match.
  return availAt <= now + 1000 * 60 * 60 * 48
    ? { pts:10, ok:true }
    : { pts:4, ok:true };
}

function priceCompatibility(cargo) {
  const dist = Number(cargo?.dist) || 0;
  const pay  = Number(cargo?.pay)  || 0;
  if (!dist || !pay) return { pts:5, ok:true };
  const rateKm = pay / dist;
  if (rateKm >= 100) return { pts:10, ok:true };
  if (rateKm >= 60)  return { pts:6,  ok:true };
  return { pts:2, ok:false };
}

/**
 * Distance from the truck's current/declared location to the cargo's
 * pickup point.
 */
export function originDistanceKm(truck, cargo) {
  const truckPoint = truck?.currentLocation;
  const cargoPoint = resolveTownCoord(cargo?.from);
  return distanceKm(truckPoint, cargoPoint);
}

/* ── Core scoring function ──────────────────────────────────────────────── */

/**
 * Scores one TruckAvailability against one Cargo (Load) item.
 *
 * @returns {{
 *   matchScore:number, truckId:string, cargoId:string,
 *   originDistance:number|null, destinationCompatibility:boolean,
 *   routeCompatibility:"exact"|"along_route"|"detour"|"none",
 *   detourDistance:number, capacityCompatibility:boolean,
 *   availabilityCompatibility:boolean, priceCompatibility:boolean,
 *   reasons:string[]
 * }}
 *
 * The score is a product-facing heuristic for ranking + explaining matches —
 * not an objective guarantee of a good match.
 */
export function scoreMatch(truck, cargo) {
  const reasons = [];
  let score = 0;

  const route = classifyRouteMatch(truck, cargo);
  if (route.type === "exact") { score += 35; reasons.unshift("✓ Same destination"); }
  else if (route.type === "along_route") { score += 25; reasons.unshift("✓ Cargo lies along your declared route"); }
  else if (route.type === "detour") {
    const km = Math.round(route.detourKm || 0);
    if (km <= 15) { score += 15; reasons.push(`+${km} km detour — low route deviation`); }
    else { score += 5; reasons.push(`+${km} km detour`); }
  } else {
    reasons.push("⚠ Off your declared route");
  }

  const originKm = originDistanceKm(truck, cargo);
  if (originKm != null) {
    if (originKm <= 5)       { score += 15; reasons.push(`✓ ${originKm.toFixed(0)} km from pickup`); }
    else if (originKm <= 15) { score += 10; reasons.push(`${originKm.toFixed(0)} km from pickup`); }
    else if (originKm <= 30) { score += 5;  reasons.push(`${originKm.toFixed(0)} km from pickup`); }
    else                     { reasons.push(`${originKm.toFixed(0)} km from pickup — far`); }
  }

  const typeC = cargoTruckCompatibility(cargo?.cargo || cargo?.cargoType, truck?.truckType);
  score += typeC.pts;
  if (typeC.reason) reasons.push(typeC.reason);

  const capC = capacityCompatibility(truck?.capacity, cargo?.weight);
  score += capC.pts;
  if (capC.reason) reasons.push(capC.reason);

  const availC = availabilityCompatibility(truck?.availableFrom, cargo);
  score += availC.pts;
  if (availC.ok && availC.pts >= 8) reasons.push("✓ Truck available during pickup window");

  const priceC = priceCompatibility(cargo);
  score += priceC.pts;

  let partialPts = 0;
  if (cargo?.partialLoadAllowed && truck?.acceptsPartial) {
    partialPts = 5;
    reasons.push("✓ Both sides accept a partial load");
  }
  score += partialPts;

  const matchScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    matchScore,
    truckId: truck?.id,
    cargoId: cargo?.id,
    originDistance: originKm,
    destinationCompatibility: route.type === "exact",
    routeCompatibility: route.type,
    detourDistance: Math.round(route.detourKm || 0),
    capacityCompatibility: capC.ok,
    availabilityCompatibility: availC.ok,
    priceCompatibility: priceC.ok,
    reasons,
  };
}

/* ── Factories ───────────────────────────────────────────────────────────── */

let _taCounter = 0;
export function createTruckAvailability(formData = {}) {
  _taCounter += 1;
  return {
    id:            `TA-${Date.now().toString(36)}${_taCounter}`,
    carrierId:     formData.carrierId || "CARRIER-001",
    carrierName:   formData.carrierName || "James Mwangi",
    plate:         formData.plate || "",
    truckType:     formData.truckType || "Any Available",
    capacity:      formData.capacity || "",
    currentLocation: {
      name: formData.currentLocationName || "",
      ...(resolveTownCoord(formData.currentLocationName) || { lat:-1.2921, lng:36.8219 }),
    },
    currentTripFrom: formData.currentTripFrom || "",
    currentTripTo:   formData.currentTripTo   || "",
    availableFrom:   formData.availableFrom   || new Date().toISOString(),
    goingToward:     formData.goingToward     || "",
    acceptsPartial:  !!formData.acceptsPartial,
    maxDetourKm:     Number(formData.maxDetourKm) || 30,
    acceptedCargoTypes: formData.acceptedCargoTypes || [],
    status:          TRUCK_AVAILABILITY_STATUS.ACTIVE,
    createdAt:       new Date().toISOString(),
  };
}

let _matchCounter = 0;
export function createMatch(scoreResult, extra = {}) {
  _matchCounter += 1;
  return {
    id:        `MATCH-${Date.now().toString(36)}${_matchCounter}`,
    ...scoreResult,
    score:     scoreResult.matchScore,
    status:    MATCH_STATUS.SUGGESTED,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

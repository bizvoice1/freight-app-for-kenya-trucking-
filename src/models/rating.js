/**
 * src/models/rating.js
 * --------------------
 * Domain model for carrier ↔ shipper ratings.
 *
 * After a load reaches PAID_OUT:
 *   • Shipper rates the carrier on 4 dimensions
 *   • Carrier rates the shipper on 2 dimensions
 *
 * Ratings are stored in loadService._store.ratings
 * and exposed on carrier/shipper profile summaries.
 */

/* ── Dimension definitions ───────────────────────────────────────────────── */

export const CARRIER_RATING_DIMS = [
  { id:"timeliness",     label:"On-time delivery",   icon:"⏱",  desc:"Did the carrier meet pickup and delivery deadlines?" },
  { id:"communication",  label:"Communication",       icon:"💬",  desc:"Responsive and professional during the trip?" },
  { id:"cargoHandling",  label:"Cargo handling",      icon:"📦",  desc:"Were goods delivered in good condition?" },
  { id:"professionalism",label:"Professionalism",     icon:"⭐",  desc:"Overall conduct, documentation, and compliance?" },
];

export const SHIPPER_RATING_DIMS = [
  { id:"facilityAccess", label:"Facility access",    icon:"🚪",  desc:"Easy loading/unloading access at pickup and destination?" },
  { id:"communication",  label:"Communication",      icon:"💬",  desc:"Clear instructions and responsiveness during the job?" },
];

/* ── Factory functions ───────────────────────────────────────────────────── */

/**
 * Creates a rating record submitted by a shipper for a carrier.
 * @param {Object} params
 * @param {string} params.loadId
 * @param {string} params.raterRole      - "shipper" | "carrier"
 * @param {string} params.rateeId        - carrier or shipper identifier
 * @param {Object} params.scores         - { [dimensionId]: 1..5 }
 * @param {string} [params.comment]
 * @returns {Object} rating record
 */
export function createRatingRecord({ loadId, raterRole, rateeId, scores, comment = "" }) {
  const validScores = {};
  for (const [k, v] of Object.entries(scores)) {
    validScores[k] = Math.max(1, Math.min(5, Number(v) || 3));
  }
  const vals = Object.values(validScores);
  const avg  = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

  return {
    id:        `rating_${Date.now()}`,
    loadId,
    raterRole,
    rateeId,
    scores:    validScores,
    average:   Math.round(avg * 10) / 10,
    comment,
    createdAt: new Date().toLocaleDateString("en-KE", { day:"numeric", month:"short" }),
  };
}

/**
 * Computes aggregate rating stats for a carrier or shipper from their
 * full array of rating records.
 *
 * @param {Object[]} records - array of rating records
 * @returns {{ count, average, breakdown }}
 */
export function aggregateRatings(records = []) {
  if (!records.length) return { count: 0, average: 0, breakdown: {} };

  const breakdown = {};
  const totals    = {};
  const counts    = {};

  for (const r of records) {
    for (const [dim, score] of Object.entries(r.scores)) {
      totals[dim]  = (totals[dim]  || 0) + score;
      counts[dim]  = (counts[dim]  || 0) + 1;
    }
  }

  for (const dim of Object.keys(totals)) {
    breakdown[dim] = Math.round((totals[dim] / counts[dim]) * 10) / 10;
  }

  const grandTotal = records.reduce((s, r) => s + r.average, 0);

  return {
    count:     records.length,
    average:   Math.round((grandTotal / records.length) * 10) / 10,
    breakdown,
  };
}

/**
 * Returns star string (e.g. "★★★★☆") for a numeric rating.
 */
export function starsDisplay(rating, max = 5) {
  const full  = Math.round(rating);
  return "★".repeat(full) + "☆".repeat(Math.max(0, max - full));
}

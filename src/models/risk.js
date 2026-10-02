/**
 * src/models/risk.js
 * ------------------
 * AI Risk & Fraud Intelligence — domain model for carrier and shipper risk scoring.
 *
 * In production: replace the deterministic simulation below with a call to
 * a machine learning inference endpoint (e.g. Google Vertex AI, AWS SageMaker).
 * The factory function signatures remain identical — nothing else changes.
 *
 * Risk scores: 0–100 (higher = riskier)
 * Severity:    Low (< 35) | Medium (35–65) | High (> 65)
 */

/* ── Risk factor definitions ─────────────────────────────────────────────── */

export const CARRIER_RISK_FACTORS = {
  DISPUTE_FREQUENCY:   { weight:25, label:"Dispute frequency",      icon:"⚖",  desc:"Number of disputes in last 30 days" },
  GPS_ANOMALY:         { weight:20, label:"GPS inactivity/anomaly",  icon:"📍", desc:"Signal loss or route deviation detected" },
  PAYOUT_TIMING:       { weight:15, label:"Unusual payout timing",   icon:"💸", desc:"Payout requests at anomalous times" },
  DUPLICATE_ACCOUNT:   { weight:20, label:"Duplicate account risk",  icon:"👤", desc:"Multiple accounts sharing phone or ID" },
  ROUTE_INCONSISTENCY: { weight:10, label:"Route inconsistency",     icon:"🗺", desc:"GPS path deviates from booked corridor" },
  KYC_GAP:             { weight:10, label:"KYC verification gaps",   icon:"📋", desc:"Documents expired or unclear" },
};

export const SHIPPER_RISK_FACTORS = {
  ESCROW_ABUSE:       { weight:30, label:"Escrow abuse pattern",   icon:"🔒", desc:"Repeated escrow holds without valid cause" },
  CANCELLATION_TREND: { weight:25, label:"Cancellation frequency", icon:"🚫", desc:"High cancellation rate after transporter booking" },
  DISPUTE_INITIATION: { weight:25, label:"Dispute initiation",     icon:"⚖",  desc:"Disputes opened disproportionately" },
  PAYMENT_ANOMALY:    { weight:20, label:"Payment anomalies",      icon:"💸", desc:"Unusual payment timing or amounts" },
};

/* ── Deterministic seeding helper (stable risk for demo data) ────────────── */

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* ── Carrier risk factory ────────────────────────────────────────────────── */

/**
 * Builds a full AI risk profile for a carrier.
 *
 * @param {string} carrierId  - unique carrier identifier (name or ID)
 * @param {Object} history    - carrier's activity history
 * @param {number} history.disputes    - disputes filed against this carrier
 * @param {number} history.fraudFlags  - fraud flags raised
 * @param {number} history.trips       - total completed trips
 * @param {number} history.gpsAnomalies- detected GPS anomalies
 */
export function buildCarrierRiskProfile(carrierId, { disputes=0, fraudFlags=0, trips=0, gpsAnomalies=0 }) {
  const seed       = hashStr(carrierId);
  const base       = (seed % 25) + 5;                                   // 5–30 base noise
  const score      = Math.min(100, Math.round(
    base + (disputes * 18) + (fraudFlags * 28) + (gpsAnomalies * 12)
  ));
  const confidence = Math.min(97, 72 + (seed % 22));                    // 72–94 %

  const factors = [];
  if (disputes > 0)
    factors.push({ id:"DISPUTE_FREQUENCY",   score:Math.min(100,disputes*20),  description:`${disputes} dispute(s) in last 30 days` });
  if (gpsAnomalies > 0)
    factors.push({ id:"GPS_ANOMALY",         score:gpsAnomalies*25,           description:"GPS signal loss detected mid-route" });
  if (fraudFlags > 0)
    factors.push({ id:"DUPLICATE_ACCOUNT",   score:fraudFlags*32,             description:"Flagged by automated fraud detection" });
  if ((seed % 5) === 0)
    factors.push({ id:"PAYOUT_TIMING",       score:35,                        description:"Payout requests at unusual hours (01:00–04:00 EAT)" });
  if ((seed % 7) === 0)
    factors.push({ id:"ROUTE_INCONSISTENCY", score:28,                        description:"GPS path deviated >40km from booked corridor" });
  if ((seed % 11) === 0)
    factors.push({ id:"KYC_GAP",             score:22,                        description:"Driver's Licence CE expires within 30 days" });

  let severity, severityColor, severityBg;
  if (score >= 68)      { severity="High";   severityColor="#C0392B"; severityBg="#FDE8E3"; }
  else if (score >= 35) { severity="Medium"; severityColor="#E07B39"; severityBg="#FFF3E0"; }
  else                  { severity="Low";    severityColor="#06C167"; severityBg="#E6F9F0"; }

  const recommendations =
    severity === "High"
      ? ["Freeze payouts pending manual review","Request updated KYC documents","Flag account for investigation","Limit to 1 active load"]
      : severity === "Medium"
      ? ["Monitor for 7 days","Require photo proof on next delivery","Review GPS logs for last 3 trips"]
      : ["No immediate action required","Routine 30-day review"];

  return {
    entityId:        carrierId,
    entityType:      "carrier",
    riskScore:       score,
    severity,
    severityColor,
    severityBg,
    confidence,
    factors,
    trips,
    lastUpdated:     new Date().toLocaleDateString("en-KE",{day:"numeric",month:"short"}),
    recommendations,
  };
}

/* ── Shipper risk factory ────────────────────────────────────────────────── */

/**
 * Builds a full AI risk profile for a shipper.
 *
 * @param {string} shipperId  - shipper company name or ID
 * @param {Object} history
 * @param {number} history.disputes      - disputes raised by shipper
 * @param {number} history.cancellations - loads cancelled after carrier booking
 * @param {number} history.totalLoads    - total loads posted
 */
export function buildShipperRiskProfile(shipperId, { disputes=0, cancellations=0, totalLoads=1 }) {
  const seed  = hashStr(shipperId);
  const base  = (seed % 20) + 3;
  const ratio = totalLoads > 0 ? (disputes / totalLoads) : 0;
  const score = Math.min(100, Math.round(
    base + (disputes * 14) + (cancellations * 10) + (ratio > 0.3 ? 20 : 0)
  ));
  const confidence = Math.min(95, 68 + (seed % 25));

  const factors = [];
  if (disputes > 0)
    factors.push({ id:"DISPUTE_INITIATION",  score:disputes*18,  description:`${disputes} dispute(s) raised by shipper` });
  if (cancellations > 0)
    factors.push({ id:"CANCELLATION_TREND",  score:cancellations*15, description:`${cancellations} load(s) cancelled after booking` });
  if (ratio > 0.3)
    factors.push({ id:"ESCROW_ABUSE",        score:55, description:`Dispute/load ratio ${(ratio*100).toFixed(0)}% — above 30% threshold` });
  if ((seed % 6) === 0)
    factors.push({ id:"PAYMENT_ANOMALY",     score:30, description:"STK Push payments initiated outside business hours" });

  let severity, severityColor, severityBg;
  if (score >= 65)      { severity="High";   severityColor="#C0392B"; severityBg="#FDE8E3"; }
  else if (score >= 35) { severity="Medium"; severityColor="#E07B39"; severityBg="#FFF3E0"; }
  else                  { severity="Low";    severityColor="#06C167"; severityBg="#E6F9F0"; }

  const recommendations =
    severity === "High"
      ? ["Require advance payment verification","Limit active loads to 2","Manual approval for new load posts"]
      : severity === "Medium"
      ? ["Add payment confirmation step","Monitor cancellation pattern"]
      : ["Standard platform monitoring"];

  return {
    entityId:        shipperId,
    entityType:      "shipper",
    riskScore:       score,
    severity,
    severityColor,
    severityBg,
    confidence,
    factors,
    totalLoads,
    lastUpdated:     new Date().toLocaleDateString("en-KE",{day:"numeric",month:"short"}),
    recommendations,
  };
}

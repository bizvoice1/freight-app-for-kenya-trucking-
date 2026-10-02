/**
 * backend/src/domain/offer.js
 * -------------------------------
 * Phase 5D-1 — pure rules for negotiation offers (docs/5D-PRICING-SPEC.md
 * Sections 3.1, 4.1, 5.1, 5.5). No database, no Express. The transactional
 * enforcement lives in services/offers.js; the cap is also a schema fact
 * (CHECK + UNIQUE on offers).
 *
 * Actor-neutral five-offer rule: a thread (loadId, transporterId) holds at
 * most MAX_ROUNDS rows whichever party proposed them. `round` is just the
 * row's position. Nothing here assumes which role proposes which round.
 */

export const OFFER_STATUS = {
  PENDING:   "PENDING",
  COUNTERED: "COUNTERED",
  ACCEPTED:  "ACCEPTED",
  REJECTED:  "REJECTED",
  EXPIRED:   "EXPIRED",
  WITHDRAWN: "WITHDRAWN",
};

export const CLOSE_REASON = {
  SUPERSEDED_BY_COUNTER:    "SUPERSEDED_BY_COUNTER",
  COMPETING_OFFER_ACCEPTED: "COMPETING_OFFER_ACCEPTED",
  ACCEPTED_AT_POSTED_PRICE: "ACCEPTED_AT_POSTED_PRICE",
  LOAD_NOT_OPEN:            "LOAD_NOT_OPEN",
  EXPIRED:                  "EXPIRED",
  REJECTED_BY_COUNTERPARTY: "REJECTED_BY_COUNTERPARTY",
  WITHDRAWN_BY_PROPOSER:    "WITHDRAWN_BY_PROPOSER",
};

export const MAX_ROUNDS = 5;
export const MAX_AMOUNT = 100_000_000;
export const MAX_NOTE_LENGTH = 500;
export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 72;

const envNum = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const offerTtlHours = () => Math.min(MAX_TTL_HOURS, Math.max(MIN_TTL_HOURS, envNum("OFFER_TTL_HOURS", 24)));
export const offerBandMin  = () => envNum("OFFER_BAND_MIN", 0.2);
export const offerBandMax  = () => envNum("OFFER_BAND_MAX", 3);

export const generateOfferId = (existingCount) => `OFR-${1000 + existingCount}`;

/**
 * Money at the API boundary is a positive integer of KSh (I13). When the load
 * has a posted price the amount must also sit inside the sanity band.
 * @returns {{ok:true, amount:number} | {ok:false, status:number, code:string, error:string}}
 */
export function validateOfferAmount(raw, loadPrice) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0 || raw > MAX_AMOUNT) {
    return { ok: false, status: 400, code: "INVALID_AMOUNT", error: `amount must be a positive whole number of KSh, at most ${MAX_AMOUNT.toLocaleString("en-US")}.` };
  }
  if (typeof loadPrice === "number" && loadPrice > 0) {
    const min = loadPrice * offerBandMin();
    const max = loadPrice * offerBandMax();
    if (raw < min || raw > max) {
      return { ok: false, status: 422, code: "AMOUNT_OUT_OF_BAND", error: `amount must be between KSh ${Math.ceil(min).toLocaleString("en-US")} and KSh ${Math.floor(max).toLocaleString("en-US")} for this load.` };
    }
  }
  return { ok: true, amount: raw };
}

/** Optional free text: trimmed, bounded, stored verbatim, rendered as text only. */
export function validateNote(raw) {
  if (raw == null) return { ok: true, note: null };
  if (typeof raw !== "string") return { ok: false, status: 400, code: "INVALID_NOTE", error: "note must be a string." };
  const note = raw.trim();
  if (note.length > MAX_NOTE_LENGTH) return { ok: false, status: 400, code: "INVALID_NOTE", error: `note must be at most ${MAX_NOTE_LENGTH} characters.` };
  return { ok: true, note: note || null };
}

/**
 * Expiry = now + ttl, ttl defaulting to OFFER_TTL_HOURS and overridable within
 * 1–72h, never later than the load's pickupDate when that parses to a future
 * instant. A pickupDate already in the past is ignored for the cap (stale demo
 * data must not make every offer instantly dead).
 */
export function resolveExpiry(ttlHoursRaw, pickupDate, nowMs = Date.now()) {
  let ttl = offerTtlHours();
  if (ttlHoursRaw != null) {
    if (typeof ttlHoursRaw !== "number" || !Number.isFinite(ttlHoursRaw) || ttlHoursRaw < MIN_TTL_HOURS || ttlHoursRaw > MAX_TTL_HOURS) {
      return { ok: false, status: 400, code: "INVALID_TTL", error: `ttlHours must be a number between ${MIN_TTL_HOURS} and ${MAX_TTL_HOURS}.` };
    }
    ttl = ttlHoursRaw;
  }
  let expiresMs = nowMs + ttl * 3600 * 1000;
  const pickupMs = pickupDate ? Date.parse(pickupDate) : NaN;
  if (Number.isFinite(pickupMs) && pickupMs > nowMs && pickupMs < expiresMs) expiresMs = pickupMs;
  return { ok: true, expiresAt: new Date(expiresMs).toISOString() };
}

export const isOfferExpired = (offer, nowMs = Date.now()) => Date.parse(offer.expiresAt) <= nowMs;

/** Idempotency-Key header: optional, printable, bounded. */
export function parseIdempotencyKey(raw) {
  if (raw == null || raw === "") return { ok: true, key: null };
  if (typeof raw !== "string" || raw.length > 128 || !/^[\x21-\x7e]+$/.test(raw)) {
    return { ok: false, status: 400, code: "INVALID_IDEMPOTENCY_KEY", error: "Idempotency-Key must be 1–128 printable characters with no spaces." };
  }
  return { ok: true, key: raw };
}

/** @param {{loadId:string, transporterId:string, round:number, proposerRole:"transporter"|"shipper", proposerId:string, amount:number, note:string|null, expiresAt:string, parentOfferId?:string|null, idempotencyKey?:string|null}} d */
export function buildOffer(d, existingCount) {
  const now = new Date().toISOString();
  return {
    id:             generateOfferId(existingCount),
    loadId:         d.loadId,
    transporterId:  d.transporterId,
    round:          d.round,
    proposerRole:   d.proposerRole,
    proposerId:     d.proposerId,
    amount:         d.amount,
    note:           d.note,
    status:         OFFER_STATUS.PENDING,
    closeReason:    null,
    expiresAt:      d.expiresAt,
    parentOfferId:  d.parentOfferId ?? null,
    idempotencyKey: d.idempotencyKey ?? null,
    createdAt:      now,
    updatedAt:      now,
    resolvedAt:     null,
  };
}

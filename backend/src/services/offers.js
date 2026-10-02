/**
 * backend/src/services/offers.js
 * ----------------------------------
 * Phase 5D-1 — negotiation + agreement (docs/5D-PRICING-SPEC.md 4.1, 5.1, 5.2).
 *
 * Every state change is ONE synchronous better-sqlite3 transaction (no await
 * inside), so the read-check-write sequence cannot interleave with another
 * request; the unique indexes are the backstop, not the first line of defence.
 * Audit rows are written inside the transaction (logPaymentEventSync);
 * notifications go out after commit, and a notification failure never undoes
 * a committed agreement.
 *
 * Check order everywhere: existence (404) -> authorization (403) -> state
 * (409) -> amount (4xx/422). Out-of-scope ids are 403, never a hint that a
 * thread exists.
 */

import { and, eq, lte, asc } from "drizzle-orm";
import { db, isUniqueConstraintError } from "../db/client.js";
import { offers, loads, bookings } from "../db/schema.js";
import { LOAD_STATUS } from "../domain/load.js";
import { createBooking, AGREEMENT_SOURCE } from "../domain/booking.js";
import {
  OFFER_STATUS, CLOSE_REASON, MAX_ROUNDS, buildOffer, isOfferExpired,
  validateOfferAmount, validateNote, resolveExpiry, parseIdempotencyKey,
} from "../domain/offer.js";
import { NOTIFICATION_TYPE } from "../domain/notification.js";
import { notifyUsers } from "./notifications.js";
import { ensureLoadRoute, ROAD_DISTANCE_REQUIRED } from "./loadRoute.js";
import { logPaymentEventSync } from "./ledger.js";

export class OfferError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new OfferError(status, code, message); };

const ksh = (n) => `KSh ${Number(n).toLocaleString("en-US")}`;
const nowIso = () => new Date().toISOString();

const roleOf = (user) => (user.role === "fleet_owner" ? "transporter" : user.role === "shipper" ? "shipper" : null);

/** The party that may counter / accept / reject a PENDING offer. */
function isCounterparty(user, offer, load) {
  if (offer.proposerRole === "transporter") return user.role === "shipper" && load.shipperId === user.id;
  return user.role === "fleet_owner" && offer.transporterId === user.id;
}
const isProposer = (user, offer) => offer.proposerId === user.id;

/** Can this user see anything of this offer's thread at all? (shipper-owner or the thread's transporter) */
function isThreadParty(user, offer, load) {
  return (user.role === "shipper" && load.shipperId === user.id) || (user.role === "fleet_owner" && offer.transporterId === user.id);
}

const getOffer = (tx, id) => tx.select().from(offers).where(eq(offers.id, id)).get();
const getLoad = (tx, id) => tx.select().from(loads).where(eq(loads.id, id)).get();

function insertOffer(tx, data, requestId) {
  const count = tx.select().from(offers).all().length;
  const row = buildOffer(data, count);
  tx.insert(offers).values(row).run();
  logPaymentEventSync(tx, "offer", row.id, "offer_created", null, OFFER_STATUS.PENDING,
    { loadId: row.loadId, transporterId: row.transporterId, round: row.round, proposerRole: row.proposerRole, amount: row.amount, parentOfferId: row.parentOfferId, expiresAt: row.expiresAt }, requestId);
  return row;
}

function closeOffer(tx, offer, status, closeReason, eventType, requestId) {
  const now = nowIso();
  tx.update(offers).set({ status, closeReason, updatedAt: now, resolvedAt: now })
    .where(and(eq(offers.id, offer.id), eq(offers.status, OFFER_STATUS.PENDING))).run();
  logPaymentEventSync(tx, "offer", offer.id, eventType, OFFER_STATUS.PENDING, status, { closeReason, amount: offer.amount }, requestId);
}

/**
 * Shared by offer acceptance and posted-price acceptance: closes every other
 * PENDING offer on the load, snapshots the agreement onto a new booking, books
 * the load. agreedAmount is written once here and never again.
 */
function finalizeAgreement(tx, { load, transporterId, agreedAmount, source, agreedOfferId, otherPendingReason, requestId }) {
  const others = tx.select().from(offers)
    .where(and(eq(offers.loadId, load.id), eq(offers.status, OFFER_STATUS.PENDING))).all()
    .filter(o => o.id !== agreedOfferId);
  for (const o of others) closeOffer(tx, o, OFFER_STATUS.REJECTED, otherPendingReason, "offer_rejected", requestId);

  const count = tx.select().from(bookings).all().length;
  const booking = createBooking({ loadId: load.id, transporterId, agreedRoadDistanceMeters: load.distanceMeters, agreedAmount, agreementSource: source, agreedOfferId: agreedOfferId ?? null }, count);
  tx.insert(bookings).values(booking).run();
  tx.update(loads).set({ status: LOAD_STATUS.BOOKED, updatedAt: nowIso() }).where(eq(loads.id, load.id)).run();
  logPaymentEventSync(tx, "booking", booking.id, "booking_created", null, booking.status,
    { loadId: load.id, transporterId, agreedAmount, agreementSource: source, agreedOfferId: agreedOfferId ?? null }, requestId);
  return { booking, closedOffers: others };
}

async function sendNotifications(list) {
  for (const n of list) {
    try {
      await notifyUsers([n.userId], n.type, n.title, n.body, "offer", n.entityId);
    } catch (err) {
      console.error("offer notification failed:", err?.message);
    }
  }
}

/** Computes/persists the load's road route outside the (synchronous) transaction; the gate itself runs inside it. */
async function prepareRoute(loadId) {
  const [load] = await db.select().from(loads).where(eq(loads.id, loadId));
  if (load && load.status === LOAD_STATUS.OPEN) await ensureLoadRoute(load);
}

/** 5C-3 commercial gate: only a stored Google Routes distance may be committed to an agreement. */
function assertRoadDistance(load) {
  if (!(load.distanceSource === "ROAD" && load.distanceMeters > 0)) {
    fail(ROAD_DISTANCE_REQUIRED.status, ROAD_DISTANCE_REQUIRED.body.code, ROAD_DISTANCE_REQUIRED.body.error);
  }
}

function describeLoad(load) {
  return `${load.cargo}: ${load.origin} → ${load.destination}`;
}

/** POST /api/loads/:loadId/offers — a transporter opens a thread (round 1). */
export async function createOffer(user, loadId, body, idempotencyHeader, requestId) {
  if (user.role !== "fleet_owner") fail(403, "FORBIDDEN", "Only a transporter can open an offer thread.");
  const key = parseIdempotencyKey(idempotencyHeader);
  if (!key.ok) fail(key.status ?? 400, key.code, key.error);
  const note = validateNote(body?.note);
  if (!note.ok) fail(note.status, note.code, note.error);

  const out = db.transaction((tx) => {
    if (key.key) {
      const prior = tx.select().from(offers).where(and(eq(offers.proposerId, user.id), eq(offers.idempotencyKey, key.key))).get();
      if (prior) {
        if (prior.loadId !== loadId || prior.round !== 1) fail(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request.");
        return { replay: true, offer: prior, notifications: [] };
      }
    }
    const load = getLoad(tx, loadId);
    if (!load) fail(404, "LOAD_NOT_FOUND", `No load found with id ${loadId}.`);
    if (load.status !== LOAD_STATUS.OPEN) fail(409, "LOAD_NOT_OPEN", `Load ${load.id} is not open (status: ${load.status}).`);

    const existing = tx.select().from(offers).where(and(eq(offers.loadId, loadId), eq(offers.transporterId, user.id))).all();
    if (existing.length) fail(409, "THREAD_EXISTS", "You already have an offer thread on this load — counter the existing thread instead. A thread holds at most five offers and cannot be reopened.");

    const amount = validateOfferAmount(body?.amount, load.price);
    if (!amount.ok) fail(amount.status, amount.code, amount.error);
    const expiry = resolveExpiry(body?.ttlHours, load.pickupDate);
    if (!expiry.ok) fail(expiry.status, expiry.code, expiry.error);

    const offer = insertOffer(tx, {
      loadId, transporterId: user.id, round: 1, proposerRole: "transporter", proposerId: user.id,
      amount: amount.amount, note: note.note, expiresAt: expiry.expiresAt, idempotencyKey: key.key,
    }, requestId);
    return {
      replay: false, offer,
      notifications: [{ userId: load.shipperId, type: NOTIFICATION_TYPE.OFFER_RECEIVED, entityId: offer.id,
        title: "New offer received", body: `${user.name || "A transporter"} offered ${ksh(offer.amount)} for ${describeLoad(load)}` }],
    };
  });
  await sendNotifications(out.notifications);
  return { status: out.replay ? 200 : 201, replay: out.replay, offer: out.offer };
}

/** POST /api/offers/:id/counter — the non-proposer replies with a new row in the same thread. */
export async function counterOffer(user, offerId, body, idempotencyHeader, requestId) {
  const key = parseIdempotencyKey(idempotencyHeader);
  if (!key.ok) fail(key.status ?? 400, key.code, key.error);
  const note = validateNote(body?.note);
  if (!note.ok) fail(note.status, note.code, note.error);

  const out = db.transaction((tx) => {
    const parent = getOffer(tx, offerId);
    if (!parent) fail(404, "OFFER_NOT_FOUND", `No offer found with id ${offerId}.`);
    const load = getLoad(tx, parent.loadId);
    if (!load || !isCounterparty(user, parent, load)) fail(403, "FORBIDDEN", "You are not the party who may counter this offer.");

    if (key.key) {
      const prior = tx.select().from(offers).where(and(eq(offers.proposerId, user.id), eq(offers.idempotencyKey, key.key))).get();
      if (prior) {
        if (prior.parentOfferId !== parent.id) fail(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request.");
        return { replay: true, offer: prior, notifications: [] };
      }
    }

    if (parent.status !== OFFER_STATUS.PENDING) fail(409, "OFFER_NOT_PENDING", `Offer ${parent.id} is no longer pending (status: ${parent.status}).`);
    if (isOfferExpired(parent)) fail(409, "OFFER_EXPIRED", `Offer ${parent.id} has expired.`);
    if (load.status !== LOAD_STATUS.OPEN) fail(409, "LOAD_NOT_OPEN", `Load ${load.id} is not open (status: ${load.status}).`);

    const rows = tx.select().from(offers).where(and(eq(offers.loadId, parent.loadId), eq(offers.transporterId, parent.transporterId))).all();
    if (rows.length >= MAX_ROUNDS || parent.round >= MAX_ROUNDS) {
      fail(409, "FINAL_ROUND", "This is the final offer of the thread (five offers maximum). It can only be accepted, rejected or withdrawn.");
    }

    const amount = validateOfferAmount(body?.amount, load.price);
    if (!amount.ok) fail(amount.status, amount.code, amount.error);
    const expiry = resolveExpiry(body?.ttlHours, load.pickupDate);
    if (!expiry.ok) fail(expiry.status, expiry.code, expiry.error);

    closeOffer(tx, parent, OFFER_STATUS.COUNTERED, CLOSE_REASON.SUPERSEDED_BY_COUNTER, "offer_countered", requestId);
    const offer = insertOffer(tx, {
      loadId: parent.loadId, transporterId: parent.transporterId, round: rows.length + 1,
      proposerRole: roleOf(user), proposerId: user.id, amount: amount.amount, note: note.note,
      expiresAt: expiry.expiresAt, parentOfferId: parent.id, idempotencyKey: key.key,
    }, requestId);
    return {
      replay: false, offer,
      notifications: [{ userId: parent.proposerId, type: NOTIFICATION_TYPE.OFFER_COUNTERED, entityId: offer.id,
        title: "Counter-offer received", body: `${ksh(offer.amount)} proposed for ${describeLoad(load)}` +
          (offer.round >= MAX_ROUNDS ? " (final offer)" : "") }],
    };
  });
  await sendNotifications(out.notifications);
  return { status: out.replay ? 200 : 201, replay: out.replay, offer: out.offer };
}

/** POST /api/offers/:id/accept — the critical transaction (spec 5.2). */
export async function acceptOffer(user, offerId, requestId) {
  const [pre] = await db.select().from(offers).where(eq(offers.id, offerId));
  if (pre) await prepareRoute(pre.loadId);
  const out = db.transaction((tx) => {
    const offer = getOffer(tx, offerId);
    if (!offer) fail(404, "OFFER_NOT_FOUND", `No offer found with id ${offerId}.`);
    const load = getLoad(tx, offer.loadId);
    if (!load || !isCounterparty(user, offer, load)) fail(403, "FORBIDDEN", "You are not the party who may accept this offer.");
    if (offer.status !== OFFER_STATUS.PENDING) fail(409, "OFFER_NOT_PENDING", `Offer ${offer.id} is no longer pending (status: ${offer.status}).`);
    if (isOfferExpired(offer)) fail(409, "OFFER_EXPIRED", `Offer ${offer.id} has expired.`);
    if (load.status !== LOAD_STATUS.OPEN) fail(409, "LOAD_NO_LONGER_OPEN", `Load ${load.id} is no longer open (status: ${load.status}).`);
    assertRoadDistance(load);

    const now = nowIso();
    try {
      tx.update(offers).set({ status: OFFER_STATUS.ACCEPTED, closeReason: null, updatedAt: now, resolvedAt: now })
        .where(and(eq(offers.id, offer.id), eq(offers.status, OFFER_STATUS.PENDING))).run();
      logPaymentEventSync(tx, "offer", offer.id, "offer_accepted", OFFER_STATUS.PENDING, OFFER_STATUS.ACCEPTED, { amount: offer.amount, round: offer.round }, requestId);
      const { booking, closedOffers } = finalizeAgreement(tx, {
        load, transporterId: offer.transporterId, agreedAmount: offer.amount, source: AGREEMENT_SOURCE.OFFER,
        agreedOfferId: offer.id, otherPendingReason: CLOSE_REASON.COMPETING_OFFER_ACCEPTED, requestId,
      });
      const accepted = getOffer(tx, offer.id);
      const notifications = [
        { userId: offer.proposerId, type: NOTIFICATION_TYPE.OFFER_ACCEPTED, entityId: offer.id,
          title: "Offer accepted", body: `${ksh(offer.amount)} agreed for ${describeLoad(load)}` },
        ...closedOffers.map(o => ({ userId: o.proposerId, type: NOTIFICATION_TYPE.OFFER_REJECTED, entityId: o.id,
          title: "Offer closed", body: `Another offer was accepted for ${describeLoad(load)}` })),
      ];
      return { offer: accepted, booking, notifications };
    } catch (err) {
      if (err instanceof OfferError) throw err;
      if (isUniqueConstraintError(err)) fail(409, "LOAD_NO_LONGER_OPEN", `Load ${load.id} was just booked by another request.`);
      throw err;
    }
  });
  await sendNotifications(out.notifications);
  return { status: 201, offer: out.offer, booking: out.booking };
}

/** POST /api/offers/:id/reject — the non-proposer declines; the thread is dead. */
export async function rejectOffer(user, offerId, body, requestId) {
  const reason = validateNote(body?.reason);
  if (!reason.ok) fail(reason.status, reason.code, reason.error);
  const out = db.transaction((tx) => {
    const offer = getOffer(tx, offerId);
    if (!offer) fail(404, "OFFER_NOT_FOUND", `No offer found with id ${offerId}.`);
    const load = getLoad(tx, offer.loadId);
    if (!load || !isCounterparty(user, offer, load)) fail(403, "FORBIDDEN", "You are not the party who may reject this offer.");
    if (offer.status !== OFFER_STATUS.PENDING) fail(409, "OFFER_NOT_PENDING", `Offer ${offer.id} is no longer pending (status: ${offer.status}).`);
    if (isOfferExpired(offer)) fail(409, "OFFER_EXPIRED", `Offer ${offer.id} has expired.`);
    closeOffer(tx, offer, OFFER_STATUS.REJECTED, CLOSE_REASON.REJECTED_BY_COUNTERPARTY, "offer_rejected", requestId);
    return {
      offer: getOffer(tx, offer.id),
      notifications: [{ userId: offer.proposerId, type: NOTIFICATION_TYPE.OFFER_REJECTED, entityId: offer.id,
        title: "Offer rejected", body: `${ksh(offer.amount)} was declined for ${describeLoad(load)}` + (reason.note ? ` — "${reason.note}"` : "") }],
    };
  });
  await sendNotifications(out.notifications);
  return { status: 200, offer: out.offer };
}

/** POST /api/offers/:id/withdraw — only the proposer, only while PENDING. */
export async function withdrawOffer(user, offerId, requestId) {
  const out = db.transaction((tx) => {
    const offer = getOffer(tx, offerId);
    if (!offer) fail(404, "OFFER_NOT_FOUND", `No offer found with id ${offerId}.`);
    const load = getLoad(tx, offer.loadId);
    if (!load || !isThreadParty(user, offer, load) || !isProposer(user, offer)) fail(403, "FORBIDDEN", "Only the party who made this offer can withdraw it.");
    if (offer.status !== OFFER_STATUS.PENDING) fail(409, "OFFER_NOT_PENDING", `Offer ${offer.id} is no longer pending (status: ${offer.status}).`);
    closeOffer(tx, offer, OFFER_STATUS.WITHDRAWN, CLOSE_REASON.WITHDRAWN_BY_PROPOSER, "offer_withdrawn", requestId);
    return { offer: getOffer(tx, offer.id) };
  });
  return { status: 200, offer: out.offer };
}

/**
 * POST /api/loads/:loadId/accept — the posted-price path (spec 5.2). Same
 * transaction shape as an offer acceptance: agreedAmount = loads.price.
 */
export async function acceptLoadAtPostedPrice(user, loadId, requestId) {
  await prepareRoute(loadId);
  const out = db.transaction((tx) => {
    const load = getLoad(tx, loadId);
    if (!load) fail(404, "LOAD_NOT_FOUND", `No load found with id ${loadId}.`);
    if (load.status !== LOAD_STATUS.OPEN) fail(409, "LOAD_NOT_OPEN", `Load ${load.id} is not open (status: ${load.status}).`);
    if (typeof load.price !== "number" || !(load.price > 0)) {
      fail(409, "NO_POSTED_PRICE", `Load ${load.id} has no posted price — make an offer instead.`);
    }
    assertRoadDistance(load);
    try {
      const { booking, closedOffers } = finalizeAgreement(tx, {
        load, transporterId: user.id, agreedAmount: load.price, source: AGREEMENT_SOURCE.POSTED_PRICE,
        agreedOfferId: null, otherPendingReason: CLOSE_REASON.ACCEPTED_AT_POSTED_PRICE, requestId,
      });
      return {
        booking,
        notifications: closedOffers.map(o => ({ userId: o.proposerId, type: NOTIFICATION_TYPE.OFFER_REJECTED, entityId: o.id,
          title: "Offer closed", body: `${describeLoad(load)} was accepted at the posted price` })),
      };
    } catch (err) {
      if (isUniqueConstraintError(err)) fail(409, "LOAD_NO_LONGER_OPEN", `Load ${load.id} was just accepted by another transporter.`);
      throw err;
    }
  });
  await sendNotifications(out.notifications);
  return { status: 201, booking: out.booking };
}

/** Marks every PENDING offer whose expiresAt has passed as EXPIRED, with audit. Returns the number swept. */
export function expireDueOffers(nowMs = Date.now()) {
  const cutoff = new Date(nowMs).toISOString();
  return db.transaction((tx) => {
    const due = tx.select().from(offers)
      .where(and(eq(offers.status, OFFER_STATUS.PENDING), lte(offers.expiresAt, cutoff))).orderBy(asc(offers.expiresAt)).all();
    for (const o of due) closeOffer(tx, o, OFFER_STATUS.EXPIRED, CLOSE_REASON.EXPIRED, "offer_expired", null);
    return due.length;
  });
}

const decorate = (offer, user, nowMs = Date.now()) => {
  const expired = offer.status === OFFER_STATUS.PENDING && isOfferExpired(offer, nowMs);
  return {
    ...offer,
    effectiveStatus: expired ? OFFER_STATUS.EXPIRED : offer.status,
    isFinalRound: offer.round >= MAX_ROUNDS,
    mine: offer.proposerId === user.id,
    needsMyAction: offer.status === OFFER_STATUS.PENDING && !expired && offer.proposerId !== user.id,
  };
};

/** GET /api/loads/:loadId/offers — shipper: all threads on own load; transporter: own thread only; admin: all (read-only). */
export function listOffersForLoad(user, loadId) {
  const load = getLoad(db, loadId);
  if (!load) fail(404, "LOAD_NOT_FOUND", `No load found with id ${loadId}.`);
  let rows;
  if (user.role === "shipper") {
    if (load.shipperId !== user.id) fail(403, "FORBIDDEN", "This load does not belong to the authenticated shipper.");
    rows = db.select().from(offers).where(eq(offers.loadId, loadId)).orderBy(asc(offers.transporterId), asc(offers.round)).all();
  } else if (user.role === "fleet_owner") {
    rows = db.select().from(offers).where(and(eq(offers.loadId, loadId), eq(offers.transporterId, user.id))).orderBy(asc(offers.round)).all();
  } else if (user.role === "admin") {
    rows = db.select().from(offers).where(eq(offers.loadId, loadId)).orderBy(asc(offers.transporterId), asc(offers.round)).all();
  } else {
    fail(403, "FORBIDDEN", "This role has no access to offers.");
  }
  return rows.map(o => decorate(o, user));
}

/** GET /api/offers?role=proposer|counterparty&status= — the caller's inbox/outbox, scoped to their own threads. */
export function listOffersInbox(user, { role, status } = {}) {
  if (role != null && role !== "proposer" && role !== "counterparty") fail(400, "INVALID_FILTER", "role must be 'proposer' or 'counterparty'.");
  if (status != null && !Object.values(OFFER_STATUS).includes(status)) fail(400, "INVALID_FILTER", `status must be one of ${Object.values(OFFER_STATUS).join(", ")}.`);

  let rows;
  if (user.role === "fleet_owner") {
    rows = db.select().from(offers).where(eq(offers.transporterId, user.id)).all();
  } else if (user.role === "shipper") {
    const mine = db.select().from(loads).where(eq(loads.shipperId, user.id)).all().map(l => l.id);
    const set = new Set(mine);
    rows = db.select().from(offers).all().filter(o => set.has(o.loadId));
  } else {
    fail(403, "FORBIDDEN", "This role has no offer inbox.");
  }
  const nowMs = Date.now();
  rows = rows.map(o => decorate(o, user, nowMs));
  if (role === "proposer") rows = rows.filter(o => o.mine);
  if (role === "counterparty") rows = rows.filter(o => !o.mine);
  if (status) rows = rows.filter(o => o.effectiveStatus === status);
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id.localeCompare(a.id)));
  return rows;
}

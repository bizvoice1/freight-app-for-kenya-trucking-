/**
 * src/hooks/useCommerce.js
 * -------------------------
 * 5D-3 — React state over the backend's commercial records for ONE role
 * ("shipper" | "fleet_owner"): the authenticated identity, loads, offer
 * threads, bookings and offer/booking notifications. Polls; every mutation
 * re-fetches so the backend stays the only commercial authority.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getSession } from "../services/backendSession.js";
import * as api from "../services/commerceApi.js";
import { COMMERCIAL_NOTIFICATION_TYPES, groupOfferThreads } from "../models/backendLoad.js";

const POLL_MS = 6000;

export function useCommerce(role) {
  const [identity, setIdentity] = useState(null);
  const [loads, setLoads] = useState([]);          // transporter: Open marketplace; shipper: own loads
  const [offers, setOffers] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [bookedLoads, setBookedLoads] = useState({}); // loadId -> load view (for the booking's own party)
  const [finance, setFinance] = useState({});      // bookingId -> {ledger, adjustments} (backend ledger, never recomputed here)
  const [notifications, setNotifications] = useState([]);
  const [online, setOnline] = useState(true);
  const [ready, setReady] = useState(false);
  const [sessionError, setSessionError] = useState(null);
  const bookedRef = useRef({});

  const refresh = useCallback(async () => {
    try {
      const s = await getSession(role);
      setIdentity(s.user);
    } catch (e) { setIdentity(null); setSessionError(e.message); setOnline(false); setReady(true); return; }
    setSessionError(null);
    const loadsReq = role === "shipper" ? api.fetchShipperLoads() : api.fetchOpenLoads();
    const [l, o, b, n] = await Promise.all([loadsReq, api.fetchOffers(role), api.fetchBookings(role), api.fetchNotifications(role)]);
    if (!l.ok && l.status === 0) { setOnline(false); setReady(true); return; }
    setOnline(true);
    if (l.ok) setLoads(l.data);
    if (o.ok) setOffers(Array.isArray(o.data) ? o.data : (o.data?.offers ?? []));
    if (n.ok) setNotifications(n.data.filter(x => COMMERCIAL_NOTIFICATION_TYPES.has(x.type)));
    if (b.ok) {
      setBookings(b.data);
      const missing = b.data.filter(x => !bookedRef.current[x.loadId]);
      if (missing.length) {
        const views = await Promise.all(missing.map(x => api.fetchLoadAs(role, x.loadId)));
        views.forEach((v, i) => { if (v.ok) bookedRef.current[missing[i].loadId] = v.data; });
        setBookedLoads({ ...bookedRef.current });
      }
    }
    if (b.ok) {
      const funded = b.data.filter(x => x.payment?.escrowStatus === "Held");
      const fin = await Promise.all(funded.map(x => api.fetchBookingFinance(role, x.id)));
      const next = {};
      funded.forEach((x, i) => { if (fin[i].ok) next[x.id] = fin[i].data; });
      setFinance(next);
    }
    setReady(true);
  }, [role]);

  useEffect(() => {
    let alive = true;
    refresh();
    const t = setInterval(() => { if (alive && !document.hidden) refresh(); }, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [refresh]);

  const wrap = useCallback((fn) => async (...args) => {
    const r = await fn(...args);
    await refresh();
    return r;
  }, [refresh]);

  const markRead = useCallback(async (id) => {
    setNotifications(ns => ns.map(n => (n.id === id ? { ...n, read: true } : n)));
    await api.markNotificationRead(role, id);
  }, [role]);

  return {
    identity, loads, offers, bookings, bookedLoads, finance, notifications, online, ready, sessionError, refresh, markRead,
    threads: groupOfferThreads(offers),
    actions: {
      acceptPostedPrice: wrap(api.acceptPostedPrice),
      makeOffer: wrap(api.makeOffer),
      counter: wrap((id, amt, note) => api.counterOffer(role, id, amt, note)),
      accept: wrap((id) => api.acceptOffer(role, id)),
      reject: wrap((id, reason) => api.rejectOffer(role, id, reason)),
      withdraw: wrap((id) => api.withdrawOffer(role, id)),
      requestAdjustment: wrap(api.requestAdjustment),
      approveAdjustment: wrap(api.approveAdjustment),
      rejectAdjustment: wrap(api.rejectAdjustment),
      withdrawAdjustment: wrap(api.withdrawAdjustment),
      fundAdjustment: wrap(api.startAdjustmentPayment),
      fundBooking: wrap((bookingId, phone) => api.startBookingPayment(bookingId, phone)),
    },
  };
}

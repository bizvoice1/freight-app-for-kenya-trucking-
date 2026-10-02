import { useState, useEffect, useCallback } from "react";
// Phase 4E introduced this screen; Phase 4F gave it a real backend.
// Deliberately its own tiny app, not a tab inside the Carrier portal: the
// person holding this phone is the DRIVER, who may not be the fleet owner
// signed into the Carrier app at all (see src/models/fleetOwner.js). One
// job only: start/stop sharing this device's location for whichever trip
// is currently assigned to this driver.
//
// Phase 4H: the trip list below now comes from the real backend
// (trackingService.getMyTrips(), GET /api/trips?driverId=) instead of the
// frontend's localStorage tripService — trips created through the real
// Marketplace (Load -> Booking -> Trip) only ever exist on the backend, so
// this is no longer optional. Truck plate lookup still falls back to the
// frontend's fleetService for the Phase 4F/4G seed trip, which predates
// backend/api/trucks — see getTruckLabel below.
import { getTruckById } from "./src/services/fleetService.js";
import { ACTIVE_TRIP_STATUSES } from "./src/models/trip.js";
import GoogleMap from "./src/components/maps/GoogleMap.jsx";
import { hasMapsKey } from "./src/services/googleMaps.js";
import {
  loginDriver,
  getCurrentDriverUser,
  logoutDriver,
  getMyTrips,
  startDriverTracking,
  stopDriverTracking,
  getTrackingState,
} from "./src/services/trackingService.js";

const C = {
  bg:     "#0B0B0B",
  card:   "#151515",
  border: "#262626",
  white:  "#FFFFFF",
  muted:  "#8A8A8A",
  green:  "#06C167",
  greenBg:"rgba(6,193,103,0.12)",
  red:    "#E5484D",
  redBg:  "rgba(229,72,77,0.12)",
  amber:  "#E0A639",
};
const font = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";

function fmtCoord(value, posLabel, negLabel) {
  if (typeof value !== "number") return "—";
  const dir = value >= 0 ? posLabel : negLabel;
  return `${Math.abs(value).toFixed(4)}° ${dir}`;
}

function secondsAgo(isoTimestamp) {
  if (!isoTimestamp) return null;
  return Math.max(0, Math.round((Date.now() - new Date(isoTimestamp).getTime()) / 1000));
}

/**
 * This portal is deliberately its own self-contained app (see the file
 * header) and was never wired to App.jsx's own logout/portal-switch sheet —
 * which meant there was no way back to the main Behari site once you
 * landed here, not even from the login screen. `onExit` is App.jsx's
 * existing onLogout (resets the outer app's active portal, same mechanism
 * every other portal already uses) — only rendered when it's actually
 * passed in, so this component still works standalone if reused elsewhere.
 */
function ExitToMainSite({ onExit }) {
  if (!onExit) return null;
  return (
    <button onClick={onExit} style={{ background:"none", border:"none", color:C.muted, fontFamily:font, fontSize:13, fontWeight:700, cursor:"pointer", padding:0, marginBottom:20, display:"flex", alignItems:"center", gap:6 }}>
      ← Main site
    </button>
  );
}

/* ── Step 1: real backend login — phone + PIN, verified server-side ── */
function DriverLogin({ onLoggedIn, onExit }) {
  const [phone, setPhone]   = useState("");
  const [pin, setPin]       = useState("");
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState("");

  async function handleLogin(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const result = await loginDriver(phone.trim(), pin.trim());
    setBusy(false);
    if (result.ok) onLoggedIn(result.user);
    else setError(result.error || "Login failed.");
  }

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.white, fontFamily:font, padding:"32px 20px" }}>
      <ExitToMainSite onExit={onExit} />
      <div style={{ fontSize:13, fontWeight:800, letterSpacing:1.5, color:C.green, marginBottom:6 }}>BEHARI DRIVER</div>
      <div style={{ fontSize:20, fontWeight:700, marginBottom:24 }}>Sign in to track a trip</div>

      <form onSubmit={handleLogin}>
        <label style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:0.8, textTransform:"uppercase", display:"block", marginBottom:6 }}>Phone</label>
        <input
          value={phone} onChange={e => setPhone(e.target.value)} placeholder="0722100200" inputMode="tel"
          style={{ width:"100%", boxSizing:"border-box", background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 16px", color:C.white, fontFamily:font, fontSize:16, marginBottom:16 }}
        />
        <label style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:0.8, textTransform:"uppercase", display:"block", marginBottom:6 }}>PIN</label>
        <input
          value={pin} onChange={e => setPin(e.target.value)} placeholder="••••" type="password" inputMode="numeric"
          style={{ width:"100%", boxSizing:"border-box", background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 16px", color:C.white, fontFamily:font, fontSize:16, marginBottom:20, letterSpacing:4 }}
        />
        {error && <div style={{ background:C.redBg, color:C.red, fontSize:13, borderRadius:8, padding:"10px 12px", marginBottom:16 }}>{error}</div>}
        <button
          type="submit" disabled={busy}
          style={{ width:"100%", background:C.green, color:"#00220F", border:"none", borderRadius:12, padding:"16px", fontSize:16, fontWeight:800, fontFamily:font, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}
        >
          {busy ? "Signing in…" : "SIGN IN"}
        </button>
      </form>
    </div>
  );
}

/* ── Step 2: pick the active trip assigned to this driver ── */
function TripPicker({ driverId, onPick, onSwitchDriver, onExit }) {
  const [trips, setTrips] = useState(null);

  useEffect(() => {
    getMyTrips().then(all => {
      setTrips(all.filter(t => ACTIVE_TRIP_STATUSES.has(t.status)));
    });
  }, [driverId]);

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.white, fontFamily:font, padding:"32px 20px" }}>
      <ExitToMainSite onExit={onExit} />
      <div style={{ fontSize:13, fontWeight:800, letterSpacing:1.5, color:C.green, marginBottom:6 }}>BEHARI DRIVER</div>
      <div style={{ fontSize:20, fontWeight:700, marginBottom:24 }}>Your active trips</div>

      {trips === null && <div style={{ color:C.muted, fontSize:14 }}>Loading trips…</div>}
      {trips !== null && trips.length === 0 && (
        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:18, color:C.muted, fontSize:14 }}>
          No active trip is currently assigned to you.
        </div>
      )}
      {trips?.map(t => (
        <button
          key={t.id}
          onClick={() => onPick(t.id)}
          style={{
            display:"block", width:"100%", textAlign:"left", background:C.card,
            border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px",
            marginBottom:10, color:C.white, fontFamily:font, cursor:"pointer",
          }}
        >
          <div style={{ fontSize:12, color:C.muted, marginBottom:4 }}>Trip: {t.loadId}</div>
          <div style={{ fontSize:16, fontWeight:700 }}>{t.pickup} → {t.delivery}</div>
          <div style={{ fontSize:12, color:C.green, marginTop:4, fontWeight:700 }}>{t.status}</div>
        </button>
      ))}

      <button onClick={onSwitchDriver} style={{ marginTop:20, background:"transparent", border:"none", color:C.muted, fontFamily:font, fontSize:13, textDecoration:"underline", cursor:"pointer" }}>
        Not you? Switch driver
      </button>
    </div>
  );
}

/* ── Step 3: the tracker itself — Ready, then Tracking ── */
function TrackerScreen({ tripId, driverName, onSwitchTrip, onExit }) {
  const [trip, setTrip]   = useState(null);
  const [truck, setTruck] = useState(null);
  const [state, setState] = useState(getTrackingState(tripId));
  const [now, setNow]     = useState(Date.now()); // ticks the "updated Ns ago" label
  const [mapFailed, setMapFailed] = useState(false);

  useEffect(() => {
    getMyTrips().then(all => {
      const t = all.find(x => x.id === tripId) || null;
      setTrip(t);
      if (t?.truckId) getTruckById(t.truckId).then(setTruck);
    });
  }, [tripId]);

  // Poll tracking state — trackingService has no event emitter, this is
  // deliberately the simplest thing that works for a single-screen demo.
  useEffect(() => {
    const iv = setInterval(() => { setState(getTrackingState(tripId)); setNow(Date.now()); }, 1000);
    return () => clearInterval(iv);
  }, [tripId]);

  useEffect(() => () => stopDriverTracking(tripId), [tripId]); // stop on unmount

  const handleStart = useCallback(async () => {
    const result = await startDriverTracking(tripId);
    setState(getTrackingState(tripId));
    if (!result.started) {
      // eslint-disable-next-line no-alert
      alert(result.reason);
    }
  }, [tripId]);

  const handleStop = useCallback(() => {
    stopDriverTracking(tripId);
    setState(getTrackingState(tripId));
  }, [tripId]);

  if (!trip) {
    return <div style={{ minHeight:"100vh", background:C.bg, color:C.muted, fontFamily:font, padding:32 }}>Loading trip…</div>;
  }

  const isTracking = state.status === "tracking" || state.status === "requesting-permission";
  const loc  = state.lastUpdate;
  const ago  = secondsAgo(loc?.timestamp);

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.white, fontFamily:font, padding:"28px 20px 40px", display:"flex", flexDirection:"column" }}>
      <ExitToMainSite onExit={onExit} />
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:28 }}>
        <div style={{ width:9, height:9, borderRadius:"50%", background: isTracking ? C.green : C.muted, boxShadow: isTracking ? `0 0 10px ${C.green}` : "none" }} />
        <div style={{ fontSize:13, fontWeight:800, letterSpacing:1.2 }}>
          {isTracking ? "TRACKING" : state.status === "error" ? "ERROR" : "READY"}
        </div>
        <div style={{ marginLeft:"auto" }}>
          <button onClick={onSwitchTrip} style={{ background:"transparent", border:"none", color:C.muted, fontFamily:font, fontSize:12, textDecoration:"underline", cursor:"pointer" }}>
            Switch trip
          </button>
        </div>
      </div>

      {!isTracking && (
        <>
          <div style={{ fontSize:12, color:C.muted, marginBottom:4 }}>Trip: {trip.loadId}</div>
          <div style={{ fontSize:22, fontWeight:800, marginBottom:2 }}>{truck?.plate || "—"}</div>
          <div style={{ fontSize:14, color:C.muted, marginBottom:24 }}>{trip.pickup} → {trip.delivery}</div>

          <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 16px", marginBottom:24 }}>
            <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:1, marginBottom:6 }}>GPS</div>
            <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:15, fontWeight:700 }}>
              <span style={{ width:8, height:8, borderRadius:"50%", background: state.status==="error" ? C.red : C.amber }} />
              {state.status === "error" ? "Error" : "Ready"}
            </div>
            {state.error && <div style={{ color:C.red, fontSize:12, marginTop:8 }}>{state.error}</div>}
          </div>
        </>
      )}

      {isTracking && (
        <>
          <div style={{ fontSize:22, fontWeight:800, marginBottom:2 }}>{truck?.plate || "—"}</div>
          <div style={{ fontSize:14, color:C.muted, marginBottom:24 }}>{driverName}</div>

          <div style={{ fontSize:26, fontWeight:800, lineHeight:1.3, marginBottom:20 }}>
            {loc ? fmtCoord(loc.lat, "N", "S") : "Waiting for signal…"}
            {loc && <><br />{fmtCoord(loc.lng, "E", "W")}</>}
          </div>

          {loc && hasMapsKey() && !mapFailed && (
            <div style={{ borderRadius:12, overflow:"hidden", marginBottom:20, border:`1px solid ${C.border}` }}>
              <GoogleMap
                height={200}
                follow
                markers={[{ id:"me", lat:loc.lat, lng:loc.lng, label:"You", color:"#06C167" }]}
                onUnavailable={() => setMapFailed(true)}
              />
            </div>
          )}

          <div style={{ display:"flex", gap:10, marginBottom:24 }}>
            <div style={{ flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:0.5 }}>SPEED</div>
              <div style={{ fontSize:17, fontWeight:800, marginTop:4 }}>{loc ? `${Math.round(loc.speed)} km/h` : "—"}</div>
            </div>
            <div style={{ flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:0.5 }}>ACCURACY</div>
              <div style={{ fontSize:17, fontWeight:800, marginTop:4 }}>{loc?.accuracy != null ? `${Math.round(loc.accuracy)} m` : "—"}</div>
            </div>
          </div>

          <div style={{ fontSize:12, color:C.muted, marginBottom:24 }}>
            Updated {ago != null ? `${ago} sec ago` : "—"}
          </div>
          {state.error && (
            <div style={{ background:C.redBg, color:C.red, fontSize:12, borderRadius:8, padding:"10px 12px", marginBottom:16 }}>
              Last reading flagged: {state.error}
            </div>
          )}
        </>
      )}

      <div style={{ marginTop:"auto" }}>
        {!isTracking ? (
          <>
            <button
              onClick={handleStart}
              style={{ width:"100%", background:C.green, color:"#00220F", border:"none", borderRadius:12, padding:"18px", fontSize:16, fontWeight:800, fontFamily:font, cursor:"pointer" }}
            >
              START TRIP TRACKING
            </button>
            <div style={{ textAlign:"center", fontSize:12, color:C.muted, marginTop:12 }}>Location permission required</div>
          </>
        ) : (
          <button
            onClick={handleStop}
            style={{ width:"100%", background:"transparent", color:C.red, border:`1.5px solid ${C.red}`, borderRadius:12, padding:"18px", fontSize:16, fontWeight:800, fontFamily:font, cursor:"pointer" }}
          >
            STOP TRACKING
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Root ─────────────────────────────────────────────────── */
export default function BehariDriverTracker({ onLogout }) {
  const [user, setUser] = useState(() => getCurrentDriverUser());
  const [tripId, setTripId] = useState(null);

  function handleLoggedIn(loggedInUser) {
    setUser(loggedInUser);
    setTripId(null);
  }

  function switchDriver() {
    logoutDriver();
    setUser(null);
    setTripId(null);
  }

  if (!user)   return <DriverLogin onLoggedIn={handleLoggedIn} onExit={onLogout} />;
  if (!tripId) return <TripPicker driverId={user.driverId} onPick={setTripId} onSwitchDriver={switchDriver} onExit={onLogout} />;
  return <TrackerScreen tripId={tripId} driverName={user.name} onSwitchTrip={() => setTripId(null)} onExit={onLogout} />;
}

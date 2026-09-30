import { useState, useEffect, useCallback } from "react";
// Phase 4H — the real Load -> Booking -> Trip marketplace, backed entirely
// by backend/ (Phases 4F/4G's GPS backend, extended here with loads and
// bookings). Deliberately its own standalone surface, same precedent as
// behari-driver-tracker.jsx: this is new backend-connected capability, not
// a rewrite of the existing demo's escrow-simulated Post Cargo/Find Loads
// flows, which stay completely untouched.
import * as market from "./src/services/marketplaceService.js";
// Reusing Phase 4G's live-tracking infrastructure unchanged — once a
// Marketplace load has a real backend Trip, it's the exact same
// LocationUpdate stream the Shipper/Transporter/Admin portals already read.
import { useLiveTripByLoadId } from "./src/hooks/useLiveTrip.js";
import LiveTrackingPanel from "./src/components/tracking/LiveTrackingPanel.jsx";
import { getTruckById } from "./src/services/fleetService.js";

const C = {
  bg: "#0B0B0B", card: "#151515", border: "#262626", white: "#FFFFFF",
  muted: "#8A8A8A", green: "#06C167", greenBg: "rgba(6,193,103,0.12)",
  red: "#E5484D", redBg: "rgba(229,72,77,0.12)", amber: "#E0A639", blue: "#4C8DFF",
};
const font = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";

const inputStyle = {
  width: "100%", boxSizing: "border-box", background: C.card, border: `1px solid ${C.border}`,
  borderRadius: 10, padding: "12px 14px", color: C.white, fontFamily: font, fontSize: 14, marginBottom: 12,
};
const labelStyle = { fontSize: 11, color: C.muted, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", display: "block", marginBottom: 6 };
const btnPrimary = { background: C.green, color: "#00220F", border: "none", borderRadius: 10, padding: "12px 16px", fontSize: 14, fontWeight: 800, fontFamily: font, cursor: "pointer" };
const btnGhost = { background: "transparent", border: `1px solid ${C.border}`, color: C.white, borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 700, fontFamily: font, cursor: "pointer" };

/** Phase 4H step 12 — "Shipper tracks truck": expands into the same live panel Shipper/Admin/Transporter already use. */
function ShipperLoadRow({ load }) {
  const [expanded, setExpanded] = useState(false);
  const [plate, setPlate] = useState(null);
  const live = useLiveTripByLoadId(load.id);

  useEffect(() => {
    if (live.trip?.truckId) getTruckById(live.trip.truckId).then(t => setPlate(t?.plate || null));
  }, [live.trip?.truckId]);

  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 16px", marginBottom:8 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", cursor: live.trip ? "pointer" : "default" }}
           onClick={() => live.trip && setExpanded(v => !v)}>
        <div>
          <div style={{ fontSize:11, color:C.muted, marginBottom:2 }}>{load.id}</div>
          <div style={{ fontSize:15, fontWeight:700 }}>{load.cargo}</div>
          <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>{load.origin} → {load.destination}</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <StatusPill status={load.status} />
          {live.trip && <div style={{ fontSize:10, color:C.muted, marginTop:4 }}>{expanded ? "▲ hide" : "▼ track live"}</div>}
        </div>
      </div>
      {expanded && live.trip && <div style={{ marginTop:12 }}><LiveTrackingPanel {...live} truckPlate={plate} /></div>}
    </div>
  );
}

function StatusPill({ status }) {
  const color = status === "Open" ? C.blue : status === "Booked" ? C.amber : status === "Accepted" ? C.amber
    : status === "Assigned" ? C.blue : status === "Trip Created" ? C.green : status === "Cancelled" ? C.red : C.muted;
  return <span style={{ fontSize: 11, fontWeight:800, color, border:`1px solid ${color}`, borderRadius:100, padding:"2px 10px" }}>{status}</span>;
}

/* ── Login ── */
function MarketplaceLogin({ onLoggedIn }) {
  const [role, setRole] = useState("shipper");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleLogin(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const result = await market.login(phone.trim(), pin.trim(), role);
    setBusy(false);
    if (result.ok) onLoggedIn(result.user);
    else setError(result.error || "Login failed.");
  }

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.white, fontFamily:font, padding:"32px 20px" }}>
      <div style={{ fontSize:13, fontWeight:800, letterSpacing:1.5, color:C.green, marginBottom:6 }}>BEHARI MARKETPLACE</div>
      <div style={{ fontSize:20, fontWeight:700, marginBottom:24 }}>Sign in</div>

      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        {["shipper","fleet_owner"].map(r => (
          <button key={r} type="button" onClick={()=>setRole(r)}
            style={{ flex:1, padding:"10px", borderRadius:10, border:`1.5px solid ${role===r?C.green:C.border}`, background: role===r?C.greenBg:C.card, color:C.white, fontFamily:font, fontWeight:700, fontSize:13, cursor:"pointer" }}>
            {r === "shipper" ? "Shipper" : "Transporter"}
          </button>
        ))}
      </div>

      <form onSubmit={handleLogin}>
        <label style={labelStyle}>Phone</label>
        <input value={phone} onChange={e=>setPhone(e.target.value)} placeholder={role==="shipper"?"0700000001":"0722100200"} inputMode="tel" style={inputStyle} />
        <label style={labelStyle}>PIN</label>
        <input value={pin} onChange={e=>setPin(e.target.value)} placeholder="••••" type="password" inputMode="numeric" style={{ ...inputStyle, letterSpacing:4 }} />
        {error && <div style={{ background:C.redBg, color:C.red, fontSize:13, borderRadius:8, padding:"10px 12px", marginBottom:16 }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ ...btnPrimary, width:"100%", opacity:busy?0.7:1 }}>{busy?"Signing in…":"SIGN IN"}</button>
      </form>
    </div>
  );
}

/* ── Shipper view ── */
function ShipperView({ user, onLogout }) {
  const [form, setForm] = useState({ cargo:"", origin:"", destination:"", weight:"", truckType:"", price:"", pickupDate:"" });
  const [myLoads, setMyLoads] = useState([]);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(() => { market.listLoads({ shipperId: user.id }).then(setMyLoads); }, [user.id]);
  useEffect(() => { refresh(); }, [refresh]);

  async function handlePost(e) {
    e.preventDefault();
    setPosting(true); setError("");
    try {
      await market.createLoad({ ...form, price: form.price ? Number(form.price) : undefined });
      setForm({ cargo:"", origin:"", destination:"", weight:"", truckType:"", price:"", pickupDate:"" });
      refresh();
    } catch (err) { setError(err.message); }
    setPosting(false);
  }

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.white, fontFamily:font, padding:"28px 20px 60px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:800, letterSpacing:1.5, color:C.green }}>BEHARI MARKETPLACE</div>
          <div style={{ fontSize:18, fontWeight:700, marginTop:2 }}>{user.name} · Shipper</div>
        </div>
        <button onClick={onLogout} style={btnGhost}>Log out</button>
      </div>

      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:18, marginBottom:24 }}>
        <div style={{ fontSize:15, fontWeight:800, marginBottom:14 }}>Post a Load</div>
        <form onSubmit={handlePost}>
          <label style={labelStyle}>Cargo</label>
          <input required value={form.cargo} onChange={e=>setForm(f=>({...f,cargo:e.target.value}))} placeholder="Bagged Rice" style={inputStyle} />
          <div style={{ display:"flex", gap:10 }}>
            <div style={{ flex:1 }}>
              <label style={labelStyle}>Origin</label>
              <input required value={form.origin} onChange={e=>setForm(f=>({...f,origin:e.target.value}))} placeholder="Nakuru" style={inputStyle} />
            </div>
            <div style={{ flex:1 }}>
              <label style={labelStyle}>Destination</label>
              <input required value={form.destination} onChange={e=>setForm(f=>({...f,destination:e.target.value}))} placeholder="Nairobi" style={inputStyle} />
            </div>
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <div style={{ flex:1 }}>
              <label style={labelStyle}>Weight</label>
              <input value={form.weight} onChange={e=>setForm(f=>({...f,weight:e.target.value}))} placeholder="20T" style={inputStyle} />
            </div>
            <div style={{ flex:1 }}>
              <label style={labelStyle}>Truck Type</label>
              <input value={form.truckType} onChange={e=>setForm(f=>({...f,truckType:e.target.value}))} placeholder="Flatbed" style={inputStyle} />
            </div>
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <div style={{ flex:1 }}>
              <label style={labelStyle}>Price (KSh)</label>
              <input value={form.price} onChange={e=>setForm(f=>({...f,price:e.target.value}))} placeholder="38000" inputMode="numeric" style={inputStyle} />
            </div>
            <div style={{ flex:1 }}>
              <label style={labelStyle}>Pickup Date</label>
              <input value={form.pickupDate} onChange={e=>setForm(f=>({...f,pickupDate:e.target.value}))} type="date" style={inputStyle} />
            </div>
          </div>
          {error && <div style={{ background:C.redBg, color:C.red, fontSize:13, borderRadius:8, padding:"10px 12px", marginBottom:12 }}>{error}</div>}
          <button type="submit" disabled={posting} style={{ ...btnPrimary, width:"100%", opacity:posting?0.7:1 }}>{posting?"Posting…":"POST LOAD"}</button>
        </form>
      </div>

      <div style={{ fontSize:13, fontWeight:800, letterSpacing:0.8, textTransform:"uppercase", color:C.muted, marginBottom:10 }}>My Loads</div>
      {myLoads.length === 0 && <div style={{ color:C.muted, fontSize:13 }}>No loads posted yet.</div>}
      {myLoads.map(l => <ShipperLoadRow key={l.id} load={l} />)}
    </div>
  );
}

/* ── Transporter view ── */
function TransporterView({ user, onLogout }) {
  const [tab, setTab] = useState("marketplace");
  const [openLoads, setOpenLoads] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [picks, setPicks] = useState({}); // bookingId -> {truckId, driverId}

  const refresh = useCallback(() => {
    market.listLoads({ status: "Open" }).then(setOpenLoads);
    market.listBookings({ transporterId: user.id }).then(setBookings);
    market.listMyTrucks(user.fleetOwnerId).then(setTrucks);
    market.listDrivers().then(setDrivers);
  }, [user.id, user.fleetOwnerId]);
  useEffect(() => { refresh(); }, [refresh]);

  async function handleAccept(loadId) {
    setBusyId(loadId); setError("");
    try { await market.acceptLoad(loadId); refresh(); setTab("bookings"); }
    catch (err) { setError(err.message); }
    setBusyId(null);
  }

  async function handleAssign(bookingId) {
    const pick = picks[bookingId];
    if (!pick?.truckId || !pick?.driverId) { setError("Pick both a truck and a driver first."); return; }
    setBusyId(bookingId); setError("");
    try { await market.assignBooking(bookingId, pick); refresh(); }
    catch (err) { setError(err.message); }
    setBusyId(null);
  }

  async function handleCreateTrip(bookingId) {
    setBusyId(bookingId); setError("");
    try { await market.createTripForBooking(bookingId); refresh(); }
    catch (err) { setError(err.message); }
    setBusyId(null);
  }

  function truckPlate(id) { return trucks.find(t => t.id === id)?.plate || id; }
  function driverName(id) { return drivers.find(d => d.id === id)?.name || id; }

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.white, fontFamily:font, padding:"28px 20px 60px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:800, letterSpacing:1.5, color:C.green }}>BEHARI MARKETPLACE</div>
          <div style={{ fontSize:18, fontWeight:700, marginTop:2 }}>{user.name} · Transporter</div>
        </div>
        <button onClick={onLogout} style={btnGhost}>Log out</button>
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:20 }}>
        {[["marketplace","Marketplace"],["bookings","My Bookings"]].map(([id,label]) => (
          <button key={id} onClick={()=>setTab(id)} style={{ ...btnGhost, flex:1, background: tab===id?C.greenBg:"transparent", borderColor: tab===id?C.green:C.border, color: tab===id?C.green:C.white }}>{label}</button>
        ))}
      </div>

      {error && <div style={{ background:C.redBg, color:C.red, fontSize:13, borderRadius:8, padding:"10px 12px", marginBottom:16 }}>{error}</div>}

      {tab === "marketplace" && (
        <>
          {openLoads.length === 0 && <div style={{ color:C.muted, fontSize:13 }}>No open loads right now.</div>}
          {openLoads.map(l => (
            <div key={l.id} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 16px", marginBottom:8 }}>
              <div style={{ fontSize:11, color:C.muted, marginBottom:2 }}>{l.id}</div>
              <div style={{ fontSize:15, fontWeight:700 }}>{l.cargo}</div>
              <div style={{ fontSize:12, color:C.muted, marginTop:2, marginBottom:10 }}>{l.origin} → {l.destination} · {l.truckType || "Any"} · KSh {l.price ?? "—"}</div>
              <button onClick={()=>handleAccept(l.id)} disabled={busyId===l.id} style={{ ...btnPrimary, opacity:busyId===l.id?0.7:1 }}>{busyId===l.id?"Accepting…":"Accept Load"}</button>
            </div>
          ))}
        </>
      )}

      {tab === "bookings" && (
        <>
          {bookings.length === 0 && <div style={{ color:C.muted, fontSize:13 }}>No bookings yet — accept a load first.</div>}
          {bookings.map(b => (
            <div key={b.id} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 16px", marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                <div style={{ fontSize:11, color:C.muted }}>{b.id} · Load {b.loadId}</div>
                <StatusPill status={b.status} />
              </div>

              {b.status === "Accepted" && (
                <div>
                  <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                    <select onChange={e=>setPicks(p=>({...p,[b.id]:{...p[b.id],truckId:e.target.value}}))} defaultValue=""
                      style={{ flex:1, background:"#0F0F0F", color:C.white, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px", fontFamily:font, fontSize:13 }}>
                      <option value="" disabled>Select truck…</option>
                      {trucks.map(t => <option key={t.id} value={t.id}>{t.plate} ({t.status})</option>)}
                    </select>
                    <select onChange={e=>setPicks(p=>({...p,[b.id]:{...p[b.id],driverId:e.target.value}}))} defaultValue=""
                      style={{ flex:1, background:"#0F0F0F", color:C.white, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px", fontFamily:font, fontSize:13 }}>
                      <option value="" disabled>Select driver…</option>
                      {drivers.map(d => <option key={d.id} value={d.id}>{d.name} ({d.status})</option>)}
                    </select>
                  </div>
                  <button onClick={()=>handleAssign(b.id)} disabled={busyId===b.id} style={{ ...btnPrimary, width:"100%", opacity:busyId===b.id?0.7:1 }}>{busyId===b.id?"Assigning…":"Assign Truck & Driver"}</button>
                </div>
              )}

              {b.status === "Assigned" && (
                <div>
                  <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>{truckPlate(b.truckId)} · {driverName(b.driverId)}</div>
                  <button onClick={()=>handleCreateTrip(b.id)} disabled={busyId===b.id} style={{ ...btnPrimary, width:"100%", opacity:busyId===b.id?0.7:1 }}>{busyId===b.id?"Creating…":"Create Trip"}</button>
                </div>
              )}

              {b.status === "Trip Created" && (
                <div style={{ fontSize:12, color:C.green }}>
                  Trip {b.tripId} created — {driverName(b.driverId)} can now start GPS from the Driver Tracker.
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ── Root ─────────────────────────────────────────────────── */
export default function BehariMarketplace() {
  const [user, setUser] = useState(() => market.getCurrentUser());

  function handleLogout() { market.logout(); setUser(null); }

  if (!user) return <MarketplaceLogin onLoggedIn={setUser} />;
  if (user.role === "shipper") return <ShipperView user={user} onLogout={handleLogout} />;
  return <TransporterView user={user} onLogout={handleLogout} />;
}

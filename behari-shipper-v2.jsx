import { useState, useRef, useEffect } from "react";
// Data layer — reference lists and seed data decoupled from the portal.
import { CORRIDORS, CARGO_TYPES, TRUCK_TYPES, CARGO_UNITS, TRUCK_COUNT_OPTIONS } from "./src/data/reference.js";
// Phase 3B of the seed-data unification — the Shipper portal's load list now
// comes from the centralized pipeline (canonical SEED_LOADS + live
// postedLoads) instead of its own private SHIPMENTS_SEED/SHIPMENT_HISTORY_SEED
// arrays. See src/services/loadViews.js for the merge/formatting logic.
// data/shipments.js itself is left untouched (not yet deleted).
import { sortNewestFirst, makePlace, resolveDistance, distLabel, metersToKm } from "./src/models/geo.js";
import PlaceInput from "./src/components/maps/PlaceInput.jsx";
import { hasMapsKey } from "./src/services/googleMaps.js";
// Step 8: Rating dimensions
import { CARRIER_RATING_DIMS } from "./src/models/rating.js";
// Matching engine — shared UI components (Truck ↔ Cargo)
import { useCommerce } from "./src/hooks/useCommerce.js";
import { OfferThread, AgreedPriceBlock, CommerceBell } from "./src/components/negotiation/negotiation.jsx";
import { ksh, paymentView } from "./src/models/backendLoad.js";
// Phase 4G — real backend GPS (Phase 4F), distinct from the simulated map
// below it. Most shipments have no backend-tracked trip yet (see
// backend/README.md's scope note) — LiveTrackingPanel renders "Not
// currently tracked live" for those rather than pretending otherwise.
import { useLiveTripByLoadId } from "./src/hooks/useLiveTrip.js";
import LiveTrackingPanel from "./src/components/tracking/LiveTrackingPanel.jsx";
import NotLive from "./src/components/NotLive.jsx";
import TripTrackingModal from "./src/components/tracking/TripTrackingModal.jsx";

const C = {
  white:"#FFFFFF", bg:"#F6F6F6", border:"#EBEBEB",
  muted:"#9E9E9E", secondary:"#545454", black:"#000000",
  green:"#06C167", greenBg:"#E6F9F0",
  red:"#C0392B",   redBg:"#FDE8E3",
  amber:"#E07B39", amberBg:"#FFF3E0",
  blue:"#276EF1",  blueBg:"#EFF3FE",
};
const card = { background:C.white, borderRadius:8, boxShadow:"0 1px 4px rgba(0,0,0,0.08)", border:`1px solid ${C.border}` };
const font = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";

// CORRIDORS, CARGO_TYPES, TRUCK_TYPES are imported from the data layer.
// SHIPMENTS/HISTORY (SHIPMENTS_SEED/SHIPMENT_HISTORY_SEED) are no longer
// imported here as of Phase 3B — see getAllKnownLoads()/toShipperShipmentView.

const STATUS_MAP = {
  "Escrow Held":        { color:C.amber, bg:C.amberBg },
  "Accepted":           { color:C.green, bg:C.greenBg },
  "Loading":            { color:C.amber, bg:C.amberBg },
  "In Transit":         { color:C.blue,  bg:C.blueBg  },
  "Arrived":            { color:C.green, bg:C.greenBg },
  "Delivery Confirmed": { color:C.green, bg:C.greenBg },
  "Paid Out":           { color:C.green, bg:C.greenBg },
  "Delivered":          { color:C.green, bg:C.greenBg },
  "Cancelled":          { color:C.red,   bg:C.redBg   },
  "Disputed":           { color:C.red,   bg:C.redBg   },
  "Dispute Resolved":   { color:C.amber, bg:C.amberBg },
};

// PROGRESS_MAP_SEED removed — Phase 3B: status→progress fallback now lives
// once in src/services/loadViews.js (STATUS_PROGRESS_FALLBACK), applied by
// toShipperShipmentView() instead of being re-derived separately in every
// component that merged SHIPMENTS_SEED locally.

// 5D-1: for a backend-linked load no money is held, so the local "Escrow Held" status reads "Open".
const statusLabel = (load) => (load.isBackend && load.status === "Escrow Held" ? "Open" : load.status);

function Pill({ status, label }) {
  const s = STATUS_MAP[status] || { color:C.muted, bg:C.bg };
  return <span style={{ background:s.bg, color:s.color, fontSize:11, fontWeight:700, borderRadius:100, padding:"3px 10px" }}>{label || status}</span>;
}

function ProgressBar({ value }) {
  return (
    <div style={{ background:C.border, borderRadius:2, height:3, overflow:"hidden" }}>
      <div style={{ width:`${value}%`, height:"100%", background:value===100?C.green:C.black, transition:"width 0.5s" }} />
    </div>
  );
}

/* ── POST CARGO MODAL ───────────────────────────────────── */
function PostModal({ onClose, onPostLoad }) {
  const [step,        setStep]        = useState(1);
  const [escrowState, setEscrowState] = useState("idle"); // idle | matching | posted
  const [postError,     setPostError]     = useState(null);
  const [form, setForm] = useState({
    pickup:"", destination:"", cargoType:"", description:"",
    pickupPlace:null, deliveryPlace:null, 
    weight:"", unit:"Tonnes", truckType:"", truckCount:"1", pickupDate:"", deadline:"", penalty:"", budget:"", phone:"+254 7",
    recurring:false, recurFreq:"weekly",
    partialLoadAllowed:false, // Matching engine — partial-load compatibility
  });

  const set = (k, v) => setForm(f => ({...f, [k]:v}));

  const [placesUsable, setPlacesUsable] = useState(hasMapsKey());

  const _pp = makePlace(form.pickup, form.pickupPlace), _dp = makePlace(form.destination, form.deliveryPlace);

  const inp = { width:"100%", background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"12px 14px", fontSize:14, fontFamily:font, color:C.black, outline:"none", marginBottom:12, fontWeight:500, boxSizing:"border-box" };
  const lbl = { display:"block", fontSize:11, fontWeight:700, color:C.secondary, letterSpacing:0.8, textTransform:"uppercase", marginBottom:5 };

  const budgetNum  = Number(form.budget) || 0;
  const _sameRoute = form.pickup.trim() && form.pickup.trim().toLowerCase() === form.destination.trim().toLowerCase();
  const _dateInv   = form.pickupDate && form.deadline && form.deadline < form.pickupDate;
  const step1Valid = (
    (!placesUsable || (form.pickupPlace && form.deliveryPlace)) &&
    form.pickup.trim() &&
    form.destination.trim() &&
    !_sameRoute &&
    form.cargoType &&
    Number(form.weight) > 0 &&
    budgetNum > 0 &&
    !_dateInv
  );

  /* Post the cargo, then immediately run the matching
   * engine against declared truck availabilities — "MATCHING TRUCKS" — before
   * falling through to the existing success screen. */
  async function finalizePost() {
    setPostError(null);
    let newLoad;
    try { newLoad = await onPostLoad(form); }
    catch (e) { setPostError(e?.message || "Could not post cargo."); return; }
    setEscrowState("posted");
  }

  /* ── SUCCESS SCREEN ─────────────────────────────────────── */
  if (escrowState === "posted") {
    return (
      <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,padding:16 }}>
        <div style={{ background:C.white,borderRadius:16,width:"100%",maxWidth:480,padding:"32px 24px",textAlign:"center" }}>
          <div style={{ fontSize:60,marginBottom:12 }}>🎉</div>
          <div style={{ fontSize:26,fontWeight:900,color:C.black,marginBottom:6 }}>Load Posted!</div>
          <div style={{ fontSize:14,color:C.secondary,marginBottom:24 }}>Your cargo is live. Transporters can now accept it or make an offer.</div>
          <div style={{ background:C.greenBg,border:`1.5px solid ${C.green}`,borderRadius:12,padding:"16px 18px",marginBottom:24,textAlign:"left" }}>
            <div style={{ fontSize:11,fontWeight:800,color:C.green,letterSpacing:0.8,textTransform:"uppercase",marginBottom:10 }}>What happens next</div>
            {[
              `Posted price: KSh ${budgetNum.toLocaleString()}`,
              "A transporter accepts or negotiates a price",
              "You pay the agreed amount into escrow",
              "Payment releases only after delivery confirmation",
            ].map(t => (
              <div key={t} style={{ display:"flex",alignItems:"flex-start",gap:8,marginBottom:7,fontSize:13,fontWeight:600,color:C.black }}>
                <span style={{ color:C.green }}>✅</span><span>{t}</span>
              </div>
            ))}
          </div>
          <button onClick={onClose} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:8,padding:14,fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:font }}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,padding:16 }} onClick={onClose}>
      <div style={{ background:C.white,borderRadius:16,width:"100%",maxWidth:480,maxHeight:"92vh",overflowY:"auto",padding:"24px 20px" }} onClick={e=>e.stopPropagation()}>

        {/* ── HEADER ──────────────────────────────────────────── */}
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6 }}>
          <div>
            <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:2 }}>Step {step} of 2</div>
            <div style={{ fontSize:22,fontWeight:800,color:C.black }}>
              {step===1 ? "Post Your Cargo" : "Review & Post"}
            </div>
          </div>
          <button onClick={onClose} style={{ background:C.bg,border:"none",borderRadius:"50%",width:34,height:34,cursor:"pointer",fontSize:16,color:C.secondary }}>✕</button>
        </div>

        {/* ── PROGRESS BAR ────────────────────────────────────── */}
        <div style={{ display:"flex",gap:4,marginBottom:22 }}>
          {[1,2].map(s => <div key={s} style={{ flex:1,height:3,background:s<=step?C.black:C.border,borderRadius:2,transition:"background 0.3s" }} />)}
        </div>

        {/* ════════════════════════════════════════════════════════
            STEP 1 — POST CARGO
            ════════════════════════════════════════════════════════ */}
        {step===1 && <>
          <label style={lbl}>Pickup Location</label>
          <PlaceInput style={inp} theme={{bg:C.white,border:C.border,text:C.black,muted:C.muted,ok:C.green}} placeholder="e.g. Mombasa Port, Gate 3" value={form.pickup} pinned={!!form.pickupPlace} onUsableChange={setPlacesUsable}
            onChange={(t,pl)=>setForm(f=>({...f, pickup:t, pickupPlace:pl}))} />

          <label style={lbl}>Destination</label>
          <PlaceInput style={inp} theme={{bg:C.white,border:C.border,text:C.black,muted:C.muted,ok:C.green}} placeholder="e.g. Kampala, Nakawa Industrial Area" value={form.destination} pinned={!!form.deliveryPlace} onUsableChange={setPlacesUsable}
            onChange={(t,pl)=>setForm(f=>({...f, destination:t, deliveryPlace:pl}))} />
          {(_pp.name && _dp.name) && (
            <div style={{ fontSize:12, fontWeight:600, color:C.secondary, marginTop:-6, marginBottom:12 }}>
              Road distance is calculated by the server once the load is posted.
            </div>
          )}

          <label style={lbl}>Cargo Type</label>
          <select style={inp} value={form.cargoType} onChange={e=>{ const v=e.target.value; setForm(f=>({...f, cargoType:v, unit: v==="Vehicle" ? "Vehicles" : f.unit})); }}>
            <option value="">Select cargo type…</option>
            {CARGO_TYPES.map(c=><option key={c}>{c}</option>)}
          </select>

          <label style={lbl}>
            Cargo Description
            <span style={{ fontWeight:400,color:C.muted,fontSize:10,textTransform:"none",letterSpacing:0 }}> — shown to transporters before they accept</span>
          </label>
          <input style={inp} placeholder='e.g. "28 tons of ceramic tiles on wooden pallets"' value={form.description} onChange={e=>set("description",e.target.value)} />

          {/* Weight + Unit side by side */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 130px",gap:10,marginBottom:12 }}>
            <div>
              <label style={lbl}>Weight / Volume</label>
              <input style={{...inp,marginBottom:0}} type="number" placeholder="e.g. 28" value={form.weight} onChange={e=>set("weight",e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Unit</label>
              <select style={{...inp,marginBottom:0}} value={form.unit} onChange={e=>set("unit",e.target.value)}>
                {CARGO_UNITS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
          </div>

          {/* Truck Type + How Many side by side */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 110px",gap:10,marginBottom:12 }}>
            <div>
              <label style={lbl}>Truck Type Required</label>
              <select style={{...inp,marginBottom:0}} value={form.truckType} onChange={e=>set("truckType",e.target.value)}>
                <option value="">Select truck type…</option>
                {TRUCK_TYPES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>No. of Trucks</label>
              <select style={{...inp,marginBottom:0}} value={form.truckCount} onChange={e=>set("truckCount",e.target.value)}>
                {TRUCK_COUNT_OPTIONS.map(n => <option key={n}>{n}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12 }}>
            <div>
              <label style={lbl}>Pickup Date</label>
              <input style={{...inp,marginBottom:0}} type="date" value={form.pickupDate} onChange={e=>set("pickupDate",e.target.value)} />
            </div>
            <div>
              <label style={lbl}>Delivery Deadline</label>
              <input style={{...inp,marginBottom:0}} type="date" value={form.deadline} onChange={e=>set("deadline",e.target.value)} />
            </div>
          </div>

          {/* Penalty + Budget side by side */}
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12 }}>
            <div>
              <label style={lbl}>
                Late Penalty
                <span style={{ fontWeight:400,color:C.muted,fontSize:10,textTransform:"none",letterSpacing:0 }}> /day</span>
              </label>
              <div style={{ position:"relative" }}>
                <span style={{ position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:13,fontWeight:700,color:C.muted,pointerEvents:"none" }}>KSh</span>
                <input style={{...inp,paddingLeft:42,marginBottom:0}} type="number" placeholder="e.g. 2,000" value={form.penalty} onChange={e=>set("penalty",e.target.value)} />
              </div>
            </div>
            <div>
              <label style={lbl}>Your Budget (KSh)</label>
              <div style={{ position:"relative" }}>
                <span style={{ position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:13,fontWeight:700,color:C.muted,pointerEvents:"none" }}>KSh</span>
                <input style={{...inp,paddingLeft:42,marginBottom:0}} type="number" placeholder="e.g. 95,000" value={form.budget} onChange={e=>set("budget",e.target.value)} />
              </div>
            </div>
          </div>

          {/* Penalty note */}
          {form.penalty && (
            <div style={{ background:C.amberBg,border:`1px solid ${C.amber}`,borderRadius:8,padding:"9px 13px",marginBottom:14,fontSize:12,color:C.amber,fontWeight:600 }}>
              ⚠️ KSh {Number(form.penalty).toLocaleString()} per day penalty applies if delivery is late. Deducted from driver payment automatically.
            </div>
          )}

          {/* Hint */}
          <div style={{ background:"#EFF6FF",border:"1px solid #BFDBFE",borderRadius:8,padding:"10px 14px",marginBottom:10,fontSize:12,color:"#1D4ED8",fontWeight:500 }}>
            💡 <strong>Example:</strong> "Transport 28 tons of tiles from Mombasa to Kampala."
          </div>

          {/* Inline validation errors */}
          {_sameRoute && (
            <div style={{ background:C.redBg,border:`1px solid ${C.red}`,borderRadius:8,padding:"8px 13px",marginBottom:8,fontSize:12,color:C.red,fontWeight:600 }}>
              Pickup and destination cannot be the same location.
            </div>
          )}
          {budgetNum < 0 && (
            <div style={{ background:C.redBg,border:`1px solid ${C.red}`,borderRadius:8,padding:"8px 13px",marginBottom:8,fontSize:12,color:C.red,fontWeight:600 }}>
              Budget must be a positive amount in KSh.
            </div>
          )}
          {_dateInv && (
            <div style={{ background:C.redBg,border:`1px solid ${C.red}`,borderRadius:8,padding:"8px 13px",marginBottom:8,fontSize:12,color:C.red,fontWeight:600 }}>
              Delivery deadline cannot be before the pickup date.
            </div>
          )}

          {/* Recurring load toggle */}
          <div style={{ background:C.bg,border:`1.5px solid ${form.recurring?C.black:C.border}`,borderRadius:10,padding:"13px 14px",marginBottom:12,transition:"border-color 0.15s" }}>
            <label style={{ display:"flex",alignItems:"center",gap:12,cursor:"pointer" }}>
              <div
                onClick={()=>set("recurring",!form.recurring)}
                style={{ width:42,height:24,borderRadius:12,background:form.recurring?C.black:C.border,position:"relative",flexShrink:0,transition:"background 0.2s",cursor:"pointer" }}
              >
                <div style={{ width:18,height:18,borderRadius:"50%",background:C.white,position:"absolute",top:3,left:form.recurring?21:3,transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)" }} />
              </div>
              <div>
                <div style={{ fontSize:14,fontWeight:700,color:C.black }}>Repeat this load automatically</div>
                <div style={{ fontSize:11,color:C.muted,marginTop:1 }}>Saves time for regular shipments</div>
              </div>
            </label>
            {form.recurring && (
              <div style={{ marginTop:12,display:"flex",gap:8 }}>
                {["weekly","monthly"].map(f=>(
                  <button key={f} onClick={()=>set("recurFreq",f)} style={{ flex:1,background:form.recurFreq===f?C.black:C.white,color:form.recurFreq===f?C.white:C.secondary,border:`1.5px solid ${form.recurFreq===f?C.black:C.border}`,borderRadius:8,padding:"9px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font,transition:"all 0.15s",textTransform:"capitalize" }}>{f}</button>
                ))}
              </div>
            )}
            {form.recurring && (
              <div style={{ marginTop:8,fontSize:12,color:C.green,fontWeight:600 }}>
                ✓ Load will be reposted automatically every {form.recurFreq === "weekly" ? "7 days" : "30 days"}
              </div>
            )}
          </div>

          {/* Matching engine — partial-load toggle */}
          <div
            onClick={()=>set("partialLoadAllowed",!form.partialLoadAllowed)}
            style={{ display:"flex",alignItems:"center",gap:12,background:C.bg,border:`1.5px solid ${form.partialLoadAllowed?C.black:C.border}`,borderRadius:10,padding:"13px 14px",marginBottom:16,cursor:"pointer" }}
          >
            <div style={{ width:42,height:24,borderRadius:12,background:form.partialLoadAllowed?C.black:C.border,position:"relative",flexShrink:0,transition:"background 0.2s" }}>
              <div style={{ width:18,height:18,borderRadius:"50%",background:C.white,position:"absolute",top:3,left:form.partialLoadAllowed?21:3,transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)" }} />
            </div>
            <div>
              <div style={{ fontSize:14,fontWeight:700,color:C.black }}>Accept a partial load</div>
              <div style={{ fontSize:11,color:C.muted,marginTop:1 }}>A truck with spare capacity can carry part of this cargo</div>
            </div>
          </div>

          <button
            onClick={()=>setStep(2)}
            disabled={!step1Valid}
            style={{ width:"100%",background:step1Valid?C.black:"#C8C8C8",color:C.white,border:"none",borderRadius:8,padding:14,fontSize:15,fontWeight:800,cursor:step1Valid?"pointer":"not-allowed",fontFamily:font,transition:"background 0.2s" }}
          >
            Continue → Review & Post
          </button>
        </>}

        {/* ════════════════════════════════════════════════════════
            STEP 2 — M-PESA ESCROW
            ════════════════════════════════════════════════════════ */}
        {step===2 && <>

          {/* Cargo recap pill */}
          <div style={{ background:C.bg,borderRadius:10,padding:"12px 14px",marginBottom:16,border:`1px solid ${C.border}` }}>
            <div style={{ fontSize:10,fontWeight:800,color:C.muted,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Cargo Summary</div>
            {[
              ["Route",    `${form.pickup} → ${form.destination}`],
              ["Cargo",    form.cargoType],
              ...(form.description ? [["Description", form.description]] : []),
              ["Weight",   `${form.weight} ${form.unit}`],
              ["Truck",    `${form.truckCount} × ${form.truckType || "Any Available"}`],
              ["Pickup",   form.pickupDate || "—"],
              ["Deadline", form.deadline   || "—"],
              ...(form.penalty ? [["Late Penalty", `KSh ${Number(form.penalty).toLocaleString()}/day`]] : []),
            ].map(([k,v]) => (
              <div key={k} style={{ display:"flex",justifyContent:"space-between",marginBottom:5 }}>
                <span style={{ fontSize:12,color:C.secondary }}>{k}</span>
                <span style={{ fontSize:12,fontWeight:700,color:C.black,maxWidth:220,textAlign:"right" }}>{v}</span>
              </div>
            ))}
          </div>

          {/* 5D-1 — nothing is paid at posting; escrow starts only after a price is agreed */}
          <div data-testid="no-payment-at-post" style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:14,padding:"16px 18px",marginBottom:16 }}>
            <div style={{ fontSize:15,fontWeight:800,color:C.black,marginBottom:6 }}>No payment is taken now</div>
            <div style={{ fontSize:12,color:C.secondary,lineHeight:1.6 }}>
              Posting is free. Transporters can accept your posted price of <strong>KSh {budgetNum.toLocaleString()}</strong> or make an offer.
              Once you and a transporter agree an amount, you pay it into escrow, and it is released only after delivery is confirmed.
            </div>
          </div>

          {/* ── IDLE: show phone + send button ─────────────────── */}
          {escrowState==="idle" && <>
            <label style={lbl}>Contact Phone</label>
            <input style={inp} placeholder="+254 7XX XXX XXX" value={form.phone} onChange={e=>set("phone",e.target.value)} />
            {postError && <div data-testid="post-error" style={{ background:C.redBg,color:C.red,borderRadius:8,padding:"10px 12px",fontSize:12,fontWeight:700,marginBottom:10 }}>{postError}</div>}
            <div style={{ display:"flex",gap:8 }}>
              <button onClick={()=>setStep(1)} style={{ flex:1,background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:13,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>
                ← Back
              </button>
              <button
                onClick={finalizePost}
                style={{ flex:2,background:C.black,color:C.white,border:"none",borderRadius:8,padding:13,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:font }}
              >
                🚛 Post Cargo
              </button>
            </div>
          </>}

        </>}
      </div>
    </div>
  );
}

/* ── SIGNATURE CANVAS ───────────────────────────────────── */
function SignaturePad({ onSigned }) {
  const canvasRef = useRef(null);
  const drawing   = useRef(false);
  const hasSig    = useRef(false);

  function pos(e) {
    const r = canvasRef.current.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return { x: src.clientX - r.left, y: src.clientY - r.top };
  }
  function start(e) { e.preventDefault(); drawing.current = true; const c = canvasRef.current; const ctx = c.getContext("2d"); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function move(e)  { e.preventDefault(); if (!drawing.current) return; const c = canvasRef.current; const ctx = c.getContext("2d"); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.strokeStyle="#000"; ctx.lineWidth=2; ctx.lineCap="round"; ctx.stroke(); hasSig.current = true; }
  function end(e)   { e.preventDefault(); drawing.current = false; if (hasSig.current) onSigned(canvasRef.current.toDataURL()); }
  function clear()  { const c = canvasRef.current; c.getContext("2d").clearRect(0,0,c.width,c.height); hasSig.current=false; onSigned(null); }

  return (
    <div>
      <div style={{ border:`1.5px solid ${C.border}`,borderRadius:8,background:C.bg,position:"relative" }}>
        <canvas ref={canvasRef} width={340} height={120}
          style={{ display:"block",width:"100%",height:120,borderRadius:8,cursor:"crosshair",touchAction:"none" }}
          onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
          onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        />
        <div style={{ position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",pointerEvents:"none",fontSize:11,color:C.muted,fontWeight:500,opacity:0.5 }}>Sign here</div>
      </div>
      <button onClick={clear} style={{ marginTop:6,background:"none",border:"none",fontSize:12,color:C.muted,cursor:"pointer",fontFamily:font,fontWeight:600,padding:0 }}>↺ Clear</button>
    </div>
  );
}

/* ── DELIVERY CONFIRMATION MODAL (Step 3) ────────────────── */
function DeliveryConfirmModal({ s, onClose, onConfirmDelivery }) {
  // step: "otp" | "info" | "photo" | "signature" | "gps" | "submitting" | "done"
  const [step,         setStep]         = useState("otp");
  const [otpInput,     setOtpInput]     = useState("");
  const [otpError,     setOtpError]     = useState("");
  const [receiverName, setReceiverName] = useState("");
  const [photoLabel,   setPhotoLabel]   = useState(null);  // file name or "Demo photo"
  const [sigDataUrl,   setSigDataUrl]   = useState(null);
  const [gps,          setGps]          = useState(null);

  const DEMO_OTP = "473821"; // "sent" to receiver's phone in production

  function verifyOtp() {
    if (otpInput.trim() === DEMO_OTP) { setOtpError(""); setStep("info"); }
    else setOtpError(`Incorrect OTP. (Hint: use ${DEMO_OTP})`);
  }

  function handlePhoto(e) {
    if (e.target.files && e.target.files[0]) setPhotoLabel(e.target.files[0].name);
  }
  function demoPhoto() { setPhotoLabel("delivery_photo_demo.jpg"); }

  function confirmGps() {
    // Simulate getting GPS — use Nairobi city centre
    setGps({ lat:-1.2921, lng:36.8219, accuracy:10 });
    setTimeout(() => setStep("submitting"), 400);
  }

  useEffect(() => {
    if (step !== "submitting") return;
    const timer = setTimeout(async () => {
      await onConfirmDelivery(s.id, {
        otp:            DEMO_OTP,
        receiverName,
        photoDataUrl:   photoLabel || "demo",
        signatureDataUrl: sigDataUrl,
        gps,
      });
      setStep("done");
    }, 2000);
    return () => clearTimeout(timer);
  }, [step]);

  /* ── Step: submitting ── */
  if (step === "submitting") return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400,padding:16 }}>
      <div style={{ background:C.white,borderRadius:16,padding:"48px 28px",maxWidth:340,width:"100%",textAlign:"center",fontFamily:font }}>
        <div style={{ fontSize:52,marginBottom:16 }}>🔄</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:8 }}>Verifying Delivery…</div>
        <div style={{ fontSize:14,color:C.secondary,marginBottom:24 }}>Checking OTP, photo & GPS data</div>
        <div style={{ height:4,background:C.border,borderRadius:2,overflow:"hidden" }}>
          <div style={{ height:"100%",background:C.green,borderRadius:2,width:"80%",transition:"width 2s linear" }} />
        </div>
      </div>
    </div>
  );

  /* ── Step: done ── */
  if (step === "done") return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400,padding:16 }} onClick={onClose}>
      <div style={{ background:C.white,borderRadius:16,padding:"48px 28px",maxWidth:340,width:"100%",textAlign:"center",fontFamily:font }}>
        <div style={{ width:72,height:72,background:C.greenBg,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:36,margin:"0 auto 20px" }}>✅</div>
        <div style={{ fontSize:22,fontWeight:800,color:C.black,marginBottom:6 }}>Delivery Confirmed!</div>
        <div style={{ fontSize:14,color:C.secondary,marginBottom:20 }}>
          Escrow is now <strong style={{ color:C.green }}>Ready for Release</strong>.<br />
          Go to the shipment to release KSh {s.pay.toLocaleString()} to the carrier.
        </div>
        <div style={{ background:C.greenBg,border:`1px solid ${C.green}`,borderRadius:10,padding:"14px 16px",marginBottom:16,textAlign:"left" }}>
          <div style={{ fontSize:10,color:C.green,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:6 }}>Proof of Delivery ✓</div>
          <div style={{ fontSize:13,fontWeight:700,color:C.black }}>{s.id} — {s.cargo}</div>
          <div style={{ fontSize:12,color:C.secondary,marginTop:2 }}>{s.from} → {s.to}</div>
          <div style={{ fontSize:11,color:C.muted,marginTop:4 }}>Signed by: {receiverName || "Receiver"}</div>
        </div>
        <button onClick={onClose} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:8,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
      </div>
    </div>
  );

  /* ── Step progress indicator ── */
  const STEPS = ["otp","info","photo","signature","gps"];
  const stepIdx = STEPS.indexOf(step);

  /* ── Step: OTP ── */
  if (step === "otp") return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:400 }}>
      <div style={{ background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 40px",fontFamily:font }}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        {/* Progress dots */}
        <div style={{ display:"flex",gap:6,marginBottom:20,justifyContent:"center" }}>
          {STEPS.map((s,i) => <div key={s} style={{ width:i<=stepIdx?24:8,height:8,borderRadius:4,background:i<=stepIdx?C.black:C.border,transition:"all 0.3s" }} />)}
        </div>
        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Step 1 of 5</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:6 }}>Enter Delivery OTP</div>
        <div style={{ fontSize:13,color:C.secondary,lineHeight:1.6,marginBottom:16 }}>
          The receiver at <strong>{s.to}</strong> received a 6-digit OTP via SMS.
          Ask them to provide it to confirm delivery.
        </div>
        <div style={{ background:C.amberBg,borderRadius:8,padding:"10px 14px",fontSize:12,color:C.amber,fontWeight:600,marginBottom:16 }}>
          📱 Demo OTP: <strong style={{ letterSpacing:2 }}>{DEMO_OTP}</strong>
        </div>
        <input
          type="text" inputMode="numeric" maxLength={6}
          placeholder="Enter 6-digit OTP"
          value={otpInput} onChange={e=>setOtpInput(e.target.value.replace(/\D/g,"").slice(0,6))}
          style={{ width:"100%",padding:"14px",fontSize:24,fontFamily:font,background:C.bg,border:`1.5px solid ${otpError?C.red:C.border}`,borderRadius:8,outline:"none",letterSpacing:6,textAlign:"center",marginBottom:8 }}
        />
        {otpError && <div style={{ fontSize:12,color:C.red,fontWeight:600,marginBottom:10 }}>{otpError}</div>}
        <button onClick={verifyOtp} disabled={otpInput.length<6} style={{ width:"100%",background:otpInput.length<6?C.muted:C.black,color:C.white,border:"none",borderRadius:8,padding:"14px",fontSize:15,fontWeight:700,cursor:otpInput.length<6?"not-allowed":"pointer",fontFamily:font }}>
          Verify OTP →
        </button>
      </div>
    </div>
  );

  /* ── Step: receiver info ── */
  if (step === "info") return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:400 }}>
      <div style={{ background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 40px",fontFamily:font }}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ display:"flex",gap:6,marginBottom:20,justifyContent:"center" }}>
          {STEPS.map((s,i) => <div key={s} style={{ width:i<=1?24:8,height:8,borderRadius:4,background:i<=1?C.black:C.border,transition:"all 0.3s" }} />)}
        </div>
        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Step 2 of 5</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:6 }}>Receiver Details</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:16 }}>Enter the full name of the person receiving the goods.</div>
        <label style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",display:"block",marginBottom:6 }}>Receiver's Full Name</label>
        <input
          type="text" placeholder="e.g. John Kamau"
          value={receiverName} onChange={e=>setReceiverName(e.target.value)}
          style={{ width:"100%",padding:"13px 14px",fontSize:14,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",marginBottom:20 }}
        />
        <button onClick={()=>setStep("photo")} disabled={!receiverName.trim()} style={{ width:"100%",background:receiverName.trim()?C.black:C.muted,color:C.white,border:"none",borderRadius:8,padding:"14px",fontSize:15,fontWeight:700,cursor:receiverName.trim()?"pointer":"not-allowed",fontFamily:font }}>
          Continue →
        </button>
      </div>
    </div>
  );

  /* ── Step: photo ── */
  if (step === "photo") return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:400 }}>
      <div style={{ background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 40px",fontFamily:font }}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ display:"flex",gap:6,marginBottom:20,justifyContent:"center" }}>
          {STEPS.map((s,i) => <div key={s} style={{ width:i<=2?24:8,height:8,borderRadius:4,background:i<=2?C.black:C.border,transition:"all 0.3s" }} />)}
        </div>
        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Step 3 of 5</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:6 }}>Delivery Photo</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:16 }}>Take a photo of the delivered goods at the destination for proof of delivery.</div>
        {photoLabel ? (
          <div style={{ background:C.greenBg,border:`1px solid ${C.green}`,borderRadius:8,padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10 }}>
            <span style={{ fontSize:20 }}>📸</span>
            <div>
              <div style={{ fontSize:13,fontWeight:700,color:C.black }}>{photoLabel}</div>
              <div style={{ fontSize:11,color:C.green,fontWeight:600 }}>Photo attached ✓</div>
            </div>
          </div>
        ) : (
          <div style={{ background:C.bg,border:`1.5px dashed ${C.border}`,borderRadius:8,padding:"28px 16px",textAlign:"center",marginBottom:16 }}>
            <div style={{ fontSize:36,marginBottom:8 }}>📷</div>
            <div style={{ fontSize:13,color:C.muted,marginBottom:12 }}>No photo yet</div>
          </div>
        )}
        <div style={{ display:"flex",gap:8,marginBottom:12 }}>
          <label style={{ flex:1,background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font,textAlign:"center" }}>
            📁 Upload Photo
            <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display:"none" }} />
          </label>
          <button onClick={demoPhoto} style={{ flex:1,background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font }}>
            📸 Demo Photo
          </button>
        </div>
        <button onClick={()=>setStep("signature")} disabled={!photoLabel} style={{ width:"100%",background:photoLabel?C.black:C.muted,color:C.white,border:"none",borderRadius:8,padding:"14px",fontSize:15,fontWeight:700,cursor:photoLabel?"pointer":"not-allowed",fontFamily:font }}>
          Continue →
        </button>
      </div>
    </div>
  );

  /* ── Step: signature ── */
  if (step === "signature") return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:400 }}>
      <div style={{ background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 40px",fontFamily:font }}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ display:"flex",gap:6,marginBottom:20,justifyContent:"center" }}>
          {STEPS.map((s,i) => <div key={s} style={{ width:i<=3?24:8,height:8,borderRadius:4,background:i<=3?C.black:C.border,transition:"all 0.3s" }} />)}
        </div>
        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Step 4 of 5</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:6 }}>Receiver Signature</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:14 }}>Ask <strong>{receiverName}</strong> to sign below to acknowledge receipt of goods.</div>
        <SignaturePad onSigned={setSigDataUrl} />
        <div style={{ height:16 }} />
        <button onClick={()=>setStep("gps")} disabled={!sigDataUrl} style={{ width:"100%",background:sigDataUrl?C.black:C.muted,color:C.white,border:"none",borderRadius:8,padding:"14px",fontSize:15,fontWeight:700,cursor:sigDataUrl?"pointer":"not-allowed",fontFamily:font }}>
          Continue →
        </button>
      </div>
    </div>
  );

  /* ── Step: GPS ── */
  if (step === "gps") return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:400 }}>
      <div style={{ background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 40px",fontFamily:font }}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ display:"flex",gap:6,marginBottom:20,justifyContent:"center" }}>
          {STEPS.map((s,i) => <div key={s} style={{ width:i<=4?24:8,height:8,borderRadius:4,background:i<=4?C.black:C.border,transition:"all 0.3s" }} />)}
        </div>
        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Step 5 of 5</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:6 }}>GPS Confirmation</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:16 }}>Confirm delivery location to seal the proof-of-delivery record.</div>
        <div style={{ background:C.bg,borderRadius:10,padding:"14px 16px",marginBottom:20 }}>
          <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Delivery Location</div>
          <div style={{ fontSize:14,fontWeight:700,color:C.black,marginBottom:4 }}>{s.to}</div>
          <div style={{ fontSize:12,color:C.muted }}>📍 -1.2921, 36.8219 · Accuracy: ±10 m</div>
        </div>
        <button onClick={confirmGps} style={{ width:"100%",background:C.green,color:C.black,border:"none",borderRadius:8,padding:"14px",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:font }}>
          ✅ Confirm Location & Submit
        </button>
      </div>
    </div>
  );

  return null;
}

/* ── ESCROW RELEASE PANEL (Step 4) ───────────────────────── */
function EscrowReleasePanel({ s, escrow, onRelease, onClose }) {
  const [penalty,    setPenalty]    = useState(escrow?.latePenalty  || 0);
  const [partial,    setPartial]    = useState(escrow?.partialRefund || 0);
  const [releasing,  setReleasing]  = useState(false);
  const [released,   setReleased]   = useState(false);

  const base      = s.pay || 0;
  const adminFee  = Math.round(base * 0.02);
  const toCarrier = Math.max(0, base - penalty - adminFee - partial);

  async function doRelease() {
    setReleasing(true);
    await new Promise(r => setTimeout(r, 2000));
    await onRelease(s.id, { latePenalty: penalty, partialRefund: partial, adminFee, baseAmount: base });
    setReleasing(false);
    setReleased(true);
    setTimeout(onClose, 2500);
  }

  if (released) return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400,padding:16 }} onClick={onClose}>
      <div style={{ background:C.white,borderRadius:16,padding:"48px 28px",maxWidth:340,width:"100%",textAlign:"center",fontFamily:font }}>
        <div style={{ width:72,height:72,background:C.greenBg,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:36,margin:"0 auto 20px" }}>📱</div>
        <div style={{ fontSize:22,fontWeight:800,color:C.black,marginBottom:6 }}>Payment Sent!</div>
        <div style={{ fontSize:14,color:C.secondary,marginBottom:20 }}>
          KSh {toCarrier.toLocaleString()} sent to {s.driver}'s M-Pesa
        </div>
        <div style={{ fontSize:12,color:C.muted }}>Tap anywhere to close</div>
      </div>
    </div>
  );

  if (releasing) return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400,padding:16 }}>
      <div style={{ background:C.white,borderRadius:16,padding:"44px 28px",maxWidth:340,width:"100%",textAlign:"center",fontFamily:font }}>
        <div style={{ fontSize:52,marginBottom:16 }}>💸</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:8 }}>Releasing Payment…</div>
        <div style={{ fontSize:14,color:C.secondary,lineHeight:1.65,marginBottom:24 }}>
          Transferring <strong>KSh {toCarrier.toLocaleString()}</strong><br />to {s.driver} via M-Pesa
        </div>
        <div style={{ height:4,background:C.border,borderRadius:2,overflow:"hidden" }}>
          <div style={{ height:"100%",background:C.green,borderRadius:2,width:"75%",transition:"width 2s linear" }} />
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:400 }} onClick={onClose}>
      <div style={{ background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 40px",fontFamily:font }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:4 }}>Release Escrow</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:18 }}>
          Review the payment breakdown before releasing to {s.driver}.
        </div>

        {/* Escrow breakdown */}
        <div style={{ background:C.bg,borderRadius:12,overflow:"hidden",marginBottom:16 }}>
          {[
            ["Escrow (base amount)", `KSh ${base.toLocaleString()}`, C.black, false],
            ["Admin fee (2%)",       `− KSh ${adminFee.toLocaleString()}`, C.red,   false],
          ].map(([k,v,c,bold]) => (
            <div key={k} style={{ display:"flex",justifyContent:"space-between",padding:"11px 16px",borderBottom:`1px solid ${C.border}` }}>
              <span style={{ fontSize:13,color:C.secondary }}>{k}</span>
              <span style={{ fontSize:13,fontWeight:bold?800:600,color:c }}>{v}</span>
            </div>
          ))}

          {/* Editable: late penalty */}
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 16px",borderBottom:`1px solid ${C.border}` }}>
            <span style={{ fontSize:13,color:C.secondary }}>Late penalty (KSh)</span>
            <input type="number" min="0" value={penalty} onChange={e=>setPenalty(Number(e.target.value)||0)}
              style={{ width:90,padding:"5px 8px",fontSize:13,fontFamily:font,background:C.white,border:`1px solid ${C.border}`,borderRadius:6,textAlign:"right",outline:"none",color:penalty?C.red:C.black }} />
          </div>

          {/* Editable: partial refund */}
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 16px",borderBottom:`1px solid ${C.border}` }}>
            <span style={{ fontSize:13,color:C.secondary }}>Partial refund to shipper (KSh)</span>
            <input type="number" min="0" value={partial} onChange={e=>setPartial(Number(e.target.value)||0)}
              style={{ width:90,padding:"5px 8px",fontSize:13,fontFamily:font,background:C.white,border:`1px solid ${C.border}`,borderRadius:6,textAlign:"right",outline:"none",color:partial?C.amber:C.black }} />
          </div>

          {/* Total to carrier */}
          <div style={{ display:"flex",justifyContent:"space-between",padding:"14px 16px",background:C.greenBg }}>
            <span style={{ fontSize:14,fontWeight:800,color:C.black }}>Released to Transporter</span>
            <span style={{ fontSize:16,fontWeight:800,color:C.green }}>KSh {toCarrier.toLocaleString()}</span>
          </div>
        </div>

        <button onClick={doRelease} disabled={toCarrier<=0} style={{
          width:"100%",background:toCarrier>0?C.green:C.muted,color:C.black,border:"none",
          borderRadius:8,padding:"14px",fontSize:15,fontWeight:800,
          cursor:toCarrier>0?"pointer":"not-allowed",fontFamily:font,
        }}>
          📱 Release KSh {toCarrier.toLocaleString()} via M-Pesa
        </button>
      </div>
    </div>
  );
}

/* ── SHIPMENT DETAIL ────────────────────────────────────── */
/* ── 5D-3 backend negotiation panel (shipper) ───────────── */
function ShipperCommercePanel({ s, commerce }) {
  const booking = commerce.bookings.find(b => b.loadId === s.id);
  const threads = commerce.threads[s.id] || [];
  const A = commerce.actions;
  if (booking) return (
    <div style={{ marginBottom:16 }}>
      <div style={{ fontSize:11,fontWeight:700,color:C.muted,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Booking</div>
      <AgreedPriceBlock booking={booking} load={{ price:s.pay }} viewer="shipper" onFund={A.fundBooking} finance={commerce.finance[booking.id]} adjActions={A} />
    </div>
  );
  return (
    <div style={{ marginBottom:16 }} data-testid="shipper-offers">
      <div style={{ fontSize:11,fontWeight:700,color:C.muted,letterSpacing:0.8,textTransform:"uppercase" }}>Offers ({threads.length})</div>
      <div style={{ fontSize:12,color:C.secondary,marginTop:4 }}>Posted price {ksh(s.pay)}. You choose — Behari never auto-selects an offer.</div>
      {threads.length === 0 && <div style={{ fontSize:12,color:C.muted,padding:"14px 0",textAlign:"center" }}>No offers yet — transporters can accept your posted price or make an offer.</div>}
      {threads.map(t => (
        <OfferThread key={t.key} thread={{ ...t, title:t.transporterName || "Transporter" }}
          partyLabel={() => t.transporterName || "Transporter"}
          highlight={t.latest.needsMyAction}
          onAccept={A.accept} onCounter={A.counter} onReject={A.reject} onWithdraw={A.withdraw} />
      ))}
    </div>
  );
}

function DetailModal({ s, commerce, onClose, onConfirmDelivery = ()=>{}, escrowData = {}, bookingSlots = {}, onOpenDispute = ()=>{}, onSubmitRating = ()=>{} }) {
  const [deliveryFlow,   setDeliveryFlow]   = useState(false);
  const [showDispute,    setShowDispute]    = useState(false);
  const [showRate,       setShowRate]       = useState(false);
  const [hasRated,       setHasRated]       = useState(false);
  const [showInvoice,    setShowInvoice]    = useState(false);
  const [showTracking,   setShowTracking]   = useState(false); // Feature 2
  // Matching engine — Nearby Trucks for cargo still awaiting a carrier

  const escrow  = escrowData[s.id];
  const slots   = bookingSlots[s.id] || [];
  const status  = s.status || "In Transit";
  const isDelivered       = status === "Delivered" || status === "Paid Out";
  const isReadyForRelease = status === "Delivery Confirmed";
  const isArrived         = status === "Arrived";
  const canConfirmDelivery = isArrived || (status === "In Transit" && s.driver !== "Matching transporter…");
  const isDisputed        = status === "Disputed";
  const canDispute        = (status === "In Transit" || status === "Arrived" || status === "Loading") && !isDisputed;
  const awaitingCarrier   = !s.driver || s.driver === "Matching transporter…";

  // Escape key — must be before ALL conditional early returns to satisfy Rules of Hooks
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (deliveryFlow) return (
    <DeliveryConfirmModal s={s} onClose={()=>{setDeliveryFlow(false); onClose();}} onConfirmDelivery={onConfirmDelivery} />
  );
  if (showDispute) return (
    <ShipperDisputeModal shipment={s} onClose={()=>setShowDispute(false)} onOpenDispute={onOpenDispute} />
  );
  if (showRate) return (
    <ShipperRatingModal shipment={s} onClose={()=>{ setShowRate(false); setHasRated(true); onClose(); }} onSubmitRating={onSubmitRating} />
  );
  if (showInvoice) return (
    <InvoiceModal s={s} onClose={()=>setShowInvoice(false)} />
  );
  if (showTracking) return (
    <ShipperTrackingModal s={s} onClose={()=>setShowTracking(false)} />
  );

  return (
    <div
      style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:300 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background:C.white,borderRadius:"16px 16px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 32px",maxHeight:"88vh",overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
        {/* Drag handle + explicit close button */}
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20 }}>
          <div style={{ width:40,height:4,background:C.border,borderRadius:2,margin:"12px auto 0",flex:1 }} />
          <button onClick={onClose} style={{ background:"none",border:"none",fontSize:20,cursor:"pointer",color:C.muted,lineHeight:1,padding:"4px 0 0 12px",flexShrink:0 }}>✕</button>
        </div>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16 }}>
          <div>
            <div style={{ fontSize:11,color:C.muted,marginBottom:4 }}>{s.id}</div>
            <div style={{ fontSize:22,fontWeight:800,color:C.black }}>{s.cargo}</div>
          </div>
          <Pill status={status} label={statusLabel(s)} />
        </div>

        {/* Progress */}
        <div style={{ background:C.bg,borderRadius:12,padding:"14px 16px",marginBottom:16 }}>
          <div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}>
            <span style={{ fontSize:13,fontWeight:700,color:C.black }}>{s.from}</span>
            <span style={{ fontSize:12,fontWeight:700,color:C.black }}>{s.progress}%</span>
            <span style={{ fontSize:13,fontWeight:700,color:C.black }}>{s.to}</span>
          </div>
          <ProgressBar value={s.progress} />
          <div style={{ marginTop:8,fontSize:12,color:C.muted,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <span>📍 {s.ping} · {s.eta}</span>
            {(status==="Booked"||status==="In Transit"||status==="Loading"||status==="Arrived")&&(
              <button onClick={()=>setShowTracking(true)} style={{ background:C.blueBg,color:C.blue,border:"none",borderRadius:6,padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font }}>
                🗺 Track Live
              </button>
            )}
          </div>
        </div>

        {/* Details */}
        <div style={{ background:C.bg,borderRadius:12,overflow:"hidden",marginBottom:16 }}>
          {[["Driver",s.driver],["Truck",`${s.truck} · ${s.plate}`],["Distance",distLabel(s).text],["Payment",`KSh ${(s.agreedAmount ?? s.pay).toLocaleString()}`]].map(([k,v],i,a)=>(
            <div key={k} style={{ display:"flex",justifyContent:"space-between",padding:"12px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
              <span style={{ fontSize:13,color:C.secondary }}>{k}</span>
              <span style={{ fontSize:13,fontWeight:700,color:C.black }}>{v}</span>
            </div>
          ))}
        </div>

        {/* 5D-3 — real backend negotiation; demo loads have no commercial record */}
        {s.isBackend && (
          <ShipperCommercePanel s={s} commerce={commerce} />
        )}

        {/* Multi-truck fulfillment panel (Step 5) */}
        {s.truckCount > 1 && <MultiTruckPanel slots={slots} truckCount={s.truckCount || 1} />}

        {/* Escrow status banner */}
        {escrow && !s.isBackend && (
          <div style={{ background: isReadyForRelease?C.greenBg:C.amberBg, borderRadius:8, padding:"10px 14px", marginBottom:16, fontSize:12, fontWeight:600, color: isReadyForRelease?C.green:C.amber }}>
            🔒 Escrow: {escrow.status} · KSh {s.pay.toLocaleString()}
          </div>
        )}

        {/* Paid out — rate prompt */}
        {isDelivered && !hasRated && s.driver && s.driver !== "Matching transporter…" && (
          <div style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div>
              <div style={{ fontSize:12,fontWeight:700,color:C.black,marginBottom:2 }}>⭐ Rate your transporter</div>
              <div style={{ fontSize:11,color:C.muted }}>{s.driver} · {s.id}</div>
            </div>
            <button onClick={()=>setShowRate(true)} style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:"8px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>Rate Now</button>
          </div>
        )}

        {/* Actions */}
        {isDelivered && (
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            <div style={{ background:C.greenBg,borderRadius:8,padding:"12px 16px",textAlign:"center",fontSize:13,fontWeight:700,color:C.green }}>
              ✓ Payment released to {s.driver} via M-Pesa
            </div>
            <button
              onClick={()=>setShowInvoice(true)}
              style={{ background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:"11px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font }}
            >
              🧾 View Receipt / Invoice
            </button>
          </div>
        )}

        {isReadyForRelease && (
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            <div style={{ background:C.greenBg,border:`1px solid ${C.green}`,borderRadius:8,padding:"14px 16px",fontSize:13,color:C.green,fontWeight:600,textAlign:"center",lineHeight:1.6 }}>
              ✅ Delivery confirmed — proof of delivery is on file.<br />
              <strong>Behari Admin will verify and release payment</strong> to {s.driver} via M-Pesa.
            </div>
            <a href="tel:+254712345678" style={{ background:C.bg,color:C.black,textDecoration:"none",textAlign:"center",borderRadius:8,padding:"12px",fontSize:13,fontWeight:700,border:`1px solid ${C.border}`,display:"block" }}>📞 Call Driver</a>
          </div>
        )}

        {canConfirmDelivery && !isReadyForRelease && !isDelivered && (
          <div style={{ display:"flex",gap:8,marginBottom:8 }}>
            <a href="tel:+254712345678" style={{ flex:1,background:C.bg,color:C.black,textDecoration:"none",textAlign:"center",borderRadius:8,padding:13,fontSize:14,fontWeight:700,border:`1px solid ${C.border}` }}>📞 Call</a>
            <button onClick={()=>setDeliveryFlow(true)} style={{ flex:2,background:C.black,color:C.white,border:"none",borderRadius:8,padding:13,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:font }}>
              ✓ Confirm Delivery
            </button>
          </div>
        )}

        {/* Dispute button (Step 7) */}
        {canDispute && (
          <button onClick={()=>setShowDispute(true)} style={{ width:"100%",background:C.redBg,color:C.red,border:`1px solid ${C.red}`,borderRadius:8,padding:"11px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font,marginTop:canConfirmDelivery?0:8 }}>
            ⚖ Open a Dispute
          </button>
        )}

        {!canConfirmDelivery && !isReadyForRelease && !isDelivered && !isDisputed && !canDispute && status !== "Cancelled" && (
          <a href="tel:+254712345678" style={{ display:"block",background:C.bg,color:C.black,textDecoration:"none",textAlign:"center",borderRadius:8,padding:13,fontSize:14,fontWeight:700,border:`1px solid ${C.border}` }}>📞 Call Driver</a>
        )}

        {isDisputed && (
          <div style={{ background:C.redBg,borderRadius:8,padding:"12px 16px",textAlign:"center",fontSize:13,fontWeight:700,color:C.red }}>
            ⚖ Dispute under review · Escrow frozen · Ref: DSP-{s.id}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── INVOICE MODAL ──────────────────────────────────────── */
function InvoiceModal({ s, onClose }) {
  const today   = new Date().toLocaleDateString("en-KE", { day:"numeric", month:"long", year:"numeric" });
  const invNo   = `INV-${s.id}-${new Date().getFullYear()}`;
  const adminFee = Math.round(s.pay * 0.02);
  const net      = s.pay - adminFee;
  const [dlDone, setDlDone] = useState(false);

  function handlePrint() { window.print(); }

  /* Feature 3 — download invoice as standalone HTML (save-as PDF in browser) */
  function handleDownload() {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${invNo}</title><style>
      body{font-family:'Arial',sans-serif;margin:0;padding:32px;color:#1a1a1a;background:#fff}
      .logo{font-size:20px;font-weight:900;color:#1a1a1a}.green{color:#16a34a}
      .header{display:flex;justify-content:space-between;margin-bottom:24px}
      .inv{font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
      .inv-no{font-size:18px;font-weight:800}
      table{width:100%;border-collapse:collapse;margin-top:16px}
      th{background:#1a1a1a;color:#fff;padding:10px 14px;font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:1px}
      td{padding:10px 14px;border-bottom:1px solid #eee;font-size:13px}
      .total{background:#F0FFF4;font-weight:800;font-size:15px}
      .footer{margin-top:32px;font-size:11px;color:#999;text-align:center;border-top:1px solid #eee;padding-top:16px}
      @media print{body{padding:0}}
    </style></head><body>
      <div class="header">
        <div><span class="logo"><span class="green">|</span> Behari Freight Ltd</span><br>
          <span style="font-size:12px;color:#666">Upperhill, Nairobi · billing@beharifreight.co.ke</span></div>
        <div style="text-align:right"><div class="inv">Invoice No.</div><div class="inv-no">${invNo}</div><div style="font-size:12px;color:#666;margin-top:4px">${today}</div></div>
      </div>
      <div style="margin-bottom:16px"><b>Bill To:</b> ${s.shipper||"Shipper"} · ${s.phone||"—"}</div>
      <table><thead><tr><th>Description</th><th>Route</th><th>Driver</th><th>Weight</th></tr></thead>
        <tbody><tr><td>${s.cargo}</td><td>${s.from} → ${s.to}</td><td>${s.driver||"—"}</td><td>${s.weight||"—"}</td></tr></tbody>
      </table>
      <table style="margin-top:16px"><thead><tr><th>Item</th><th>Amount</th></tr></thead>
        <tbody>
          <tr><td>Freight charge</td><td>KSh ${s.pay.toLocaleString()}</td></tr>
          <tr><td>Platform fee (2%)</td><td style="color:#dc2626">− KSh ${adminFee.toLocaleString()}</td></tr>
          <tr><td>Net paid to transporter</td><td style="color:#16a34a">KSh ${net.toLocaleString()}</td></tr>
          <tr class="total"><td>Total Charged</td><td>KSh ${s.pay.toLocaleString()}</td></tr>
        </tbody>
      </table>
      <div style="margin-top:16px;padding:12px 16px;background:#F0FFF4;border:1px solid #16a34a;border-radius:8px;font-size:13px">
        ✅ Paid via M-Pesa Escrow · Ref: MPESA-${s.id}-${Math.floor(Math.random()*900000+100000)}
      </div>
      <div class="footer">Behari Freight Ltd · KRA PIN: P051234567M · © ${new Date().getFullYear()}</div>
    </body></html>`;
    const blob = new Blob([html], { type:"text/html" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `${invNo}.html`; a.click();
    URL.revokeObjectURL(url);
    setDlDone(true); setTimeout(()=>setDlDone(false),2500);
  }

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400,padding:16,fontFamily:font }}>
      <div style={{ background:C.white,borderRadius:16,width:"100%",maxWidth:520,maxHeight:"94vh",overflowY:"auto",boxShadow:"0 24px 64px rgba(0,0,0,0.2)" }}>

        {/* Print-friendly header bar */}
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px 20px",borderBottom:`1px solid ${C.border}` }}>
          <div style={{ fontSize:14,fontWeight:800,color:C.black }}>Freight Receipt</div>
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={handleDownload} style={{ background:dlDone?C.green:C.bg,color:dlDone?C.white:C.black,border:`1px solid ${dlDone?C.green:C.border}`,borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font,transition:"all .25s" }}>
              {dlDone?"✓ Saved!":"📥 Download"}
            </button>
            <button onClick={handlePrint} style={{ background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>🖨 Print</button>
            <button onClick={onClose}    style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>✕ Close</button>
          </div>
        </div>

        {/* Invoice body */}
        <div style={{ padding:"28px 24px 32px" }}>
          {/* Letterhead */}
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:28 }}>
            <div>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                <div style={{ width:5,height:20,background:C.green,borderRadius:3 }} />
                <span style={{ fontSize:16,fontWeight:800,color:C.black }}>Behari Freight Ltd</span>
              </div>
              <div style={{ fontSize:12,color:C.muted,lineHeight:1.6 }}>
                Upperhill, Nairobi, Kenya<br />
                billing@beharifreight.co.ke<br />
                +254 700 BEHARI
              </div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:2 }}>Invoice No.</div>
              <div style={{ fontSize:16,fontWeight:800,color:C.black,letterSpacing:0.5 }}>{invNo}</div>
              <div style={{ fontSize:12,color:C.muted,marginTop:4 }}>Date: {today}</div>
            </div>
          </div>

          {/* Divider */}
          <div style={{ height:1,background:C.border,marginBottom:20 }} />

          {/* Bill to */}
          <div style={{ marginBottom:20 }}>
            <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:6 }}>Bill To</div>
            <div style={{ fontSize:14,fontWeight:700,color:C.black }}>{s.shipper || "Your Company"}</div>
            <div style={{ fontSize:12,color:C.secondary }}>{s.phone || "+254 7XX XXX XXX"}</div>
          </div>

          {/* Shipment details */}
          <div style={{ background:C.bg,borderRadius:10,padding:"16px",marginBottom:20 }}>
            <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:12 }}>Shipment Details</div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>
              {[
                ["Load ID",      s.id],
                ["Cargo",        s.cargo],
                ["Route",        `${s.from} → ${s.to}`],
                ["Truck",        `${s.truck} · ${s.plate}`],
                ["Driver",       s.driver],
                ["Pickup Date",  s.pickD  || "—"],
                ["Delivery Date",s.delD   || "—"],
                ["Weight",       s.weight || "—"],
              ].map(([k,v]) => (
                <div key={k}>
                  <div style={{ fontSize:10,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,marginBottom:2 }}>{k}</div>
                  <div style={{ fontSize:13,fontWeight:600,color:C.black }}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Payment breakdown */}
          <div style={{ border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",marginBottom:20 }}>
            <div style={{ background:C.black,padding:"12px 16px" }}>
              <div style={{ fontSize:11,color:"rgba(255,255,255,0.55)",fontWeight:700,letterSpacing:1,textTransform:"uppercase" }}>Payment Breakdown</div>
            </div>
            {[
              { label:"Freight charge",        value:`KSh ${s.pay.toLocaleString()}`,     color:C.black, bold:false },
              { label:"Platform fee (2%)",      value:`− KSh ${adminFee.toLocaleString()}`, color:C.red,   bold:false },
              { label:"Net paid to transporter",    value:`KSh ${net.toLocaleString()}`,        color:C.green, bold:true  },
            ].map(({ label, value, color, bold }) => (
              <div key={label} style={{ display:"flex",justifyContent:"space-between",padding:"12px 16px",borderBottom:`1px solid ${C.border}` }}>
                <span style={{ fontSize:13,color:C.secondary }}>{label}</span>
                <span style={{ fontSize:13,fontWeight:bold?800:600,color }}>{value}</span>
              </div>
            ))}
            <div style={{ display:"flex",justifyContent:"space-between",padding:"16px 16px",background:C.greenBg }}>
              <span style={{ fontSize:14,fontWeight:800,color:C.black }}>Total Charged</span>
              <span style={{ fontSize:16,fontWeight:800,color:C.black }}>KSh {s.pay.toLocaleString()}</span>
            </div>
          </div>

          {/* M-Pesa reference */}
          <div style={{ background:C.greenBg,border:`1px solid ${C.green}`,borderRadius:10,padding:"14px 16px",marginBottom:20 }}>
            <div style={{ fontSize:11,color:C.green,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Payment Status</div>
            <div style={{ fontSize:14,fontWeight:700,color:C.black }}>✅ Paid via M-Pesa Escrow</div>
            <div style={{ fontSize:12,color:C.secondary,marginTop:4 }}>
              M-Pesa Ref: MPESA-{s.id}-{Math.floor(Math.random()*900000+100000)} · Released on delivery confirmation
            </div>
          </div>

          {/* Footer note */}
          <div style={{ fontSize:11,color:C.muted,textAlign:"center",lineHeight:1.6 }}>
            This receipt was generated automatically by Behari Freight Ltd.<br />
            For billing queries: billing@beharifreight.co.ke · KRA PIN: P051234567M
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── NOTIFICATIONS PANEL ────────────────────────────────── */
function NotificationsPanel({ notifications, onClose, onMarkAllRead }) {
  const unreadCount = notifications.filter(n => !n.read).length;
  return (
    <div style={{ position:"fixed",inset:0,zIndex:250 }} onClick={onClose}>
      <div style={{ position:"absolute",top:52,left:0,right:0,background:C.white,borderBottom:`1px solid ${C.border}`,maxHeight:"65vh",overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,0.12)" }} onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px",borderBottom:`1px solid ${C.border}`,position:"sticky",top:0,background:C.white,zIndex:1 }}>
          <div style={{ fontSize:15,fontWeight:800,color:C.black }}>
            Notifications {unreadCount > 0 && <span style={{ background:C.red,color:C.white,fontSize:11,fontWeight:700,borderRadius:100,padding:"2px 8px",marginLeft:6 }}>{unreadCount}</span>}
          </div>
          {unreadCount > 0 && (
            <button onClick={onMarkAllRead} style={{ background:"none",border:"none",fontSize:12,fontWeight:700,color:C.green,cursor:"pointer",fontFamily:font }}>
              Mark all read
            </button>
          )}
        </div>

        {/* Empty state */}
        {notifications.length === 0 && (
          <div style={{ textAlign:"center",padding:"48px 20px" }}>
            <div style={{ fontSize:36,marginBottom:10 }}>🔔</div>
            <div style={{ fontSize:15,fontWeight:700,color:C.secondary,marginBottom:4 }}>No notifications yet</div>
            <div style={{ fontSize:13,color:C.muted }}>You'll be notified when a transporter accepts your load</div>
          </div>
        )}

        {/* List */}
        {notifications.map((n,i,a) => (
          <div key={n.id} style={{ display:"flex",gap:12,alignItems:"flex-start",padding:"14px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none",background:n.read?C.white:"#F0FBF6" }}>
            <div style={{ width:38,height:38,borderRadius:"50%",background:C.greenBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0 }}>🚛</div>
            <div style={{ flex:1,minWidth:0 }}>
              <div style={{ fontSize:13,fontWeight:700,color:C.black,marginBottom:3 }}>Transporter Accepted Your Load</div>
              <div style={{ fontSize:12,color:C.secondary,lineHeight:1.55 }}>
                <strong>{n.carrier}</strong> assigned <strong>{n.plate}</strong> ({n.truckType}) to <strong>{n.loadId}</strong> — {n.cargo}
              </div>
              <div style={{ fontSize:11,color:C.muted,marginTop:5 }}>{n.timestamp}</div>
            </div>
            {!n.read && <div style={{ width:8,height:8,borderRadius:"50%",background:C.green,flexShrink:0,marginTop:5 }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── TABS ───────────────────────────────────────────────── */
function Dashboard({ onPost, onDetail, allShipments = [], identity = null }) {
  // Phase 3B: allShipments already comes fully merged (canonical load +
  // live booking + loadStatuses override) from getAllKnownLoads() +
  // toShipperShipmentView() in the root component — no local merge needed.
  const active = sortNewestFirst(allShipments.filter(s => s.status !== "Delivered"));
  return (
    <div style={{ padding:12 }}>
      <div style={{ background:C.black,borderRadius:12,padding:"18px 16px",marginBottom:12 }}>
        <div style={{ fontSize:10,color:"rgba(255,255,255,0.45)",fontWeight:700,letterSpacing:1,marginBottom:2 }}>LOGGED IN AS</div>
        <div style={{ fontSize:22,fontWeight:800,color:C.white,letterSpacing:-0.3 }}>{identity?.company || identity?.name || "—"}</div>
        <div style={{ fontSize:13,color:"rgba(255,255,255,0.6)",marginTop:4,fontWeight:600 }}>{identity?.company && identity?.name ? identity.name : "Shipper"}{identity?.phone ? ` · ${identity.phone}` : ""}</div>
      </div>

      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12 }}>
        {[["Active Loads",String(active.length)],["Delivered",String(allShipments.filter(x=>x.status==="Delivered"||x.status==="Paid Out").length)]].map(([l,v])=>(
          <div key={l} style={{ ...card,padding:"14px 14px" }}>
            <div style={{ fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5,marginBottom:4 }}>{l}</div>
            <div style={{ fontSize:22,fontWeight:800,color:C.black,letterSpacing:-0.3 }}>{v}</div>
          </div>
        ))}
      </div>

      <button onClick={onPost} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:8,padding:14,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font,marginBottom:14 }}>
        + Post a New Load
      </button>

      <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Active Shipments</div>
      {active.length === 0 && (
        <div style={{ ...card,padding:"28px 18px",textAlign:"center" }}>
          <div style={{ fontSize:15,fontWeight:700,color:C.secondary,marginBottom:4 }}>No cargo posted yet</div>
          <div style={{ fontSize:13,color:C.muted }}>Post your first load to start finding transporters.</div>
        </div>
      )}
      {active.map(s=>(
        <div key={s.id} onClick={()=>onDetail(s)} style={{ ...card,padding:16,marginBottom:8,cursor:"pointer" }}>
          <div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}>
            <div>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                <span style={{ fontSize:11,color:C.muted }}>{s.id}</span>
                <Pill status={s.status} label={statusLabel(s)} />
              </div>
              <div style={{ fontSize:17,fontWeight:700,color:C.black }}>{s.cargo}</div>
              <div style={{ fontSize:13,color:C.secondary }}>{s.from} → {s.to}</div>
            </div>
            <div style={{ fontSize:17,fontWeight:800,color:C.black }}>KSh {s.pay.toLocaleString()}</div>
          </div>
          <ProgressBar value={s.progress} />
          <div style={{ display:"flex",justifyContent:"space-between",marginTop:8 }}>
            <div style={{ fontSize:12,color:C.black,fontWeight:600 }}>{s.driver} · {s.plate}</div>
            <div style={{ fontSize:11,color:C.muted }}>📍 {s.ping}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Shipments({ onDetail, allShipments = [] }) {
  // Phase 3B: allShipments already comes fully merged from the root
  // component — see Dashboard's comment above for why no local merge is
  // needed here anymore.
  /* Feature 24 — recurring filter */
  const [shipFilter, setShipFilter] = useState("All"); // "All" | "Recurring"
  const [manageScheduleId, setManageScheduleId] = useState(null);

  const recurringLoads = allShipments.filter(s => s.recurring);

  const displayed = allShipments.filter(s => {
    if (shipFilter === "Recurring") return s.recurring;
    return true;
  });

  return (
    <div style={{ padding:12 }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase" }}>All Shipments</div>
        <div style={{ display:"flex",gap:5 }}>
          {["All","Recurring"].map(f=>(
            <button key={f} onClick={()=>setShipFilter(f)} style={{ background:shipFilter===f?C.black:C.bg, color:shipFilter===f?C.white:C.secondary, border:`1px solid ${shipFilter===f?C.black:C.border}`, borderRadius:100, padding:"4px 10px", fontSize:10, fontWeight:700, cursor:"pointer", fontFamily:font }}>{f}</button>
          ))}
        </div>
      </div>
      {/* Recurring schedule summary */}
      {shipFilter==="Recurring" && recurringLoads.length>0 && (
        <div style={{ background:C.amberBg,border:`1px solid ${C.amber}`,borderRadius:10,padding:"12px 14px",marginBottom:12,fontSize:12,color:C.amber,fontWeight:600 }}>
          ♻ {recurringLoads.length} recurring load{recurringLoads.length>1?"s":""} active
          <button onClick={()=>setManageScheduleId("all")} style={{ background:C.amber,color:C.white,border:"none",borderRadius:6,padding:"4px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font,marginLeft:10 }}>Manage Schedule</button>
        </div>
      )}
      {manageScheduleId && (
        <div style={{ ...card,padding:16,marginBottom:12,border:`1.5px solid ${C.amber}` }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
            <div style={{ fontSize:14,fontWeight:800,color:C.black }}>♻ Recurring Schedule</div>
            <button onClick={()=>setManageScheduleId(null)} style={{ background:"none",border:"none",color:C.muted,fontSize:16,cursor:"pointer" }}>✕</button>
          </div>
          {recurringLoads.length===0 && <div style={{ fontSize:13,color:C.muted }}>No recurring loads yet. Enable "Repeat this load" when posting.</div>}
          {recurringLoads.map(s=>(
            <div key={s.id} style={{ background:C.bg,borderRadius:8,padding:"10px 12px",marginBottom:8 }}>
              <div style={{ fontSize:13,fontWeight:700,color:C.black }}>{s.cargo}</div>
              <div style={{ fontSize:11,color:C.muted }}>{s.from} → {s.to} · {s.recurFreq||"weekly"}</div>
              <div style={{ display:"flex",gap:6,marginTop:8 }}>
                <button style={{ background:C.redBg,color:C.red,border:`1px solid ${C.red}33`,borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font }}>Pause</button>
                <button style={{ background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font }}>Edit Frequency</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {displayed.length===0 && <div style={{ textAlign:"center",padding:32,color:C.muted,fontSize:13 }}>No {shipFilter.toLowerCase()} loads found</div>}
      {displayed.map(s=>(
        <div key={s.id} onClick={()=>onDetail(s)} style={{ ...card,padding:16,marginBottom:8,cursor:"pointer" }}>
          <div style={{ display:"flex",justifyContent:"space-between",marginBottom:8 }}>
            <div style={{ display:"flex",alignItems:"center",gap:8 }}>
              <span style={{ fontSize:11,color:C.muted }}>{s.id}</span>
              <Pill status={s.status} label={statusLabel(s)} />
              {s.recurring && <span style={{ background:C.amberBg,color:C.amber,fontSize:9,fontWeight:700,borderRadius:100,padding:"2px 6px" }}>♻ REPEAT</span>}
            </div>
            <span style={{ fontSize:16,fontWeight:800,color:C.black }}>KSh {s.pay.toLocaleString()}</span>
          </div>
          <div style={{ fontSize:17,fontWeight:700,color:C.black,marginBottom:2 }}>{s.cargo}</div>
          <div style={{ fontSize:13,color:C.secondary,marginBottom:10 }}>{s.from} → {s.to}</div>
          <ProgressBar value={s.progress} />
          <div style={{ display:"flex",justifyContent:"space-between",marginTop:8 }}>
            <div style={{ fontSize:12,fontWeight:600,color:C.black }}>{s.driver} · {s.plate}</div>
            <div style={{ fontSize:11,color:C.muted }}>📍 {s.ping}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function History({ allShipments = [] }) {
  // Phase 3B: previously rendered only SHIPMENT_HISTORY_SEED's 3 hardcoded
  // entries; now shows every completed/paid load in the unified dataset
  // (including ones that used to only appear in Dashboard/Shipments), which
  // is the correct behavior once "shipments" and "history" stop being two
  // independently-authored arrays for the same underlying loads.
  const completed = allShipments.filter(s => s.status === "Delivered" || s.status === "Paid Out");
  return (
    <div style={{ padding:12 }}>
      <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:10 }}>Completed Shipments</div>
      {completed.map(h=>(
        <div key={h.id} style={{ ...card,padding:"14px 16px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <div>
            <div style={{ fontSize:11,color:C.muted,marginBottom:3 }}>{h.id} · {h.date}</div>
            <div style={{ fontSize:16,fontWeight:700,color:C.black }}>{h.cargo}</div>
            <div style={{ fontSize:13,color:C.secondary }}>{h.route}</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:15,fontWeight:800,color:C.black,marginBottom:6 }}>KSh {h.pay.toLocaleString()}</div>
            {h.rated
              ? <span style={{ fontSize:11,fontWeight:700,color:C.green }}>★★★★★ RATED</span>
              : <button onClick={()=>alert("Rating submitted!")} style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>Rate Driver</button>
            }
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── SPEND ANALYTICS ─────────────────────────────────────── */
function Analytics({ allShipments = [] }) {
  const [budgetCap, setBudgetCap] = useState(() => {
    try { return localStorage.getItem("behari_budget_cap") || ""; } catch { return ""; }
  });
  const [editBudget, setEditBudget] = useState(false);
  // Phase 3B: allShipments is the single unified list (see Dashboard/History
  // above) — just filter to completed loads instead of merging 3 sources.
  const allLoads = allShipments.filter(s => s.status === "Delivered" || s.status === "Paid Out");

  const totalSpend = allLoads.reduce((s,l)=>s+l.pay,0);

  // Spend by cargo type (top 5)
  const byType = {};
  allLoads.forEach(l => { if (l.cargo) { byType[l.cargo] = (byType[l.cargo]||0) + l.pay; }});
  const typeEntries = Object.entries(byType).sort((a,b)=>b[1]-a[1]).slice(0,5);

  // Spend by corridor (top 5)
  const byCorridor = {};
  allLoads.forEach(l => { if (l.from && l.to) { const k = `${l.from.split(",")[0]} → ${l.to.split(",")[0]}`; byCorridor[k] = (byCorridor[k]||0) + l.pay; }});
  const corridorEntries = Object.entries(byCorridor).sort((a,b)=>b[1]-a[1]).slice(0,5);

  return (
    <div style={{ padding:12 }}>
      {/* Hero */}
      <div style={{ background:C.black,borderRadius:12,padding:"20px 16px",marginBottom:12 }}>
        <div style={{ fontSize:11,color:"rgba(255,255,255,0.45)",fontWeight:700,letterSpacing:1,marginBottom:4 }}>2026 TOTAL SPEND</div>
        <div style={{ fontSize:36,fontWeight:800,color:C.white,letterSpacing:-1 }}>KSh {totalSpend.toLocaleString()}</div>
      </div>

      {/* Budget Cap alert (Feature 17) */}
      {editBudget ? (
        <div style={{ ...card,padding:"12px 14px",marginBottom:12,display:"flex",gap:8,alignItems:"center" }}>
          <input type="number" placeholder="Monthly budget cap (KSh)" value={budgetCap} onChange={e=>setBudgetCap(e.target.value)}
            style={{ flex:1,padding:"9px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",color:C.black }} />
          <button onClick={()=>{ localStorage.setItem("behari_budget_cap",budgetCap); setEditBudget(false); }} style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:"9px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font }}>Save</button>
        </div>
      ) : (
        <div style={{ ...card,padding:"12px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer" }} onClick={()=>setEditBudget(true)}>
          <div style={{ fontSize:13,fontWeight:600,color:C.black }}>💰 Monthly Budget Cap{budgetCap ? `: KSh ${Number(budgetCap).toLocaleString()}` : ""}</div>
          <span style={{ fontSize:12,color:C.muted,fontWeight:600 }}>{budgetCap?"Edit ›":"Set cap ›"}</span>
        </div>
      )}
      {budgetCap && Number(budgetCap) > 0 && totalSpend >= Number(budgetCap) * 0.8 && (
        <div style={{ background:totalSpend>=Number(budgetCap)?C.redBg:C.amberBg,border:`1px solid ${totalSpend>=Number(budgetCap)?C.red:C.amber}`,borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:13,fontWeight:700,color:totalSpend>=Number(budgetCap)?C.red:C.amber }}>
          {totalSpend>=Number(budgetCap)?"🚨 Budget exceeded!":"⚠"} KSh {totalSpend.toLocaleString()} of KSh {Number(budgetCap).toLocaleString()} budget used ({Math.round((totalSpend/Number(budgetCap))*100)}%)
        </div>
      )}

      {/* Summary cards */}
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16 }}>
        {[["Loads Posted",String(allLoads.length)],["Avg per Load",`KSh ${allLoads.length?Math.round(totalSpend/allLoads.length).toLocaleString():0}`]].map(([l,v])=>(
          <div key={l} style={{ ...card,padding:"14px 16px" }}>
            <div style={{ fontSize:11,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,marginBottom:4 }}>{l}</div>
            <div style={{ fontSize:20,fontWeight:800,color:C.black }}>{v}</div>
          </div>
        ))}
      </div>

      {/* By cargo type */}
      <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Spend by Cargo Type</div>
      <div style={{ ...card,overflow:"hidden",marginBottom:16 }}>
        {typeEntries.length === 0 && <div style={{ padding:"14px 16px",fontSize:13,color:C.muted }}>No data yet — post your first load!</div>}
        {typeEntries.map(([type,spend],i,a)=>{
          const pct = Math.round((spend/totalSpend)*100);
          return (
            <div key={type} style={{ padding:"12px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
              <div style={{ display:"flex",justifyContent:"space-between",marginBottom:6 }}>
                <span style={{ fontSize:13,fontWeight:600,color:C.black }}>{type}</span>
                <span style={{ fontSize:13,fontWeight:800,color:C.black }}>KSh {spend.toLocaleString()} · {pct}%</span>
              </div>
              <div style={{ background:C.border,borderRadius:2,height:3,overflow:"hidden" }}>
                <div style={{ width:`${pct}%`,height:"100%",background:C.green,transition:"width 0.5s" }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* By corridor */}
      <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Top Corridors</div>
      <div style={{ ...card,overflow:"hidden" }}>
        {corridorEntries.length === 0 && <div style={{ padding:"14px 16px",fontSize:13,color:C.muted }}>No corridor data yet.</div>}
        {corridorEntries.map(([route,spend],i,a)=>(
          <div key={route} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
            <span style={{ fontSize:13,fontWeight:600,color:C.black,flex:1 }}>{route}</span>
            <span style={{ fontSize:13,fontWeight:800,color:C.black,flexShrink:0 }}>KSh {spend.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── MULTI-TRUCK SLOTS PANEL (Step 5) ───────────────────── */
function MultiTruckPanel({ slots = [], truckCount = 1 }) {
  if (truckCount <= 1) return null;
  return (
    <div style={{ background:C.bg,borderRadius:12,padding:"12px 14px",marginBottom:14 }}>
      <div style={{ fontSize:10,fontWeight:700,color:C.muted,letterSpacing:0.8,textTransform:"uppercase",marginBottom:10 }}>
        Fleet Fulfillment — {slots.length}/{truckCount} trucks booked
      </div>
      {/* Filled slots */}
      {slots.map((sl,i) => (
        <div key={sl.slotId} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 10px",background:C.white,borderRadius:8,marginBottom:6,border:`1px solid ${C.border}` }}>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <div style={{ width:28,height:28,borderRadius:6,background:C.greenBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14 }}>🚛</div>
            <div>
              <div style={{ fontSize:13,fontWeight:700,color:C.black }}>{sl.plate} · {sl.carrier}</div>
              <div style={{ fontSize:11,color:C.muted }}>{sl.truckType} · Slot {i+1}</div>
            </div>
          </div>
          <span style={{ fontSize:10,fontWeight:700,color:C.green,background:C.greenBg,padding:"3px 8px",borderRadius:100 }}>Booked</span>
        </div>
      ))}
      {/* Empty slots */}
      {Array.from({ length: Math.max(0, truckCount - slots.length) }).map((_,i) => (
        <div key={`empty-${i}`} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 10px",background:C.white,borderRadius:8,marginBottom:6,border:`1.5px dashed ${C.border}` }}>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <div style={{ width:28,height:28,borderRadius:6,background:C.bg,border:`1px dashed ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:C.muted }}>?</div>
            <div>
              <div style={{ fontSize:12,fontWeight:700,color:C.muted }}>Slot {slots.length + i + 1} — Awaiting transporter</div>
              <div style={{ fontSize:11,color:C.muted }}>Matching in progress…</div>
            </div>
          </div>
          <div style={{ width:8,height:8,borderRadius:"50%",background:C.amber,animation:"pulse 2s infinite" }} />
        </div>
      ))}
      {/* Partial fulfillment banner */}
      {slots.length > 0 && slots.length < truckCount && (
        <div style={{ background:C.amberBg,borderRadius:8,padding:"8px 12px",fontSize:12,color:C.amber,fontWeight:600,marginTop:4 }}>
          ⏳ Partial fulfillment — {truckCount - slots.length} more truck{truckCount - slots.length > 1?"s":""} needed
        </div>
      )}
    </div>
  );
}

/* ── SHIPPER RATING MODAL (Step 8) ─────────────────────── */
function ShipperRatingModal({ shipment, onClose, onSubmitRating }) {
  const [scores,  setScores]  = useState(() => Object.fromEntries(CARRIER_RATING_DIMS.map(d => [d.id, 0])));
  const [comment, setComment] = useState("");
  const [done,    setDone]    = useState(false);

  const allFilled = CARRIER_RATING_DIMS.every(d => scores[d.id] > 0);

  async function handleSubmit() {
    await onSubmitRating({
      loadId:   shipment.id,
      raterRole:"shipper",
      rateeId:  shipment.driver || "Transporter",
      scores,
      comment,
    });
    setDone(true);
  }

  if (done) return (
    <div style={{ position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"32px 20px 48px",textAlign:"center" }}>
        <div style={{ fontSize:56,marginBottom:12 }}>⭐</div>
        <div style={{ fontSize:22,fontWeight:800,color:C.black,marginBottom:6 }}>Rating Submitted!</div>
        <div style={{ fontSize:14,color:C.secondary,marginBottom:24 }}>Transporter will see your feedback. It helps build trust on the platform.</div>
        <button onClick={onClose} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:10,padding:14,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
      </div>
    </div>
  );

  return (
    <div style={{ position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(4px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,maxHeight:"90vh",overflowY:"auto",padding:"8px 20px 40px" }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />

        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Rate This Transporter</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:2 }}>{shipment.driver || "Transporter"}</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:20 }}>{shipment.cargo} · {shipment.id}</div>

        {CARRIER_RATING_DIMS.map(d => (
          <div key={d.id} style={{ marginBottom:18 }}>
            <div style={{ fontSize:13,fontWeight:700,color:C.black,marginBottom:3 }}>{d.icon} {d.label}</div>
            <div style={{ fontSize:11,color:C.muted,marginBottom:8 }}>{d.desc}</div>
            <div style={{ display:"flex",gap:6 }}>
              {[1,2,3,4,5].map(n => (
                <button key={n} onClick={() => setScores(s => ({...s,[d.id]:n}))} style={{
                  flex:1, padding:"10px 4px", border:`2px solid ${scores[d.id]>=n?C.black:C.border}`,
                  borderRadius:8, background:scores[d.id]>=n?C.black:C.white,
                  color:scores[d.id]>=n?C.white:C.muted, fontSize:16, cursor:"pointer",
                  transition:"all 0.12s", fontFamily:font,
                }}>★</button>
              ))}
            </div>
          </div>
        ))}

        <textarea
          placeholder="Any feedback about the delivery? (optional)"
          value={comment} onChange={e=>setComment(e.target.value)}
          style={{ width:"100%",minHeight:72,padding:"10px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,resize:"vertical",outline:"none",marginBottom:16 }}
        />

        <button
          onClick={handleSubmit} disabled={!allFilled}
          style={{ width:"100%",background:allFilled?C.green:C.border,color:allFilled?C.black:C.muted,border:"none",borderRadius:10,padding:15,fontSize:15,fontWeight:700,cursor:allFilled?"pointer":"not-allowed",fontFamily:font }}
        >
          {allFilled ? "⭐ Submit Rating" : "Rate all categories to continue"}
        </button>
      </div>
    </div>
  );
}

/* ── SHIPPER DISPUTE MODAL (Step 7) ─────────────────────── */
function ShipperDisputeModal({ shipment, onClose, onOpenDispute }) {
  const [reason,   setReason]   = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy,     setBusy]     = useState(false);
  const [done,     setDone]     = useState(false);

  async function handleSubmit() {
    if (!reason.trim()) return;
    setBusy(true);
    await onOpenDispute(shipment.id, { raisedBy:"Shipper", reason, evidence });
    setBusy(false);
    setDone(true);
  }

  if (done) return (
    <div style={{ position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"32px 20px 48px",textAlign:"center" }}>
        <div style={{ fontSize:48,marginBottom:12 }}>⚖️</div>
        <div style={{ fontSize:22,fontWeight:800,color:C.black,marginBottom:8 }}>Dispute Filed</div>
        <div style={{ background:C.amberBg,borderRadius:10,padding:"14px 16px",marginBottom:24,fontSize:13,color:C.amber,fontWeight:600,textAlign:"left" }}>
          🔒 Escrow frozen · Ref: DSP-{shipment.id}<br />
          Our team will contact both parties within 2 business hours.
        </div>
        <button onClick={onClose} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:10,padding:14,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
      </div>
    </div>
  );

  return (
    <div style={{ position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(4px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,maxHeight:"90vh",overflowY:"auto",padding:"8px 20px 40px" }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ fontSize:11,color:C.red,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Open Dispute</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:2 }}>{shipment.cargo} · {shipment.id}</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:16 }}>{shipment.from} → {shipment.to}</div>
        <div style={{ background:C.amberBg,borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:12,color:C.amber,fontWeight:600 }}>
          ⚠ This will freeze the escrow until admin resolution. Only use for genuine issues.
        </div>
        <label style={{ display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:6 }}>Issue Description *</label>
        <textarea
          placeholder="e.g. Cargo arrived damaged, driver late by 3 days…"
          value={reason} onChange={e=>setReason(e.target.value)}
          style={{ width:"100%",minHeight:90,padding:"10px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${reason?C.black:C.border}`,borderRadius:8,resize:"vertical",outline:"none",marginBottom:12 }}
        />
        <label style={{ display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:6 }}>Evidence Notes (optional)</label>
        <textarea
          placeholder="Photos taken, WhatsApp messages, damage report number…"
          value={evidence} onChange={e=>setEvidence(e.target.value)}
          style={{ width:"100%",minHeight:64,padding:"10px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,resize:"vertical",outline:"none",marginBottom:6 }}
        />
        <div style={{ fontSize:11,color:C.muted,marginBottom:20 }}>📎 Upload photos after submission via +254 700 BEHARI</div>
        <div style={{ display:"flex",gap:8 }}>
          <button onClick={onClose} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Cancel</button>
          <button onClick={handleSubmit} disabled={!reason.trim()||busy} style={{ flex:2,background:reason.trim()?C.red:C.border,color:reason.trim()?C.white:C.muted,border:"none",borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:reason.trim()?"pointer":"not-allowed",fontFamily:font }}>
            {busy?"Filing…":"File Dispute"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── SHIPPER LIVE TRACKING — real backend GPS only; no simulated position ── */
function ShipperTrackingModal({ s, onClose }) {
  const live = useLiveTripByLoadId(s.id);
  if (live.trip) {
    return <TripTrackingModal trip={live.trip} role="shipper" onClose={onClose} />;
  }
  return (
    <div style={{ position:"fixed",inset:0,zIndex:500,display:"flex",alignItems:"flex-end",justifyContent:"center" }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.65)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:520,padding:"20px 18px 32px" }}>
        <div style={{ display:"flex",justifyContent:"space-between",marginBottom:10 }}>
          <div style={{ fontSize:16,fontWeight:800,color:C.black }}>Live tracking</div>
          <button onClick={onClose} aria-label="Close" style={{ background:"none",border:"none",fontSize:22,cursor:"pointer",color:C.muted }}>×</button>
        </div>
        <div data-testid="tracking-unavailable" style={{ fontSize:13,fontWeight:700,color:C.secondary }}>
          {live.loading ? "Checking live tracking…" : "Live location unavailable."}
        </div>
        {!live.loading && <div style={{ fontSize:12,color:C.muted,marginTop:6 }}>Tracking starts once a trip has been created and the driver is reporting GPS.</div>}
      </div>
    </div>
  );
}

/* ── TOAST NOTIFICATION (Feature 5 — SMS Alerts) ─────────── */
function Toast({ message, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{ position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",background:C.black,color:C.white,borderRadius:10,padding:"12px 20px",fontSize:13,fontWeight:600,fontFamily:font,zIndex:9999,maxWidth:340,textAlign:"center",boxShadow:"0 8px 24px rgba(0,0,0,0.3)",animation:"slideDown 0.3s ease" }}>
      <style>{`@keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`}</style>
      {message}
    </div>
  );
}

/* ── ROOT ───────────────────────────────────────────────── */
const LANG_KEY_SHIPPER = "behari_lang_shipper";
const I18N_SHIPPER = {
  en: { dashboard:"Dashboard", shipments:"Shipments", history:"History", analytics:"Analytics", shipper:"SHIPPER PORTAL · KENYA" },
  sw: { dashboard:"Dashibodi", shipments:"Mizigo", history:"Historia", analytics:"Takwimu", shipper:"LANGO LA MSAFIRISHAJI" },
};

const NAV = [
  { id:0, label:"Dashboard", icon:"⊞" },
  { id:1, label:"Shipments", icon:"≡" },
  { id:2, label:"History",   icon:"◎" },
  { id:3, label:"Analytics", icon:"◈" },
];

export default function BehariShipper({ onPostLoad = ()=>{}, postedLoads = [], notifications = [], deliveredLoadIds = new Set(), onConfirmDelivery = ()=>{}, onLogout = ()=>{},
  loadStatuses = {}, escrowData = {},
  onReleaseEscrow = ()=>{}, onRefundEscrow = ()=>{}, onOpenDispute = ()=>{}, onCancelShipment = ()=>{},
  // Step 5: multi-truck
  bookingSlots = {},
  // Step 8: ratings
  onSubmitRating = ()=>{},
  // Legal modal trigger (passed from App.jsx)
  onShowLegal = ()=>{},
  // Dark mode (lifted to App.jsx — uniform across all portals)
  darkMode = false, toggleDark = ()=>{},
}) {
  const [tab, setTab]               = useState(0);
  const [posting, setPosting]       = useState(false);
  const [detail, setDetail]         = useState(null);
  const [toast, setToast]           = useState(null); // Feature 5 — SMS alert simulation
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem(LANG_KEY_SHIPPER) || "en"; } catch { return "en"; }
  });
  function toggleLang() {
    const next = lang === "en" ? "sw" : "en";
    setLang(next);
    try { localStorage.setItem(LANG_KEY_SHIPPER, next); } catch (_) {}
  }
  const tl = I18N_SHIPPER[lang];

  // Phase 3B — the single unified shipment list. Replaces the old
  // per-component merges of postedLoads + SHIPMENTS_SEED + SHIPMENT_HISTORY_SEED
  // with one call into the centralized pipeline: canonical load (SEED_LOADS
  // or a freshly-posted load) → toShipperShipmentView (live booking +
  // loadStatuses override + shipper-facing field shaping already applied).
  // Passed to every tab below instead of each one re-deriving its own merge.
  // 5D-3: the backend is the load source. Local records already linked to a backend load are dropped
  // in favour of the backend copy; anything else local is demo data (browsable, no commercial actions).
  const commerce = useCommerce("shipper");
  const seenNotifs = useRef(null);
  useEffect(() => {
    if (!commerce.ready) return;
    const ids = new Set(commerce.notifications.map(n => n.id));
    if (seenNotifs.current) {
      const fresh = commerce.notifications.filter(n => !seenNotifs.current.has(n.id));
      if (fresh.length) setToast(`${fresh[0].title}: ${fresh[0].body}`);
    }
    seenNotifs.current = ids;
  }, [commerce.notifications, commerce.ready]);
  const backendShipments = commerce.loads.filter(v => v.price != null).map(v => {
    const booking = commerce.bookings.find(b => b.loadId === v.id);
    const status = v.status === "Open" ? "Escrow Held" : v.status;
    const road = v.distanceSource === "ROAD" && v.distanceMeters > 0;
    return {
      id:v.id, backendLoadId:v.id, isBackend:true, status,
      cargo:v.cargo, from:v.origin, to:v.destination, route:`${v.origin} → ${v.destination}`,
      weight:v.weight ?? "—", truck:v.truckType || "Any Available",
      pay:v.price ?? 0, agreedAmount: booking?.agreedAmount ?? null, dist:road ? metersToKm(v.distanceMeters) : 0, distSource:road ? "route" : "unresolved",
      pickD:v.pickupDate || "TBD", eta:"TBD", truckCount:1,
      progress:status === "Escrow Held" ? 10 : 25,
      driver: booking ? "Transporter booked" : "Matching transporter…", plate:"—",
      ping: booking ? `Price agreed · ${paymentView(booking.payment).label}` : "Awaiting offers",
      createdAt: v.createdAt ? Date.parse(v.createdAt) : 0,
    };
  }).sort((a,b) => b.createdAt - a.createdAt);
  const allShipments = backendShipments;

  function openNotification(n) {
    const offer = commerce.offers.find(o => o.id === n.relatedEntityId);
    const loadId = offer?.loadId ?? commerce.bookings.find(b => b.id === n.relatedEntityId || b.payment?.paymentId === n.relatedEntityId || b.payment?.escrowId === n.relatedEntityId || (commerce.finance[b.id]?.adjustments || []).some(a => a.id === n.relatedEntityId))?.loadId;
    const target = allShipments.find(x => x.id === loadId);
    if (target) setDetail(target);
  }
  // keep an open detail modal fresh as backend state changes
  const liveDetail = detail ? (allShipments.find(x => x.id === detail.id) || detail) : null;

  return (
    <div style={{ background:C.bg, minHeight:"100vh", fontFamily:font, color:C.black, paddingBottom:68 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{display:none}
        input::placeholder,select::placeholder{color:#9E9E9E}
      `}</style>

      {/* App bar */}
      <div style={{ background:C.white,borderBottom:`1px solid ${C.border}`,padding:"0 16px",position:"sticky",top:0,zIndex:100 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",height:52 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <div style={{ width:5,height:22,background:C.green,borderRadius:3 }} />
            <div>
              <div style={{ fontSize:15,fontWeight:800,color:C.black,letterSpacing:-0.3 }}>Behari Freight</div>
              <div style={{ fontSize:10,color:C.muted,fontWeight:600,letterSpacing:0.5 }}>{tl.shipper}</div>
            </div>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <button onClick={toggleLang} style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.secondary }}>
              {lang === "en" ? "🇰🇪 SW" : "🇬🇧 EN"}
            </button>
            {/* Dark mode toggle — near bell */}
            <button onClick={toggleDark} title={darkMode?"Switch to light mode":"Switch to dark mode"} style={{ background:"none",border:`1px solid transparent`,borderRadius:8,width:36,height:36,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18,flexShrink:0 }}>
              {darkMode ? "☀️" : "🌙"}
            </button>
            <CommerceBell notifications={commerce.notifications} onOpen={openNotification} onMarkRead={commerce.markRead} />
            <button onClick={()=>setPosting(true)} style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:"8px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font }}>
              + Post Cargo
            </button>
            {/* Avatar — tap to sign out, mirrors carrier portal */}
            <div onClick={onLogout} title="Sign out" style={{ width:34,height:34,borderRadius:"50%",background:C.black,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:C.white,cursor:"pointer",flexShrink:0 }}>{(commerce.identity?.name || "—").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()}</div>
          </div>
        </div>
      </div>

      {tab===0 && <Dashboard onPost={()=>setPosting(true)} onDetail={setDetail} allShipments={allShipments} identity={commerce.identity} />}
      {tab===0 && (
        <div style={{ padding:"0 12px 12px" }}>
          <NotLive icon="🧭" title="Nearby trucks & matching" body="Behari will automatically match your cargo with available trucks along their routes." />
          <NotLive compact icon="💬" title="Chat with transporter" />
          <NotLive compact icon="⭐" title="Transporter profiles & ratings" />
          <NotLive compact icon="🛡️" title="Cargo insurance" />
        </div>
      )}
      {tab===1 && <Shipments onDetail={setDetail} allShipments={allShipments} />}
      {tab===2 && <History allShipments={allShipments} />}
      {tab===3 && <Analytics allShipments={allShipments} />}

      {/* Bottom tab bar */}
      <div style={{ position:"fixed",bottom:0,left:0,right:0,background:C.white,borderTop:`1px solid ${C.border}`,display:"flex",zIndex:200 }}>
        {NAV.map(n=>{
          const navLabel = [tl.dashboard,tl.shipments,tl.history,tl.analytics][n.id] || n.label;
          return (
            <button key={n.id} onClick={()=>setTab(n.id)} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2,padding:"10px 4px 12px",background:"none",border:"none",cursor:"pointer",fontFamily:font }}>
              <span style={{ fontSize:20,lineHeight:1 }}>{n.icon}</span>
              <span style={{ fontSize:10,fontWeight:tab===n.id?700:500,color:tab===n.id?C.black:C.muted }}>{navLabel}</span>
              {tab===n.id && <div style={{ width:18,height:2.5,background:C.black,borderRadius:2,marginTop:1 }} />}
            </button>
          );
        })}
      </div>

      {/* Legal footer strip */}
      <div style={{ padding:"16px 20px 80px",display:"flex",gap:20,justifyContent:"center",flexWrap:"wrap" }}>
        <span onClick={()=>onShowLegal("terms")}   style={{ fontSize:11,color:C.muted,cursor:"pointer",fontWeight:500 }}>Terms of Service</span>
        <span onClick={()=>onShowLegal("privacy")} style={{ fontSize:11,color:C.muted,cursor:"pointer",fontWeight:500 }}>Privacy Policy</span>
        <span style={{ fontSize:11,color:C.muted }}>© 2026 Behari Freight Ltd</span>
      </div>

      {posting && <PostModal onClose={()=>setPosting(false)} onPostLoad={onPostLoad} />}
      {liveDetail && <DetailModal s={liveDetail} commerce={commerce} onClose={()=>setDetail(null)} onConfirmDelivery={onConfirmDelivery} escrowData={escrowData} bookingSlots={bookingSlots} onOpenDispute={onOpenDispute} onSubmitRating={onSubmitRating} />}
      {/* Feature 5: SMS Alert Toast */}
      {toast && <Toast message={toast} onDone={()=>setToast(null)} />}
    </div>
  );
}

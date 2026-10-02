import { useState, useEffect, useRef } from "react";
import { useAdminOps } from "./src/hooks/useAdminOps.js";
import { INCIDENT_TYPES, INCIDENT_SEVERITY } from "./src/models/incident.js";
import { COLORS as C_SHARED, FONT as FONT_SHARED, MONO as MONO_SHARED } from "./src/constants/theme.js";
import { STATUS_MAP as STATUS_MAP_SHARED, RISK_MAP as RISK_MAP_SHARED, PRI_MAP as PRI_MAP_SHARED, SEV_MAP as SEV_MAP_SHARED } from "./src/constants/status.js";
// Phase 3A of the seed-data unification — Admin's load list now comes from
// the centralized pipeline (canonical SEED_LOADS + live postedLoads) instead
// of its own private, independently-authored LOADS array. See
// src/services/loadViews.js for the merge/formatting logic.
import { getAllKnownLoads, toAdminLoadView } from "./src/services/loadViews.js";
// Matching engine — pure model function + shared stats component
import { scoreMatch } from "./src/models/match.js";
import NetworkStats from "./src/components/matching/NetworkStats.jsx";
// Phase 4G — real backend GPS (Phase 4F). Truck/driver names are resolved
// from the frontend's own fleetService (still localStorage, per 4F/4G's
// scope boundary — only the tracking trust boundary moved to the backend)
// since the backend's Trip rows only carry ids.
import { useAllLiveTrips } from "./src/hooks/useLiveTrip.js";
import { getTrucks, getDrivers } from "./src/services/fleetService.js";

/* ── Design tokens — sourced from shared constants ───────────────────────── */
const C        = C_SHARED;
const font     = FONT_SHARED;
const mono     = MONO_SHARED;
const card     = { background:C.white, borderRadius:8, boxShadow:"0 1px 4px rgba(0,0,0,0.08)", border:`1px solid ${C.border}` };
const darkCard = { background:C.darkCard, borderRadius:8, border:"1px solid #30363D" };

/* ── Seed data (keep for KYC / Disputes / Financials) ───────────────────── */
const KYC_QUEUE = [
  { id:"U-4421", name:"David Mutua",    phone:"+254 712 441 009", type:"Driver",  truck:"KCY 882P", submitted:"2h ago",  docs:[true,true,false],  risk:"Low"    },
  { id:"U-4422", name:"Amina Hassan",   phone:"+254 722 183 774", type:"Shipper", company:"Hassan Traders Ltd", submitted:"4h ago",  docs:[true,true,true],   risk:"Low"    },
  { id:"U-4423", name:"Joseph Kamori",  phone:"+254 733 992 114", type:"Driver",  truck:"KDM 551J", submitted:"6h ago",  docs:[true,true,true],   risk:"Medium" },
  { id:"U-4424", name:"Fatuma Ochieng", phone:"+254 701 338 220", type:"Driver",  truck:"KBR 774F", submitted:"1d ago",  docs:[false,true,true],  risk:"High"   },
];
const DISPUTES_SEED = [
  { id:"D-0091", load:"KE-2038", type:"Late Delivery",   shipper:"Bamburi Cement", driver:"Samuel Kamau",  amount:68500, status:"Open",      filed:"May 14", priority:"High"   },
  { id:"D-0090", load:"KE-2031", type:"Cargo Damage",    shipper:"Unga Group Ltd", driver:"Peter Otieno",  amount:28000, status:"In Review",  filed:"May 12", priority:"High"   },
  { id:"D-0089", load:"KE-2025", type:"Payment Dispute", shipper:"Oserian Farm",   driver:"Grace Wanjiku", amount:18000, status:"In Review",  filed:"May 10", priority:"Medium" },
  { id:"D-0088", load:"KE-2019", type:"No-show Driver",  shipper:"Steel & Tube",   driver:"David Mutua",   amount:55000, status:"Resolved",   filed:"May 8",  priority:"Low"    },
];
// Phase 3A: the inline LOADS array that used to live here has been removed.
// Admin's load list now comes entirely from getAllKnownLoads() + toAdminLoadView()
// (see the allAdminLoads computation in the root BehariAdmin component below),
// which reads the canonical src/data/seedLoads.js dataset instead of a private
// admin-only copy. This is what fixed the KE-2044/2045 cargo transposition that
// existed in this array (Building Mats and FMCG Goods were swapped relative to
// the marketplace's numbering) — see the seed-data collision audit.
/* ── Status/label maps — sourced from shared constants ───────────────────── */
const STATUS_MAP = STATUS_MAP_SHARED;
const RISK_MAP   = RISK_MAP_SHARED;
const PRI_MAP    = PRI_MAP_SHARED;
const SEV_MAP    = SEV_MAP_SHARED;

/* ── Shared micro-components ─────────────────────────────────────────────── */
function Chip({ label, map }) {
  const s = (map||{})[label] || { c:C.muted, b:C.bg };
  return <span style={{ background:s.b, color:s.c, fontSize:11, fontWeight:700, borderRadius:100, padding:"3px 10px", whiteSpace:"nowrap" }}>{label}</span>;
}
function KPI({ label, value, sub, accent }) {
  return (
    <div style={{ ...card, padding:"16px 14px" }}>
      <div style={{ fontSize:10, color:C.muted, fontWeight:700, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:26, fontWeight:800, color:accent||C.black, letterSpacing:-0.5, lineHeight:1 }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:C.muted, marginTop:5 }}>{sub}</div>}
    </div>
  );
}
function SectionHead({ label, color }) {
  return <div style={{ fontSize:11, color:color||C.muted, fontWeight:700, letterSpacing:0.8, textTransform:"uppercase", marginBottom:8, marginTop:4 }}>{label}</div>;
}
function ScoreBar({ score, color }) {
  return (
    <div style={{ height:6, background:C.border, borderRadius:3, overflow:"hidden", margin:"6px 0" }}>
      <div style={{ width:`${score}%`, height:"100%", background:color||C.green, borderRadius:3, transition:"width 0.4s" }} />
    </div>
  );
}

/* ── Phase 1: COMMAND CENTER ─────────────────────────────────────────────── */
function CommandCenter({ allLoads, healthScore, networkAlerts, auditLog, corridors, adminOps }) {
  const [gmv, setGmv] = useState(1_082_400);
  const [tick, setTick] = useState(false);

  useEffect(() => {
    const t = setInterval(() => {
      setGmv(v => v + Math.floor(Math.random() * 3800 + 200));
      setTick(x => !x);
    }, 4000);
    return () => clearInterval(t);
  }, []);

  const inTransit    = allLoads.filter(l => l.status === "In Transit").length;
  const escrowHeld   = allLoads.filter(l => l.status === "Escrow Held").length;
  const openDisputes = networkAlerts.filter(a => a.type === "DISPUTE").length;
  const criticalAlerts = networkAlerts.filter(a => a.severity === "CRITICAL" || a.severity === "HIGH");
  const health = healthScore || { score:82, label:"Good", color:C.teal, bg:C.tealBg };

  return (
    <>
      {/* Bloomberg-style header ticker */}
      <div style={{ ...darkCard, padding:"14px 16px", marginBottom:12, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:10, color:"#58A6FF", fontWeight:700, letterSpacing:1.5, textTransform:"uppercase", marginBottom:4 }}>NETWORK GMV · LIVE</div>
          <div style={{ fontSize:28, fontWeight:900, color:"#F0F6FC", fontFamily:mono, letterSpacing:-1, transition:"color 0.3s" }}>
            KSh {gmv.toLocaleString()}
          </div>
          <div style={{ fontSize:11, color:"#3FB950", marginTop:3 }}>↑ 12.4% vs prior period · {new Date().toLocaleTimeString("en-KE",{hour:"2-digit",minute:"2-digit"})} EAT</div>
        </div>
        <div style={{ minWidth:140 }}>
          <div style={{ background:health.bg, borderRadius:8, padding:"10px 14px", border:`1px solid ${health.color}44` }}>
            <div style={{ fontSize:9, fontWeight:700, color:health.color, letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>NETWORK HEALTH</div>
            <div style={{ display:"flex", alignItems:"baseline", gap:4, marginBottom:6 }}>
              <div style={{ fontSize:36, fontWeight:900, color:health.color, fontFamily:mono, lineHeight:1 }}>{health.score}</div>
              <div style={{ fontSize:11, color:health.color, opacity:0.7 }}>/100</div>
            </div>
            {/* Score bar */}
            <div style={{ height:5, background:"rgba(0,0,0,0.12)", borderRadius:3, overflow:"hidden", marginBottom:5 }}>
              <div style={{ width:`${health.score}%`, height:"100%", background:health.color, borderRadius:3, transition:"width 0.6s ease" }} />
            </div>
            <div style={{ fontSize:11, fontWeight:700, color:health.color }}>{health.label}</div>
          </div>
        </div>
      </div>

      {/* Critical alert banner */}
      {criticalAlerts.length > 0 && (
        <div style={{ background:C.redBg, border:`1px solid ${C.red}55`, borderRadius:8, padding:"10px 14px", marginBottom:12, display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:16 }}>🚨</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:12, fontWeight:700, color:C.red }}>
              {criticalAlerts.length} critical alert{criticalAlerts.length > 1 ? "s" : ""} requiring attention
            </div>
            <div style={{ fontSize:11, color:C.red, opacity:0.8 }}>{criticalAlerts[0]?.message}</div>
          </div>
        </div>
      )}

      {/* KPI grid */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:14 }}>
        {[
          ["Active Loads", allLoads.length,  "Total on network",   C.black],
          ["In Transit",   inTransit,         "Moving now",         C.blue ],
          ["Escrow Held",  escrowHeld,        "Funds secured",      C.amber],
          ["Revenue May",  "KSh 64.8K",       "6% of GMV",          C.green],
          ["Disputes",     openDisputes || 3,  "Open cases",        C.red  ],
          ["KYC Queue",    4,                  "Awaiting review",   C.amber],
        ].map(([l,v,s,a]) => (
          <div key={l} style={{ ...card, padding:"12px 10px" }}>
            <div style={{ fontSize:9, color:C.muted, fontWeight:700, textTransform:"uppercase", letterSpacing:0.7, marginBottom:4 }}>{l}</div>
            <div style={{ fontSize:22, fontWeight:900, color:a, letterSpacing:-0.5 }}>{v}</div>
            <div style={{ fontSize:10, color:C.muted, marginTop:3 }}>{s}</div>
          </div>
        ))}
      </div>

      {/* Corridor status */}
      <SectionHead label="East Africa Corridor Status" />
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:14 }}>
        {(corridors||[]).map(c => {
          const cc = c.congestionPct >= 65 ? C.red : c.congestionPct >= 45 ? C.amber : C.green;
          return (
            <div key={c.id} style={{ flex:"1 1 calc(50% - 3px)", minWidth:140, ...card, padding:"10px 12px" }}>
              <div style={{ fontSize:11, fontWeight:800, color:C.black, marginBottom:2 }}>{c.shortName}</div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:6 }}>{c.activeTrucks} trucks · {c.km}km</div>
              <ScoreBar score={c.congestionPct} color={cc} />
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span style={{ fontSize:9, color:cc, fontWeight:700 }}>{c.congestion} congestion</span>
                <span style={{ fontSize:9, color:C.muted }}>{c.congestionPct}%</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Network alerts */}
      {networkAlerts.length > 0 && (
        <>
          <SectionHead label="Network Alerts" color={C.red} />
          <div style={{ ...card, overflow:"hidden", marginBottom:14 }}>
            {networkAlerts.slice(0,4).map((a,i,arr) => {
              const sc = SEV_MAP[a.severity] || { c:C.muted, b:C.bg };
              return (
                <div key={a.id} style={{ padding:"10px 14px", borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none", display:"flex", alignItems:"flex-start", gap:10 }}>
                  <span style={{ fontSize:14, marginTop:1 }}>
                    {a.type==="INCIDENT"?"🔧":a.type==="FRAUD"?"🚩":a.type==="DISPATCH"?"🚛":"📡"}
                  </span>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:12, fontWeight:700, color:C.black }}>{a.message}</div>
                    <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>{a.at}</div>
                  </div>
                  <span style={{ background:sc.b, color:sc.c, fontSize:9, fontWeight:700, borderRadius:100, padding:"2px 7px", whiteSpace:"nowrap" }}>{a.severity}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Recent audit activity */}
      <SectionHead label="Recent Admin Activity" />
      <div style={{ ...card, overflow:"hidden" }}>
        {(auditLog||[]).slice(0,6).map((e,i,arr) => (
          <div key={e.id} style={{ padding:"10px 14px", borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none", display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:7, height:7, borderRadius:"50%", background:
              e.action.includes("FRAUD")||e.action.includes("SUSPEND") ? C.red :
              e.action.includes("FREEZE") ? C.amber :
              e.action.includes("RELEASE")||e.action.includes("REINSTATE") ? C.green : C.blue,
              flexShrink:0 }} />
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, fontWeight:600, color:C.black }}>{e.detail}</div>
              <div style={{ fontSize:10, color:C.muted }}>{e.admin} · {e.at}</div>
            </div>
            <span style={{ fontSize:9, color:C.muted, fontFamily:mono, whiteSpace:"nowrap" }}>{e.action}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Phase 2: NATIONAL HEATMAP ───────────────────────────────────────────── */
function NationalHeatmap({ allLoads, corridors, onForceStatus, onCancelShipment, adminOps }) {
  const [filter, setFilter]           = useState("All");
  const [corridorFilter, setCorFilter]= useState("All");
  const [intervention, setIntervention] = useState(null);

  // Kenya + EA map SVG projection
  // bounds: lat [-8,12], lng [29,45]
  function proj(lat, lng) {
    const x = ((lng - 29) / 16) * 360;
    const y = ((12 - lat) / 20) * 240;
    return { x, y };
  }

  const cities = [
    { name:"Nairobi",         lat:-1.29, lng:36.82 },
    { name:"Mombasa",         lat:-4.04, lng:39.67 },
    { name:"Kisumu",          lat:-0.10, lng:34.76 },
    { name:"Eldoret",         lat: 0.52, lng:35.27 },
    { name:"Nakuru",          lat:-0.42, lng:36.95 },
    { name:"Kampala",         lat: 0.35, lng:32.58 },
    { name:"Dar es Salaam",   lat:-6.79, lng:39.21 },
    { name:"Addis Ababa",     lat: 9.03, lng:38.75 },
    { name:"Namanga",         lat:-2.55, lng:36.79 },
    { name:"Malaba",          lat: 0.45, lng:34.12 },
  ];

  const CORRIDOR_COLORS = {
    "NBI-MSA": C.blue, "NBI-KSM": C.red, "NBI-ELD": C.green,
    "MSA-DAR": C.purple, "NBI-KLA": C.amber, "NBI-ADD": C.teal,
  };

  const statuses = ["All","In Transit","Escrow Held","Delivered","Paid Out","Cancelled"];
  const filtered = allLoads.filter(l =>
    (filter === "All" || l.status === filter)
  );

  return (
    <>
      {/* Dark map canvas */}
      <div style={{ background:"#0D1117", borderRadius:8, marginBottom:12, position:"relative", overflow:"hidden", height:220 }}>
        <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%" }} viewBox="0 0 360 240" preserveAspectRatio="xMidYMid meet">
          {/* Grid */}
          {[...Array(8)].map((_,i) => <line key={`h${i}`} x1="0" y1={i*30} x2="360" y2={i*30} stroke="rgba(255,255,255,0.04)" strokeWidth="1" />)}
          {[...Array(12)].map((_,i) => <line key={`v${i}`} x1={i*30} y1="0" x2={i*30} y2="240" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />)}

          {/* Corridor route lines */}
          {(corridors||[]).map(cor => {
            const pts = cor.waypoints.map(w => proj(w.lat, w.lng));
            const d = pts.map((p,i) => `${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
            const cc = CORRIDOR_COLORS[cor.id] || C.muted;
            return (
              <path key={cor.id} d={d} stroke={cc} strokeWidth="1.5" fill="none" strokeOpacity="0.6"
                strokeDasharray={cor.congestionPct >= 65 ? "4,3" : "none"} />
            );
          })}

          {/* City dots */}
          {cities.map(city => {
            const p = proj(city.lat, city.lng);
            if (p.x < 0 || p.x > 360 || p.y < 0 || p.y > 240) return null;
            return (
              <g key={city.name}>
                <circle cx={p.x} cy={p.y} r="3" fill="rgba(255,255,255,0.6)" />
                <text x={p.x+5} y={p.y+4} fill="rgba(255,255,255,0.35)" fontSize="7" fontFamily={font}>{city.name}</text>
              </g>
            );
          })}

          {/* Animated truck markers for in-transit loads */}
          {allLoads.filter(l=>l.status==="In Transit").slice(0,5).map((l,i) => {
            const positions = [
              { lat:-1.0, lng:37.2 }, { lat:-2.1, lng:38.5 }, { lat:-0.3, lng:35.5 },
              { lat:-0.1, lng:35.8 }, { lat:-1.5, lng:36.0 },
            ];
            const pos = positions[i % positions.length];
            const p = proj(pos.lat, pos.lng);
            return (
              <g key={l.id}>
                <circle cx={p.x} cy={p.y} r="5" fill={C.green} fillOpacity="0.25">
                  <animate attributeName="r" values="5;9;5" dur="2.5s" repeatCount="indefinite" />
                  <animate attributeName="fill-opacity" values="0.25;0.05;0.25" dur="2.5s" repeatCount="indefinite" />
                </circle>
                <circle cx={p.x} cy={p.y} r="3.5" fill={C.green} />
                <text x={p.x+5} y={p.y+4} fill={C.green} fontSize="7" fontFamily={mono} fontWeight="700">{l.id}</text>
              </g>
            );
          })}
        </svg>

        {/* Overlay labels */}
        <div style={{ position:"absolute", top:10, left:14, fontSize:10, fontWeight:700, color:"rgba(255,255,255,0.5)", letterSpacing:1.5 }}>
          KENYA · EAST AFRICA · SIMULATED
        </div>
        <div style={{ position:"absolute", top:10, right:12, display:"flex", gap:8 }}>
          <div style={{ display:"flex", alignItems:"center", gap:4 }}>
            <div style={{ width:8, height:8, borderRadius:"50%", background:C.green }} />
            <span style={{ fontSize:9, color:"rgba(255,255,255,0.5)" }}>In Transit</span>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:4 }}>
            <div style={{ width:8, height:3, background:C.red }} />
            <span style={{ fontSize:9, color:"rgba(255,255,255,0.5)" }}>Congested</span>
          </div>
        </div>

        {/* Corridor legend bottom */}
        <div style={{ position:"absolute", bottom:8, left:8, right:8, display:"flex", gap:6, flexWrap:"wrap" }}>
          {(corridors||[]).map(c => (
            <div key={c.id} style={{ display:"flex", alignItems:"center", gap:3 }}>
              <div style={{ width:12, height:2, background:CORRIDOR_COLORS[c.id]||C.muted, borderRadius:1 }} />
              <span style={{ fontSize:8, color:"rgba(255,255,255,0.4)" }}>{c.shortName}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Status filter chips */}
      <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:12, overflowX:"auto" }}>
        {statuses.map(s => (
          <button key={s} onClick={()=>setFilter(s)} style={{ background:filter===s?C.black:C.white, color:filter===s?C.white:C.secondary, border:`1.5px solid ${filter===s?C.black:C.border}`, borderRadius:100, padding:"5px 12px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font, whiteSpace:"nowrap", flexShrink:0 }}>{s}</button>
        ))}
      </div>

      {/* Load list */}
      <div style={{ ...card, overflow:"hidden" }}>
        {filtered.map((l,i,a) => (
          <div key={l.id} style={{ padding:"12px 16px", borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
              <div>
                <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:3 }}>
                  <span style={{ fontSize:10, fontWeight:700, color:C.muted, fontFamily:mono }}>{l.id}</span>
                  <Chip label={l.status} map={STATUS_MAP} />
                </div>
                <div style={{ fontSize:13, fontWeight:700, color:C.black }}>{l.cargo}</div>
                <div style={{ fontSize:11, color:C.muted }}>{l.route||`${l.from}→${l.to}`} · {l.driver} · {l.date}</div>
              </div>
              <div style={{ fontSize:14, fontWeight:900, color:C.black, flexShrink:0, marginLeft:8 }}>KSh {(l.pay||0).toLocaleString()}</div>
            </div>
            {l.status !== "Paid Out" && l.status !== "Delivered" && l.status !== "Cancelled" && (
              <button onClick={()=>setIntervention(l)} style={{ background:C.amberBg, color:C.amber, border:`1px solid ${C.amber}44`, borderRadius:6, padding:"5px 12px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font }}>
                ⚙ Intervene
              </button>
            )}
          </div>
        ))}
        {filtered.length===0 && <div style={{ padding:30, textAlign:"center", color:C.muted, fontSize:13, fontWeight:600 }}>No loads match this filter</div>}
      </div>

      {intervention && (
        <InterventionPanel
          load={intervention}
          onForceStatus={onForceStatus}
          onCancel={onCancelShipment}
          onClose={()=>setIntervention(null)}
          onLogAudit={adminOps.logAudit}
        />
      )}
    </>
  );
}

/* ── Phase 3: RISK CENTER ────────────────────────────────────────────────── */
function RiskCenter({ carrierRiskProfiles, shipperRiskProfiles, carrierRoster }) {
  const [tab, setTab] = useState("carriers");
  const profiles = tab === "carriers" ? carrierRiskProfiles : shipperRiskProfiles;
  const [recalcId, setRecalcId] = useState(null); // tracks which card is recalculating

  return (
    <>
      {/* Tab switcher */}
      <div style={{ display:"flex", gap:6, marginBottom:14 }}>
        {["carriers","shippers"].map(t => (
          <button key={t} onClick={()=>setTab(t)} style={{ flex:1, background:tab===t?C.black:C.white, color:tab===t?C.white:C.secondary, border:`1.5px solid ${tab===t?C.black:C.border}`, borderRadius:8, padding:"10px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:font }}>
            {t === "carriers" ? `🚛 Transporters (${carrierRiskProfiles.length})` : `📦 Shippers (${shipperRiskProfiles.length})`}
          </button>
        ))}
      </div>

      {/* Summary row */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:14 }}>
        {["High","Medium","Low"].map(sev => {
          const count = profiles.filter(p => p.severity === sev).length;
          const sc = RISK_MAP[sev] || { c:C.muted, b:C.bg };
          return (
            <div key={sev} style={{ ...card, padding:"12px 10px", textAlign:"center" }}>
              <div style={{ fontSize:24, fontWeight:900, color:sc.c }}>{count}</div>
              <div style={{ fontSize:10, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:0.7 }}>{sev} Risk</div>
            </div>
          );
        })}
      </div>

      {profiles.length === 0 && (
        <div style={{ ...card, padding:40, textAlign:"center" }}>
          <div style={{ fontSize:36, marginBottom:10 }}>🛡️</div>
          <div style={{ fontSize:14, fontWeight:700, color:C.secondary }}>
            {tab === "shippers" ? "No shipper risk profiles yet" : "Loading risk profiles…"}
          </div>
        </div>
      )}

      {profiles.map(p => {
        const sc = RISK_MAP[p.severity] || { c:C.muted, b:C.bg };
        const roster = tab === "carriers" ? carrierRoster.find(c => c.id === p.entityId) : null;
        return (
          <div key={p.entityId} style={{ ...card, marginBottom:10, padding:"14px 16px", borderLeft:`3px solid ${sc.c}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
              <div>
                <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:3 }}>
                  <span style={{ fontSize:10, color:C.muted, fontFamily:mono }}>{p.entityId}</span>
                  <span style={{ background:sc.b, color:sc.c, fontSize:10, fontWeight:700, borderRadius:100, padding:"2px 8px" }}>{p.severity} Risk</span>
                  <span style={{ background:C.bg, color:C.muted, fontSize:10, fontWeight:600, borderRadius:100, padding:"2px 8px" }}>{p.confidence}% confidence</span>
                </div>
                <div style={{ fontSize:16, fontWeight:800, color:C.black }}>
                  {roster ? roster.name : p.entityId}
                </div>
                {roster && <div style={{ fontSize:11, color:C.muted }}>{roster.truckReg} · {roster.truckType} · {roster.trips} trips</div>}
              </div>
              <div style={{ textAlign:"right", flexShrink:0, marginLeft:10 }}>
                <div style={{ fontSize:28, fontWeight:900, color:sc.c, fontFamily:mono, lineHeight:1 }}>{p.riskScore}</div>
                <div style={{ fontSize:9, color:C.muted, fontWeight:600 }}>/ 100</div>
              </div>
            </div>

            {/* Score bar */}
            <ScoreBar score={p.riskScore} color={sc.c} />

            {/* Risk factors */}
            {p.factors && p.factors.length > 0 && (
              <div style={{ marginTop:8, marginBottom:8 }}>
                {p.factors.map(f => (
                  <div key={f.id} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:5 }}>
                    <ScoreBar score={Math.min(100, f.score)} color={sc.c} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:11, fontWeight:600, color:C.secondary }}>{f.description}</div>
                    </div>
                    <span style={{ fontSize:10, fontFamily:mono, color:sc.c, fontWeight:700, flexShrink:0 }}>{f.score}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Recommendations */}
            {p.recommendations && p.recommendations.length > 0 && (
              <div style={{ background:sc.b, borderRadius:6, padding:"8px 10px", marginTop:6 }}>
                <div style={{ fontSize:9, fontWeight:700, color:sc.c, textTransform:"uppercase", letterSpacing:0.8, marginBottom:4 }}>Recommended Actions</div>
                {p.recommendations.map((r,i) => (
                  <div key={i} style={{ fontSize:11, color:sc.c, marginBottom:2 }}>· {r}</div>
                ))}
              </div>
            )}
            {/* Recalculate button */}
            <button onClick={()=>{ setRecalcId(p.entityId); setTimeout(()=>setRecalcId(null),1800); }} disabled={recalcId===p.entityId} style={{ marginTop:10, width:"100%", background:recalcId===p.entityId?C.amberBg:C.bg, color:recalcId===p.entityId?C.amber:C.secondary, border:`1px solid ${recalcId===p.entityId?C.amber:C.border}`, borderRadius:7, padding:"7px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font, transition:"all .2s" }}>
              {recalcId===p.entityId?"⟳ Recalculating…":"↻ Recalculate Risk Score"}
            </button>
          </div>
        );
      })}
    </>
  );
}

/* ── Phase 4: TREASURY ───────────────────────────────────────────────────── */
/**
 * Admin-side escrow release panel — moved here from the Shipper portal.
 * Business rule: the shipper confirms delivery (OTP/photo/signature/GPS),
 * which puts escrow into "Ready for Release" — but the ACTUAL M-Pesa release
 * to the carrier is an admin action, not a shipper one. The shipper only
 * sees a "Behari Admin will verify and release payment" message.
 */
function EscrowReleasePanel({ load, escrow, onRelease, onClose }) {
  const [penalty,    setPenalty]    = useState(escrow?.latePenalty  || 0);
  const [partial,    setPartial]    = useState(escrow?.partialRefund || 0);
  const [releasing,  setReleasing]  = useState(false);
  const [released,   setReleased]   = useState(false);

  const base      = load.pay || 0;
  const adminFee  = Math.round(base * 0.02);
  const toCarrier = Math.max(0, base - penalty - adminFee - partial);

  async function doRelease() {
    setReleasing(true);
    await new Promise(r => setTimeout(r, 2000));
    await onRelease(load.id, { latePenalty: penalty, partialRefund: partial, adminFee, baseAmount: base });
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
          KSh {toCarrier.toLocaleString()} sent to {load.driver}'s M-Pesa
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
          Transferring <strong>KSh {toCarrier.toLocaleString()}</strong><br />to {load.driver} via M-Pesa
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
        <div style={{ fontSize:11,color:C.amber,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Admin Escrow Release</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:4 }}>{load.cargo} · {load.id}</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:18 }}>
          Shipper confirmed delivery. Review the payment breakdown before releasing to {load.driver}.
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

function Treasury({ escrowData, frozenPayouts, frozenPayoutsReason, onFreezePayouts, onUnfreezePayouts, allLoads = [], onReleaseEscrow = ()=>{} }) {
  const [showFreezeConfirm, setShowFreezeConfirm] = useState(false);
  const [freezeReason, setFreezeReason]           = useState("");
  const [busy, setBusy]                           = useState(false);
  const [txnPeriod, setTxnPeriod]                 = useState("Today"); // date filter
  const [txnCsvDone, setTxnCsvDone]               = useState(false);
  const [releasingLoad, setReleasingLoad]         = useState(null);

  const liveEscrow     = Object.values(escrowData);
  const liveHeld       = liveEscrow.filter(e => e.status === "Held" || e.status === "Ready for Release");
  const liveHeldAmt    = liveHeld.reduce((s,e) => s + (e.baseAmount||0), 0);
  const liveReleased   = liveEscrow.filter(e => e.status === "Released");
  const liveReleasedAmt = liveReleased.reduce((s,e) => s + (e.breakdown?.toCarrier||0), 0);
  const readyForRelease = allLoads.filter(l => l.status === "Delivery Confirmed");

  const TXN = [
    { id:"T-9941", type:"STK Push",   load:"KE-2042", party:"Bamburi Cement", amount:68500, fee:0,    status:"Escrow",  time:"09:14" },
    { id:"T-9940", type:"B2C Payout", load:"KE-2038", party:"Samuel Kamau",   amount:64390, fee:4110, status:"Settled", time:"08:55" },
    { id:"T-9939", type:"STK Push",   load:"KE-2041", party:"Unga Group Ltd", amount:42000, fee:0,    status:"Escrow",  time:"07:33" },
    { id:"T-9938", type:"B2C Payout", load:"KE-2036", party:"Grace Wanjiku",  amount:16920, fee:1080, status:"Settled", time:"Yesterday" },
    { id:"T-9937", type:"Refund",     load:"KE-2045", party:"Steel & Tube",   amount:55000, fee:0,    status:"Refunded",time:"Yesterday" },
  ];
  const TXN_STATUS = { Escrow:{ c:C.amber,b:C.amberBg }, Settled:{ c:C.green,b:C.greenBg }, Refunded:{ c:C.red,b:C.redBg } };

  return (
    <>
      {/* Freeze banner */}
      {frozenPayouts && (
        <div style={{ background:C.redBg, border:`1px solid ${C.red}55`, borderRadius:8, padding:"12px 14px", marginBottom:12, display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:18 }}>🔴</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.red }}>PAYOUTS FROZEN</div>
            <div style={{ fontSize:11, color:C.red, opacity:0.8 }}>{frozenPayoutsReason}</div>
          </div>
          <button onClick={async()=>{ setBusy(true); await onUnfreezePayouts(); setBusy(false); }} disabled={busy} style={{ background:C.red, color:C.white, border:"none", borderRadius:6, padding:"7px 14px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font }}>
            {busy?"…":"Unfreeze"}
          </button>
        </div>
      )}

      {/* KPIs */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:14 }}>
        <KPI label="Escrow Held"     value={liveHeldAmt>0?`KSh ${Math.round(liveHeldAmt/1000)}K`:"KSh 110K"} sub={`${liveHeld.length||2} loads pending`} accent={C.amber} />
        <KPI label="May Revenue"     value={liveReleasedAmt>0?`KSh ${Math.round(liveReleasedAmt/1000)}K`:"KSh 64.8K"} sub="14 completed" accent={C.green} />
        <KPI label="Pending Payouts" value="KSh 64.4K" sub="1 awaiting" accent={C.blue}  />
        <KPI label="Refunds Issued"  value="KSh 55K"   sub="1 cancelled load" accent={C.red}   />
      </div>

      {/* Awaiting Admin Release — shipper has confirmed delivery; the actual
          M-Pesa release to the carrier is an admin action, not a shipper one. */}
      <SectionHead label="⏳ Awaiting Admin Release" color={C.amber} />
      {readyForRelease.length === 0 ? (
        <div style={{ ...card, padding:22, textAlign:"center", color:C.muted, fontSize:13, marginBottom:14 }}>
          No deliveries are currently awaiting release.
        </div>
      ) : (
        <div style={{ ...card, overflow:"hidden", marginBottom:14 }}>
          {readyForRelease.map((l,i,a) => (
            <div key={l.id} style={{ padding:"12px 16px", borderBottom:i<a.length-1?`1px solid ${C.border}`:"none", display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.black }}>{l.cargo} · {l.id}</div>
                <div style={{ fontSize:11, color:C.muted }}>{l.route || `${l.from}→${l.to}`} · {l.driver}</div>
              </div>
              <div style={{ textAlign:"right", flexShrink:0 }}>
                <div style={{ fontSize:13, fontWeight:800, color:C.black, marginBottom:4 }}>KSh {(l.pay||0).toLocaleString()}</div>
                <button onClick={()=>setReleasingLoad(l)} style={{ background:C.green, color:C.black, border:"none", borderRadius:6, padding:"6px 12px", fontSize:11, fontWeight:800, cursor:"pointer", fontFamily:font }}>
                  Release →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Escrow pipeline */}
      <SectionHead label="M-Pesa Escrow Pipeline" />
      <div style={{ ...card, padding:"14px 16px", marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", gap:0 }}>
          {[
            ["STK Push", liveHeld.length||2, C.amber],
            ["→", null, C.muted],
            ["In Escrow", liveHeld.length||2, C.blue],
            ["→", null, C.muted],
            ["Release", liveReleased.length||1, C.green],
            ["→", null, C.muted],
            ["B2C Paid", liveReleased.length||1, C.teal],
          ].map(([l,n,c],i) => (
            l === "→"
              ? <div key={i} style={{ fontSize:16, color:C.muted, margin:"0 4px" }}>→</div>
              : (
                <div key={i} style={{ flex:1, textAlign:"center", background:n?`${c}18`:C.bg, borderRadius:6, padding:"8px 4px" }}>
                  <div style={{ fontSize:14, fontWeight:900, color:c||C.muted }}>{n||"—"}</div>
                  <div style={{ fontSize:9, fontWeight:700, color:c||C.muted, textTransform:"uppercase", letterSpacing:0.5 }}>{l}</div>
                </div>
              )
          ))}
        </div>
      </div>

      {/* Live escrow records */}
      {liveEscrow.length > 0 && (
        <>
          <SectionHead label="⚡ Live Escrow Records" color={C.blue} />
          <div style={{ ...card, overflow:"hidden", marginBottom:14 }}>
            {liveEscrow.map((e,i,a) => (
              <div key={i} style={{ padding:"12px 16px", borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:C.black, marginBottom:2 }}>Escrow {i+1} · {e.status}</div>
                    <div style={{ fontSize:11, color:C.muted }}>Held at: {e.heldAt}</div>
                  </div>
                  <div style={{ textAlign:"right", flexShrink:0 }}>
                    <div style={{ fontSize:14, fontWeight:800, color:C.black }}>KSh {(e.baseAmount||0).toLocaleString()}</div>
                    {e.breakdown && <div style={{ fontSize:11, color:C.green, fontWeight:600 }}>→ KSh {e.breakdown.toCarrier.toLocaleString()} to transporter</div>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Today's transactions — date filter + CSV */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <SectionHead label={`${txnPeriod}'s Transactions`} />
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          {["Today","Week","Month"].map(p=>(
            <button key={p} onClick={()=>setTxnPeriod(p)} style={{ background:txnPeriod===p?C.black:C.bg, color:txnPeriod===p?C.white:C.secondary, border:`1px solid ${txnPeriod===p?C.black:C.border}`, borderRadius:100, padding:"4px 10px", fontSize:10, fontWeight:700, cursor:"pointer", fontFamily:font }}>{p}</button>
          ))}
          <button onClick={()=>{
            const hdr = ["ID","Type","Load","Party","Amount","Fee","Status","Time"];
            const rows = TXN.map(t=>[t.id,t.type,t.load,t.party,t.amount,t.fee,t.status,t.time]);
            const csv = [hdr,...rows].map(r=>r.join(",")).join("\n");
            const blob = new Blob([csv],{type:"text/csv"});
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href=url; a.download=`treasury-${txnPeriod}-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
            setTxnCsvDone(true); setTimeout(()=>setTxnCsvDone(false),2200);
          }} style={{ background:txnCsvDone?C.green:C.bg, color:txnCsvDone?C.white:C.secondary, border:`1px solid ${txnCsvDone?C.green:C.border}`, borderRadius:100, padding:"4px 10px", fontSize:10, fontWeight:700, cursor:"pointer", fontFamily:font, transition:"all .25s" }}>
            {txnCsvDone?"✓ Saved":"📥 CSV"}
          </button>
        </div>
      </div>
      <div style={{ ...card, overflow:"hidden", marginBottom:14 }}>
        {TXN.map((t,i,a) => (
          <div key={t.id} style={{ padding:"11px 16px", borderBottom:i<a.length-1?`1px solid ${C.border}`:"none", display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:10, color:C.muted, fontFamily:mono }}>{t.id} · {t.type}</div>
              <div style={{ fontSize:12, fontWeight:600, color:C.black }}>{t.party} · <span style={{ color:C.muted, fontSize:11 }}>{t.load} · {t.time}</span></div>
            </div>
            <Chip label={t.status} map={TXN_STATUS} />
            <div style={{ textAlign:"right", minWidth:80 }}>
              <div style={{ fontSize:13, fontWeight:800, color:t.type==="Refund"?C.red:t.type==="B2C Payout"?C.green:C.black }}>
                {t.type==="Refund"?"−":""}KSh {t.amount.toLocaleString()}
              </div>
              {t.fee>0 && <div style={{ fontSize:9, color:C.green, fontWeight:700 }}>+{t.fee.toLocaleString()} fee</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Emergency freeze */}
      <SectionHead label="Emergency Operations" color={C.red} />
      <div style={{ ...card, padding:"14px 16px" }}>
        <div style={{ fontSize:13, fontWeight:700, color:C.black, marginBottom:4 }}>Freeze All Transporter Payouts</div>
        <div style={{ fontSize:12, color:C.muted, marginBottom:12 }}>Suspends all pending B2C M-Pesa disbursements network-wide. Requires reason.</div>
        {frozenPayouts
          ? <div style={{ background:C.redBg, color:C.red, borderRadius:6, padding:"10px 12px", fontSize:12, fontWeight:700 }}>🔴 Payouts currently frozen — use Unfreeze above</div>
          : (
            <>
              <input value={freezeReason} onChange={e=>setFreezeReason(e.target.value)} placeholder="Reason for freeze (required)…" style={{ width:"100%", padding:"9px 11px", fontSize:12, fontFamily:font, background:C.bg, border:`1.5px solid ${C.border}`, borderRadius:7, outline:"none", marginBottom:8 }} />
              <button disabled={!freezeReason.trim()||busy} onClick={async()=>{ setBusy(true); await onFreezePayouts(freezeReason); setFreezeReason(""); setBusy(false); }} style={{ width:"100%", background:freezeReason.trim()?C.red:C.border, color:freezeReason.trim()?C.white:C.muted, border:"none", borderRadius:7, padding:"11px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:font }}>
                {busy?"Freezing…":"🔴 Freeze All Payouts"}
              </button>
            </>
          )}
      </div>

      {releasingLoad && (
        <EscrowReleasePanel
          load={releasingLoad}
          escrow={escrowData[releasingLoad.id]}
          onRelease={onReleaseEscrow}
          onClose={()=>setReleasingLoad(null)}
        />
      )}
    </>
  );
}

/* ── Phase 6: DISPATCH CENTER ────────────────────────────────────────────── */
function DispatchCenter({ allLoads, carrierRoster, adminOps }) {
  const [selectedLoad, setSelectedLoad] = useState(null);
  const [recs, setRecs]                 = useState([]);
  const [loadingRecs, setLoadingRecs]   = useState(false);
  const [rosterFilter, setRosterFilter] = useState("All"); // smart-assign filter

  const unassigned = allLoads.filter(l =>
    (l.status === "Escrow Held" || l.status === "In Transit") && (!l.driver || l.driver === "Unassigned")
  );

  async function handleSelect(load) {
    setSelectedLoad(load);
    setLoadingRecs(true);
    const result = await adminOps.getDispatchRecs(load);
    setRecs(result);
    setLoadingRecs(false);
  }

  const MATCH_COLOR = (s) => s >= 75 ? C.green : s >= 50 ? C.amber : C.red;

  return (
    <>
      <SectionHead label="Unassigned / Needs Transporter" color={C.blue} />
      {unassigned.length === 0 ? (
        <div style={{ ...card, padding:36, textAlign:"center", marginBottom:14 }}>
          <div style={{ fontSize:32, marginBottom:8 }}>✅</div>
          <div style={{ fontSize:14, fontWeight:700, color:C.secondary }}>All active loads have assigned transporters</div>
        </div>
      ) : (
        <div style={{ ...card, overflow:"hidden", marginBottom:14 }}>
          {unassigned.map((l,i,a) => (
            <div key={l.id} style={{ padding:"12px 16px", borderBottom:i<a.length-1?`1px solid ${C.border}`:"none", display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer", background:selectedLoad?.id===l.id?C.blueBg:"transparent" }} onClick={()=>handleSelect(l)}>
              <div>
                <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:3 }}>
                  <span style={{ fontSize:10, fontFamily:mono, color:C.muted }}>{l.id}</span>
                  <Chip label={l.status} map={STATUS_MAP} />
                </div>
                <div style={{ fontSize:13, fontWeight:700, color:C.black }}>{l.cargo}</div>
                <div style={{ fontSize:11, color:C.muted }}>{l.route||`${l.from}→${l.to}`}</div>
              </div>
              <div style={{ textAlign:"right", flexShrink:0, marginLeft:8 }}>
                <div style={{ fontSize:13, fontWeight:800, color:C.black }}>KSh {(l.pay||0).toLocaleString()}</div>
                <div style={{ fontSize:10, color:C.blue, fontWeight:600 }}>Find transporter →</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Carrier recommendations */}
      {selectedLoad && (
        <>
          <SectionHead label={`AI Transporter Matches — ${selectedLoad.id}`} color={C.blue} />
          {loadingRecs && <div style={{ textAlign:"center", padding:24, color:C.muted, fontSize:13 }}>Scoring transporters…</div>}
          {!loadingRecs && recs.slice(0,5).map((c,i) => (
            <div key={c.id} style={{ ...card, marginBottom:8, padding:"14px 16px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:3 }}>
                    <span style={{ fontSize:10, fontFamily:mono, color:C.muted }}>{c.id}</span>
                    <span style={{ background:c.available?C.greenBg:C.redBg, color:c.available?C.green:C.red, fontSize:10, fontWeight:700, borderRadius:100, padding:"2px 8px" }}>
                      {c.available?"Available":"Busy"}
                    </span>
                    <span style={{ background:RISK_MAP[c.riskSeverity]?.b||C.bg, color:RISK_MAP[c.riskSeverity]?.c||C.muted, fontSize:10, fontWeight:700, borderRadius:100, padding:"2px 8px" }}>
                      {c.riskSeverity} risk
                    </span>
                  </div>
                  <div style={{ fontSize:15, fontWeight:800, color:C.black }}>{c.name}</div>
                  <div style={{ fontSize:11, color:C.muted }}>{c.truckReg} · {c.truckType} · ★{c.rating} · {c.trips} trips</div>
                </div>
                <div style={{ textAlign:"center", flexShrink:0, marginLeft:12 }}>
                  <div style={{ fontSize:24, fontWeight:900, color:MATCH_COLOR(c.matchScore), fontFamily:mono }}>{c.matchScore}</div>
                  <div style={{ fontSize:9, color:C.muted, fontWeight:600 }}>match %</div>
                </div>
              </div>
              <ScoreBar score={c.matchScore} color={MATCH_COLOR(c.matchScore)} />
              <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginTop:8 }}>
                {c.reasons.slice(0,3).map((r,ri) => (
                  <span key={ri} style={{ background:C.bg, color:C.secondary, fontSize:10, borderRadius:100, padding:"3px 9px", fontWeight:600 }}>{r}</span>
                ))}
              </div>
              {i === 0 && c.available && (
                <button onClick={()=>{ adminOps.logAudit("DISPATCH_ASSIGN", selectedLoad.id, `Transporter ${c.name} (${c.id}) recommended via smart dispatch`); setSelectedLoad(null); setRecs([]); }} style={{ width:"100%", marginTop:10, background:C.black, color:C.white, border:"none", borderRadius:7, padding:"10px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:font }}>
                  ✓ Assign {c.name}
                </button>
              )}
            </div>
          ))}
        </>
      )}

      {/* All available carriers — with smart-assign filter */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <SectionHead label="Transporter Roster" />
        <div style={{ display:"flex", gap:4 }}>
          {["All","Available","Flatbed","Refrigerated","Tanker"].map(f=>(
            <button key={f} onClick={()=>setRosterFilter(f)} style={{ background:rosterFilter===f?C.black:C.bg, color:rosterFilter===f?C.white:C.secondary, border:`1px solid ${rosterFilter===f?C.black:C.border}`, borderRadius:100, padding:"3px 8px", fontSize:9, fontWeight:700, cursor:"pointer", fontFamily:font }}>{f}</button>
          ))}
        </div>
      </div>
      <div style={{ ...card, overflow:"hidden" }}>
        {(carrierRoster||[]).filter(c=>{
          if(rosterFilter==="All") return true;
          if(rosterFilter==="Available") return c.available;
          return (c.truckType||"").toLowerCase().includes(rosterFilter.toLowerCase());
        }).map((c,i,a) => (
          <div key={c.id} style={{ padding:"11px 14px", borderBottom:i<a.length-1?`1px solid ${C.border}`:"none", display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.black }}>{c.name}</div>
              <div style={{ fontSize:10, color:C.muted }}>{c.truckReg} · {c.truckType} · {c.location.label}</div>
            </div>
            <div style={{ fontSize:11, color:C.muted }}>★{c.rating}</div>
            <span style={{ background:c.available?C.greenBg:C.redBg, color:c.available?C.green:C.red, fontSize:10, fontWeight:700, borderRadius:100, padding:"2px 8px" }}>
              {c.available?"Available":"Busy"}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Phase 7: INCIDENT CENTER ────────────────────────────────────────────── */
function IncidentCenter({ incidents, adminOps }) {
  const [showCreate, setShowCreate]   = useState(false);
  const [selectedInc, setSelectedInc] = useState(null);
  const [form, setForm]               = useState({ type:"BREAKDOWN", severity:"MEDIUM", location:"", description:"", loadId:"", officer:"" });
  const [busy, setBusy]               = useState(false);
  const [resolveNote, setResolveNote] = useState("");

  const open     = incidents.filter(i => i.status !== "Resolved");
  const resolved = incidents.filter(i => i.status === "Resolved");

  async function handleCreate() {
    if (!form.location.trim() || !form.description.trim()) return;
    setBusy(true);
    await adminOps.createIncident({ ...form, loadId: form.loadId||null });
    setBusy(false);
    setShowCreate(false);
    setForm({ type:"BREAKDOWN", severity:"MEDIUM", location:"", description:"", loadId:"", officer:"" });
  }

  async function handleResolve(inc) {
    if (!resolveNote.trim()) return;
    setBusy(true);
    await adminOps.resolveIncident(inc.id, resolveNote);
    setBusy(false);
    setSelectedInc(null);
    setResolveNote("");
  }

  return (
    <>
      {/* Summary */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:12 }}>
        {[["Open", open.length, C.red], ["In Progress", open.filter(i=>i.status==="In Progress").length, C.blue], ["Resolved", resolved.length, C.green]].map(([l,n,c]) => (
          <div key={l} style={{ ...card, padding:"12px 10px", textAlign:"center" }}>
            <div style={{ fontSize:24, fontWeight:900, color:c }}>{n}</div>
            <div style={{ fontSize:9, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:0.7 }}>{l}</div>
          </div>
        ))}
      </div>

      <button onClick={()=>setShowCreate(true)} style={{ width:"100%", background:C.red, color:C.white, border:"none", borderRadius:8, padding:"11px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:font, marginBottom:14 }}>
        + Log New Incident
      </button>

      <SectionHead label="Open Incidents" color={C.red} />
      {open.map(inc => {
        const it = INCIDENT_TYPES[inc.type] || { icon:"🔧", color:C.muted };
        const sv = SEV_MAP[inc.severity] || { c:C.muted, b:C.bg };
        return (
          <div key={inc.id} style={{ ...card, marginBottom:8, padding:"14px 16px", borderLeft:`3px solid ${sv.c}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
              <div>
                <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:4 }}>
                  <span style={{ fontSize:10, fontFamily:mono, color:C.muted }}>{inc.id}</span>
                  <Chip label={inc.status==="Open"?"Open":inc.status==="IN_PROGRESS"?"In Progress":inc.status} map={STATUS_MAP} />
                  <span style={{ background:sv.b, color:sv.c, fontSize:10, fontWeight:700, borderRadius:100, padding:"2px 8px" }}>{inc.severity}</span>
                </div>
                <div style={{ fontSize:15, fontWeight:800, color:C.black }}>{it.icon} {INCIDENT_TYPES[inc.type]?.label || inc.type}</div>
                <div style={{ fontSize:11, color:C.muted }}>{inc.location}{inc.loadId?` · ${inc.loadId}`:""} · {inc.officer}</div>
              </div>
              <div style={{ fontSize:11, color:C.muted, flexShrink:0 }}>{inc.createdAt}</div>
            </div>
            <div style={{ fontSize:12, color:C.secondary, marginBottom:10, lineHeight:1.5 }}>{inc.description.slice(0,120)}{inc.description.length>120?"…":""}</div>
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={()=>setSelectedInc(inc)} style={{ flex:1, background:C.bg, color:C.black, border:`1px solid ${C.border}`, borderRadius:6, padding:"7px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font }}>View Timeline</button>
              {inc.status !== "Resolved" && (
                <button onClick={()=>{ adminOps.updateIncidentStatus(inc.id,"In Progress","Admin acknowledged incident"); }} style={{ flex:1, background:C.blueBg, color:C.blue, border:`1px solid ${C.blue}44`, borderRadius:6, padding:"7px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font }}>Mark In Progress</button>
              )}
            </div>
          </div>
        );
      })}

      {resolved.length > 0 && (
        <>
          <SectionHead label="Resolved Incidents" />
          {resolved.map(inc => (
            <div key={inc.id} style={{ ...card, marginBottom:6, padding:"11px 14px", display:"flex", justifyContent:"space-between", alignItems:"center", opacity:0.65 }}>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:C.black }}>{INCIDENT_TYPES[inc.type]?.label || inc.type} · {inc.location}</div>
                <div style={{ fontSize:10, color:C.muted }}>{inc.id} · Resolved {inc.resolvedAt}</div>
              </div>
              <Chip label="Resolved" map={STATUS_MAP} />
            </div>
          ))}
        </>
      )}

      {/* Create incident bottom sheet */}
      {showCreate && (
        <div style={{ position:"fixed", inset:0, zIndex:500, display:"flex", alignItems:"flex-end", justifyContent:"center" }} onClick={()=>setShowCreate(false)}>
          <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.5)" }} />
          <div style={{ position:"relative", background:C.white, borderRadius:"16px 16px 0 0", width:"100%", maxWidth:480, padding:"8px 20px 40px", fontFamily:font, maxHeight:"85vh", overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
            <div style={{ width:36, height:4, background:C.border, borderRadius:2, margin:"12px auto 18px" }} />
            <div style={{ fontSize:17, fontWeight:800, color:C.black, marginBottom:14 }}>Log New Incident</div>

            {/* Type */}
            <div style={{ fontSize:10, fontWeight:700, color:C.secondary, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>Incident Type</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:12 }}>
              {Object.values(INCIDENT_TYPES).map(t => (
                <button key={t.id} onClick={()=>setForm(f=>({...f,type:t.id}))} style={{ padding:"6px 12px", border:`2px solid ${form.type===t.id?C.black:C.border}`, borderRadius:100, background:form.type===t.id?C.black:C.white, color:form.type===t.id?C.white:C.secondary, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font }}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>

            {/* Severity */}
            <div style={{ fontSize:10, fontWeight:700, color:C.secondary, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>Severity</div>
            <div style={{ display:"flex", gap:6, marginBottom:12 }}>
              {["LOW","MEDIUM","HIGH","CRITICAL"].map(s => {
                const sc = SEV_MAP[s]||{c:C.muted,b:C.bg};
                return <button key={s} onClick={()=>setForm(f=>({...f,severity:s}))} style={{ flex:1, padding:"8px 4px", border:`2px solid ${form.severity===s?sc.c:C.border}`, borderRadius:8, background:form.severity===s?sc.b:C.white, color:sc.c, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font }}>{s}</button>;
              })}
            </div>

            {/* Fields */}
            {[["Location","location","e.g. Nakuru Bypass, A104"],["Load ID (optional)","loadId","e.g. KE-2041"],["Officer","officer","Assigned officer name"]].map(([label,key,ph]) => (
              <div key={key}>
                <div style={{ fontSize:10, fontWeight:700, color:C.secondary, textTransform:"uppercase", letterSpacing:0.8, marginBottom:4 }}>{label}</div>
                <input value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))} placeholder={ph} style={{ width:"100%", padding:"9px 11px", fontSize:12, fontFamily:font, background:C.bg, border:`1.5px solid ${C.border}`, borderRadius:7, outline:"none", marginBottom:10 }} />
              </div>
            ))}
            <div style={{ fontSize:10, fontWeight:700, color:C.secondary, textTransform:"uppercase", letterSpacing:0.8, marginBottom:4 }}>Description</div>
            <textarea value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} placeholder="Full incident description…" style={{ width:"100%", minHeight:80, padding:"9px 11px", fontSize:12, fontFamily:font, background:C.bg, border:`1.5px solid ${C.border}`, borderRadius:7, outline:"none", resize:"vertical", marginBottom:16 }} />

            <div style={{ display:"flex", gap:8 }}>
              <button onClick={()=>setShowCreate(false)} style={{ flex:1, background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"12px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:font, color:C.black }}>Cancel</button>
              <button onClick={handleCreate} disabled={busy||!form.location.trim()||!form.description.trim()} style={{ flex:2, background:form.location.trim()&&form.description.trim()?C.red:C.border, color:form.location.trim()&&form.description.trim()?C.white:C.muted, border:"none", borderRadius:8, padding:"12px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:font }}>
                {busy?"Logging…":"Log Incident"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Incident timeline modal */}
      {selectedInc && (
        <div style={{ position:"fixed", inset:0, zIndex:500, display:"flex", alignItems:"flex-end", justifyContent:"center" }} onClick={()=>setSelectedInc(null)}>
          <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.5)" }} />
          <div style={{ position:"relative", background:C.white, borderRadius:"16px 16px 0 0", width:"100%", maxWidth:480, padding:"8px 20px 40px", fontFamily:font, maxHeight:"85vh", overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
            <div style={{ width:36, height:4, background:C.border, borderRadius:2, margin:"12px auto 18px" }} />
            <div style={{ fontSize:10, color:C.muted, marginBottom:4 }}>{selectedInc.id} · {selectedInc.severity}</div>
            <div style={{ fontSize:18, fontWeight:800, color:C.black, marginBottom:2 }}>{INCIDENT_TYPES[selectedInc.type]?.icon} {INCIDENT_TYPES[selectedInc.type]?.label}</div>
            <div style={{ fontSize:12, color:C.muted, marginBottom:14 }}>{selectedInc.location}{selectedInc.loadId?` · ${selectedInc.loadId}`:""}</div>
            <div style={{ fontSize:12, color:C.secondary, lineHeight:1.6, marginBottom:14 }}>{selectedInc.description}</div>

            {/* Timeline */}
            <div style={{ fontSize:10, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:8 }}>Timeline</div>
            {(selectedInc.timeline||[]).map((t,i) => (
              <div key={i} style={{ display:"flex", gap:10, marginBottom:8 }}>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center" }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:i===0?C.red:C.blue, flexShrink:0 }} />
                  {i<(selectedInc.timeline.length-1) && <div style={{ width:1, flex:1, background:C.border, marginTop:3 }} />}
                </div>
                <div style={{ paddingBottom:8 }}>
                  <div style={{ fontSize:11, fontWeight:600, color:C.black }}>{t.event}</div>
                  <div style={{ fontSize:10, color:C.muted }}>{t.at}</div>
                </div>
              </div>
            ))}

            {/* Resolve form */}
            {selectedInc.status !== "Resolved" && (
              <>
                <div style={{ fontSize:10, fontWeight:700, color:C.secondary, textTransform:"uppercase", letterSpacing:0.8, marginBottom:4, marginTop:8 }}>Resolution Note</div>
                <textarea value={resolveNote} onChange={e=>setResolveNote(e.target.value)} placeholder="Describe how incident was resolved…" style={{ width:"100%", minHeight:64, padding:"9px 11px", fontSize:12, fontFamily:font, background:C.bg, border:`1.5px solid ${C.border}`, borderRadius:7, outline:"none", resize:"vertical", marginBottom:10 }} />
                <button onClick={()=>handleResolve(selectedInc)} disabled={busy||!resolveNote.trim()} style={{ width:"100%", background:resolveNote.trim()?C.green:C.border, color:resolveNote.trim()?C.white:C.muted, border:"none", borderRadius:8, padding:"11px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:font }}>
                  {busy?"Resolving…":"✓ Mark Resolved"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* ── Phase 8: AUDIT CENTER ───────────────────────────────────────────────── */
function AuditCenter({ auditLog }) {
  const ACTION_COLORS = {
    ESCROW_RELEASE: C.green, PAYOUT_FREEZE: C.red, PAYOUT_UNFREEZE: C.green,
    INCIDENT_CREATED: C.amber, INCIDENT_RESOLVED: C.green,
    FRAUD_FLAG_RAISED: C.red, KYC_APPROVED: C.teal,
    FORCE_STATUS: C.purple, ACCOUNT_SUSPENDED: C.red, ACCOUNT_REINSTATED: C.green,
    BROADCAST_ALERT: C.amber, DISPUTE_RESOLVED: C.green, DISPATCH_ASSIGN: C.blue,
  };
  const ACTION_TYPES = ["ALL", "ESCROW", "INCIDENT", "FRAUD", "OPS", "DISPUTE"];
  const [filter, setFilter] = useState("ALL");
  const [csvDone, setCsvDone] = useState(false);

  const filtered = (auditLog||[]).filter(e => {
    if (filter === "ALL") return true;
    if (filter === "ESCROW")   return e.action.includes("ESCROW") || e.action.includes("PAYOUT");
    if (filter === "INCIDENT") return e.action.includes("INCIDENT");
    if (filter === "FRAUD")    return e.action.includes("FRAUD") || e.action.includes("SUSPENDED") || e.action.includes("REINSTATED");
    if (filter === "OPS")      return e.action.includes("FREEZE") || e.action.includes("BROADCAST") || e.action.includes("FORCE");
    if (filter === "DISPUTE")  return e.action.includes("DISPUTE");
    return true;
  });

  /* Feature 14 — CSV export */
  function downloadCSV() {
    const header = ["ID","Timestamp","Action","Entity","Detail","Admin"];
    const rows = filtered.map(e => [e.id, e.at, e.action, e.entity, `"${(e.detail||"").replace(/"/g,'""')}"`, e.admin]);
    const csv = [header, ...rows].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type:"text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `behari-audit-${filter}-${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
    setCsvDone(true); setTimeout(()=>setCsvDone(false), 2500);
  }

  return (
    <>
      {/* Filter chips + CSV export */}
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:10 }}>
        {ACTION_TYPES.map(t => (
          <button key={t} onClick={()=>setFilter(t)} style={{ background:filter===t?C.black:C.white, color:filter===t?C.white:C.secondary, border:`1.5px solid ${filter===t?C.black:C.border}`, borderRadius:100, padding:"5px 12px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font }}>
            {t}
          </button>
        ))}
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
        <div style={{ fontSize:12, color:C.muted }}>{filtered.length} entries · immutable audit trail</div>
        <button onClick={downloadCSV} disabled={filtered.length===0} style={{ background:csvDone?C.green:C.bg, color:csvDone?C.white:C.black, border:`1.5px solid ${csvDone?C.green:C.border}`, borderRadius:100, padding:"5px 14px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font, transition:"all .25s" }}>
          {csvDone?"✓ Downloaded!":"📥 Export CSV"}
        </button>
      </div>

      {/* Timeline */}
      <div style={{ ...card, overflow:"hidden" }}>
        {filtered.map((e,i,a) => {
          const ac = ACTION_COLORS[e.action] || C.muted;
          return (
            <div key={e.id} style={{ padding:"12px 16px", borderBottom:i<a.length-1?`1px solid ${C.border}`:"none", display:"flex", gap:12, alignItems:"flex-start" }}>
              {/* Dot + line */}
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", paddingTop:2 }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:ac, flexShrink:0 }} />
              </div>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8, marginBottom:2 }}>
                  <span style={{ fontSize:9, fontFamily:mono, fontWeight:700, color:ac, background:`${ac}18`, borderRadius:4, padding:"2px 6px" }}>{e.action}</span>
                  <span style={{ fontSize:10, color:C.muted, flexShrink:0 }}>{e.at}</span>
                </div>
                <div style={{ fontSize:12, fontWeight:600, color:C.black, marginBottom:2 }}>{e.detail}</div>
                <div style={{ fontSize:11, color:C.muted }}>
                  <span style={{ fontFamily:mono }}>{e.entity}</span> · {e.admin}
                </div>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <div style={{ padding:30, textAlign:"center", color:C.muted, fontSize:13, fontWeight:600 }}>No entries match this filter</div>}
      </div>
    </>
  );
}

/* ── KYC (keep verbatim) ─────────────────────────────────────────────────── */
function Kyc() {
  const [approved,setApproved] = useState([]);
  const [rejected,setRejected] = useState([]);
  const [modal,setModal]       = useState(null);
  const [lightbox,setLightbox] = useState(null); // Feature 8: {label, ok}
  const DOC_LABELS = { Driver:["National ID","Driver's Licence","GIT Insurance"], Shipper:["National ID","KRA PIN Cert","Business Reg. Cert"] };
  const pending = KYC_QUEUE.filter(u=>!approved.includes(u.id)&&!rejected.includes(u.id));

  /* Feature 8 — simulated doc images (data-URI 1×1 placeholder tints) */
  const DOC_COLORS = { "National ID":"#1a73e8", "Driver's Licence":"#0f9d58", "GIT Insurance":"#f4511e", "KRA PIN Cert":"#7c4dff", "Business Reg. Cert":"#ff6d00" };

  return (
    <>
      <div style={{ background:C.amberBg,border:`1px solid ${C.amber}44`,borderRadius:8,padding:"11px 14px",marginBottom:12,fontSize:13,fontWeight:600,color:C.amber }}>
        ⚠ {pending.length} application{pending.length!==1?"s":""} awaiting review
      </div>
      {/* Feature 13 — Bulk actions */}
      {pending.length>1&&(
        <div style={{ display:"flex",gap:8,marginBottom:12 }}>
          <button onClick={()=>setApproved(a=>[...a,...pending.map(u=>u.id)])} style={{ flex:1,background:C.green,color:C.white,border:"none",borderRadius:8,padding:"10px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>✓ Approve All ({pending.length})</button>
          <button onClick={()=>setRejected(r=>[...r,...pending.map(u=>u.id)])} style={{ flex:1,background:C.redBg,color:C.red,border:`1px solid ${C.red}44`,borderRadius:8,padding:"10px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>✕ Reject All ({pending.length})</button>
        </div>
      )}
      {pending.length===0&&<div style={{...card,padding:40,textAlign:"center",color:C.muted}}><div style={{fontSize:36,marginBottom:12}}>✅</div><div style={{fontSize:16,fontWeight:700,color:C.secondary}}>All clear — no pending KYC</div></div>}
      {pending.map(u=>(
        <div key={u.id} style={{...card,marginBottom:8,padding:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
            <div>
              <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:4}}>
                <span style={{fontSize:10,color:C.muted,fontFamily:mono}}>{u.id}</span>
                <Chip label={u.type} map={{Driver:{c:C.blue,b:C.blueBg},Shipper:{c:C.black,b:C.bg}}}/>
                <Chip label={u.risk+" Risk"} map={{"Low Risk":{c:C.green,b:C.greenBg},"Medium Risk":{c:C.amber,b:C.amberBg},"High Risk":{c:C.red,b:C.redBg}}}/>
              </div>
              <div style={{fontSize:17,fontWeight:700,color:C.black}}>{u.name}</div>
              <div style={{fontSize:12,color:C.muted}}>{u.phone} · {u.truck||u.company}</div>
            </div>
            <div style={{fontSize:11,color:C.muted}}>{u.submitted}</div>
          </div>
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            {DOC_LABELS[u.type].map((label,i)=>(
              <div key={label} style={{flex:1,background:u.docs[i]?C.greenBg:C.redBg,borderRadius:8,padding:"8px 6px",textAlign:"center"}}>
                <div style={{fontSize:16,marginBottom:2}}>{u.docs[i]?"✓":"✕"}</div>
                <div style={{fontSize:9,fontWeight:700,color:u.docs[i]?C.green:C.red,letterSpacing:0.3,lineHeight:1.2}}>{label}</div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setModal(u)} style={{flex:1,background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:"9px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font}}>View Docs</button>
            <button onClick={()=>setApproved(a=>[...a,u.id])} style={{flex:1,background:C.green,color:C.white,border:"none",borderRadius:8,padding:"9px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font}}>✓ Approve</button>
            <button onClick={()=>setRejected(r=>[...r,u.id])} style={{flex:1,background:C.redBg,color:C.red,border:`1px solid ${C.red}44`,borderRadius:8,padding:"9px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font}}>✕ Reject</button>
          </div>
        </div>
      ))}
      {modal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400,padding:16}} onClick={()=>setModal(null)}>
          <div style={{background:C.white,borderRadius:16,width:"100%",maxWidth:400,padding:"24px 20px"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div><div style={{fontSize:11,color:C.muted,marginBottom:3}}>{modal.id} · {modal.type}</div><div style={{fontSize:20,fontWeight:800,color:C.black}}>{modal.name}</div></div>
              <button onClick={()=>setModal(null)} style={{background:C.bg,border:"none",borderRadius:"50%",width:34,height:34,cursor:"pointer",fontSize:16,color:C.secondary}}>✕</button>
            </div>
            {/* Feature 8 — tap row to zoom doc */}
            <div style={{fontSize:10,color:C.muted,fontWeight:600,letterSpacing:0.6,marginBottom:6}}>TAP A DOCUMENT TO VIEW</div>
            <div style={{background:C.bg,borderRadius:12,overflow:"hidden",marginBottom:20}}>
              {DOC_LABELS[modal.type].map((label,i,a)=>(
                <div key={label} onClick={()=>modal.docs[i]&&setLightbox({label,ok:true})} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none",cursor:modal.docs[i]?"pointer":"default",transition:"background .15s"}} onMouseEnter={e=>{if(modal.docs[i])e.currentTarget.style.background=C.blueBg}} onMouseLeave={e=>e.currentTarget.style.background=""}>
                  <div><div style={{fontSize:13,fontWeight:700,color:C.black}}>{label}</div><div style={{fontSize:11,color:C.muted}}>{modal.docs[i]?"Submitted & readable — tap to zoom":"Missing or unclear"}</div></div>
                  <span style={{fontSize:18,fontWeight:900,color:modal.docs[i]?C.green:C.red}}>{modal.docs[i]?"🔍":"✕"}</span>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setApproved(a=>[...a,modal.id]);setModal(null);}} style={{flex:1,background:C.black,color:C.white,border:"none",borderRadius:8,padding:13,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:font}}>Approve</button>
              <button onClick={()=>{setRejected(r=>[...r,modal.id]);setModal(null);}} style={{flex:1,background:C.redBg,color:C.red,border:`1px solid ${C.red}44`,borderRadius:8,padding:13,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:font}}>Reject</button>
            </div>
          </div>
        </div>
      )}
      {/* Feature 8 — lightbox overlay */}
      {lightbox&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.92)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:500,padding:20}} onClick={()=>setLightbox(null)}>
          <div style={{color:"#fff",fontSize:13,fontWeight:700,marginBottom:16,letterSpacing:0.5}}>{lightbox.label} — Submitted Document</div>
          {/* Simulated document image */}
          <div style={{width:"100%",maxWidth:340,background:DOC_COLORS[lightbox.label]||"#333",borderRadius:12,padding:24,boxShadow:"0 8px 40px rgba(0,0,0,0.6)"}} onClick={e=>e.stopPropagation()}>
            <div style={{background:"rgba(255,255,255,0.15)",borderRadius:8,padding:"14px 16px",marginBottom:12}}>
              <div style={{color:"rgba(255,255,255,0.6)",fontSize:10,fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>REPUBLIC OF KENYA</div>
              <div style={{color:"#fff",fontSize:16,fontWeight:800}}>{lightbox.label}</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
              {["Full Name","ID / Reg. No","Issued Date","Expiry Date"].map(f=>(
                <div key={f} style={{background:"rgba(255,255,255,0.1)",borderRadius:6,padding:"8px 10px"}}>
                  <div style={{color:"rgba(255,255,255,0.5)",fontSize:9,fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{f}</div>
                  <div style={{color:"#fff",fontSize:11,fontWeight:600}}>{"█".repeat(6+Math.floor(Math.random()*6))}</div>
                </div>
              ))}
            </div>
            <div style={{background:"rgba(255,255,255,0.08)",borderRadius:6,height:48,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <div style={{color:"rgba(255,255,255,0.3)",fontSize:28,letterSpacing:12}}>▓▓▓▓▓▓▓▓</div>
            </div>
          </div>
          <div style={{color:"rgba(255,255,255,0.45)",fontSize:11,marginTop:16}}>Tap anywhere to close</div>
        </div>
      )}
    </>
  );
}

/* ── DISPUTES (keep verbatim) ────────────────────────────────────────────── */
function Disputes({ liveDisputes={}, escrowData={}, onClose=()=>{}, onRelease=()=>{}, onRefund=()=>{} }) {
  const [resolvedSeed,setResolvedSeed]=useState(["D-0088"]);
  const [modal,setModal]=useState(null);
  const [resolving,setResolving]=useState(false);
  /* Feature 7 — evidence thread per dispute */
  const [threads,setThreads]=useState({}); // { disputeId: [{role,text,at}] }
  const [threadInput,setThreadInput]=useState("");
  const liveList=Object.values(liveDisputes);
  const seedOpen=DISPUTES_SEED.filter(d=>!resolvedSeed.includes(d.id));
  const seedDone=DISPUTES_SEED.filter(d=>resolvedSeed.includes(d.id));
  const totalOpen=liveList.filter(d=>d.status!=="Resolved").length+seedOpen.length;
  const totalInReview=seedOpen.filter(d=>d.status==="In Review").length;
  const totalResolved=liveList.filter(d=>d.status==="Resolved").length+seedDone.length;
  async function handleResolve(opt){
    setResolving(true);
    const favor=opt.includes("driver")?"carrier":opt.includes("shipper")?"shipper":"both";
    if(modal._isLive){await onClose(modal.loadId,{resolution:opt,favor});if(favor==="carrier")await onRelease(modal.loadId,{});if(favor==="shipper")await onRefund(modal.loadId,opt);}
    else{setResolvedSeed(r=>[...r,modal.id]);}
    setResolving(false);setModal(null);
  }
  const RES_OPTS=[{label:"💸 Release full payment to driver"},{label:"↩ Refund shipper from escrow"},{label:"⚖ Split 50/50 — compromise"}];
  return(
    <>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
        {[["Open",totalOpen,C.red],["In Review",totalInReview,C.amber],["Resolved",totalResolved,C.green]].map(([l,n,c])=>(
          <div key={l} style={{...card,padding:"14px 12px",textAlign:"center"}}><div style={{fontSize:26,fontWeight:900,color:c}}>{n}</div><div style={{fontSize:10,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:0.8}}>{l}</div></div>
        ))}
      </div>
      {liveList.filter(d=>d.status!=="Resolved").length>0&&<>
        <SectionHead label="⚡ Live Disputes" color={C.red}/>
        {liveList.filter(d=>d.status!=="Resolved").map(d=>(
          <div key={d.id} style={{...card,padding:"14px 16px",marginBottom:8,borderLeft:`3px solid ${C.red}`}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,gap:8,flexWrap:"wrap"}}>
              <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}><span style={{fontSize:10,color:C.muted,fontFamily:mono}}>{d.id}</span><span style={{background:C.redBg,color:C.red,fontSize:10,fontWeight:700,borderRadius:100,padding:"2px 8px"}}>Open</span><span style={{background:C.amberBg,color:C.amber,fontSize:10,fontWeight:700,borderRadius:100,padding:"2px 8px"}}>High</span></div>
              <span style={{fontSize:11,color:C.muted,flexShrink:0}}>{d.openedAt}</span>
            </div>
            <div style={{fontSize:15,fontWeight:700,color:C.black,marginBottom:2}}>Delivery Dispute</div>
            <div style={{fontSize:12,color:C.muted,marginBottom:12}}>Load {d.loadId} · {d.raisedBy} raised · {d.reason}</div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:15,fontWeight:800,color:C.red}}>KSh {(escrowData[d.loadId]?.baseAmount||0).toLocaleString()}</span>
              <button onClick={()=>setModal({...d,_isLive:true,type:"Delivery Dispute",amount:escrowData[d.loadId]?.baseAmount||0})} style={{background:C.black,color:C.white,border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font}}>Resolve →</button>
            </div>
          </div>
        ))}
      </>}
      <SectionHead label="Active Disputes"/>
      {seedOpen.map(d=>(
        <div key={d.id} style={{...card,padding:"14px 16px",marginBottom:8}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,gap:8,flexWrap:"wrap"}}>
            <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}><span style={{fontSize:10,color:C.muted,fontFamily:mono}}>{d.id}</span><Chip label={d.status} map={STATUS_MAP}/><Chip label={d.priority} map={PRI_MAP}/></div>
            <span style={{fontSize:11,color:C.muted,flexShrink:0}}>{d.filed}</span>
          </div>
          <div style={{fontSize:16,fontWeight:700,color:C.black,marginBottom:2}}>{d.type}</div>
          <div style={{fontSize:12,color:C.muted,marginBottom:12}}>Load {d.load} · {d.shipper} vs {d.driver}</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:16,fontWeight:800,color:C.red}}>KSh {d.amount.toLocaleString()}</span>
            <button onClick={()=>setModal({...d,_isLive:false})} style={{background:C.black,color:C.white,border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font}}>Resolve →</button>
          </div>
        </div>
      ))}
      {(seedDone.length>0||liveList.filter(d=>d.status==="Resolved").length>0)&&<>
        <SectionHead label="Resolved"/>
        {seedDone.map(d=><div key={d.id} style={{...card,padding:"12px 16px",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center",opacity:0.65}}><div><div style={{fontSize:13,fontWeight:700,color:C.black}}>{d.type} · {d.load}</div><div style={{fontSize:11,color:C.muted}}>{d.id} · {d.filed}</div></div><Chip label="Resolved" map={STATUS_MAP}/></div>)}
        {liveList.filter(d=>d.status==="Resolved").map(d=><div key={d.id} style={{...card,padding:"12px 16px",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center",opacity:0.65}}><div><div style={{fontSize:13,fontWeight:700,color:C.black}}>Delivery Dispute · {d.loadId}</div><div style={{fontSize:11,color:C.muted}}>{d.id} · {d.closedAt}</div></div><Chip label="Resolved" map={STATUS_MAP}/></div>)}
      </>}
      {modal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:400}} onClick={()=>setModal(null)}>
          <div style={{background:C.white,borderRadius:"16px 16px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 36px",fontFamily:font}} onClick={e=>e.stopPropagation()}>
            <div style={{width:40,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px"}}/>
            <div style={{fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4}}>Resolve Dispute</div>
            <div style={{fontSize:20,fontWeight:800,color:C.black,marginBottom:2}}>{modal.type}</div>
            <div style={{fontSize:13,color:C.muted,marginBottom:16}}>{modal._isLive?modal.loadId:`${modal.id} · ${modal.load}`} · KSh {(modal.amount||0).toLocaleString()} at stake</div>
            {modal._isLive&&escrowData[modal.loadId]&&(
              <div style={{background:C.bg,borderRadius:8,padding:"12px 14px",marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>Escrow Summary</div>
                {[["Base amount",`KSh ${(escrowData[modal.loadId].baseAmount||0).toLocaleString()}`],["Late penalty",`KSh ${(escrowData[modal.loadId].latePenalty||0).toLocaleString()}`],["Escrow status",escrowData[modal.loadId].status]].map(([k,v])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:12,color:C.secondary}}>{k}</span><span style={{fontSize:12,fontWeight:700,color:C.black}}>{v}</span></div>
                ))}
              </div>
            )}
            {/* Feature 7 — Evidence thread */}
            <div style={{fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8}}>Evidence Thread</div>
            <div style={{background:C.bg,borderRadius:10,padding:"10px 12px",marginBottom:12,maxHeight:160,overflowY:"auto"}}>
              {(threads[modal.id||modal.loadId]||[]).length===0&&(
                <div style={{fontSize:12,color:C.muted,textAlign:"center",padding:"10px 0"}}>No comments yet — add evidence below</div>
              )}
              {(threads[modal.id||modal.loadId]||[]).map((c,i)=>(
                <div key={i} style={{marginBottom:8,display:"flex",flexDirection:"column",alignItems:c.role==="Admin"?"flex-end":"flex-start"}}>
                  <div style={{background:c.role==="Admin"?C.black:C.white,color:c.role==="Admin"?C.white:C.black,border:`1px solid ${C.border}`,borderRadius:c.role==="Admin"?"12px 12px 2px 12px":"12px 12px 12px 2px",padding:"7px 10px",maxWidth:"80%",fontSize:12,fontWeight:500}}>
                    {c.text}
                  </div>
                  <div style={{fontSize:9,color:C.muted,marginTop:2}}>{c.role} · {c.at}</div>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:6,marginBottom:12}}>
              <input value={threadInput} onChange={e=>setThreadInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&threadInput.trim()){const key=modal.id||modal.loadId;const entry={role:"Admin",text:threadInput.trim(),at:new Date().toLocaleTimeString("en-KE",{hour:"2-digit",minute:"2-digit"})};setThreads(t=>({...t,[key]:[...(t[key]||[]),entry]}));setThreadInput("");}}} placeholder="Add evidence or note…" style={{flex:1,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,padding:"9px 11px",fontSize:12,fontFamily:font,outline:"none"}}/>
              <button disabled={!threadInput.trim()} onClick={()=>{const key=modal.id||modal.loadId;const entry={role:"Admin",text:threadInput.trim(),at:new Date().toLocaleTimeString("en-KE",{hour:"2-digit",minute:"2-digit"})};setThreads(t=>({...t,[key]:[...(t[key]||[]),entry]}));setThreadInput("");}} style={{background:C.black,color:C.white,border:"none",borderRadius:8,padding:"9px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font,flexShrink:0}}>Send</button>
            </div>
            <div style={{fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8}}>Resolution Action</div>
            {RES_OPTS.map(opt=>(
              <button key={opt.label} disabled={resolving} onClick={()=>handleResolve(opt.label)} style={{display:"flex",alignItems:"center",width:"100%",textAlign:"left",background:C.white,color:C.black,border:`1.5px solid ${C.border}`,borderRadius:8,padding:"12px 16px",fontSize:14,fontWeight:600,cursor:resolving?"not-allowed":"pointer",fontFamily:font,marginBottom:8,opacity:resolving?0.6:1}}>
                {resolving?"Processing…":opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ── FRAUD FLAGS (keep verbatim) ─────────────────────────────────────────── */
function FraudFlags({ fraudFlags={}, onFlagFraud=()=>{}, onResolveFraudFlag=()=>{} }) {
  const [showFlag,setShowFlag]=useState(false);
  const [userId,setUserId]=useState("");
  const [reason,setReason]=useState("");
  const [severity,setSeverity]=useState("Medium");
  // useRef guarantees handleFlag always reads the LATEST severity value,
  // even if the user clicks Submit before the setState re-render fires.
  const severityRef=useRef("Medium");
  const [busy,setBusy]=useState(false);
  const allFlags=Object.values(fraudFlags).flat();
  const open=allFlags.filter(f=>!f.resolved);
  const resolved=allFlags.filter(f=>f.resolved);
  function pickSeverity(s){setSeverity(s);severityRef.current=s;}
  async function handleFlag(){if(!userId.trim()||!reason.trim())return;setBusy(true);await onFlagFraud(userId.trim(),reason.trim(),severityRef.current);setBusy(false);setShowFlag(false);setUserId("");setReason("");setSeverity("Medium");severityRef.current="Medium";}
  const FF_MAP={High:{c:C.red,b:C.redBg},Medium:{c:C.amber,b:C.amberBg},Low:{c:C.green,b:C.greenBg}};
  return(
    <>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
        {[["Active Flags",open.length,C.red],["Resolved",resolved.length,C.green],["Total",allFlags.length,C.black]].map(([l,n,c])=>(
          <div key={l} style={{...card,padding:"14px 12px",textAlign:"center"}}><div style={{fontSize:26,fontWeight:900,color:c}}>{n}</div><div style={{fontSize:10,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:0.8}}>{l}</div></div>
        ))}
      </div>
      <button onClick={()=>setShowFlag(true)} style={{width:"100%",background:C.red,color:C.white,border:"none",borderRadius:8,padding:"12px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font,marginBottom:16}}>🚩 Flag Suspicious User</button>
      {open.length===0&&<div style={{...card,padding:40,textAlign:"center"}}><div style={{fontSize:36,marginBottom:10}}>🛡️</div><div style={{fontSize:15,fontWeight:700,color:C.secondary}}>No active fraud flags</div><div style={{fontSize:12,color:C.muted,marginTop:4}}>The platform is looking clean</div></div>}
      {open.map(f=>(
        <div key={f.id} style={{...card,padding:"14px 16px",marginBottom:8,borderLeft:`3px solid ${FF_MAP[f.severity]?.c||C.amber}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
            <div>
              <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:4}}><span style={{fontSize:10,fontFamily:mono,color:C.muted}}>{f.id}</span><span style={{background:FF_MAP[f.severity]?.b||C.amberBg,color:FF_MAP[f.severity]?.c||C.amber,fontSize:10,fontWeight:700,borderRadius:100,padding:"2px 8px"}}>{f.severity} Risk</span></div>
              <div style={{fontSize:15,fontWeight:700,color:C.black}}>{f.userId}</div>
              <div style={{fontSize:12,color:C.muted,marginTop:2}}>{f.reason}</div>
            </div>
            <div style={{fontSize:11,color:C.muted,flexShrink:0}}>{f.flaggedAt}</div>
          </div>
          <button onClick={()=>onResolveFraudFlag(f.userId,f.id)} style={{width:"100%",background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:"9px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font}}>✓ Mark Resolved</button>
        </div>
      ))}
      {resolved.length>0&&<><SectionHead label="Resolved Flags"/>{resolved.map(f=><div key={f.id} style={{...card,padding:"12px 16px",marginBottom:6,opacity:0.55,display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><div style={{fontSize:13,fontWeight:700,color:C.black}}>{f.userId}</div><div style={{fontSize:11,color:C.muted}}>{f.reason} · {f.resolvedAt}</div></div><span style={{background:C.greenBg,color:C.green,fontSize:10,fontWeight:700,borderRadius:100,padding:"3px 8px"}}>Resolved</span></div>)}</>}
      {showFlag&&(
        <div style={{position:"fixed",inset:0,zIndex:500,display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={()=>setShowFlag(false)}>
          <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.5)"}}/>
          <div style={{position:"relative",background:C.white,borderRadius:"16px 16px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 36px",fontFamily:font}} onClick={e=>e.stopPropagation()}>
            <div style={{width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px"}}/>
            <div style={{fontSize:17,fontWeight:800,color:C.black,marginBottom:4}}>🚩 Flag Suspicious User</div>
            <div style={{fontSize:13,color:C.secondary,marginBottom:16}}>Flag a user for suspicious activity. This will be reviewed by the fraud team.</div>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:5}}>User ID / Phone</label>
            <input value={userId} onChange={e=>setUserId(e.target.value)} placeholder="+254 7XX / U-XXXX" style={{width:"100%",padding:"11px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",marginBottom:12}}/>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:5}}>Reason</label>
            <textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="Describe the suspicious behaviour…" style={{width:"100%",minHeight:72,padding:"10px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,resize:"vertical",outline:"none",marginBottom:12}}/>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:5}}>Severity</label>
            <div style={{display:"flex",gap:8,marginBottom:16}}>
              {["Low","Medium","High"].map(s=><button key={s} onClick={()=>pickSeverity(s)} style={{flex:1,padding:"10px",border:`2px solid ${severity===s?FF_MAP[s].c:C.border}`,borderRadius:8,background:severity===s?FF_MAP[s].b:C.white,color:FF_MAP[s].c,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font}}>{s}</button>)}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setShowFlag(false)} style={{flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black}}>Cancel</button>
              <button onClick={handleFlag} disabled={!userId.trim()||!reason.trim()||busy} style={{flex:2,background:userId.trim()&&reason.trim()?C.red:C.border,color:userId.trim()&&reason.trim()?C.white:C.muted,border:"none",borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font}}>{busy?"Flagging…":"Submit Flag"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── INTERVENTION PANEL (keep verbatim, tiny tweak for logAudit) ─────────── */
function InterventionPanel({ load, onForceStatus, onCancel, onClose, onLogAudit=()=>{} }) {
  const [reason,setReason]=useState("");
  const [busy,setBusy]=useState(false);
  const STATUS_OPTIONS=["Accepted","Loading","In Transit","Arrived","Delivery Confirmed","Cancelled"];
  return(
    <div style={{position:"fixed",inset:0,zIndex:500,display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={onClose}>
      <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.55)"}}/>
      <div style={{position:"relative",background:C.white,borderRadius:"16px 16px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 36px",fontFamily:font,maxHeight:"80vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px"}}/>
        <div style={{fontSize:11,color:C.amber,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4}}>Admin Intervention</div>
        <div style={{fontSize:18,fontWeight:800,color:C.black,marginBottom:2}}>{load.cargo} · {load.id}</div>
        <div style={{fontSize:13,color:C.secondary,marginBottom:16}}>{load.route||`${load.from}→${load.to}`} · Current: <strong>{load.status}</strong></div>
        <div style={{background:C.amberBg,borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:12,color:C.amber,fontWeight:600}}>⚠ Force-changing status will add an admin milestone to the shipment log.</div>
        <label style={{display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:5}}>Force Status To</label>
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
          {STATUS_OPTIONS.map(s=>(
            <button key={s} onClick={async()=>{setBusy(true);await onForceStatus(load.id,s,reason||"Admin override");await onLogAudit("FORCE_STATUS",load.id,`Status forced to ${s}: ${reason||"Admin override"}`,"Admin");setBusy(false);onClose();}} disabled={busy||s===load.status} style={{width:"100%",textAlign:"left",padding:"11px 14px",border:`1.5px solid ${C.border}`,borderRadius:8,background:s===load.status?C.bg:C.white,color:s===load.status?C.muted:C.black,fontSize:13,fontWeight:700,cursor:s===load.status?"not-allowed":"pointer",fontFamily:font}}>
              {s===load.status?`${s} ← current`:`→ ${s}`}
            </button>
          ))}
        </div>
        <label style={{display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:5}}>Reason (optional)</label>
        <input value={reason} onChange={e=>setReason(e.target.value)} placeholder="e.g. Transporter reported breakdown, manual correction…" style={{width:"100%",padding:"11px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",marginBottom:16}}/>
        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black}}>Cancel</button>
          <button onClick={async()=>{setBusy(true);await onCancel(load.id,"Admin cancelled");await onLogAudit("LOAD_CANCELLED",load.id,"Admin cancelled load","Admin");setBusy(false);onClose();}} disabled={busy} style={{flex:1,background:C.redBg,color:C.red,border:`1px solid ${C.red}44`,borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font}}>Cancel Load</button>
        </div>
      </div>
    </div>
  );
}

/* ── Feature 29: BROADCAST ALERT MODAL ──────────────────────────────────── */
function BroadcastModal({ onClose, onLogAudit = ()=>{} }) {
  const [audience, setAudience] = useState("All Transporters");
  const [channel,  setChannel]  = useState("push");   // push | email | sms
  const [subject,  setSubject]  = useState("");
  const [body,     setBody]     = useState("");
  const [sending,  setSending]  = useState(false);
  const [sent,     setSent]     = useState(false);

  async function handleSend() {
    if (!body.trim()) return;
    setSending(true);
    await new Promise(r => setTimeout(r, 1200));
    await onLogAudit("BROADCAST_ALERT", audience, `${channel.toUpperCase()}: ${subject||"(no subject)"} — ${body.slice(0,80)}`, "Admin");
    setSending(false);
    setSent(true);
    setTimeout(onClose, 2000);
  }

  const AUDIENCES = ["All Transporters","All Shippers","All Users","Nairobi Region","Mombasa Region","In-Transit Drivers"];
  const CHANNELS  = [
    { id:"push",  label:"📲 Push",  sub:"In-app notification" },
    { id:"email", label:"📧 Email", sub:"Via Mailchimp" },
    { id:"sms",   label:"📱 SMS",   sub:"Via Safaricom Bonga" },
  ];

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:9000 }} onClick={onClose}>
      <div style={{ background:C.white,borderRadius:"16px 16px 0 0",width:"100%",maxWidth:520,padding:"8px 20px 36px",maxHeight:"90vh",overflowY:"auto",fontFamily:font }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:40,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        {sent ? (
          <div style={{ textAlign:"center",padding:"24px 0" }}>
            <div style={{ fontSize:40,marginBottom:12 }}>✅</div>
            <div style={{ fontSize:18,fontWeight:800,color:C.black }}>Alert Sent!</div>
            <div style={{ fontSize:13,color:C.muted,marginTop:4 }}>Delivered to {audience} via {channel.toUpperCase()}</div>
          </div>
        ) : (
          <>
            <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Broadcast Alert</div>
            <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:16 }}>Compose Message</div>

            {/* Audience */}
            <div style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:6 }}>Audience</div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:6,marginBottom:14 }}>
              {AUDIENCES.map(a=>(
                <button key={a} onClick={()=>setAudience(a)} style={{ background:audience===a?C.black:C.bg, color:audience===a?C.white:C.secondary, border:`1px solid ${audience===a?C.black:C.border}`, borderRadius:100, padding:"5px 12px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font }}>
                  {a}
                </button>
              ))}
            </div>

            {/* Channel */}
            <div style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:6 }}>Channel</div>
            <div style={{ display:"flex",gap:8,marginBottom:14 }}>
              {CHANNELS.map(ch=>(
                <button key={ch.id} onClick={()=>setChannel(ch.id)} style={{ flex:1, background:channel===ch.id?C.black:C.bg, color:channel===ch.id?C.white:C.secondary, border:`1px solid ${channel===ch.id?C.black:C.border}`, borderRadius:8, padding:"10px 8px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:font, textAlign:"center" }}>
                  <div>{ch.label}</div>
                  <div style={{ fontSize:10,fontWeight:500,opacity:0.7,marginTop:2 }}>{ch.sub}</div>
                </button>
              ))}
            </div>

            {/* Subject (email/push only) */}
            {channel !== "sms" && (
              <>
                <div style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:5 }}>Subject</div>
                <input value={subject} onChange={e=>setSubject(e.target.value)} placeholder="e.g. New loads available in Mombasa" style={{ width:"100%",background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,padding:"10px 13px",fontSize:13,fontFamily:font,outline:"none",marginBottom:12 }} />
              </>
            )}

            {/* Body */}
            <div style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:5 }}>Message</div>
            <textarea value={body} onChange={e=>setBody(e.target.value)} rows={4} placeholder={channel==="sms"?"Keep it short — SMS is 160 chars":"Write your message to transporters/shippers…"} maxLength={channel==="sms"?160:undefined} style={{ width:"100%",background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,padding:"10px 13px",fontSize:13,fontFamily:font,outline:"none",resize:"vertical",marginBottom:8 }} />
            {channel==="sms" && <div style={{ fontSize:11,color:C.muted,marginBottom:12,textAlign:"right" }}>{body.length}/160</div>}

            <button onClick={handleSend} disabled={!body.trim()||sending} style={{ width:"100%",background:body.trim()&&!sending?C.black:"#C8C8C8",color:C.white,border:"none",borderRadius:8,padding:"13px",fontSize:14,fontWeight:700,cursor:body.trim()&&!sending?"pointer":"not-allowed",fontFamily:font }}>
              {sending ? "Sending…" : `📤 Send to ${audience}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Phase 9: NETWORK COMMAND — the matching engine, made visible ────────── *
 * Per product direction: matching is the reason Behari exists, so admin must
 * see the network itself — available capacity, available cargo, potential
 * and made matches, and where the network is failing to connect (unmatched
 * trucks / unmatched cargo) — not just manually dispatch already-booked loads.
 */
function corridorTownMatch(name, corridor) {
  if (!name) return false;
  const nl = name.toLowerCase();
  return corridor.waypoints.some(w => nl.includes(w.label.split(",")[0].toLowerCase()));
}

/** Phase 4G.4 — live operations view over every backend-tracked trip. */
function AdminActiveTrips() {
  const { trips, loading, error } = useAllLiveTrips();
  const [fleet, setFleet] = useState({ trucks: [], drivers: [] });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  useEffect(() => {
    Promise.all([getTrucks(), getDrivers()]).then(([trucks, drivers]) => setFleet({ trucks, drivers }));
  }, []);

  function plateFor(truckId) { return fleet.trucks.find(t => t.id === truckId)?.plate || truckId; }
  function nameFor(driverId) { return fleet.drivers.find(d => d.id === driverId)?.name || driverId; }

  const rows = trips.map(({ trip, location }) => ({
    trip, location,
    plate: plateFor(trip.truckId),
    driverName: nameFor(trip.driverId),
  }));

  const statuses = ["All", ...new Set(rows.map(r => r.trip.status))];
  const q = query.trim().toLowerCase();
  const filtered = rows.filter(r => {
    if (statusFilter !== "All" && r.trip.status !== statusFilter) return false;
    if (!q) return true;
    const haystack = `${r.plate} ${r.driverName} ${r.trip.pickup} ${r.trip.delivery} ${r.trip.loadId} ${r.trip.id}`.toLowerCase();
    return haystack.includes(q);
  });

  return (
    <>
      <SectionHead label="Active Trips (Live)" color={C.green} />
      <div style={{ display:"flex", gap:8, marginBottom:10 }}>
        <input
          value={query} onChange={e=>setQuery(e.target.value)} placeholder="Filter by truck, driver, route, trip…"
          style={{ flex:1, padding:"9px 12px", fontSize:13, fontFamily:font, border:`1px solid ${C.border}`, borderRadius:8, outline:"none" }}
        />
        <select
          value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}
          style={{ padding:"9px 10px", fontSize:13, fontFamily:font, border:`1px solid ${C.border}`, borderRadius:8, outline:"none", background:C.white }}
        >
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {loading && <div style={{ textAlign:"center", padding:16, color:C.muted, fontSize:13 }}>Loading live trips…</div>}
      {error && <div style={{ ...card, padding:14, color:C.red, fontSize:13, marginBottom:16 }}>Live tracking backend unavailable: {error}</div>}
      {!loading && !error && filtered.length === 0 && (
        <div style={{ ...card, padding:20, textAlign:"center", color:C.muted, fontSize:13, marginBottom:16 }}>No trips match.</div>
      )}
      {!loading && filtered.map(({ trip, location, plate, driverName }) => {
        const ago = location ? Math.max(0, Math.round((Date.now() - new Date(location.timestamp).getTime())/1000)) : null;
        return (
          <div key={trip.id} style={{ ...card, padding:"12px 14px", marginBottom:8, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <div style={{ fontSize:13, fontWeight:800, color:C.black }}>{plate} <span style={{ color:C.muted, fontWeight:600 }}>· {driverName}</span></div>
              <div style={{ fontSize:11, color:C.secondary, marginTop:2 }}>{trip.pickup} → {trip.delivery} · Trip {trip.loadId || trip.id}</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:11, fontWeight:800, color:C.green }}>{trip.status}</div>
              <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>
                {location ? `${Math.round(location.speed||0)} km/h · ${ago<60?`${ago}s`:`${Math.round(ago/60)}m`} ago` : "no location yet"}
              </div>
            </div>
          </div>
        );
      })}
      <div style={{ height:16 }} />
    </>
  );
}

function NetworkCommand({ networkStats = {}, truckAvailabilities = [], matchingCargoPool = [], onGetUnmatchedTrucks = ()=>Promise.resolve([]), onGetUnmatchedCargo = ()=>Promise.resolve([]), corridors = [] }) {
  const [unmatchedTrucks, setUnmatchedTrucks] = useState([]);
  const [unmatchedCargo,  setUnmatchedCargo]  = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      onGetUnmatchedTrucks(matchingCargoPool),
      onGetUnmatchedCargo(truckAvailabilities, matchingCargoPool),
    ]).then(([ut, uc]) => { setUnmatchedTrucks(ut); setUnmatchedCargo(uc); setLoading(false); });
  }, [truckAvailabilities.length, matchingCargoPool.length]); // eslint-disable-line

  const corridorStats = corridors.map(cor => {
    const trucksHere = truckAvailabilities.filter(t => corridorTownMatch(t.currentLocation?.name, cor) || corridorTownMatch(t.goingToward, cor));
    const cargoHere  = matchingCargoPool.filter(c => corridorTownMatch(c.from, cor) || corridorTownMatch(c.to, cor));
    let matches = 0;
    trucksHere.forEach(t => cargoHere.forEach(c => { if (scoreMatch(t, c).matchScore >= 40) matches += 1; }));
    return {
      ...cor,
      trucksHere: trucksHere.length,
      cargoHere: cargoHere.length,
      matches,
      unmatched: trucksHere.filter(t => !cargoHere.some(c => scoreMatch(t, c).matchScore >= 40)).length
               + cargoHere.filter(c => !trucksHere.some(t => scoreMatch(t, c).matchScore >= 40)).length,
    };
  });

  return (
    <>
      <AdminActiveTrips />

      <NetworkStats stats={networkStats} />
      <div style={{ height:16 }} />

      <SectionHead label="Corridor Intelligence" />
      <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:18 }}>
        {corridorStats.map(cor => (
          <div key={cor.id} style={{ ...card, padding:"12px 14px" }}>
            <div style={{ fontSize:13, fontWeight:800, color:C.black, marginBottom:8 }}>{cor.name}</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6 }}>
              {[["Trucks",cor.trucksHere,C.blue],["Cargo",cor.cargoHere,C.amber],["Matches",cor.matches,C.green],["Unmatched",cor.unmatched,C.red]].map(([l,v,c]) => (
                <div key={l} style={{ textAlign:"center" }}>
                  <div style={{ fontSize:17, fontWeight:900, color:c }}>{v}</div>
                  <div style={{ fontSize:9, color:C.muted, fontWeight:700, textTransform:"uppercase", letterSpacing:0.4 }}>{l}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <SectionHead label="Unmatched Truck Capacity" color={C.amber} />
      {loading && <div style={{ textAlign:"center", padding:20, color:C.muted, fontSize:13 }}>Scoring the network…</div>}
      {!loading && unmatchedTrucks.length === 0 && (
        <div style={{ ...card, padding:24, textAlign:"center", color:C.muted, fontSize:13, marginBottom:16 }}>Every declared truck has a compatible match right now.</div>
      )}
      {!loading && unmatchedTrucks.map(t => (
        <div key={t.id} style={{ ...card, padding:"12px 14px", marginBottom:8 }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.black }}>{t.plate} · {t.truckType}</div>
          <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
            {t.currentLocation?.name || "—"} → {t.goingToward || "—"} · {t.capacity || "—"} · max detour {t.maxDetourKm}km
          </div>
        </div>
      ))}

      <div style={{ height:8 }} />
      <SectionHead label="Unmatched Cargo" color={C.red} />
      {!loading && unmatchedCargo.length === 0 && (
        <div style={{ ...card, padding:24, textAlign:"center", color:C.muted, fontSize:13 }}>Every open cargo item has a compatible truck right now.</div>
      )}
      {!loading && unmatchedCargo.map(c => (
        <div key={c.id} style={{ ...card, padding:"12px 14px", marginBottom:8 }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.black }}>{c.cargo} · {c.from} → {c.to}</div>
          <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
            {c.weight || "—"} · needs {c.truck || "Any"} · KSh {(c.pay || 0).toLocaleString()}
          </div>
        </div>
      ))}
    </>
  );
}

/* ── Tab definitions ─────────────────────────────────────────────────────── */
const PAGES = [
  { id:"command",   label:"Command"   },
  { id:"network",   label:"Network"   },
  { id:"heatmap",   label:"Heatmap"   },
  { id:"risk",      label:"Risk"      },
  { id:"treasury",  label:"Treasury"  },
  { id:"dispatch",  label:"Dispatch"  },
  { id:"incidents", label:"Incidents" },
  { id:"audit",     label:"Audit"     },
  { id:"kyc",       label:"KYC",      badge:4 },
  { id:"disputes",  label:"Disputes", badge:3 },
  { id:"fraud",     label:"Fraud"     },
];

/* ── ROOT ────────────────────────────────────────────────────────────────── */
export default function BehariAdmin({
  postedLoads = [], notifications = [], deliveredLoadIds = new Set(),
  loadStatuses = {}, escrowData = {}, disputes = {},
  onCloseDispute = ()=>{}, onReleaseEscrow = ()=>{}, onRefundEscrow = ()=>{},
  onCancelShipment = ()=>{}, onReassignTruck = ()=>{},
  fraudFlags = {}, onFlagFraud = ()=>{}, onResolveFraudFlag = ()=>{}, onAdminForceStatus = ()=>{},
  milestones = {},
  // Dark mode (lifted to App.jsx — uniform across all portals)
  darkMode = false, toggleDark = ()=>{},
  // Matching engine (Truck ↔ Cargo) — see hooks/useMatching.js
  truckAvailabilities = [], matchingCargoPool = [], networkStats = {},
  onGetUnmatchedTrucks = ()=>Promise.resolve([]), onGetUnmatchedCargo = ()=>Promise.resolve([]),
}) {
  const [page, setPage]             = useState("command");
  const [showBroadcast, setShowBroadcast] = useState(false); // Feature 29

  // Admin-only state — never touches App.jsx
  const adminOps = useAdminOps();

  // Phase 3A — canonical load list for admin view, sourced entirely from the
  // centralized pipeline (SEED_LOADS + live postedLoads, deduplicated, with
  // loadStatuses overrides already applied) instead of a private admin-only
  // array. toAdminLoadView() adds the "route" string + booking-aware driver
  // field this file's components already expect — no other prop shape changed.
  const allAdminLoads = getAllKnownLoads().map(l => toAdminLoadView(l, notifications));

  // Derived metrics for health + alerts
  const openDisputeCount = Object.values(disputes).filter(d => d.status !== "Resolved").length;
  const fraudFlagCount   = Object.values(fraudFlags).flat().filter(f => !f.resolved).length;

  // Refresh health score whenever load/dispute/fraud state changes
  useEffect(() => {
    adminOps.refreshHealth(allAdminLoads, openDisputeCount, fraudFlagCount);
  }, [allAdminLoads.length, openDisputeCount, fraudFlagCount]); // eslint-disable-line

  const currentPage = PAGES.find(p => p.id === page);

  return (
    <div style={{ background:C.bg, minHeight:"100vh", fontFamily:font, color:C.black }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Roboto+Mono:wght@400;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-thumb{background:${C.border}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes glow{0%,100%{box-shadow:0 0 6px ${C.green}44}50%{box-shadow:0 0 18px ${C.green}88}}
        @keyframes slideInTop{from{transform:translateY(-8px);opacity:0}to{transform:translateY(0);opacity:1}}
      `}</style>

      {/* App bar */}
      <div style={{ background:C.white, borderBottom:`1px solid ${C.border}`, padding:"0 16px", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", height:52 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:5, height:22, background:C.green, borderRadius:3 }} />
            <div>
              <div style={{ fontSize:15, fontWeight:800, color:C.black, letterSpacing:-0.3 }}>Behari Freight</div>
              <div style={{ fontSize:10, color:C.muted, fontWeight:600, letterSpacing:0.5 }}>NATIONAL COMMAND CENTRE</div>
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {adminOps.frozenPayouts && (
              <span style={{ background:C.redBg, color:C.red, fontSize:9, fontWeight:700, borderRadius:100, padding:"3px 8px", animation:"pulse 1.5s infinite" }}>🔴 PAYOUTS FROZEN</span>
            )}
            {/* Dark mode toggle — near bell */}
            <button onClick={toggleDark} title={darkMode?"Switch to light mode":"Switch to dark mode"} style={{ background:"none", border:`1px solid transparent`, borderRadius:8, width:36, height:36, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:18, flexShrink:0 }}>
              {darkMode ? "☀️" : "🌙"}
            </button>
            {/* Feature 29 — Broadcast alert button */}
            <button onClick={()=>setShowBroadcast(true)} style={{ background:C.amberBg, color:C.amber, border:`1px solid ${C.amber}44`, borderRadius:8, padding:"5px 10px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:font }}>
              📢 Alert
            </button>
            <div style={{ fontSize:11, fontWeight:600, color:C.muted }}>{new Date().toLocaleDateString("en-KE",{ day:"numeric",month:"short" })}</div>
          </div>
        </div>

        {/* Tabs — scrollable with right-fade scroll indicator */}
        <div style={{ position:"relative", borderTop:`1px solid ${C.border}` }}>
          <div style={{ display:"flex", overflowX:"auto", WebkitOverflowScrolling:"touch", scrollbarWidth:"none", msOverflowStyle:"none" }}>
          {PAGES.map(p => (
            <button key={p.id} onClick={()=>setPage(p.id)} style={{
              flexShrink:0, padding:"10px 10px", fontSize:11, fontWeight:700, fontFamily:font,
              border:"none", background:"transparent",
              color:page===p.id?C.black:C.muted,
              borderBottom:page===p.id?`2.5px solid ${C.black}`:"2.5px solid transparent",
              cursor:"pointer", whiteSpace:"nowrap", transition:"color 0.15s",
              display:"flex", alignItems:"center", gap:3
            }}>
              {p.label}
              {p.badge && <span style={{ background:C.red, color:C.white, borderRadius:100, minWidth:14, height:14, padding:"0 3px", fontSize:8, fontWeight:900, display:"inline-flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>{p.badge}</span>}
            </button>
          ))}
          </div>
          {/* Right-fade gradient — signals there are more tabs to scroll to */}
          <div style={{ position:"absolute", top:0, right:0, bottom:0, width:32, background:`linear-gradient(to left, ${C.white} 20%, transparent)`, pointerEvents:"none" }} />
        </div>
      </div>

      {/* Page content */}
      <div style={{ padding:"12px 12px 48px", maxWidth:720, margin:"0 auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <div style={{ fontSize:20, fontWeight:800, color:C.black, letterSpacing:-0.4 }}>{currentPage?.label}</div>
          <div style={{ fontSize:11, fontWeight:600, color:C.muted }}>Admin · Nairobi HQ</div>
        </div>

        {page === "command"   && <CommandCenter allLoads={allAdminLoads} healthScore={adminOps.healthScore} networkAlerts={adminOps.networkAlerts} auditLog={adminOps.auditLog} corridors={adminOps.corridors} adminOps={adminOps} />}
        {page === "network"   && <NetworkCommand networkStats={networkStats} truckAvailabilities={truckAvailabilities} matchingCargoPool={matchingCargoPool} onGetUnmatchedTrucks={onGetUnmatchedTrucks} onGetUnmatchedCargo={onGetUnmatchedCargo} corridors={adminOps.corridors} />}
        {page === "heatmap"   && <NationalHeatmap allLoads={allAdminLoads} corridors={adminOps.corridors} onForceStatus={onAdminForceStatus} onCancelShipment={onCancelShipment} adminOps={adminOps} />}
        {page === "risk"      && <RiskCenter carrierRiskProfiles={adminOps.carrierRiskProfiles} shipperRiskProfiles={adminOps.shipperRiskProfiles} carrierRoster={adminOps.carrierRoster} />}
        {page === "treasury"  && <Treasury escrowData={escrowData} frozenPayouts={adminOps.frozenPayouts} frozenPayoutsReason={adminOps.frozenPayoutsReason} onFreezePayouts={adminOps.freezePayouts} onUnfreezePayouts={adminOps.unfreezePayouts} allLoads={allAdminLoads} onReleaseEscrow={onReleaseEscrow} />}
        {page === "dispatch"  && <DispatchCenter allLoads={allAdminLoads} carrierRoster={adminOps.carrierRoster} adminOps={adminOps} />}
        {page === "incidents" && <IncidentCenter incidents={adminOps.incidents} adminOps={adminOps} />}
        {page === "audit"     && <AuditCenter auditLog={adminOps.auditLog} />}
        {page === "kyc"       && <Kyc />}
        {page === "disputes"  && <Disputes liveDisputes={disputes} escrowData={escrowData} onClose={onCloseDispute} onRelease={onReleaseEscrow} onRefund={onRefundEscrow} />}
        {page === "fraud"     && <FraudFlags fraudFlags={fraudFlags} onFlagFraud={onFlagFraud} onResolveFraudFlag={onResolveFraudFlag} />}
      </div>

      {/* Feature 29 — Broadcast alert modal */}
      {showBroadcast && (
        <BroadcastModal onClose={()=>setShowBroadcast(false)} onLogAudit={adminOps.logAudit} />
      )}
    </div>
  );
}

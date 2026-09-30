/**
 * src/components/matching/MatchCard.jsx
 * The core matching UI element — used identically in the Carrier portal
 * (truck looking at cargo matches), the Shipper portal (cargo looking at
 * truck matches), and Admin. Same component both directions, per product
 * requirement that matching "must not build two disconnected systems."
 *
 * Plain props only:
 *   match   — a scoreMatch() result (matchScore, reasons[], routeCompatibility,
 *             detourDistance, originDistance, capacityCompatibility,
 *             availabilityCompatibility, priceCompatibility)
 *   truck   — { plate, truckType, currentLocation, goingToward, availableFrom, carrierName }
 *   cargo   — { cargo, from, to, weight, pay, pickD, pickT, shipper }
 *   primaryLabel / onPrimary — the call-to-action ("Book Load" or "Request Truck")
 */
import { useState } from "react";
import { COLORS as C, FONT as font } from "../../constants/theme.js";
import MatchScoreBadge from "./MatchScoreBadge.jsx";
import RouteCompatibility from "./RouteCompatibility.jsx";

const card = { background:C.white, borderRadius:10, border:`1px solid ${C.border}`, boxShadow:"0 1px 4px rgba(0,0,0,0.06)" };

function fmtAvail(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString("en-KE", { hour:"2-digit", minute:"2-digit" });
    if (isToday) return `Today, ${time}`;
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${time}`;
    return `${d.toLocaleDateString("en-KE",{ day:"numeric", month:"short" })}, ${time}`;
  } catch { return iso; }
}

export default function MatchCard({ match, truck, cargo, primaryLabel = "View Match", onPrimary = () => {}, secondaryLabel, onSecondary }) {
  const [open, setOpen] = useState(false);
  if (!match) return null;

  const truckLoc = truck?.currentLocation?.name || truck?.currentTripTo || "Truck";
  const pickup    = cargo?.from || "Pickup";
  const dest      = cargo?.to   || "Destination";

  return (
    <div style={{ ...card, marginBottom:10, overflow:"hidden" }}>
      <div style={{ padding:14, cursor:"pointer" }} onClick={() => setOpen(o => !o)}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10, gap:8 }}>
          <MatchScoreBadge score={match.matchScore} size="lg" />
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:18, fontWeight:800, color:C.black, letterSpacing:-0.3 }}>
              KSh {(cargo?.pay || 0).toLocaleString()}
            </div>
            {cargo?.weight && <div style={{ fontSize:11, color:C.muted }}>{cargo.weight}</div>}
          </div>
        </div>

        {/* TRUCK LOCATION → PICKUP → DESTINATION */}
        <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:10, flexWrap:"wrap" }}>
          <div style={{ flex:"1 1 auto", minWidth:70 }}>
            <div style={{ fontSize:9, color:C.muted, fontWeight:700, letterSpacing:0.5, textTransform:"uppercase" }}>Truck</div>
            <div style={{ fontSize:13, fontWeight:700, color:C.black }}>{truckLoc}</div>
          </div>
          <span style={{ color:C.muted, fontSize:14 }}>→</span>
          <div style={{ flex:"1 1 auto", minWidth:70 }}>
            <div style={{ fontSize:9, color:C.muted, fontWeight:700, letterSpacing:0.5, textTransform:"uppercase" }}>Pickup</div>
            <div style={{ fontSize:13, fontWeight:700, color:C.black }}>{pickup}</div>
          </div>
          <span style={{ color:C.muted, fontSize:14 }}>→</span>
          <div style={{ flex:"1 1 auto", minWidth:70 }}>
            <div style={{ fontSize:9, color:C.muted, fontWeight:700, letterSpacing:0.5, textTransform:"uppercase" }}>Destination</div>
            <div style={{ fontSize:13, fontWeight:700, color:C.black }}>{dest}</div>
          </div>
        </div>

        {cargo?.cargo && (
          <div style={{ fontSize:13, color:C.secondary, marginBottom:8 }}>
            {cargo.cargo}{cargo.shipper ? ` · ${cargo.shipper}` : ""}
          </div>
        )}

        {/* Chips row */}
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:8 }}>
          <RouteCompatibility type={match.routeCompatibility} detourKm={match.detourDistance} />
          {match.originDistance != null && (
            <span style={{ background:C.bg, color:C.secondary, borderRadius:100, padding:"3px 10px", fontSize:11, fontWeight:600 }}>
              {match.originDistance.toFixed(0)} km from pickup
            </span>
          )}
          {truck?.availableFrom && (
            <span style={{ background:C.bg, color:C.secondary, borderRadius:100, padding:"3px 10px", fontSize:11, fontWeight:600 }}>
              ⏱ {fmtAvail(truck.availableFrom)}
            </span>
          )}
        </div>

        <div style={{ textAlign:"right", fontSize:11, color:C.muted }}>{open ? "▲ less" : "▼ why this match"}</div>
      </div>

      {open && (
        <div style={{ borderTop:`1px solid ${C.border}`, padding:14, background:C.bg }}>
          <div style={{ fontSize:11, fontWeight:700, color:C.muted, letterSpacing:0.6, textTransform:"uppercase", marginBottom:8 }}>Why this match</div>
          {(match.reasons || []).map((r, i) => (
            <div key={i} style={{ fontSize:12, color:C.black, marginBottom:5, lineHeight:1.5 }}>{r}</div>
          ))}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:10 }}>
            {[
              ["Capacity",     match.capacityCompatibility     ? "✓ Fits" : "⚠ Check"],
              ["Availability", match.availabilityCompatibility ? "✓ Good window" : "⚠ Check timing"],
              ["Price",        match.priceCompatibility        ? "✓ Fair rate" : "⚠ Below benchmark"],
              ["Route",        match.destinationCompatibility  ? "✓ Exact" : match.routeCompatibility],
            ].map(([k, v]) => (
              <div key={k} style={{ background:C.white, borderRadius:8, padding:"7px 10px", border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:9, color:C.muted, fontWeight:700, textTransform:"uppercase" }}>{k}</div>
                <div style={{ fontSize:12, fontWeight:700, color:C.black }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display:"flex", gap:8, padding:"0 14px 14px" }}>
        {secondaryLabel && (
          <button onClick={onSecondary} style={{ flex:1, background:C.white, color:C.secondary, border:`1px solid ${C.border}`, borderRadius:8, padding:"11px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:font }}>
            {secondaryLabel}
          </button>
        )}
        <button onClick={onPrimary} style={{ flex:2, background:C.black, color:C.white, border:"none", borderRadius:8, padding:"11px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:font }}>
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}

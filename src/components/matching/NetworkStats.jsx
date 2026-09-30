/**
 * src/components/matching/NetworkStats.jsx
 * Network-wide matching stat tiles — used on the landing page and in the
 * Admin "Network Command" tab. Always visibly captioned as simulated demo
 * data, per product requirement: never imply real live network numbers.
 */
import { COLORS as C, FONT as font } from "../../constants/theme.js";

const card = { background:C.white, borderRadius:10, border:`1px solid ${C.border}`, boxShadow:"0 1px 4px rgba(0,0,0,0.05)" };

export default function NetworkStats({ stats = {}, dark = false, compact = false }) {
  const tiles = [
    ["Available trucks", stats.availableTrucks ?? 0, C.blue],
    ["Available cargo",  stats.availableCargo  ?? 0, C.amber],
    ["Potential matches",stats.potentialMatches?? 0, C.green],
    ["Matches today",    stats.matchesToday    ?? 0, C.black],
  ];
  return (
    <div style={{ fontFamily:font }}>
      <div style={{
        display:"grid", gridTemplateColumns:`repeat(${tiles.length}, 1fr)`, gap:8,
        marginBottom:6,
      }}>
        {tiles.map(([label, value, accent]) => (
          <div key={label} style={{
            ...(dark
              ? { background:"#111", border:"1px solid #2a2a2a", borderRadius:10 }
              : { ...card }),
            padding: compact ? "10px 8px" : "14px 10px", textAlign:"center",
          }}>
            <div style={{ fontSize: compact ? 18 : 22, fontWeight:800, color: dark ? C.white : accent, letterSpacing:-0.5 }}>{value}</div>
            <div style={{ fontSize:10, color: dark ? "rgba(255,255,255,0.45)" : C.muted, fontWeight:600, marginTop:2 }}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize:10, color: dark ? "rgba(255,255,255,0.35)" : C.muted, textAlign:"center", fontStyle:"italic" }}>
        Simulated network activity — demo data
      </div>
    </div>
  );
}

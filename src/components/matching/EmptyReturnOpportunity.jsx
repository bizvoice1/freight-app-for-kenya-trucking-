/**
 * src/components/matching/EmptyReturnOpportunity.jsx
 * The "⚠ Empty Return Risk" banner — the product's central use case: a truck
 * that finished a delivery and would otherwise drive back empty.
 */
import { COLORS as C, FONT as font } from "../../constants/theme.js";

export default function EmptyReturnOpportunity({ direction, matchCount = 0, onViewMatches = () => {} }) {
  if (matchCount > 0) {
    return (
      <div style={{ background:C.greenBg, border:`1px solid ${C.green}55`, borderRadius:10, padding:"12px 14px", marginBottom:12, fontFamily:font }}>
        <div style={{ fontSize:13, fontWeight:800, color:C.green, marginBottom:2 }}>✅ Return Loads Found</div>
        <div style={{ fontSize:12, color:C.secondary, marginBottom:8 }}>
          {matchCount} compatible load{matchCount !== 1 ? "s" : ""} found heading toward {direction || "your destination"}.
        </div>
        <button onClick={onViewMatches} style={{ background:C.green, color:C.black, border:"none", borderRadius:8, padding:"8px 14px", fontSize:12, fontWeight:800, cursor:"pointer", fontFamily:font }}>
          View Matches →
        </button>
      </div>
    );
  }
  return (
    <div style={{ background:C.amberBg, border:`1px solid ${C.amber}55`, borderRadius:10, padding:"12px 14px", marginBottom:12, fontFamily:font }}>
      <div style={{ fontSize:13, fontWeight:800, color:C.amber, marginBottom:2 }}>⚠ Empty Return Risk</div>
      <div style={{ fontSize:12, color:C.secondary }}>
        This truck may return toward {direction || "its next stop"} without cargo. Behari is watching for matching loads.
      </div>
    </div>
  );
}

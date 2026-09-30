/**
 * src/components/matching/MatchScoreBadge.jsx
 * The "94% MATCH" pill used on every MatchCard, shared by both portals.
 * Plain-props component — no service/data imports (per the existing rule
 * already documented in useLoads.js: components must not import from
 * services/data directly).
 */
import { COLORS as C, FONT as font } from "../../constants/theme.js";

export default function MatchScoreBadge({ score = 0, size = "md" }) {
  const color = score >= 80 ? C.green : score >= 55 ? C.amber : C.red;
  const bg    = score >= 80 ? C.greenBg : score >= 55 ? C.amberBg : C.redBg;
  const big   = size === "lg";
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:4,
      background:bg, color, borderRadius:100,
      padding: big ? "6px 14px" : "4px 10px",
      fontSize: big ? 14 : 11, fontWeight:800, fontFamily:font,
      letterSpacing:0.3, whiteSpace:"nowrap",
    }}>
      {score}% MATCH
    </span>
  );
}

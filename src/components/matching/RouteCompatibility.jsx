/**
 * src/components/matching/RouteCompatibility.jsx
 * Renders the exact / along-route / detour / off-route classification that
 * comes back from models/match.js's classifyRouteMatch() (surfaced on the
 * match object as `routeCompatibility` + `detourDistance`).
 */
import { COLORS as C, FONT as font } from "../../constants/theme.js";

const LABELS = {
  exact:       { text:"Exact route",  color:C.green, bg:C.greenBg },
  along_route: { text:"Along route",  color:C.blue,  bg:C.blueBg  },
  detour:      { text:"Small detour", color:C.amber, bg:C.amberBg },
  none:        { text:"Off route",    color:C.muted, bg:C.bg      },
};

export default function RouteCompatibility({ type = "none", detourKm = 0 }) {
  const l = LABELS[type] || LABELS.none;
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:4,
      background:l.bg, color:l.color, borderRadius:100,
      padding:"3px 10px", fontSize:11, fontWeight:700, fontFamily:font,
    }}>
      {l.text}{type !== "exact" && type !== "along_route" && detourKm > 0 ? ` · +${detourKm} km` : ""}
    </span>
  );
}

/**
 * src/components/matching/NearbyList.jsx
 * Generic "N km — suitable truck/cargo" list — used by the Carrier portal
 * ("Cargo Near My Truck") and Shipper portal ("Nearby Trucks"). Same shape,
 * parameterized by entity type so it isn't duplicated per side.
 */
import { COLORS as C, FONT as font } from "../../constants/theme.js";

export default function NearbyList({ items = [], entityType = "cargo", onSelect = () => {} }) {
  if (items.length === 0) {
    return (
      <div style={{ textAlign:"center", padding:"28px 12px", color:C.muted, fontSize:12, fontFamily:font }}>
        No {entityType === "cargo" ? "nearby cargo" : "nearby trucks"} found for the current filters.
      </div>
    );
  }
  return (
    <div style={{ fontFamily:font }}>
      {items.map((item, i) => (
        <div
          key={item.id || i}
          onClick={() => onSelect(item)}
          style={{
            display:"flex", justifyContent:"space-between", alignItems:"center",
            background:C.white, border:`1px solid ${C.border}`, borderRadius:8,
            padding:"10px 12px", marginBottom:6, cursor:"pointer",
          }}
        >
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.black }}>
              {entityType === "cargo"
                ? `${item.cargo || "Cargo"} · ${item.from} → ${item.to}`
                : `${item.truckType || "Truck"} · ${item.currentLocation?.name || item.currentTripTo || "—"}`}
            </div>
            <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
              {entityType === "cargo"
                ? `${item.weight || "—"} · KSh ${(item.pay || 0).toLocaleString()}`
                : `Going toward ${item.goingToward || "—"} · ${item.carrierName || ""}`}
            </div>
          </div>
          <div style={{ fontSize:13, fontWeight:800, color:C.blue, flexShrink:0, marginLeft:10 }}>
            {item.distanceKm != null ? `${Math.round(item.distanceKm)} km` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

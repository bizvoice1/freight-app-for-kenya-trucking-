/** Lightweight placeholder for a planned module that has no backend yet. Never shows numbers. */
export default function NotLive({ icon = "🔒", title, body, compact = false }) {
  return (
    <div data-testid="not-live" style={{ border: "1px dashed #BDBDBD", borderRadius: 12, padding: compact ? "10px 14px" : "16px 18px", marginBottom: 10, display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ fontSize: compact ? 18 : 24, lineHeight: 1 }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 800, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {title}
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#8A8A8A", border: "1px solid #BDBDBD", borderRadius: 6, padding: "1px 6px" }}>Coming later</span>
        </div>
        {body && <div style={{ fontSize: 12, color: "#8A8A8A", marginTop: 4, lineHeight: 1.5 }}>{body}</div>}
      </div>
    </div>
  );
}

/**
 * Real-GPS-only trip tracking sheet shared by Transporter, Shipper and Admin.
 * Two honest states: a real backend location is shown, or "Live location
 * unavailable." There is no simulated position fallback anywhere.
 */
import { Component, useEffect, useState } from "react";
import GoogleMap from "../maps/GoogleMap.jsx";
import { hasMapsKey } from "../../services/googleMaps.js";
import { getLatestLocation, getLocationHistory } from "../../services/trackingApi.js";
import { POLL_MS } from "../../hooks/useLiveTrip.js";
import LiveTrackingPanel from "./LiveTrackingPanel.jsx";

const num = Number.isFinite;

// A map-library failure (bad key, blocked script) must degrade to the coordinate view, never crash the sheet.
class MapGuard extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFail?.(); }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function TripTrackingModal({ trip, role, title, subtitle, truckPlate, driverName, onClose }) {
  const [location, setLocation] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mapFailed, setMapFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [loc, hist] = await Promise.all([getLatestLocation(trip.id, role), getLocationHistory(trip.id, role)]);
        if (cancelled) return;
        setLocation(loc); setHistory(hist || []); setError(null);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [trip.id, role]);

  const live = location && num(location.lat) && num(location.lng) ? location : null;
  const trail = history.filter(p => num(p.lat) && num(p.lng)).map(p => ({ lat: p.lat, lng: p.lng }));
  const showMap = live && hasMapsKey() && !mapFailed;
  const card = { background: "var(--tt-bg, #F6F6F6)", borderRadius: 10, padding: "10px 12px" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 500, display: "flex", alignItems: "flex-end", justifyContent: "center", fontFamily: "inherit" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.65)" }} />
      <div onClick={e => e.stopPropagation()} data-testid="trip-tracking-modal" style={{ position: "relative", background: "#fff", color: "#111", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto", padding: "16px 18px 28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: "#8A8A8A", fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase" }}>Live Tracking · {trip.id}</div>
            <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }}>{title || `${trip.pickup} → ${trip.delivery}`}</div>
            {subtitle && <div style={{ fontSize: 13, color: "#5E5E5E" }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#5E5E5E" }}>×</button>
        </div>

        <LiveTrackingPanel trip={trip} location={live} loading={loading} error={error} truckPlate={truckPlate} />

        {showMap && (
          <div style={{ marginTop: 12, borderRadius: 12, overflow: "hidden" }}>
            <MapGuard onFail={() => setMapFailed(true)}><GoogleMap height={220} path={trail.length > 1 ? trail : null}
              markers={[{ id: "truck", lat: live.lat, lng: live.lng, label: truckPlate ? `🚛 ${truckPlate}` : "🚛 Live", color: "#06C167" }]}
              follow onUnavailable={() => setMapFailed(true)} /></MapGuard>
          </div>
        )}
        {live && (
          <div style={{ ...card, marginTop: 12, fontSize: 13 }}>
            Last position {live.lat.toFixed(5)}, {live.lng.toFixed(5)} ·{" "}
            <a href={`https://www.google.com/maps?q=${live.lat},${live.lng}`} target="_blank" rel="noreferrer" style={{ color: "#276EF1", fontWeight: 700 }}>Open in maps</a>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {[["Driver", driverName || "—"], ["Truck", truckPlate || "—"], ["Pings", String(history.length)]].map(([l, v]) => (
            <div key={l} style={{ ...card, flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: "#8A8A8A", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>{l}</div>
              <div style={{ fontSize: 13, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v}</div>
            </div>
          ))}
        </div>

        {history.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#8A8A8A", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 }}>Location history</div>
            {[...history].reverse().slice(0, 8).map(p => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 0", borderBottom: "1px solid #EEE" }}>
                <span>{new Date(p.timestamp).toLocaleString()}</span>
                <span style={{ color: "#5E5E5E" }}>{Number(p.lat).toFixed(4)}, {Number(p.lng).toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

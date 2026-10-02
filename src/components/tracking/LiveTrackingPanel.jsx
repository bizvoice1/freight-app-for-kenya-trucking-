/**
 * src/components/tracking/LiveTrackingPanel.jsx
 * -------------------------------------------------
 * Phase 4G — shared, plain-props presentational component (no service
 * imports here, same rule src/hooks/useLoads.js documents for the matching
 * engine's components): every portal calls useLiveTrip* itself and passes
 * the result in, so this one component renders identically in Shipper,
 * Transporter, and Admin.
 */

function secondsAgo(isoTimestamp) {
  if (!isoTimestamp) return null;
  return Math.max(0, Math.round((Date.now() - new Date(isoTimestamp).getTime()) / 1000));
}

function agoLabel(sec) {
  if (sec == null) return "—";
  if (sec < 60) return `${sec} sec ago`;
  return `${Math.round(sec / 60)} min ago`;
}

/**
 * @param {Object} props
 * @param {Object|null} props.trip     - backend Trip row, or null if untracked
 * @param {Object|null} props.location - latest LocationUpdate, or null
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {string} [props.truckPlate]  - denormalised plate for display (trip only has truckId)
 * @param {boolean} [props.compact]    - one-line badge (fleet list) vs full panel (shipment detail)
 */
export default function LiveTrackingPanel({ trip, location, loading, error, truckPlate, compact = false }) {
  if (loading && !trip) {
    return <div style={{ fontSize: 12, color: "#9E9E9E" }}>Checking live tracking…</div>;
  }
  if (error) {
    return <div style={{ fontSize: 12, color: "#C0392B" }}>Live tracking unavailable: {error}</div>;
  }
  if (!trip) {
    return (
      <div style={{ fontSize: 12, color: "#9E9E9E", fontStyle: "italic" }}>
        Not currently tracked live.
      </div>
    );
  }

  const ago = agoLabel(secondsAgo(location?.timestamp));

  if (compact) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#06C167", boxShadow: "0 0 6px #06C167aa", flexShrink: 0 }} />
        <span style={{ fontWeight: 700 }}>{trip.status}</span>
        {location && <span style={{ color: "#9E9E9E" }}>· {Math.round(location.speed || 0)} km/h · {ago}</span>}
      </div>
    );
  }

  return (
    <div style={{ background: "#0B0B0B", color: "#FFF", borderRadius: 12, padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#06C167", boxShadow: "0 0 8px #06C167aa" }} />
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: "#06C167" }}>{trip.status.toUpperCase()}</span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 2 }}>{truckPlate || "Assigned truck"}</div>
      <div style={{ fontSize: 13, color: "#9E9E9E", marginBottom: 14 }}>{trip.pickup} → {trip.delivery}</div>

      {location ? (
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1, background: "#151515", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, color: "#8A8A8A", fontWeight: 700, letterSpacing: 0.5 }}>SPEED</div>
            <div style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>{Math.round(location.speed || 0)} km/h</div>
          </div>
          <div style={{ flex: 1, background: "#151515", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, color: "#8A8A8A", fontWeight: 700, letterSpacing: 0.5 }}>HEADING</div>
            <div style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>{Math.round(location.heading || 0)}°</div>
          </div>
          <div style={{ flex: 1, background: "#151515", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, color: "#8A8A8A", fontWeight: 700, letterSpacing: 0.5 }}>UPDATED</div>
            <div style={{ fontSize: 13, fontWeight: 800, marginTop: 3 }}>{ago}</div>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "#8A8A8A" }}>Live location unavailable.</div>
      )}
    </div>
  );
}

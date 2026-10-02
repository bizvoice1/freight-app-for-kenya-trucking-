import { useState, useEffect, useRef } from "react";
// Phase 3C of the seed-data unification — Carrier's load lists (Find Loads,
// My Loads, Earnings, Trip History) now come from the centralized pipeline
// (canonical SEED_LOADS + live postedLoads) instead of MARKETPLACE_LOADS/
// MY_TRIPS_SEED. See src/services/loadViews.js. TRUCK_FILTERS is just a UI
// filter-chip list (not load identity data) and stays imported directly.
import { TRUCK_FILTERS } from "./src/data/loads.js";
import { getAllKnownLoads, toCarrierMarketplaceView, toCarrierTripView } from "./src/services/loadViews.js";
import { sortNewestFirst, distLabel, decodePolyline, metersToKm } from "./src/models/geo.js";
import { fetchBackendLoad } from "./src/services/routeApi.js";
import { useCommerce } from "./src/hooks/useCommerce.js";
import { fromBackendLoad, ksh } from "./src/models/backendLoad.js";
import { MakeOfferForm, OfferThread, AgreedPriceBlock, CommerceBell, DemoBadge } from "./src/components/negotiation/negotiation.jsx";
import GoogleMap from "./src/components/maps/GoogleMap.jsx";
import { hasMapsKey } from "./src/services/googleMaps.js";
import { CARRIER_FLEET_SEED as CARRIER_FLEET } from "./src/data/fleet.js";
// DEMO_MATCH_CARGO is deliberately NOT part of SEED_LOADS/getAllKnownLoads():
// it's synthetic matching-engine demo cargo (crafted to exercise exact/
// along-route/detour/partial-load scoring scenarios), not real load records
// with a driver/dispute/incident identity — so it stays a separate pool,
// merged only into the matching engine's cargo universe below.
import { DEMO_MATCH_CARGO } from "./src/data/network.js";
// Step 6: GPS simulation engine
import { buildTripSnapshot } from "./src/services/gpsService.js";
// Step 8: Rating dimensions
import { CARRIER_RATING_DIMS, SHIPPER_RATING_DIMS } from "./src/models/rating.js";
// Matching engine — shared UI components (Truck ↔ Cargo)
import TruckAvailabilityForm from "./src/components/matching/TruckAvailabilityForm.jsx";
import MatchCard from "./src/components/matching/MatchCard.jsx";
import EmptyReturnOpportunity from "./src/components/matching/EmptyReturnOpportunity.jsx";
import NearbyList from "./src/components/matching/NearbyList.jsx";
// Phase 4G.3 — Transporter/Fleet tracking. fleetService.js (Phase 4B) has
// never been wired into this portal's UI before now — CARRIER_FLEET above
// is the legacy display-only list (see src/data/fleetSeed.js's own note on
// the two disconnected fleet representations); this is the real
// Truck/Driver assignment layer, with live GPS layered on top of it here.
import { getTrucks, getDrivers } from "./src/services/fleetService.js";
import { useLiveTripByTruckId } from "./src/hooks/useLiveTrip.js";
import LiveTrackingPanel from "./src/components/tracking/LiveTrackingPanel.jsx";

/* ── UBER FREIGHT DESIGN TOKENS ─────────────────────────── */
const C = {
  white:    "#FFFFFF",
  bg:       "#F6F6F6",
  border:   "#EBEBEB",
  muted:    "#9E9E9E",
  secondary:"#545454",
  black:    "#000000",
  green:    "#06C167",
  greenBg:  "#E6F9F0",
  red:      "#C0392B",
  redBg:    "#FDE8E3",
  amber:    "#E07B39",
  amberBg:  "#FFF3E0",
  blue:     "#276EF1",
  blueBg:   "#EFF3FE",
};
const card  = { background:C.white, borderRadius:8, boxShadow:"0 1px 4px rgba(0,0,0,0.08)", border:`1px solid ${C.border}` };
const font  = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";

/* ── LEAFLET MAP ────────────────────────────────────────── */
const TRUCK_PINS = [
  { lat:-1.2864, lng:36.8172, label:"NBI", city:"Nairobi",  count:3 },
  { lat:-4.0435, lng:39.6682, label:"MSA", city:"Mombasa",  count:2 },
  { lat: 0.5143, lng:35.2698, label:"ELD", city:"Eldoret",  count:1 },
  { lat:-0.0917, lng:34.7680, label:"KSM", city:"Kisumu",   count:1 },
  { lat: 0.3476, lng:32.5825, label:"KLA", city:"Kampala",  count:1 },
];

function LeafletMap({ loadCount }) {
  const mapRef   = useRef(null);
  const leafRef  = useRef(null);

  useEffect(() => {
    // Inject Leaflet CSS once
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id   = "leaflet-css";
      link.rel  = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    function initMap(L) {
      if (leafRef.current) return; // already initialised
      const map = L.map(mapRef.current, {
        center: [-0.5, 37.5],
        zoom: 6,
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: false,
        dragging: false,
      });

      // Dark CartoDB tiles
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
      }).addTo(map);

      // Custom green glow marker
      TRUCK_PINS.forEach(({ lat, lng, label, city, count }) => {
        const icon = L.divIcon({
          className: "",
          html: `
            <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
              <div style="
                width:${10 + count * 2}px;height:${10 + count * 2}px;
                border-radius:50%;background:#06C167;
                box-shadow:0 0 14px #06C16799,0 0 4px #06C167;
                border:2px solid rgba(255,255,255,0.25);
              "></div>
              <span style="
                font-size:9px;font-weight:700;color:#06C167;
                font-family:Inter,sans-serif;letter-spacing:0.5px;
                text-shadow:0 1px 4px rgba(0,0,0,0.8);white-space:nowrap;
              ">${label}</span>
            </div>`,
          iconSize: [40, 36],
          iconAnchor: [20, 8],
        });
        L.marker([lat, lng], { icon })
          .addTo(map)
          .bindTooltip(`<b>${city}</b><br>${count} load${count>1?"s":""}`, {
            direction:"top", offset:[0,-10],
            className:"behari-tip",
          });
      });

      leafRef.current = map;
    }

    // Load Leaflet JS if not already present
    if (window.L) {
      initMap(window.L);
    } else {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = () => initMap(window.L);
      document.head.appendChild(script);
    }

    return () => {
      if (leafRef.current) { leafRef.current.remove(); leafRef.current = null; }
    };
  }, []);

  return (
    <div style={{ position:"relative", height:200 }}>
      <style>{`
        .behari-tip { background:#111; color:#fff; border:none; border-radius:6px;
          font-family:Inter,sans-serif; font-size:12px; padding:6px 10px;
          box-shadow:0 4px 12px rgba(0,0,0,0.4); }
        .behari-tip::before { display:none; }
        .leaflet-container { background:#17192C; }
      `}</style>
      <div ref={mapRef} style={{ width:"100%", height:"100%" }} />
      {/* Overlays */}
      <div style={{ position:"absolute",top:12,left:14,zIndex:999,fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.5)",letterSpacing:1.5,fontFamily:font,pointerEvents:"none" }}>
        KENYA · LIVE LOAD MAP
      </div>
      <div style={{ position:"absolute",top:10,right:12,zIndex:999,background:"#06C167",borderRadius:100,padding:"4px 12px",fontSize:11,fontWeight:700,color:"#000",fontFamily:font,pointerEvents:"none" }}>
        {loadCount} loads
      </div>
    </div>
  );
}

/** Privacy: pre-booking pins are snapped to a ~2 km grid, never exact. */
const snapPin = (v) => Math.round(v / 0.02) * 0.02;

/* ── LOADS MAP (Google when a key is configured, else Leaflet) ───────── */
function LoadsMap({ loads }) {
  const [gmFailed, setGmFailed] = useState(!hasMapsKey());
  if (gmFailed) return <LeafletMap loadCount={loads.length} />;
  const markers = loads
    .filter(l => Number.isFinite(l.pickup?.lat) && Number.isFinite(l.pickup?.lng))
    .map(l => ({ id:l.id, lat:snapPin(l.pickup.lat), lng:snapPin(l.pickup.lng), label:`KSh ${Math.round(l.pay/1000)}k`, title:`${l.from} → ${l.to}`, color:l.urgent ? "#E11900" : "#06C167" }));
  return (
    <div style={{ position:"relative", height:200 }}>
      <GoogleMap markers={markers} height={200} onUnavailable={() => setGmFailed(true)} />
      <div style={{ position:"absolute",top:10,right:52,background:"#06C167",borderRadius:100,padding:"4px 12px",fontSize:11,fontWeight:700,color:"#000",fontFamily:font,pointerEvents:"none" }}>
        {loads.length} loads
      </div>
      <div style={{ position:"absolute",left:8,bottom:8,background:"rgba(255,255,255,0.92)",borderRadius:6,padding:"2px 8px",fontSize:10,fontWeight:700,color:"#111",fontFamily:font,pointerEvents:"none" }}>
        Pins mark approximate pickup areas
      </div>
    </div>
  );
}

/* ── STATUS COLOURS ─────────────────────────────────────── */
// TRUCK_FILTERS, CARRIER_FLEET are imported from the data layer.
// MARKETPLACE_LOADS/MY_TRIPS_SEED are no longer imported here as of Phase 3C
// — see getAllKnownLoads()/toCarrierMarketplaceView()/toCarrierTripView().
// Only the status→colour map remains here since it's a pure UI concern.
const STATUS_C = { "In Transit":C.blue, "Delivered":C.green, "Scheduled":C.muted };

/* ── ATOMS ──────────────────────────────────────────────── */
function Pill({ children, color=C.muted, bg }) {
  return <span style={{ background:bg||color+"18", color, fontSize:11, fontWeight:700, borderRadius:100, padding:"3px 10px", display:"inline-block", letterSpacing:0.1 }}>{children}</span>;
}

function Row({ label, value, last }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", borderBottom:last?0:`1px solid ${C.border}` }}>
      <span style={{ fontSize:13, color:C.secondary }}>{label}</span>
      <span style={{ fontSize:13, fontWeight:700, color:C.black }}>{value}</span>
    </div>
  );
}

/* ── ETA helper (Feature 11) ─────────────────────────────── */
// Corridor average speeds (km/h) — border crossings and mountain routes are slower
const CORRIDOR_SPEED = { default:80, border:55, mountain:65 };
function calcETA(dist=0, from="", to="") {
  const r = (from+to).toLowerCase();
  const speed = r.includes("kampala")||r.includes("busia")||r.includes("malaba")||r.includes("namanga")||r.includes("taveta")
    ? CORRIDOR_SPEED.border
    : r.includes("thika")||r.includes("nanyuki")||r.includes("kisumu")
    ? CORRIDOR_SPEED.mountain
    : CORRIDOR_SPEED.default;
  const hrs = dist / speed;
  if (hrs < 1) return `${Math.round(hrs*60)} min`;
  if (hrs < 24) return `~${Math.round(hrs)} hrs`;
  return `~${(hrs/24).toFixed(1)} days`;
}

/* ── CARGO DETAILS ROUTE MAP (5C-3) ─────────────────────────────────────
 * Fed by GET /api/loads/:id as a transporter: the API itself decides what this
 * caller may see. Before booking that is area labels, coarsened pins, a trimmed
 * polyline and the exact server road distance. Nothing is filtered here. */
function CargoRouteMap({ load }) {
  const [view, setView] = useState(null);
  const [state, setState] = useState(load.backendLoadId ? "loading" : "none");
  const [gmFailed, setGmFailed] = useState(!hasMapsKey());
  useEffect(() => {
    if (!load.backendLoadId) return;
    let alive = true;
    fetchBackendLoad(load.backendLoadId, "fleet_owner").then(v => {
      if (!alive) return;
      setView(v); setState(v ? "ready" : "error");
    });
    return () => { alive = false; };
  }, [load.backendLoadId]);

  const box = { background:C.bg, borderRadius:8, padding:"10px 12px", marginBottom:12, fontSize:12, color:C.secondary };
  if (state === "none")    return <div style={box}>Route map is not available for this demo listing.</div>;
  if (state === "loading") return <div style={box}>Loading route…</div>;
  if (state === "error" || !view) return <div style={box}>Route details could not be loaded right now.</div>;

  const road = view.distanceSource === "ROAD" && view.distanceMeters > 0;
  const path = road && view.routePolyline ? decodePolyline(view.routePolyline) : null;
  const hasPins = Number.isFinite(view.pickupLat) && Number.isFinite(view.deliveryLat);
  const markers = hasPins ? [
    { id:"pickup",   lat:view.pickupLat,   lng:view.pickupLng,   label:view.pickupArea,   color:"#06C167" },
    { id:"delivery", lat:view.deliveryLat, lng:view.deliveryLng, label:view.deliveryArea, color:"#276EF1" },
  ] : [];
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontSize:11, color:C.muted, fontWeight:600, marginBottom:6, textTransform:"uppercase", letterSpacing:0.5 }}>Route</div>
      {hasPins && !gmFailed && (
        <div style={{ borderRadius:10, overflow:"hidden", height:170, marginBottom:8 }}>
          <GoogleMap height={170} markers={markers} path={path} onUnavailable={() => setGmFailed(true)} />
        </div>
      )}
      <div style={{ ...box, marginBottom:0, display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
        <span>{view.pickupArea} → {view.deliveryArea}</span>
        <span style={{ fontWeight:800, color: road ? C.green : C.amber }}>
          {road ? `${metersToKm(view.distanceMeters)} km by road` : "Road distance unavailable"}
        </span>
      </div>
      <div style={{ fontSize:10, color:C.muted, marginTop:4 }}>
        Exact pickup and delivery addresses are shared after booking.
      </div>
    </div>
  );
}

/* ── LOAD CARD ──────────────────────────────────────────── */
function LoadCard({ load, commerce, focused, currency = "KSh" }) {
  const [open, setOpen] = useState(!!focused);
  const ref = useRef(null);
  useEffect(() => { if (focused) { setOpen(true); ref.current?.scrollIntoView({ block:"center" }); } }, [focused]);
  const eta = calcETA(load.dist, load.from, load.to);
  return (
    <div ref={ref} style={{ ...card, marginBottom:8 }} data-testid="load-card" data-load-id={load.id}>
      <div style={{ padding:16, cursor:"pointer" }} onClick={() => setOpen(!open)}>

        {/* Top: badges + rate */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            <Pill color={C.secondary}>{load.truck}</Pill>
            {load.isDemo && <Pill color={C.muted} bg={C.bg}>Demo</Pill>}
            {load.urgent && <Pill color={C.red} bg={C.redBg}>Urgent</Pill>}
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:22, fontWeight:800, color:C.black, letterSpacing:-0.5, lineHeight:1 }}>{fmtCurr(load.pay, currency)}</div>
            {distLabel(load).source!=="unresolved" && <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>{distLabel(load).approx?"≈ ":""}{currency==="KSh"?`KSh ${load.rateKm}/km`:fmtCurr(Math.round(load.rateKm),currency)+"/km"}</div>}
          </div>
        </div>

        {/* Route */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:16, fontWeight:700, color:C.black }}>{load.from}</div>
            <div style={{ fontSize:12, color:C.muted }}>{load.pickD} · {load.pickT}</div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
            <div style={{ width:1, height:6, background:C.border }} />
            <div style={{ width:36, height:1, background:C.border }} />
            <div style={{ fontSize:10, color:C.muted, fontWeight:600, whiteSpace:"nowrap", textAlign:"center" }} title={distLabel(load).text}>
              {distLabel(load).source==="unresolved" ? "Distance n/a" : (distLabel(load).approx ? `≈ ${Math.round(load.dist)} km` : `${load.dist} km`)}
              {load.distSource==="route"
                ? <div style={{ fontSize:9, color:C.green }}>by road</div>
                : distLabel(load).approx && distLabel(load).source!=="unresolved" && <div style={{ fontSize:9, color:C.amber }}>estimated</div>}
            </div>
            <div style={{ width:36, height:1, background:C.border }} />
            <div style={{ width:6, height:6, borderRadius:"50%", background:C.black }} />
          </div>
          <div style={{ flex:1, textAlign:"right" }}>
            <div style={{ fontSize:16, fontWeight:700, color:C.black }}>{load.to}</div>
            <div style={{ fontSize:12, color:C.muted }}>{load.delD} · {load.delT}</div>
          </div>
        </div>

        {/* Trucks + penalty row (for freshly posted loads) */}
        {(load.truckCount > 0 || load.penalty > 0) && (
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:10 }}>
            {load.truckCount > 0 && (
              <div style={{ background:C.blueBg, borderRadius:6, padding:"4px 10px", fontSize:11, fontWeight:700, color:C.blue }}>
                🚛 {load.truckCount} truck{load.truckCount > 1 ? "s" : ""} needed · {load.trucksRemaining} remaining
              </div>
            )}
            {load.penalty > 0 && (
              <div style={{ background:C.amberBg, borderRadius:6, padding:"4px 10px", fontSize:11, fontWeight:700, color:C.amber }}>
                ⚠ KSh {load.penalty.toLocaleString()}/day late penalty
              </div>
            )}
          </div>
        )}

        {/* Footer: shipper + ETA + chevron */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ fontSize:13, color:C.secondary }}>
            {load.shipper}{!load.isBackend && <> · <span style={{ color:C.amber }}>★ {load.rating}</span></>}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {/* Feature 11 — ETA badge */}
            <span style={{ background:C.blueBg, color:C.blue, fontSize:10, fontWeight:700, borderRadius:100, padding:"2px 8px" }}>⏱ {eta}</span>
            <span style={{ color:C.muted, fontSize:16 }}>{open ? "▲" : "▼"}</span>
          </div>
        </div>
      </div>

      {/* Expanded */}
      {open && (
        <div style={{ borderTop:`1px solid ${C.border}`, padding:16 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
            {[
              ["Cargo Type",    load.cargo],
              ["Quantity",      load.weight],
              ["Equipment",     load.truck],
              ["Pickup Date",   load.pickD !== "TBD" ? load.pickD : "TBD"],
              ["Delivery Date", load.delD  !== "TBD" ? load.delD  : "TBD"],
              ["Facility Rating",`★ ${load.facilRating}`],
              ["Load ID",       load.id],
              ...(load.truckCount > 0 ? [
                ["Trucks Needed",    `${load.truckCount} truck${load.truckCount > 1 ? "s" : ""}`],
                ["Trucks Remaining", `${load.trucksRemaining} available`],
              ] : []),
            ].map(([k,v]) => (
              <div key={k} style={{ background:C.bg, borderRadius:8, padding:"10px 12px" }}>
                <div style={{ fontSize:11, color:C.muted, fontWeight:600, marginBottom:3, textTransform:"uppercase", letterSpacing:0.5 }}>{k}</div>
                <div style={{ fontSize:13, fontWeight:700, color:C.black }}>{v}</div>
              </div>
            ))}
          </div>

          {load.description && (
            <div style={{ background:C.bg, borderRadius:8, padding:"10px 12px", marginBottom:12 }}>
              <div style={{ fontSize:11, color:C.muted, fontWeight:600, marginBottom:3, textTransform:"uppercase", letterSpacing:0.5 }}>Cargo Description</div>
              <div style={{ fontSize:13, color:C.black, lineHeight:1.5 }}>{load.description}</div>
            </div>
          )}

          <CargoRouteMap load={load} />

          {load.penalty > 0 && (
            <div style={{ background:C.amberBg, border:`1px solid ${C.amber}`, borderRadius:8, padding:"10px 14px", marginBottom:10, fontSize:12, fontWeight:700, color:C.amber }}>
              ⚠ Late delivery penalty: KSh {load.penalty.toLocaleString()} per day — deducted from driver payment automatically.
            </div>
          )}

          {load.isBackend ? <CargoCommerce load={load} commerce={commerce} /> : <DemoBadge />}
        </div>
      )}
    </div>
  );
}

/* ── CARGO COMMERCE (5D-3) ───────────────────────────────
 * Backend loads only: Posted Price / Road Distance / Posted KSh/km, then
 * Accept at the posted price or negotiate through the offer thread. Every
 * number is the backend's; demo loads never reach this block. */
function CargoCommerce({ load, commerce }) {
  const [offering, setOffering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const thread = (commerce.threads[load.id] || []).find(t => t.transporterId === commerce.identity?.id);
  const booking = commerce.bookings.find(b => b.loadId === load.id);
  const hasRoad = load.distanceMeters > 0;

  async function acceptPosted() {
    setBusy(true); setError(null);
    const r = await commerce.actions.acceptPostedPrice(load.id);
    setBusy(false);
    if (!r.ok) setError(r.error);
  }

  if (booking) {
    return <AgreedPriceBlock booking={booking} load={{ price: load.postedPrice }} finance={commerce.finance[booking.id]} adjActions={commerce.actions} />;
  }
  return (
    <div data-testid="cargo-commerce">
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:10 }}>
        {[
          ["Posted Price", load.postedPrice ? ksh(load.postedPrice) : "—"],
          ["Road Distance", hasRoad ? `${load.dist} km` : "n/a"],
          ["Posted Rate", hasRoad && load.rateKm ? `KSh ${load.rateKm}/km` : "—"],
        ].map(([k, v]) => (
          <div key={k} style={{ background:C.bg, borderRadius:8, padding:"10px 8px", textAlign:"center" }}>
            <div style={{ fontSize:10, color:C.muted, fontWeight:700, textTransform:"uppercase", letterSpacing:0.4, marginBottom:3 }}>{k}</div>
            <div style={{ fontSize:13, fontWeight:800, color:C.black }}>{v}</div>
          </div>
        ))}
      </div>
      {error && <div data-testid="commerce-error" style={{ fontSize:12, color:C.red, fontWeight:600, marginBottom:8 }}>{error}</div>}
      {!thread && !offering && (
        <div style={{ display:"flex", gap:8 }}>
          {load.postedPrice > 0 && (
            <button disabled={busy} onClick={acceptPosted} data-testid="accept-posted"
              style={{ flex:1, background:C.black, color:C.white, border:"none", borderRadius:8, padding:14, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:font, opacity:busy?0.6:1 }}>
              {busy ? "Booking…" : `Accept ${ksh(load.postedPrice)}`}
            </button>
          )}
          <button onClick={() => setOffering(true)} data-testid="make-offer"
            style={{ flex:1, background:C.white, color:C.black, border:`1.5px solid ${C.black}`, borderRadius:8, padding:14, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:font }}>
            Make an Offer
          </button>
        </div>
      )}
      {!thread && offering && (
        <MakeOfferForm postedPrice={load.postedPrice} onCancel={() => setOffering(false)}
          onSubmit={async (amt, note) => { const r = await commerce.actions.makeOffer(load.id, amt, note); if (r.ok) setOffering(false); return r; }} />
      )}
      {thread && (
        <OfferThread thread={{ ...thread, title: "Your negotiation" }} partyLabel={() => "Shipper"}
          onAccept={commerce.actions.accept} onCounter={commerce.actions.counter}
          onReject={commerce.actions.reject} onWithdraw={commerce.actions.withdraw} highlight />
      )}
      <div style={{ fontSize:11, color:C.muted, marginTop:8 }}>Accepting or agreeing a price does not charge you — the shipper pays the agreed price to secure the booking.</div>
    </div>
  );
}

/* ── FIND LOADS ─────────────────────────────────────────── */
const CURR_RATES = { KSh:1, USD:0.0077, UGX:28.5, TZS:10.2 };
function fmtCurr(ksh, currency) {
  if (ksh == null) return "Offers invited";
  const rate = CURR_RATES[currency] || 1;
  if (currency === "KSh") return `KSh ${ksh.toLocaleString()}`;
  return `${currency} ${Math.round(ksh * rate).toLocaleString()}`;
}

function FindLoads({ commerce, focusId, allLoads = [] }) {
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [sort, setSort]     = useState("new");
  const [currency, setCurrency] = useState("KSh");
  const [minPay, setMinPay] = useState("");
  const [maxPay, setMaxPay] = useState("");

  let loads = allLoads
    .filter(l => filter === "All" || l.truck.toLowerCase().includes(filter.toLowerCase()))
    .filter(l => !search || [l.from,l.to,l.cargo].some(s => s.toLowerCase().includes(search.toLowerCase())))
    .filter(l => !minPay || l.pay >= Number(minPay))
    .filter(l => !maxPay || l.pay <= Number(maxPay));
  if (sort === "new")   loads = sortNewestFirst(loads);
  if (sort === "rate")  loads = [...loads].sort((a,b) => b.rateKm - a.rateKm);
  if (sort === "price") loads = [...loads].sort((a,b) => b.pay - a.pay);
  if (sort === "near")  loads = [...loads].sort((a,b) => a.dist - b.dist);

  return (
    <div>
      {/* Map hero */}
      <LoadsMap loads={loads} />

      <div style={{ padding:"12px 12px 0" }}>
        {/* Search */}
        <div style={{ ...card, display:"flex", alignItems:"center", gap:10, padding:"11px 14px", marginBottom:10 }}>
          <span style={{ fontSize:16, color:C.muted }}>⌕</span>
          <input
            placeholder="City, route, or cargo type…"
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ flex:1,border:"none",outline:"none",fontSize:14,fontFamily:font,color:C.black,background:"transparent" }}
          />
          {search && <button onClick={()=>setSearch("")} style={{ background:"none",border:"none",color:C.muted,fontSize:16,cursor:"pointer" }}>✕</button>}
        </div>

        {/* Filter chips */}
        <div style={{ display:"flex",gap:6,overflowX:"auto",paddingBottom:10,scrollbarWidth:"none",msOverflowStyle:"none" }}>
          {TRUCK_FILTERS.map(t => (
            <button key={t} onClick={()=>setFilter(t)} style={{
              background:filter===t?C.black:C.white, color:filter===t?C.white:C.secondary,
              border:`1.5px solid ${filter===t?C.black:C.border}`,
              borderRadius:100,padding:"7px 16px",fontSize:13,fontWeight:600,cursor:"pointer",
              whiteSpace:"nowrap",fontFamily:font,flexShrink:0,transition:"all 0.12s"
            }}>{t}</button>
          ))}
        </div>

        {/* Sort + count + currency (Feature 19) */}
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,gap:8,overflowX:"auto",scrollbarWidth:"none" }}>
          <div style={{ fontSize:13,color:C.muted,fontWeight:500,flexShrink:0 }}>{loads.length} loads</div>
          <div style={{ display:"flex",gap:4,flexShrink:0 }}>
            {[["new","Newest"],["rate","Best Rate"],["price","Highest Pay"],["near","Nearest"]].map(([v,l]) => (
              <button key={v} onClick={()=>setSort(v)} style={{
                background:sort===v?C.black:"transparent",color:sort===v?C.white:C.muted,
                border:`1px solid ${sort===v?C.black:C.border}`,borderRadius:100,padding:"5px 10px",
                fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font,transition:"all 0.12s",whiteSpace:"nowrap"
              }}>{l}</button>
            ))}
            <select value={currency} onChange={e=>setCurrency(e.target.value)} style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:100,padding:"5px 10px",fontSize:11,fontFamily:font,color:C.black,cursor:"pointer",flexShrink:0 }}>
              {Object.keys(CURR_RATES).map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        {/* Price range filter */}
        <div style={{ display:"flex",gap:6,marginBottom:10 }}>
          <input type="number" placeholder="Min KSh" value={minPay} onChange={e=>setMinPay(e.target.value)}
            style={{ flex:1,padding:"7px 10px",fontSize:12,fontFamily:font,background:C.white,border:`1px solid ${C.border}`,borderRadius:8,outline:"none",color:C.black }} />
          <input type="number" placeholder="Max KSh" value={maxPay} onChange={e=>setMaxPay(e.target.value)}
            style={{ flex:1,padding:"7px 10px",fontSize:12,fontFamily:font,background:C.white,border:`1px solid ${C.border}`,borderRadius:8,outline:"none",color:C.black }} />
          {(minPay||maxPay)&&<button onClick={()=>{setMinPay("");setMaxPay("");}} style={{ background:C.redBg,color:C.red,border:"none",borderRadius:8,padding:"7px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font }}>✕</button>}
        </div>

        {loads.map(l => <LoadCard key={l.id} load={l} commerce={commerce} focused={focusId === l.id} currency={currency} />)}
        {loads.length === 0 && (
          <div style={{ textAlign:"center",padding:"60px 20px",color:C.muted }}>
            <div style={{ fontSize:36,marginBottom:12 }}>🔍</div>
            <div style={{ fontSize:16,fontWeight:700,color:C.secondary,marginBottom:4 }}>No loads found</div>
            <div style={{ fontSize:13 }}>Try a different filter or search term</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── IN-APP CHAT ─────────────────────────────────────────── */
const chatKey = id => `behari_chat_${id}`;

function ChatModal({ loadId, title, currentUser, onClose }) {
  const [msgs, setMsgs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(chatKey(loadId)) || "[]"); } catch { return []; }
  });
  const [text,    setText]    = useState("");
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [msgs]);

  function send() {
    if (!text.trim()) return;
    const now  = new Date().toLocaleTimeString("en-KE",{hour:"2-digit",minute:"2-digit"});
    const next = [...msgs, { from:currentUser, text:text.trim(), time:now }];
    setMsgs(next);
    localStorage.setItem(chatKey(loadId), JSON.stringify(next));
    setText("");
  }

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:600,fontFamily:font }}>
      <div style={{ background:C.white,borderRadius:"16px 16px 0 0",width:"100%",maxWidth:480,height:"72vh",display:"flex",flexDirection:"column" }}>
        <div style={{ padding:"12px 16px 10px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0 }}>
          <div>
            <div style={{ fontSize:15,fontWeight:800,color:C.black }}>💬 Load Chat</div>
            <div style={{ fontSize:11,color:C.muted,marginTop:1 }}>{title}</div>
          </div>
          <button onClick={onClose} style={{ background:C.bg,border:"none",borderRadius:"50%",width:32,height:32,cursor:"pointer",fontSize:16,color:C.secondary,display:"flex",alignItems:"center",justifyContent:"center" }}>✕</button>
        </div>
        <div style={{ flex:1,overflowY:"auto",padding:"12px 16px" }}>
          {msgs.length === 0 && <div style={{ textAlign:"center",color:C.muted,fontSize:13,marginTop:48 }}>No messages yet — start the conversation!</div>}
          {msgs.map((m,i) => {
            const mine = m.from === currentUser;
            return (
              <div key={i} style={{ display:"flex",justifyContent:mine?"flex-end":"flex-start",marginBottom:10 }}>
                <div style={{ maxWidth:"76%",background:mine?C.black:C.bg,borderRadius:mine?"12px 12px 2px 12px":"12px 12px 12px 2px",padding:"10px 13px" }}>
                  <div style={{ fontSize:10,color:mine?"rgba(255,255,255,0.5)":C.muted,marginBottom:3,fontWeight:600 }}>{m.from} · {m.time}</div>
                  <div style={{ fontSize:13,color:mine?C.white:C.black,fontWeight:500 }}>{m.text}</div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
        <div style={{ padding:"10px 12px",borderTop:`1px solid ${C.border}`,display:"flex",gap:8,flexShrink:0 }}>
          <input
            value={text} onChange={e=>setText(e.target.value)}
            onKeyDown={e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); send(); }}}
            placeholder="Type a message…"
            style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px",fontSize:13,fontFamily:font,outline:"none",color:C.black }}
          />
          <button onClick={send} disabled={!text.trim()} style={{ background:text.trim()?C.black:C.border,color:text.trim()?C.white:C.muted,border:"none",borderRadius:8,padding:"10px 16px",fontSize:13,fontWeight:700,cursor:text.trim()?"pointer":"not-allowed",fontFamily:font }}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── ACTION MINI-MODAL ───────────────────────────────────── */
function ActionModal({ title, children, onClose }) {
  return (
    <div style={{ position:"fixed",inset:0,zIndex:500,display:"flex",alignItems:"flex-end",justifyContent:"center" }} onClick={onClose}>
      <div style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.5)",backdropFilter:"blur(3px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"16px 16px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 36px",fontFamily:font }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 18px" }} />
        <div style={{ fontSize:17,fontWeight:800,color:C.black,marginBottom:16 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

/* ── MY LOADS ───────────────────────────────────────────── */
const ACTIVE_STATUSES = new Set(["Escrow Held","Accepted","Loading","In Transit","Arrived"]);
const DONE_STATUSES   = new Set(["Delivery Confirmed","Paid Out","Delivered","Cancelled","Disputed","Dispute Resolved"]);

// Progress value per status
const STATUS_PROGRESS = {
  "Escrow Held":5,"Accepted":15,"Loading":25,"In Transit":55,
  "Arrived":80,"Delivery Confirmed":95,"Paid Out":100,"Delivered":100,
  "Cancelled":0,"Disputed":50,"Dispute Resolved":90,
};

// Pill colour per status
const STATUS_PILL = {
  "Escrow Held":   { bg:C.amberBg, color:C.amber },
  "Accepted":      { bg:C.greenBg, color:C.green },
  "Loading":       { bg:C.blueBg,  color:C.blue  },
  "In Transit":    { bg:C.blueBg,  color:C.blue  },
  "Arrived":       { bg:C.greenBg, color:C.green },
  "Delivery Confirmed": { bg:C.greenBg, color:C.green },
  "Paid Out":      { bg:C.greenBg, color:C.green },
  "Delivered":     { bg:C.greenBg, color:C.green },
  "Cancelled":     { bg:C.redBg,   color:C.red   },
  "Disputed":      { bg:C.redBg,   color:C.red   },
  "Dispute Resolved": { bg:C.amberBg, color:C.amber },
};

function StatusPill({ status }) {
  const s = STATUS_PILL[status] || { bg:C.bg, color:C.muted };
  return (
    <span style={{ background:s.bg, color:s.color, fontSize:10, fontWeight:700, borderRadius:100, padding:"3px 8px", whiteSpace:"nowrap" }}>
      {status}
    </span>
  );
}

function TripCard({ t, onAccept, onReject, onCancel, onConfirmLoading, onStartTrip, onMarkBorder, onMarkDelay, onMarkArrived, onOpenDispute, onSubmitRating, onCheckHasRated }) {
  const [modal,    setModal]    = useState(null); // "reject"|"cancel"|"delay"|"border"|"gps"|"rate"|"dispute"
  const [inputA,   setInputA]   = useState("");
  const [inputB,   setInputB]   = useState("");
  const [busy,     setBusy]     = useState(false);
  const [hasRated, setHasRated] = useState(() => onCheckHasRated ? onCheckHasRated(t.id, "carrier") : false);

  const status   = t.status || "Escrow Held";
  const progress = STATUS_PROGRESS[status] ?? 15;
  const pillStyle = STATUS_PILL[status] || { bg:C.bg, color:C.muted };

  async function run(fn) {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  }

  // Primary action button config per status
  const primaryActions = {
    "Escrow Held":   [{ label:"✅ Accept Load", color:C.green, textColor:C.black, fn:()=>run(()=>onAccept(t.id)) },
                      { label:"✕ Reject",       color:C.redBg, textColor:C.red,   fn:()=>setModal("reject") }],
    "Accepted":      [{ label:"📦 Confirm Loading", color:C.black, textColor:C.white, fn:()=>setModal("pickup_photo") },
                      { label:"✕ Cancel",           color:C.redBg, textColor:C.red,   fn:()=>setModal("cancel") }],
    "Loading":       [{ label:"🚛 Start Trip",   color:C.black, textColor:C.white, fn:()=>run(()=>onStartTrip(t.id)) }],
    "In Transit":    [{ label:"📍 Mark Arrived", color:C.black, textColor:C.white, fn:()=>run(()=>onMarkArrived(t.id)) },
                      { label:"🌍 Border",       color:C.bg,    textColor:C.black, fn:()=>setModal("border") },
                      { label:"⏱ Delay",         color:C.amberBg, textColor:C.amber, fn:()=>setModal("delay") }],
    "Arrived":       [], // carrier waits — shipper confirms
    "Delivery Confirmed": [],
    "Paid Out":      [],
    "Delivered":     [],
    "Cancelled":     [],
    "Disputed":      [],
    "Dispute Resolved": [],
  };

  const actions = primaryActions[status] || [];

  return (
    <>
      <div style={{ ...card, marginBottom:8, padding:16 }}>
        {/* Header row */}
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10 }}>
          <div style={{ flex:1,minWidth:0,marginRight:10 }}>
            <div style={{ fontSize:11,color:C.muted,marginBottom:4 }}>{t.id} · {t.date}</div>
            <div style={{ fontSize:16,fontWeight:700,color:C.black,marginBottom:2 }}>{t.cargo}</div>
            <div style={{ fontSize:13,color:C.secondary }}>{t.from} → {t.to}</div>
            {t.plate && <div style={{ fontSize:12,color:C.muted,marginTop:3 }}>🚛 {t.plate}{t.truckType ? ` · ${t.truckType}` : ""}</div>}
          </div>
          <div style={{ textAlign:"right",flexShrink:0 }}>
            <div style={{ fontSize:17,fontWeight:800,color:C.black,marginBottom:4 }}>KSh {t.pay.toLocaleString()}</div>
            <StatusPill status={status} />
          </div>
        </div>

        {/* Progress bar */}
        {progress > 0 && progress < 100 && (
          <div style={{ marginBottom:10 }}>
            <div style={{ height:3,background:C.border,borderRadius:2,overflow:"hidden",marginBottom:5 }}>
              <div style={{ width:`${progress}%`,height:"100%",background:C.black,transition:"width 0.5s" }} />
            </div>
            <div style={{ fontSize:11,color:C.muted }}>ETA · {t.eta || "TBD"}</div>
          </div>
        )}

        {/* Status-specific banners */}
        {(status === "Escrow Held" || status === "Accepted" || status === "Loading" || status === "In Transit") && (
          <div style={{ background:C.amberBg,borderRadius:8,padding:"8px 12px",fontSize:12,fontWeight:600,color:C.amber,marginBottom:actions.length?10:0 }}>
            🔒 KSh {t.pay.toLocaleString()} held in escrow · Releases on delivery
          </div>
        )}
        {status === "Arrived" && (
          <div style={{ background:C.blueBg,borderRadius:8,padding:"8px 12px",fontSize:12,fontWeight:600,color:C.blue }}>
            📍 Arrived at destination — waiting for shipper to confirm delivery & enter OTP
          </div>
        )}
        {status === "Delivery Confirmed" && (
          <div style={{ background:C.greenBg,borderRadius:8,padding:"8px 12px",fontSize:12,fontWeight:600,color:C.green }}>
            ✅ Delivery confirmed — escrow ready for release by shipper
          </div>
        )}
        {(status === "Paid Out" || status === "Delivered") && (
          <div style={{ background:C.greenBg,borderRadius:8,padding:"8px 12px",fontSize:12,fontWeight:600,color:C.green }}>
            📱 KSh {t.pay.toLocaleString()} released to M-Pesa{t.plate ? ` · ${t.plate}` : ""}
          </div>
        )}
        {status === "Cancelled" && (
          <div style={{ background:C.redBg,borderRadius:8,padding:"8px 12px",fontSize:12,fontWeight:600,color:C.red }}>
            🚫 Shipment cancelled — escrow refunded to shipper
          </div>
        )}
        {status === "Disputed" && (
          <div style={{ background:C.redBg,borderRadius:8,padding:"8px 12px",fontSize:12,fontWeight:600,color:C.red }}>
            ⚖ Dispute open — admin is reviewing · Escrow frozen
          </div>
        )}
        {status === "Dispute Resolved" && (
          <div style={{ background:C.amberBg,borderRadius:8,padding:"8px 12px",fontSize:12,fontWeight:600,color:C.amber }}>
            ✅ Dispute resolved — check escrow details
          </div>
        )}
        {t.penalty > 0 && ACTIVE_STATUSES.has(status) && (
          <div style={{ background:C.redBg,borderRadius:8,padding:"8px 12px",fontSize:11,fontWeight:600,color:C.red,marginTop:6 }}>
            ⚠ KSh {t.penalty.toLocaleString()}/day late penalty — deliver on time
          </div>
        )}
        {/* Rate prompt for paid loads */}
        {(status === "Paid Out" || status === "Delivered") && !hasRated && (
          <div style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 12px",marginTop:6,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <span style={{ fontSize:12,color:C.secondary,fontWeight:600 }}>Rate this shipper</span>
            <button onClick={()=>setModal("rate")} style={{ background:C.black,color:C.white,border:"none",borderRadius:6,padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font }}>⭐ Rate</button>
          </div>
        )}

        {/* Action buttons */}
        {actions.length > 0 && (
          <div style={{ display:"flex",gap:6,marginTop:10,flexWrap:"wrap" }}>
            {actions.map((a,i) => (
              <button key={i} disabled={busy} onClick={a.fn} style={{
                flex:1, minWidth:90, background:a.color, color:a.textColor,
                border:"none", borderRadius:8, padding:"10px 8px",
                fontSize:12, fontWeight:700, cursor:busy?"not-allowed":"pointer",
                fontFamily:font, opacity:busy?0.6:1, transition:"opacity 0.15s",
              }}>{busy?"…":a.label}</button>
            ))}
          </div>
        )}

        {/* GPS + Dispute + Breakdown + Chat secondary row */}
        <div style={{ display:"flex",gap:6,marginTop:actions.length?6:10,flexWrap:"wrap" }}>
          {(status === "In Transit" || status === "Arrived" || status === "Loading") && (
            <button onClick={()=>setModal("gps")} style={{ flex:1,background:C.blueBg,color:C.blue,border:"none",borderRadius:8,padding:"9px 8px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font }}>
              📍 Live GPS
            </button>
          )}
          {status === "In Transit" && (
            <button onClick={()=>setModal("breakdown")} style={{ background:C.redBg,color:C.red,border:"none",borderRadius:8,padding:"9px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font }}>
              🆘 SOS
            </button>
          )}
          {(status === "In Transit" || status === "Arrived") && (
            <button onClick={()=>setModal("dispute")} style={{ background:C.redBg,color:C.red,border:"none",borderRadius:8,padding:"9px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font }}>
              ⚖ Dispute
            </button>
          )}
          <button onClick={()=>setModal("chat")} style={{ background:C.bg,color:C.secondary,border:`1px solid ${C.border}`,borderRadius:8,padding:"9px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font }}>
            💬 Chat
          </button>
        </div>
      </div>

      {/* ── Pickup Photo Modal (Feature 4) ── */}
      {modal === "pickup_photo" && (
        <PickupPhotoModal trip={t} onClose={()=>setModal(null)} onConfirm={(id)=>{ setModal(null); return run(()=>onConfirmLoading(id)); }} />
      )}

      {/* ── Breakdown Modal (Feature 20) ── */}
      {modal === "breakdown" && (
        <BreakdownModal trip={t} onClose={()=>setModal(null)} />
      )}

      {/* ── Reject modal ── */}
      {modal === "reject" && (
        <ActionModal title="Reject Load" onClose={()=>setModal(null)}>
          <div style={{ fontSize:13,color:C.secondary,marginBottom:12 }}>
            Tell the shipper why you're rejecting this load. The escrow will be refunded.
          </div>
          <textarea
            placeholder="Reason for rejection…"
            value={inputA} onChange={e=>setInputA(e.target.value)}
            style={{ width:"100%",minHeight:80,padding:"10px 12px",fontSize:13,fontFamily:font,
              background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,resize:"vertical",outline:"none",marginBottom:12 }}
          />
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={()=>setModal(null)} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Cancel</button>
            <button onClick={()=>{ setModal(null); run(()=>onReject(t.id, inputA||"No reason given")); }} style={{ flex:2,background:C.red,color:C.white,border:"none",borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>Reject Load</button>
          </div>
        </ActionModal>
      )}

      {/* ── Cancel modal ── */}
      {modal === "cancel" && (
        <ActionModal title="Cancel Shipment" onClose={()=>setModal(null)}>
          <div style={{ fontSize:13,color:C.secondary,marginBottom:12 }}>
            Cancelling will refund the shipper's escrow. This cannot be undone.
          </div>
          <textarea
            placeholder="Reason for cancellation…"
            value={inputA} onChange={e=>setInputA(e.target.value)}
            style={{ width:"100%",minHeight:80,padding:"10px 12px",fontSize:13,fontFamily:font,
              background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,resize:"vertical",outline:"none",marginBottom:12 }}
          />
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={()=>setModal(null)} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Keep Load</button>
            <button onClick={()=>{ setModal(null); run(()=>onCancel(t.id, inputA||"Cancelled by transporter")); }} style={{ flex:2,background:C.red,color:C.white,border:"none",borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>Cancel Shipment</button>
          </div>
        </ActionModal>
      )}

      {/* ── Delay modal ── */}
      {modal === "delay" && (
        <ActionModal title="Report Delay" onClose={()=>setModal(null)}>
          <div style={{ fontSize:13,color:C.secondary,marginBottom:14 }}>
            Log the reason for delay. If a penalty rate applies it will be deducted from your payout.
          </div>
          <label style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.7,textTransform:"uppercase",display:"block",marginBottom:5 }}>Reason</label>
          <input
            placeholder="e.g. Police checkpoint, traffic, mechanical…"
            value={inputA} onChange={e=>setInputA(e.target.value)}
            style={{ width:"100%",padding:"10px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",marginBottom:12 }}
          />
          <label style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.7,textTransform:"uppercase",display:"block",marginBottom:5 }}>Penalty (KSh, leave 0 if none)</label>
          <input
            type="number" min="0" placeholder="0"
            value={inputB} onChange={e=>setInputB(e.target.value)}
            style={{ width:"100%",padding:"10px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",marginBottom:16 }}
          />
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={()=>setModal(null)} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Cancel</button>
            <button onClick={()=>{ setModal(null); run(()=>onMarkDelay(t.id, inputA||"Delay", Number(inputB)||0)); }} style={{ flex:2,background:C.amber,color:C.white,border:"none",borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>Log Delay</button>
          </div>
        </ActionModal>
      )}

      {/* ── Border crossing modal ── */}
      {modal === "border" && (
        <ActionModal title="Border Crossing" onClose={()=>setModal(null)}>
          <div style={{ fontSize:13,color:C.secondary,marginBottom:12 }}>
            Record the border crossing checkpoint for the shipment log.
          </div>
          <input
            placeholder="e.g. Namanga Border, Busia Border…"
            value={inputA} onChange={e=>setInputA(e.target.value)}
            style={{ width:"100%",padding:"10px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",marginBottom:8 }}
          />
          <button onClick={()=>{
            navigator.geolocation.getCurrentPosition(
              pos => setInputA(`${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)} (GPS)`),
              () => {}
            );
          }} style={{ width:"100%",background:C.blueBg,color:C.blue,border:"none",borderRadius:8,padding:"9px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font,marginBottom:16 }}>
            📍 Use My GPS Location
          </button>
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={()=>setModal(null)} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Cancel</button>
            <button onClick={()=>{ setModal(null); run(()=>onMarkBorder(t.id, inputA||"Border checkpoint")); }} style={{ flex:2,background:C.black,color:C.white,border:"none",borderRadius:8,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>Record Crossing</button>
          </div>
        </ActionModal>
      )}

      {/* ── GPS Modal (Step 6) ── */}
      {modal === "gps" && (
        <TripGPSModal trip={t} onClose={()=>setModal(null)} />
      )}

      {/* ── Rate Modal (Step 8) ── */}
      {modal === "rate" && (
        <RatingModal trip={t} raterRole="carrier" onClose={()=>{ setModal(null); setHasRated(true); }} onSubmitRating={onSubmitRating||((x)=>Promise.resolve(x))} />
      )}

      {/* ── Dispute Modal (Step 7) ── */}
      {modal === "dispute" && (
        <DisputeOpenModal trip={t} raisedBy="Transporter" onClose={()=>setModal(null)} onOpenDispute={onOpenDispute||((x)=>Promise.resolve(x))} />
      )}

      {/* ── Chat Modal ── */}
      {modal === "chat" && (
        <ChatModal loadId={t.id} title={`${t.cargo} · ${t.id}`} currentUser="Transporter" onClose={()=>setModal(null)} />
      )}
    </>
  );
}

function MyLoads({ myTrips = [],
  onAcceptLoad=()=>{}, onRejectLoad=()=>{}, onCancelShipment=()=>{},
  onConfirmLoading=()=>{}, onStartTrip=()=>{},
  onMarkBorderCrossing=()=>{}, onMarkDelay=()=>{}, onMarkArrived=()=>{},
  onOpenDispute=()=>{}, onSubmitRating=()=>{}, onCheckHasRated=()=>false }) {

  const [seg, setSeg] = useState("active");

  // Phase 3C: myTrips already comes fully merged (canonical load + live
  // booking + loadStatuses override) from getAllKnownLoads() +
  // toCarrierTripView() in the root component — no local merge needed.
  const active = myTrips.filter(t => ACTIVE_STATUSES.has(t.status));
  const past   = myTrips.filter(t => !ACTIVE_STATUSES.has(t.status));
  const items  = seg === "active" ? active : past;

  return (
    <div style={{ padding:12 }}>
      <div style={{ display:"flex",background:C.bg,borderRadius:8,padding:3,marginBottom:16 }}>
        {[["active",`Active (${active.length})`],["past",`Past (${past.length})`]].map(([v,l]) => (
          <button key={v} onClick={()=>setSeg(v)} style={{
            flex:1,background:seg===v?C.white:"transparent",color:seg===v?C.black:C.muted,
            border:"none",borderRadius:6,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer",
            fontFamily:font,boxShadow:seg===v?"0 1px 3px rgba(0,0,0,0.1)":"none",transition:"all 0.15s"
          }}>{l}</button>
        ))}
      </div>

      {items.length === 0 && (
        <div style={{ textAlign:"center",padding:"60px 20px" }}>
          <div style={{ fontSize:40,marginBottom:12 }}>📭</div>
          <div style={{ fontSize:16,fontWeight:700,color:C.secondary,marginBottom:4 }}>No {seg==="active"?"active":"past"} loads</div>
          <div style={{ fontSize:13,color:C.muted }}>{seg==="active"?"Book a load to get started":"Completed loads will appear here"}</div>
        </div>
      )}

      {items.map(t => (
        <TripCard key={t.id} t={t}
          onAccept={onAcceptLoad}
          onReject={onRejectLoad}
          onCancel={onCancelShipment}
          onConfirmLoading={onConfirmLoading}
          onStartTrip={onStartTrip}
          onMarkBorder={onMarkBorderCrossing}
          onMarkDelay={onMarkDelay}
          onMarkArrived={onMarkArrived}
          onOpenDispute={onOpenDispute}
          onSubmitRating={onSubmitRating}
          onCheckHasRated={onCheckHasRated}
        />
      ))}
    </div>
  );
}

/* ── EARNINGS ───────────────────────────────────────────── */
function Earnings({ myTrips = [] }) {
  // Phase 3C: every figure below is now derived directly from myTrips (the
  // canonical, unified trip list) instead of a hardcoded "base" total plus
  // manually-tracked deltas from two separate hardcoded/live sources. The
  // headline number will differ slightly from the pre-migration flavor
  // constant (KSh 108,000 / 4 trips, which was itself never quite consistent
  // with MY_TRIPS_SEED's actual 2 delivered entries) — this is the intended
  // outcome of "no duplicated facts," not a regression.
  const paidTrips  = myTrips.filter(t => t.status === "Paid Out" || t.status === "Delivered");
  const totalPay   = paidTrips.reduce((s,t) => s + (t.pay||0), 0);
  const totalTrips = paidTrips.length;

  const recentTrips = myTrips;

  const weeks = [{l:"W1",v:0},{l:"W2",v:0},{l:"W3",v:0},{l:"W4",v:totalPay}];
  const max = Math.max(...weeks.map(w=>w.v),1);
  const [showAdvance, setShowAdvance] = useState(false);
  return (
    <div style={{ padding:12 }}>
      <div style={{ background:C.black,borderRadius:12,padding:"20px 16px",marginBottom:12 }}>
        <div style={{ fontSize:11,color:"rgba(255,255,255,0.45)",fontWeight:700,letterSpacing:1,marginBottom:4 }}>MAY 2026 EARNINGS</div>
        <div style={{ fontSize:38,fontWeight:800,color:C.white,letterSpacing:-1 }}>KSh {totalPay.toLocaleString()}</div>
        <div style={{ fontSize:13,color:C.green,marginTop:6,fontWeight:600 }}>{totalTrips} trip{totalTrips!==1?"s":""} paid out this month</div>
      </div>

      {/* M-PESA PAID OUT cards — every currently paid-out/delivered trip */}
      {paidTrips.map(l => (
        <div key={l.id} style={{ background:C.greenBg,border:`1px solid ${C.green}`,borderRadius:10,padding:"12px 14px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <div>
            <div style={{ fontSize:11,color:C.green,fontWeight:700,marginBottom:2 }}>📱 M-PESA PAID OUT</div>
            <div style={{ fontSize:13,fontWeight:700,color:C.black }}>{l.cargo} · {l.id}</div>
            <div style={{ fontSize:12,color:C.secondary }}>{l.from} → {l.to}</div>
          </div>
          <div style={{ fontSize:18,fontWeight:800,color:C.green }}>+KSh {l.pay.toLocaleString()}</div>
        </div>
      ))}

      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12 }}>
        {[["Trips this month",String(totalTrips)],["Driver rating","4.9 ★"],["All-time earnings",`KSh ${(2300000+totalPay).toLocaleString()}`],["Lifetime trips",String(148+totalTrips)]].map(([l,v]) => (
          <div key={l} style={{ ...card,padding:"14px 16px" }}>
            <div style={{ fontSize:11,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.5,marginBottom:4 }}>{l}</div>
            <div style={{ fontSize:20,fontWeight:800,color:C.black }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ ...card,padding:16,marginBottom:12 }}>
        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:14 }}>Weekly Breakdown</div>
        <div style={{ display:"flex",alignItems:"flex-end",gap:10,height:80 }}>
          {weeks.map((w,i) => (
            <div key={w.l} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4 }}>
              <div style={{ fontSize:10,color:C.muted }}>{w.v>0?`${(w.v/1000).toFixed(0)}k`:""}</div>
              <div style={{ width:"100%",height:`${Math.max((w.v/max)*64,3)}px`,background:i===2?C.black:C.border,borderRadius:"3px 3px 0 0",transition:"height 0.3s" }} />
              <div style={{ fontSize:11,fontWeight:i===2?700:500,color:i===2?C.black:C.muted }}>{w.l}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Recent Payouts</div>
      <div style={{ ...card,overflow:"hidden",marginBottom:16 }}>
        {recentTrips.map((t,i,a) => {
          // Bug fix: this only special-cased "In Transit" as pending, so
          // every OTHER non-paid status (Accepted, Loading, Arrived,
          // Delivery Confirmed, even Disputed/Cancelled) fell through to
          // the "already paid" branch and showed a green +KSh amount for
          // money that hadn't actually moved. Use the same Paid Out/
          // Delivered check paidTrips above already uses, just inverted.
          const isPaid = t.status === "Paid Out" || t.status === "Delivered";
          return (
          <div key={t.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
            <div>
              <div style={{ fontSize:14,fontWeight:600,color:C.black }}>{t.cargo}</div>
              <div style={{ fontSize:12,color:C.muted }}>{t.from} → {t.to} · {t.date}</div>
            </div>
            <div style={{ fontSize:15,fontWeight:800,color:isPaid?C.green:C.amber }}>
              {isPaid?`+KSh ${t.pay.toLocaleString()}`:"Pending"}
            </div>
          </div>
          );
        })}
      </div>

      {/* Advance pay CTA */}
      <div style={{ ...card,padding:"14px 16px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer" }} onClick={()=>setShowAdvance(true)}>
        <div>
          <div style={{ fontSize:14,fontWeight:700,color:C.black }}>💰 Request Advance Pay</div>
          <div style={{ fontSize:12,color:C.muted,marginTop:2 }}>Get up to 40% of earnings early via M-Pesa</div>
        </div>
        <span style={{ fontSize:18,color:C.muted }}>›</span>
      </div>

      {showAdvance && <AdvancePayModal totalEarnings={totalPay} onClose={()=>setShowAdvance(false)} />}
    </div>
  );
}

/* ── ACCOUNT ────────────────────────────────────────────── */
const FLEET_STORAGE_KEY = "behari_carrier_fleet";

function loadFleetFromStorage() {
  try {
    const saved = localStorage.getItem(FLEET_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch (_) {}
  // Fallback to seed data shape
  return [
    { id:"T1", plate:"KDJ 441Z", type:"33-Tonne Flatbed", year:2019, status:"Available" },
    { id:"T2", plate:"KBD 092K", type:"Box Truck",         year:2021, status:"Available" },
    { id:"T3", plate:"KCN 771M", type:"Open Truck",        year:2018, status:"On Trip"   },
  ];
}

function AddTruckModal({ onClose, onAdd }) {
  const [plate, setPlate] = useState("");
  const [type,  setType]  = useState("33-Tonne Flatbed");
  const [year,  setYear]  = useState(String(new Date().getFullYear()));
  const [err,   setErr]   = useState("");

  const TRUCK_OPTIONS = ["33-Tonne Flatbed","Box Truck","Open Truck","Tanker","Refrigerated","Lowbed","Tipper"];

  function handleAdd() {
    const p = plate.trim().toUpperCase();
    if (!p || p.length < 6) { setErr("Enter a valid Kenya number plate (e.g. KDJ 441Z)"); return; }
    onAdd({ id:`T${Date.now()}`, plate:p, type, year:Number(year)||2020, status:"Available" });
    onClose();
  }

  return (
    <div style={{ position:"fixed",inset:0,zIndex:800,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(4px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 40px" }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Add Truck</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:20 }}>Register a New Vehicle</div>

        <label style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",display:"block",marginBottom:5 }}>Number Plate *</label>
        <input
          placeholder="e.g. KDJ 441Z"
          value={plate} onChange={e=>{setPlate(e.target.value); setErr("");}}
          style={{ width:"100%",padding:"12px 14px",fontSize:15,fontFamily:font,background:C.bg,border:`1.5px solid ${err?C.red:C.border}`,borderRadius:8,outline:"none",marginBottom:4,fontWeight:700,letterSpacing:1,textTransform:"uppercase" }}
        />
        {err && <div style={{ fontSize:12,color:C.red,fontWeight:600,marginBottom:10 }}>{err}</div>}
        {!err && <div style={{ marginBottom:14 }} />}

        <label style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",display:"block",marginBottom:5 }}>Truck Type *</label>
        <select
          value={type} onChange={e=>setType(e.target.value)}
          style={{ width:"100%",padding:"12px 14px",fontSize:14,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",marginBottom:14,color:C.black,cursor:"pointer" }}
        >
          {TRUCK_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <label style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",display:"block",marginBottom:5 }}>Year of Manufacture</label>
        <input
          type="number" min="2000" max={new Date().getFullYear()} placeholder="2021"
          value={year} onChange={e=>setYear(e.target.value)}
          style={{ width:"100%",padding:"12px 14px",fontSize:14,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",marginBottom:20 }}
        />

        <div style={{ background:C.amberBg,borderRadius:8,padding:"10px 14px",fontSize:12,color:C.amber,fontWeight:600,marginBottom:20 }}>
          ⚠ New trucks require document upload (NTSA inspection, insurance) before their first booking. You can upload documents in the KYC section.
        </div>

        <div style={{ display:"flex",gap:8 }}>
          <button onClick={onClose} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Cancel</button>
          <button onClick={handleAdd} style={{ flex:2,background:C.black,color:C.white,border:"none",borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>Add Truck</button>
        </div>
      </div>
    </div>
  );
}

function Account({ onLogout = ()=>{}, onShowLegal = ()=>{}, darkMode = false, toggleDark = ()=>{} }) {
  // Helper: days until expiry string like "Mar 2027"
  function daysUntilExp(expStr) {
    try {
      const [mon, yr] = expStr.split(" ");
      const d = new Date(`1 ${mon} ${yr}`);
      return Math.floor((d - Date.now()) / (1000*60*60*24));
    } catch { return 999; }
  }

  const docs = [
    { doc:"NTSA Inspection",     exp:"Mar 2027", ok:true },
    { doc:"GIT Insurance",       exp:"Dec 2026", ok:true },
    { doc:"Driver's Licence CE", exp:"Nov 2025", ok:false },
    { doc:"Goods Vehicle Lic.",  exp:"Jun 2027", ok:true },
  ];

  // Renewal reminders — docs expiring within 90 days
  const renewalDocs = docs.filter(d => {
    const days = daysUntilExp(d.exp);
    return days <= 90;
  });

  // Fleet state — persisted to localStorage
  const [fleet,       setFleet]       = useState(loadFleetFromStorage);
  const [showAddTruck, setShowAddTruck] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(null); // truck id
  const [showProfile,  setShowProfile]  = useState(false);
  const [showInsurance, setShowInsurance] = useState(false);
  /* Feature 25 — Dark mode: state & effect lifted to App.jsx, toggleDark passed as prop */

  function addTruck(truck) {
    const next = [...fleet, truck];
    setFleet(next);
    localStorage.setItem(FLEET_STORAGE_KEY, JSON.stringify(next));
  }

  function removeTruck(id) {
    const next = fleet.filter(t => t.id !== id);
    setFleet(next);
    localStorage.setItem(FLEET_STORAGE_KEY, JSON.stringify(next));
    setRemoveConfirm(null);
  }

  const expiredDocs = docs.filter(d => !d.ok).length;

  return (
    <div style={{ padding:12 }}>
      {/* Profile card */}
      <div style={{ ...card,padding:20,marginBottom:12,display:"flex",alignItems:"center",gap:16 }}>
        <div style={{ width:56,height:56,borderRadius:"50%",background:C.black,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,color:C.white,fontWeight:800,flexShrink:0 }}>JM</div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:18,fontWeight:700,color:C.black }}>James Mwangi</div>
          <div style={{ fontSize:13,color:C.muted }}>+254 722 100 200</div>
          <div style={{ fontSize:13,color:C.green,fontWeight:700,marginTop:3 }}>★ 4.9 · 148 trips</div>
        </div>
        <Pill color={C.green} bg={C.greenBg}>Active</Pill>
      </div>

      {/* Document status */}
      {expiredDocs > 0 && (
        <div style={{ background:C.redBg,border:`1px solid ${C.red}33`,borderRadius:10,padding:"10px 14px",marginBottom:8,fontSize:13,fontWeight:700,color:C.red }}>
          ⚠ {expiredDocs} document{expiredDocs>1?"s":""} expired or expiring soon — renew to keep booking loads
        </div>
      )}

      {/* 30-day renewal reminders (Feature 15) */}
      {renewalDocs.map(d => {
        const days = daysUntilExp(d.exp);
        return (
          <div key={d.doc} style={{ background:C.amberBg,border:`1px solid ${C.amber}33`,borderRadius:10,padding:"10px 14px",marginBottom:8,fontSize:12,fontWeight:600,color:C.amber,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <span>⏰ {d.doc} expires {days <= 0 ? "now" : `in ${days} days`} ({d.exp})</span>
            <span style={{ fontSize:11,fontWeight:700,color:C.amber }}>Renew →</span>
          </div>
        );
      })}

      {/* Fleet management */}
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
        <div style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase" }}>
          My Fleet ({fleet.length} truck{fleet.length!==1?"s":""})
        </div>
        <button onClick={()=>setShowAddTruck(true)} style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>
          + Add Truck
        </button>
      </div>

      <div style={{ ...card,overflow:"hidden",marginBottom:12 }}>
        {fleet.length === 0 && (
          <div style={{ padding:"24px 16px",textAlign:"center" }}>
            <div style={{ fontSize:32,marginBottom:8 }}>🚛</div>
            <div style={{ fontSize:14,fontWeight:700,color:C.secondary,marginBottom:4 }}>No trucks registered</div>
            <div style={{ fontSize:12,color:C.muted }}>Add your first truck to start booking loads</div>
          </div>
        )}
        {fleet.map((t, i, a) => (
          <div key={t.id} style={{ borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px" }}>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:2 }}>
                  <div style={{ fontSize:16,fontWeight:800,color:C.black,letterSpacing:0.5 }}>{t.plate}</div>
                  <span style={{
                    background: t.status==="Available" ? C.greenBg : t.status==="On Trip" ? C.blueBg : C.amberBg,
                    color:      t.status==="Available" ? C.green   : t.status==="On Trip" ? C.blue   : C.amber,
                    fontSize:10,fontWeight:700,borderRadius:100,padding:"2px 8px",
                  }}>{t.status}</span>
                </div>
                <div style={{ fontSize:12,color:C.muted }}>{t.type} · {t.year}</div>
              </div>
              {t.status !== "On Trip" && (
                <button
                  onClick={() => setRemoveConfirm(t.id)}
                  style={{ background:C.redBg,color:C.red,border:"none",borderRadius:8,padding:"7px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font,flexShrink:0 }}
                  title="Remove truck"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Document compliance */}
      <div style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Compliance Documents</div>
      <div style={{ ...card,overflow:"hidden",marginBottom:12 }}>
        {docs.map((d,i,a) => (
          <div key={d.doc} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
            <div>
              <div style={{ fontSize:14,fontWeight:600,color:d.ok?C.black:C.red }}>{d.doc}</div>
              <div style={{ fontSize:12,color:C.muted }}>Expires {d.exp}</div>
            </div>
            <span style={{ fontSize:18,fontWeight:900,color:d.ok?C.green:C.red }}>{d.ok?"✓":"⚠"}</span>
          </div>
        ))}
      </div>

      {/* Feature 23 — Carbon footprint tracker */}
      {(() => {
        const totalKm = 148 * 420; // 148 trips × avg 420 km
        const kgCO2   = Math.round(totalKm * 0.27); // 270g/km for 33T truck
        const trees   = Math.round(kgCO2 / 21);     // ~21 kg CO2 absorbed per tree/yr
        const offsets  = Math.round(kgCO2 * 0.001 * 750); // KSh 750/tonne
        return (
          <div style={{ ...card,padding:"16px",marginBottom:12,background:"#F0FFF4",border:`1.5px solid ${C.green}` }}>
            <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:12 }}>
              <span style={{ fontSize:22 }}>🌱</span>
              <div>
                <div style={{ fontSize:14,fontWeight:800,color:C.black }}>Carbon Footprint — 2026 YTD</div>
                <div style={{ fontSize:11,color:C.green,fontWeight:600 }}>Based on 148 completed trips</div>
              </div>
            </div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12 }}>
              {[
                [`${(kgCO2/1000).toFixed(1)} tonnes`, "CO₂ emitted"],
                [`${totalKm.toLocaleString()} km`,     "Total distance"],
                [`${trees.toLocaleString()} trees`,    "Equivalent offset"],
                [`KSh ${offsets.toLocaleString()}`,    "Offset cost est."],
              ].map(([v,l])=>(
                <div key={l} style={{ background:C.white,borderRadius:8,padding:"10px 12px" }}>
                  <div style={{ fontSize:16,fontWeight:800,color:C.black }}>{v}</div>
                  <div style={{ fontSize:10,fontWeight:600,color:C.green,textTransform:"uppercase",letterSpacing:0.5,marginTop:2 }}>{l}</div>
                </div>
              ))}
            </div>
            {/* Progress bar toward 5% reduction goal */}
            <div style={{ fontSize:11,fontWeight:700,color:C.secondary,marginBottom:4 }}>Goal: 5% annual reduction · Progress: 2.3%</div>
            <div style={{ height:6,background:C.border,borderRadius:3,overflow:"hidden" }}>
              <div style={{ height:"100%",width:"46%",background:C.green,borderRadius:3,transition:"width .5s" }} />
            </div>
            <button style={{ marginTop:10,width:"100%",background:C.green,color:C.black,border:"none",borderRadius:8,padding:"9px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>
              🌳 Purchase Carbon Offsets — KSh {offsets.toLocaleString()}
            </button>
          </div>
        );
      })()}

      {/* Cargo Insurance CTA (Feature 12) */}
      <div style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Cargo Protection</div>
      <div style={{ ...card,padding:"14px 16px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer" }} onClick={()=>setShowInsurance(true)}>
        <div>
          <div style={{ fontSize:14,fontWeight:700,color:C.black }}>🛡 Cargo Insurance</div>
          <div style={{ fontSize:12,color:C.muted,marginTop:2 }}>Per-trip cover from KSh 2,500 · APA Insurance</div>
        </div>
        <span style={{ fontSize:18,color:C.muted }}>›</span>
      </div>

      {/* Settings menu */}
      <div style={{ ...card,overflow:"hidden" }}>
        {[
          { label:"👤 View Public Profile", action:()=>setShowProfile(true) },
          { label:"Payment & M-Pesa",       action:undefined },
          { label:"Trip History",            action:undefined },
          { label:"Help & Support",          action:undefined },
          { label:"Privacy & Legal",         action:()=>onShowLegal("privacy") },
          { label:"Terms of Service",        action:()=>onShowLegal("terms") },
          { label:"Sign Out",                action:onLogout },
        ].map(({ label, action }, i, a) => (
          <div key={label} onClick={action} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"15px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none",cursor:action?"pointer":"default" }}>
            <span style={{ fontSize:14,fontWeight:600,color:label==="Sign Out"?C.red:C.black }}>{label}</span>
            {label!=="Sign Out" && <span style={{ color:C.muted,fontSize:18 }}>›</span>}
          </div>
        ))}
        {/* Feature 25 — Dark mode row */}
        <div onClick={toggleDark} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"15px 16px",cursor:"pointer" }}>
          <span style={{ fontSize:14,fontWeight:600,color:C.black }}>{darkMode?"☀ Light Mode":"🌙 Dark Mode"}</span>
          <div style={{ width:42,height:24,borderRadius:12,background:darkMode?C.black:C.border,position:"relative",flexShrink:0,transition:"background .2s" }}>
            <div style={{ width:18,height:18,borderRadius:"50%",background:C.white,position:"absolute",top:3,left:darkMode?21:3,transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.2)" }} />
          </div>
        </div>
      </div>

      {/* Add Truck Modal */}
      {showAddTruck && <AddTruckModal onClose={()=>setShowAddTruck(false)} onAdd={addTruck} />}

      {/* Carrier Public Profile */}
      {showProfile && <MyProfileModal onClose={()=>setShowProfile(false)} />}

      {/* Cargo Insurance Modal */}
      {showInsurance && <InsuranceModal onClose={()=>setShowInsurance(false)} />}

      {/* Remove Confirm */}
      {removeConfirm && (() => {
        const truck = fleet.find(t => t.id === removeConfirm);
        return (
          <div style={{ position:"fixed",inset:0,zIndex:800,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
            <div onClick={()=>setRemoveConfirm(null)} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.45)" }} />
            <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"24px 20px 40px" }}>
              <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"0 auto 20px" }} />
              <div style={{ fontSize:18,fontWeight:800,color:C.black,marginBottom:6 }}>Remove Truck?</div>
              <div style={{ fontSize:14,color:C.secondary,marginBottom:20 }}>
                Remove <strong>{truck?.plate}</strong> ({truck?.type}) from your fleet?
                This cannot be undone — the truck will need to be re-registered.
              </div>
              <div style={{ display:"flex",gap:8 }}>
                <button onClick={()=>setRemoveConfirm(null)} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Keep It</button>
                <button onClick={()=>removeTruck(removeConfirm)} style={{ flex:1,background:C.red,color:C.white,border:"none",borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>Remove</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ── GPS TRIP MODAL (Step 6) ────────────────────────────── */
function TripGPSModal({ trip, onClose }) {
  const mapRef  = useRef(null);
  const leafRef = useRef(null);
  const snap    = buildTripSnapshot(trip);
  const [progress, setProgress] = useState(snap.progressPct);
  const [simSnap,  setSimSnap]  = useState(snap);

  // Simulate truck advancing 0.3% every second while In Transit
  useEffect(() => {
    if (trip.status !== "In Transit") return;
    const iv = setInterval(() => {
      setProgress(p => {
        const next = Math.min(p + 0.3, 94);
        const s    = buildTripSnapshot({ ...trip, status: "In Transit" });
        // Override progressPct for simulation
        const fakeLoad = { ...trip, _pct: next };
        setSimSnap({ ...s, progressPct: next, kmDone: Math.round((next/100)*s.totalKm), kmLeft: Math.round(((100-next)/100)*s.totalKm) });
        return next;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [trip]);

  // Phase 5C-2: Google map with the real road route when the trip's load has
  // coordinates and a key is configured; otherwise the Leaflet simulation.
  const [gmFailed, setGmFailed] = useState(false);
  const pk = trip.pickup, dl = trip.delivery;
  const hasGeo = Number.isFinite(pk?.lat) && Number.isFinite(dl?.lat);
  const useGoogle = hasMapsKey() && hasGeo && !gmFailed;
  const roadPath = trip.routePolyline ? decodePolyline(trip.routePolyline) : null;
  let gPos = null;
  if (useGoogle) {
    const f = Math.max(0, Math.min(1, simSnap.progressPct / 100));
    gPos = roadPath && roadPath.length > 1
      ? roadPath[Math.min(roadPath.length - 1, Math.floor(f * (roadPath.length - 1)))]
      : { lat: pk.lat + (dl.lat - pk.lat) * f, lng: pk.lng + (dl.lng - pk.lng) * f };
  }

  // Leaflet GPS map
  useEffect(() => {
    if (useGoogle) return;
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css"; link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    function initMap(L) {
      if (leafRef.current) return;
      const { waypoints, polyline: line, position } = simSnap;
      const center = [position.lat, position.lng];

      const map = L.map(mapRef.current, {
        center, zoom: 7, zoomControl: false, attributionControl: false, scrollWheelZoom: false,
      });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom:19 }).addTo(map);

      // Route line
      const pl = L.polyline(line, { color:"#06C167", weight:3, opacity:0.7 }).addTo(map);

      // Waypoint dots
      waypoints.forEach(w => {
        const color = w.done ? "#06C167" : w.current ? "#FFFFFF" : "#555";
        const icon  = L.divIcon({ className:"", iconSize:[12,12], iconAnchor:[6,6],
          html:`<div style="width:10px;height:10px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.4)"></div>` });
        L.marker([w.lat, w.lng], { icon }).addTo(map)
          .bindTooltip(`<b style="font-size:11px">${w.name}</b>`, { direction:"top", offset:[0,-8], className:"behari-tip" });
      });

      // Animated truck marker
      const truckIcon = L.divIcon({ className:"", iconSize:[28,28], iconAnchor:[14,14],
        html:`<div style="width:26px;height:26px;background:#06C167;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 0 12px #06C167aa;border:2px solid white">🚛</div>` });
      const truckMarker = L.marker([position.lat, position.lng], { icon: truckIcon }).addTo(map);
      leafRef.current = { map, truckMarker };
    }

    if (window.L) initMap(window.L);
    else {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      s.onload = () => initMap(window.L);
      document.head.appendChild(s);
    }
    return () => { if (leafRef.current) { leafRef.current.map.remove(); leafRef.current = null; } };
  }, [useGoogle]); // init once per map provider

  // Update truck marker position when progress changes
  useEffect(() => {
    if (!leafRef.current) return;
    const { truckMarker } = leafRef.current;
    truckMarker?.setLatLng([simSnap.position.lat, simSnap.position.lng]);
  }, [simSnap.position.lat, simSnap.position.lng]);

  return (
    <div style={{ position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(4px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:520,maxHeight:"92vh",overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
        {/* Handle */}
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 0" }} />

        {/* Header */}
        <div style={{ padding:"14px 18px 0" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start" }}>
            <div>
              <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase" }}>Live GPS · {trip.id}</div>
              <div style={{ fontSize:18,fontWeight:800,color:C.black,marginTop:2 }}>{trip.cargo}</div>
              <div style={{ fontSize:13,color:C.secondary }}>{trip.from} → {trip.to}</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:11,color:C.muted,fontWeight:700,textTransform:"uppercase" }}>ETA</div>
              <div style={{ fontSize:20,fontWeight:800,color:C.black }}>{simSnap.eta}</div>
              <div style={{ fontSize:11,color:C.muted }}>{simSnap.kmLeft} km left</div>
            </div>
          </div>
        </div>

        {/* Map */}
        <div style={{ margin:"14px 18px",borderRadius:12,overflow:"hidden",height:200,background:"#17192C" }}>
          {useGoogle ? (
            <GoogleMap
              height={200}
              path={roadPath || [{ lat: pk.lat, lng: pk.lng }, { lat: dl.lat, lng: dl.lng }]}
              markers={[
                { id: "pickup",   lat: pk.lat, lng: pk.lng, label: trip.from, color: "#06C167" },
                { id: "delivery", lat: dl.lat, lng: dl.lng, label: trip.to,   color: "#276EF1" },
                { id: "truck",    lat: gPos.lat, lng: gPos.lng, label: "🚛", color: "#06C167" },
              ]}
              onUnavailable={() => setGmFailed(true)}
            />
          ) : (
            <div ref={mapRef} style={{ width:"100%",height:"100%" }} />
          )}
        </div>

        {/* Speed + progress strip */}
        <div style={{ display:"flex",gap:8,padding:"0 18px",marginBottom:14 }}>
          {[
            ["Speed",     `${simSnap.position.speedKmh || 0} km/h`],
            ["Progress",  `${Math.round(simSnap.progressPct)}%`],
            ["Distance",  `${simSnap.kmDone}/${simSnap.totalKm} km`],
          ].map(([l,v]) => (
            <div key={l} style={{ flex:1,background:C.bg,borderRadius:10,padding:"10px 12px",textAlign:"center" }}>
              <div style={{ fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:0.5,marginBottom:3 }}>{l}</div>
              <div style={{ fontSize:15,fontWeight:800,color:C.black }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Progress bar */}
        <div style={{ padding:"0 18px",marginBottom:18 }}>
          <div style={{ height:6,background:C.border,borderRadius:3,overflow:"hidden" }}>
            <div style={{ width:`${simSnap.progressPct}%`,height:"100%",background:C.green,transition:"width 1s linear",borderRadius:3 }} />
          </div>
        </div>

        {/* Waypoint timeline */}
        <div style={{ padding:"0 18px 32px" }}>
          <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:12 }}>Route Waypoints</div>
          {simSnap.waypoints.map((w, i) => (
            <div key={i} style={{ display:"flex",gap:12,marginBottom: i < simSnap.waypoints.length-1 ? 0 : 0 }}>
              {/* Timeline rail */}
              <div style={{ display:"flex",flexDirection:"column",alignItems:"center",width:20,flexShrink:0 }}>
                <div style={{
                  width:16,height:16,borderRadius:"50%",flexShrink:0,
                  background: w.done ? C.green : w.current ? C.black : C.border,
                  border: w.current ? `3px solid ${C.green}` : "none",
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:8,color:C.white,fontWeight:800,
                }}>
                  {w.done ? "✓" : w.current ? "●" : ""}
                </div>
                {i < simSnap.waypoints.length - 1 && (
                  <div style={{ width:2,flex:1,minHeight:24,background: w.done ? C.green : C.border,margin:"3px 0" }} />
                )}
              </div>
              {/* Waypoint info */}
              <div style={{ paddingBottom:16 }}>
                <div style={{ fontSize:13,fontWeight: w.current ? 800 : w.done ? 600 : 500, color: w.done||w.current ? C.black : C.muted }}>
                  {w.name}
                  {w.border && <span style={{ marginLeft:6,fontSize:10,fontWeight:700,color:C.amber,background:C.amberBg,padding:"2px 7px",borderRadius:100 }}>BORDER</span>}
                  {w.current && <span style={{ marginLeft:6,fontSize:10,fontWeight:700,color:C.blue,background:C.blueBg,padding:"2px 7px",borderRadius:100 }}>TRUCK HERE</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── RATING MODAL (Step 8) ───────────────────────────────── */
function RatingModal({ trip, raterRole = "carrier", onClose, onSubmitRating }) {
  const dims    = raterRole === "carrier" ? SHIPPER_RATING_DIMS : CARRIER_RATING_DIMS;
  const rateeId = raterRole === "carrier" ? (trip.shipper || "Shipper") : (trip.carrier || "James Mwangi");
  const [scores,  setScores]  = useState(() => Object.fromEntries(dims.map(d => [d.id, 0])));
  const [comment, setComment] = useState("");
  const [done,    setDone]    = useState(false);

  const allFilled = dims.every(d => scores[d.id] > 0);

  async function handleSubmit() {
    await onSubmitRating({
      loadId:   trip.id,
      raterRole,
      rateeId,
      scores,
      comment,
    });
    setDone(true);
  }

  if (done) return (
    <div style={{ position:"fixed",inset:0,zIndex:700,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"32px 20px 48px",textAlign:"center" }}>
        <div style={{ fontSize:56,marginBottom:12 }}>⭐</div>
        <div style={{ fontSize:22,fontWeight:800,color:C.black,marginBottom:6 }}>Rating Submitted</div>
        <div style={{ fontSize:14,color:C.secondary,marginBottom:24 }}>Thank you — your feedback builds trust on the platform.</div>
        <button onClick={onClose} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:10,padding:14,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
      </div>
    </div>
  );

  return (
    <div style={{ position:"fixed",inset:0,zIndex:700,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(4px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,maxHeight:"90vh",overflowY:"auto",padding:"8px 20px 40px" }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />

        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>
          Rate {raterRole === "carrier" ? "Shipper" : "Transporter"}
        </div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:2 }}>{rateeId}</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:20 }}>{trip.cargo} · {trip.id}</div>

        {dims.map(d => (
          <div key={d.id} style={{ marginBottom:20 }}>
            <div style={{ fontSize:13,fontWeight:700,color:C.black,marginBottom:4 }}>
              {d.icon} {d.label}
            </div>
            <div style={{ fontSize:11,color:C.muted,marginBottom:8 }}>{d.desc}</div>
            <div style={{ display:"flex",gap:6 }}>
              {[1,2,3,4,5].map(n => (
                <button key={n} onClick={() => setScores(s => ({...s,[d.id]:n}))} style={{
                  flex:1, padding:"10px 4px", border:`2px solid ${scores[d.id]>=n?C.black:C.border}`,
                  borderRadius:8, background:scores[d.id]>=n?C.black:C.white,
                  color:scores[d.id]>=n?C.white:C.muted, fontSize:16, cursor:"pointer",
                  transition:"all 0.12s", fontFamily:font,
                }}>★</button>
              ))}
            </div>
          </div>
        ))}

        <label style={{ display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:6 }}>
          Comments (optional)
        </label>
        <textarea
          placeholder="Any feedback for the platform…"
          value={comment} onChange={e=>setComment(e.target.value)}
          style={{ width:"100%",minHeight:72,padding:"10px 12px",fontSize:13,fontFamily:font,
            background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,resize:"vertical",outline:"none",marginBottom:16 }}
        />

        <button
          onClick={handleSubmit} disabled={!allFilled}
          style={{ width:"100%",background:allFilled?C.black:C.border,color:allFilled?C.white:C.muted,border:"none",borderRadius:10,padding:15,fontSize:15,fontWeight:700,cursor:allFilled?"pointer":"not-allowed",fontFamily:font,transition:"all 0.15s" }}
        >
          {allFilled ? "Submit Rating" : "Rate all categories to continue"}
        </button>
      </div>
    </div>
  );
}

/* ── DISPUTE OPEN MODAL (Step 7) ─────────────────────────── */
function DisputeOpenModal({ trip, raisedBy = "Transporter", onClose, onOpenDispute }) {
  const [reason,   setReason]   = useState("");
  const [evidence, setEvidence] = useState("");
  const [photos,   setPhotos]   = useState([]); // [{name, dataUrl}]
  const [busy,     setBusy]     = useState(false);
  const [done,     setDone]     = useState(false);
  const fileInputRef            = useRef(null);

  function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    files.slice(0, 4 - photos.length).forEach(file => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = ev => {
        setPhotos(prev => prev.length < 4 ? [...prev, { name:file.name, dataUrl:ev.target.result }] : prev);
      };
      reader.readAsDataURL(file);
    });
    // Reset input so same file can be re-selected
    e.target.value = "";
  }

  function removePhoto(idx) {
    setPhotos(prev => prev.filter((_,i) => i !== idx));
  }

  async function handleSubmit() {
    if (!reason.trim()) return;
    setBusy(true);
    const evidenceText = [evidence, photos.length ? `${photos.length} photo(s) attached` : ""].filter(Boolean).join(" · ");
    await onOpenDispute(trip.id, { raisedBy, reason, evidence: evidenceText });
    setBusy(false);
    setDone(true);
  }

  if (done) return (
    <div style={{ position:"fixed",inset:0,zIndex:700,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"32px 20px 48px",textAlign:"center" }}>
        <div style={{ fontSize:48,marginBottom:12 }}>⚖️</div>
        <div style={{ fontSize:22,fontWeight:800,color:C.black,marginBottom:6 }}>Dispute Filed</div>
        <div style={{ fontSize:14,color:C.secondary,marginBottom:8 }}>Reference: DSP-{trip.id}</div>
        <div style={{ background:C.amberBg,borderRadius:10,padding:"12px 16px",marginBottom:24,fontSize:13,color:C.amber,fontWeight:600,textAlign:"left" }}>
          🔒 Escrow is now frozen. Our ops team will review within 2 business hours and contact both parties.
        </div>
        <button onClick={onClose} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:10,padding:14,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
      </div>
    </div>
  );

  return (
    <div style={{ position:"fixed",inset:0,zIndex:700,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(4px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,maxHeight:"90vh",overflowY:"auto",padding:"8px 20px 40px" }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />

        <div style={{ fontSize:11,color:C.red,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Open Dispute</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:2 }}>{trip.cargo} · {trip.id}</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:16 }}>{trip.from} → {trip.to}</div>

        <div style={{ background:C.amberBg,borderRadius:10,padding:"12px 14px",marginBottom:20,fontSize:13,color:C.amber,fontWeight:600 }}>
          ⚠ Filing a dispute freezes the escrow until admin resolution. Use only for genuine issues.
        </div>

        <label style={{ display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:6 }}>
          Describe the Issue *
        </label>
        <textarea
          placeholder="e.g. Cargo damaged on arrival, wrong delivery location, unreachable driver…"
          value={reason} onChange={e=>setReason(e.target.value)}
          style={{ width:"100%",minHeight:100,padding:"10px 12px",fontSize:13,fontFamily:font,
            background:C.bg,border:`1.5px solid ${reason?C.black:C.border}`,borderRadius:8,resize:"vertical",outline:"none",marginBottom:14 }}
        />

        <label style={{ display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:6 }}>
          Evidence Description (optional)
        </label>
        <textarea
          placeholder="Describe the damage, timeline of events, WhatsApp messages received…"
          value={evidence} onChange={e=>setEvidence(e.target.value)}
          style={{ width:"100%",minHeight:72,padding:"10px 12px",fontSize:13,fontFamily:font,
            background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,resize:"vertical",outline:"none",marginBottom:14 }}
        />

        {/* Photo upload */}
        <label style={{ display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:6 }}>
          Attach Photos (up to 4)
        </label>
        <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileSelect} style={{ display:"none" }} />

        {/* Photo grid */}
        {photos.length > 0 && (
          <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:10 }}>
            {photos.map((p,i) => (
              <div key={i} style={{ position:"relative",borderRadius:8,overflow:"hidden",aspectRatio:"1",background:C.bg,border:`1px solid ${C.border}` }}>
                <img src={p.dataUrl} alt={p.name} style={{ width:"100%",height:"100%",objectFit:"cover" }} />
                <button onClick={()=>removePhoto(i)} style={{ position:"absolute",top:4,right:4,width:18,height:18,borderRadius:"50%",background:"rgba(0,0,0,0.65)",color:"#fff",border:"none",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",lineHeight:1,padding:0 }}>×</button>
              </div>
            ))}
          </div>
        )}

        {photos.length < 4 && (
          <button
            onClick={()=>fileInputRef.current?.click()}
            style={{ width:"100%",background:C.bg,border:`1.5px dashed ${C.border}`,borderRadius:8,padding:"12px",fontSize:13,fontWeight:600,color:C.secondary,cursor:"pointer",fontFamily:font,marginBottom:20,display:"flex",alignItems:"center",justifyContent:"center",gap:8 }}
          >
            <span style={{ fontSize:18 }}>📷</span>
            {photos.length === 0 ? "Attach photos or screenshots" : `Add more photos (${4-photos.length} remaining)`}
          </button>
        )}
        {photos.length >= 4 && <div style={{ marginBottom:20 }} />}

        <div style={{ display:"flex",gap:8 }}>
          <button onClick={onClose} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!reason.trim()||busy} style={{ flex:2,background:reason.trim()?C.red:C.border,color:reason.trim()?C.white:C.muted,border:"none",borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:reason.trim()?"pointer":"not-allowed",fontFamily:font }}>
            {busy ? "Filing…" : "File Dispute"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── ADVANCE PAY MODAL ──────────────────────────────────── */
function AdvancePayModal({ totalEarnings, onClose }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [done,   setDone]   = useState(false);
  const max    = Math.max(Math.round(totalEarnings * 0.4), 1000);
  const amtNum = Number(amount) || 0;
  const valid  = amtNum > 0 && amtNum <= max && reason.trim();
  const fee    = Math.round(amtNum * 0.015);
  const repayTotal = amtNum + fee;
  const repayPerTrip = Math.round(repayTotal / 3);

  if (done) return (
    <div style={{ position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"32px 20px 48px",textAlign:"center" }}>
        <div style={{ fontSize:56,marginBottom:12 }}>💰</div>
        <div style={{ fontSize:22,fontWeight:800,color:C.black,marginBottom:6 }}>Request Submitted!</div>
        <div style={{ fontSize:14,color:C.secondary,marginBottom:20 }}>KSh {amtNum.toLocaleString()} advance request sent. Ops team reviews within 4 hours.</div>
        <div style={{ background:C.greenBg,border:`1px solid ${C.green}`,borderRadius:10,padding:"12px 16px",fontSize:13,color:C.green,fontWeight:600,marginBottom:12,textAlign:"left" }}>
          📱 If approved, funds sent to your M-Pesa within 2 hours. 1.5% processing fee applies.
        </div>
        <div style={{ background:C.bg,borderRadius:8,padding:"12px 14px",fontSize:12,color:C.secondary,marginBottom:24 }}>
          <div style={{ fontWeight:700,color:C.black,marginBottom:4 }}>📋 Repayment Schedule</div>
          <div>KSh {amtNum.toLocaleString()} + 1.5% fee = KSh {(amtNum+Math.round(amtNum*0.015)).toLocaleString()}</div>
          <div style={{ marginTop:4 }}>KSh {Math.round((amtNum+Math.round(amtNum*0.015))/3).toLocaleString()} deducted from each of next 3 payouts</div>
        </div>
        <button onClick={onClose} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:10,padding:14,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
      </div>
    </div>
  );

  return (
    <div style={{ position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(3px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 36px",maxHeight:"80vh",overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 18px" }} />
        <div style={{ fontSize:17,fontWeight:800,color:C.black,marginBottom:4 }}>💰 Request Advance Pay</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:18 }}>Get up to 40% of pending earnings early via M-Pesa.</div>

        <div style={{ background:C.amberBg,border:`1px solid ${C.amber}`,borderRadius:8,padding:"10px 14px",marginBottom:18,fontSize:12,color:C.amber,fontWeight:600 }}>
          ⚠ Max advance: KSh {max.toLocaleString()} (40% of KSh {totalEarnings.toLocaleString()} earned)
        </div>

        <label style={{ display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:5 }}>Amount (KSh)</label>
        <input
          type="number" min="1" max={max} value={amount} onChange={e=>setAmount(e.target.value)}
          placeholder={`Up to KSh ${max.toLocaleString()}`}
          style={{ width:"100%",background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,padding:"12px 14px",fontSize:14,fontFamily:font,color:C.black,outline:"none",marginBottom:14,boxSizing:"border-box" }}
        />

        <label style={{ display:"block",fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:5 }}>Reason</label>
        <textarea
          placeholder="e.g. Fuel advance for next trip, truck repair, urgent expense…"
          value={reason} onChange={e=>setReason(e.target.value)}
          style={{ width:"100%",minHeight:80,padding:"10px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,resize:"vertical",outline:"none",marginBottom:20,boxSizing:"border-box" }}
        />

        <div style={{ display:"flex",gap:8 }}>
          <button onClick={onClose} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Cancel</button>
          <button onClick={()=>setDone(true)} disabled={!valid} style={{ flex:2,background:valid?C.green:C.border,color:valid?C.black:C.muted,border:"none",borderRadius:10,padding:"12px",fontSize:14,fontWeight:700,cursor:valid?"pointer":"not-allowed",fontFamily:font }}>
            {valid ? `Request KSh ${amtNum.toLocaleString()}` : "Fill in all fields"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── CARRIER PUBLIC PROFILE ─────────────────────────────── */
function MyProfileModal({ onClose }) {
  const [copied, setCopied] = useState(false);
  const KYC_DOCS = [
    { label:"National ID",     done:true  },
    { label:"Licence CE",      done:true  },
    { label:"GIT Insurance",   done:true  },
    { label:"NTSA Inspection", done:true  },
    { label:"Truck Logbook",   done:true  },
    { label:"KRA PIN",         done:true  },
    { label:"GVL",             done:false },
  ];
  const fleet = loadFleetFromStorage();
  return (
    <div style={{ position:"fixed",inset:0,zIndex:600,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(4px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,maxHeight:"88vh",overflowY:"auto",padding:"8px 20px 40px" }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:12 }}>Your public profile — shippers see this</div>

        {/* Banner */}
        <div style={{ background:C.black,borderRadius:14,padding:"20px 18px",marginBottom:20,display:"flex",gap:16,alignItems:"center" }}>
          <div style={{ width:60,height:60,borderRadius:"50%",background:C.green,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,fontWeight:800,color:C.black,flexShrink:0 }}>JM</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:17,fontWeight:800,color:C.white,marginBottom:2 }}>James K. Mwangi</div>
            <div style={{ fontSize:13,color:"rgba(255,255,255,0.6)" }}>Nairobi · 10+ years experience</div>
            <div style={{ display:"flex",alignItems:"center",gap:8,marginTop:6 }}>
              <span style={{ background:C.green,color:C.black,fontSize:11,fontWeight:800,borderRadius:100,padding:"3px 10px" }}>4.9 ★</span>
              <span style={{ fontSize:12,color:"rgba(255,255,255,0.5)" }}>148 trips · 99% on-time</span>
            </div>
          </div>
        </div>

        {/* Stats grid */}
        <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:20 }}>
          {[["148","Trips"],["4.9 ★","Rating"],["99%","On-time"]].map(([v,l]) => (
            <div key={l} style={{ ...card,padding:"12px",textAlign:"center" }}>
              <div style={{ fontSize:18,fontWeight:800,color:C.black }}>{v}</div>
              <div style={{ fontSize:11,color:C.muted,fontWeight:600,marginTop:2 }}>{l}</div>
            </div>
          ))}
        </div>

        {/* Fleet */}
        <div style={{ fontSize:11,fontWeight:700,color:C.muted,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Your Fleet</div>
        <div style={{ ...card,overflow:"hidden",marginBottom:20 }}>
          {fleet.map((t,i,a) => (
            <div key={t.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
              <div>
                <div style={{ fontSize:14,fontWeight:700,color:C.black }}>{t.plate}</div>
                <div style={{ fontSize:12,color:C.muted }}>{t.type} · {t.year}</div>
              </div>
              <span style={{ background:t.status==="Available"?C.greenBg:C.amberBg,color:t.status==="Available"?C.green:C.amber,fontSize:10,fontWeight:700,borderRadius:100,padding:"3px 8px" }}>{t.status}</span>
            </div>
          ))}
        </div>

        {/* KYC badges */}
        <div style={{ fontSize:11,fontWeight:700,color:C.muted,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>KYC Verification Status</div>
        <div style={{ display:"flex",flexWrap:"wrap",gap:6,marginBottom:24 }}>
          {KYC_DOCS.map(d => (
            <span key={d.label} style={{ background:d.done?C.greenBg:C.bg,color:d.done?C.green:C.muted,border:`1px solid ${d.done?C.green:C.border}`,borderRadius:100,padding:"5px 12px",fontSize:11,fontWeight:700,display:"inline-flex",alignItems:"center",gap:5 }}>
              {d.done ? "✓" : "○"} {d.label}
            </span>
          ))}
        </div>

        <div style={{ display:"flex",gap:8 }}>
          <button onClick={()=>{ navigator.clipboard.writeText("https://behari.co.ke/transporter/james-mwangi").catch(()=>{}); setCopied(true); setTimeout(()=>setCopied(false),2500); }} style={{ flex:1,background:copied?C.greenBg:C.bg,color:copied?C.green:C.black,border:`1px solid ${copied?C.green:C.border}`,borderRadius:10,padding:"12px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font,transition:"all 0.2s" }}>
            {copied?"✓ Copied!":"🔗 Copy Link"}
          </button>
          <button onClick={onClose} style={{ flex:1,background:C.black,color:C.white,border:"none",borderRadius:10,padding:"12px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
        </div>
      </div>
    </div>
  );
}

/* ── CARRIER NOTIFICATIONS (Feature 6) ─────────────────── */
const CARRIER_NOTIF_KEY = "behari_carrier_notifs";
function loadCarrierNotifs() {
  try { return JSON.parse(localStorage.getItem(CARRIER_NOTIF_KEY) || "[]"); } catch { return []; }
}
function CarrierNotifPanel({ onClose }) {
  const [notifs, setNotifs] = useState(loadCarrierNotifs);
  const unread = notifs.filter(n => !n.read).length;
  function markAll() {
    const next = notifs.map(n => ({ ...n, read:true }));
    setNotifs(next);
    localStorage.setItem(CARRIER_NOTIF_KEY, JSON.stringify(next));
  }
  return (
    <div style={{ position:"fixed",inset:0,zIndex:250 }} onClick={onClose}>
      <div style={{ position:"absolute",top:52,left:0,right:0,background:C.white,borderBottom:`1px solid ${C.border}`,maxHeight:"65vh",overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,0.12)" }} onClick={e=>e.stopPropagation()}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px",borderBottom:`1px solid ${C.border}`,position:"sticky",top:0,background:C.white,zIndex:1 }}>
          <div style={{ fontSize:15,fontWeight:800,color:C.black }}>
            Notifications {unread>0&&<span style={{ background:C.red,color:C.white,fontSize:11,fontWeight:700,borderRadius:100,padding:"2px 8px",marginLeft:6 }}>{unread}</span>}
          </div>
          {unread>0&&<button onClick={markAll} style={{ background:"none",border:"none",fontSize:12,fontWeight:700,color:C.green,cursor:"pointer",fontFamily:font }}>Mark all read</button>}
        </div>
        {notifs.length===0?(
          <div style={{ textAlign:"center",padding:"48px 20px" }}>
            <div style={{ fontSize:36,marginBottom:10 }}>🔔</div>
            <div style={{ fontSize:15,fontWeight:700,color:C.secondary }}>No notifications yet</div>
            <div style={{ fontSize:13,color:C.muted,marginTop:4 }}>New loads and updates appear here</div>
          </div>
        ):notifs.map((n,i,a)=>(
          <div key={n.id} style={{ display:"flex",gap:12,alignItems:"flex-start",padding:"14px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none",background:n.read?C.white:"#F0FBF6" }}>
            <div style={{ width:38,height:38,borderRadius:"50%",background:C.greenBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0 }}>{n.icon||"📦"}</div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13,fontWeight:700,color:C.black,marginBottom:3 }}>{n.title}</div>
              <div style={{ fontSize:12,color:C.secondary }}>{n.body}</div>
              <div style={{ fontSize:11,color:C.muted,marginTop:5 }}>{n.time}</div>
            </div>
            {!n.read&&<div style={{ width:8,height:8,borderRadius:"50%",background:C.green,flexShrink:0,marginTop:5 }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── PICKUP PHOTO MODAL (Feature 4) ─────────────────────── */
function PickupPhotoModal({ trip, onClose, onConfirm }) {
  const [photoLabel, setPhotoLabel] = useState(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);
  function handleFile(e) { if (e.target.files?.[0]) setPhotoLabel(e.target.files[0].name); }
  function demoPhoto() { setPhotoLabel("pickup_photo_demo.jpg"); }
  async function handleConfirm() {
    const notifs = loadCarrierNotifs();
    const n = { id:`PICKUP-${trip.id}-${Date.now()}`,icon:"📸",title:"Pickup Photo Saved",body:`Cargo photo for ${trip.cargo} · ${trip.id}${note?` — "${note}"`:""}`,time:new Date().toLocaleTimeString("en-KE",{hour:"2-digit",minute:"2-digit"}),read:false };
    localStorage.setItem(CARRIER_NOTIF_KEY, JSON.stringify([n,...notifs]));
    await onConfirm(trip.id);
    setDone(true);
  }
  if (done) return (
    <div style={{ position:"fixed",inset:0,zIndex:900,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"32px 20px 48px",textAlign:"center" }}>
        <div style={{ fontSize:48,marginBottom:12 }}>📸</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:6 }}>Photo Saved!</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:24 }}>Pickup confirmed. Loading started.</div>
        <button onClick={onClose} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:10,padding:14,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
      </div>
    </div>
  );
  return (
    <div style={{ position:"fixed",inset:0,zIndex:900,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(4px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 40px" }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Pickup Confirmation</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:6 }}>Upload Pickup Photo</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:16 }}>Photo the cargo before loading — protects you from damage claims.</div>
        {photoLabel?(
          <div style={{ background:C.greenBg,border:`1px solid ${C.green}`,borderRadius:8,padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:10 }}>
            <span style={{ fontSize:20 }}>📸</span>
            <div><div style={{ fontSize:13,fontWeight:700,color:C.black }}>{photoLabel}</div><div style={{ fontSize:11,color:C.green,fontWeight:600 }}>Photo ready ✓</div></div>
          </div>
        ):(
          <div style={{ background:C.bg,border:`1.5px dashed ${C.border}`,borderRadius:8,padding:"28px 16px",textAlign:"center",marginBottom:16 }}>
            <div style={{ fontSize:36,marginBottom:8 }}>📷</div><div style={{ fontSize:13,color:C.muted }}>No photo yet</div>
          </div>
        )}
        <div style={{ display:"flex",gap:8,marginBottom:12 }}>
          <label style={{ flex:1,background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font,textAlign:"center" }}>
            📁 Upload<input type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ display:"none" }} />
          </label>
          <button onClick={demoPhoto} style={{ flex:1,background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font }}>📸 Demo</button>
        </div>
        <input placeholder="Optional note (cargo condition, pallet count)…" value={note} onChange={e=>setNote(e.target.value)}
          style={{ width:"100%",padding:"10px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",marginBottom:16 }} />
        <div style={{ display:"flex",gap:8 }}>
          <button onClick={()=>{ onConfirm(trip.id); onClose(); }} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Skip</button>
          <button onClick={handleConfirm} disabled={!photoLabel} style={{ flex:2,background:photoLabel?C.black:C.border,color:photoLabel?C.white:C.muted,border:"none",borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:photoLabel?"pointer":"not-allowed",fontFamily:font }}>
            {photoLabel?"✓ Confirm Loading":"Add a photo first"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── BREAKDOWN MODAL (Feature 20) ───────────────────────── */
function BreakdownModal({ trip, onClose }) {
  const [issue, setIssue] = useState("");
  const [location, setLocation] = useState("");
  const [locating, setLocating] = useState(false);
  const [done, setDone] = useState(false);
  function getLocation() {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      pos => { setLocation(`${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)} (GPS)`); setLocating(false); },
      () => { setLocation("Location unavailable — type manually"); setLocating(false); }
    );
  }
  function handleReport() {
    const notifs = loadCarrierNotifs();
    const n = { id:`BRK-${trip.id}-${Date.now()}`,icon:"🆘",title:"Breakdown Reported",body:`${issue}${location?` — ${location}`:""} · ${trip.id}. Ops team notified.`,time:new Date().toLocaleTimeString("en-KE",{hour:"2-digit",minute:"2-digit"}),read:false };
    localStorage.setItem(CARRIER_NOTIF_KEY, JSON.stringify([n,...notifs]));
    setDone(true);
  }
  if (done) return (
    <div style={{ position:"fixed",inset:0,zIndex:900,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"32px 20px 48px",textAlign:"center" }}>
        <div style={{ fontSize:48,marginBottom:12 }}>🆘</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:6 }}>Report Sent!</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:8 }}>Shipper and Ops team have been notified.</div>
        <div style={{ background:C.amberBg,borderRadius:8,padding:"10px 14px",fontSize:12,color:C.amber,fontWeight:600,marginBottom:24 }}>📞 Behari Ops will call within 15 minutes.</div>
        <button onClick={onClose} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:10,padding:14,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
      </div>
    </div>
  );
  return (
    <div style={{ position:"fixed",inset:0,zIndex:900,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(4px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 40px" }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ background:C.redBg,borderRadius:10,padding:"12px 14px",marginBottom:16,display:"flex",alignItems:"center",gap:10 }}>
          <span style={{ fontSize:28 }}>🆘</span>
          <div><div style={{ fontSize:15,fontWeight:800,color:C.red }}>Report Vehicle Breakdown</div><div style={{ fontSize:12,color:C.red,opacity:0.8 }}>Ops team notified immediately</div></div>
        </div>
        <label style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",display:"block",marginBottom:5 }}>Issue Type *</label>
        <select value={issue} onChange={e=>setIssue(e.target.value)} style={{ width:"100%",padding:"12px 14px",fontSize:14,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none",marginBottom:14,color:issue?C.black:C.muted }}>
          <option value="">Select issue…</option>
          <option>Flat tyre</option><option>Engine failure</option><option>Fuel shortage</option>
          <option>Accident</option><option>Police hold</option><option>Road block</option><option>Other mechanical</option>
        </select>
        <label style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",display:"block",marginBottom:5 }}>Your Location</label>
        <div style={{ display:"flex",gap:8,marginBottom:20 }}>
          <input placeholder="e.g. A109 near Mtito Andei" value={location} onChange={e=>setLocation(e.target.value)}
            style={{ flex:1,padding:"10px 12px",fontSize:13,fontFamily:font,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:8,outline:"none" }} />
          <button onClick={getLocation} disabled={locating} style={{ background:C.blueBg,color:C.blue,border:"none",borderRadius:8,padding:"10px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>
            {locating?"…":"📍 GPS"}
          </button>
        </div>
        <div style={{ display:"flex",gap:8 }}>
          <button onClick={onClose} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Cancel</button>
          <button onClick={handleReport} disabled={!issue} style={{ flex:2,background:issue?C.red:C.border,color:issue?C.white:C.muted,border:"none",borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:issue?"pointer":"not-allowed",fontFamily:font }}>🆘 Report Breakdown</button>
        </div>
      </div>
    </div>
  );
}

/* ── CARGO INSURANCE MODAL (Feature 12) ─────────────────── */
function InsuranceModal({ onClose }) {
  const [plan, setPlan] = useState("standard");
  const [done, setDone] = useState(false);
  const PLANS = [
    { id:"basic",    label:"Basic",    price:2500, desc:"Up to KSh 500K cargo cover" },
    { id:"standard", label:"Standard", price:4800, desc:"KSh 2M cargo + 3rd party liability" },
    { id:"premium",  label:"Premium",  price:8500, desc:"KSh 5M full cover + roadside assist" },
  ];
  const selected = PLANS.find(p=>p.id===plan);
  if (done) return (
    <div style={{ position:"fixed",inset:0,zIndex:700,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"32px 20px 48px",textAlign:"center" }}>
        <div style={{ fontSize:48,marginBottom:12 }}>🛡</div>
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:6 }}>Insurance Active!</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:20 }}>Your cargo is covered. Certificate sent to your M-Pesa number.</div>
        <button onClick={onClose} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:10,padding:14,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
      </div>
    </div>
  );
  return (
    <div style={{ position:"fixed",inset:0,zIndex:700,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:font }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",backdropFilter:"blur(4px)" }} />
      <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",width:"100%",maxWidth:480,padding:"8px 20px 40px",maxHeight:"80vh",overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
        <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"12px auto 20px" }} />
        <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:4 }}>🛡 Cargo Insurance</div>
        <div style={{ fontSize:13,color:C.secondary,marginBottom:20 }}>Per-trip cargo protection. Deducted from your M-Pesa balance.</div>
        {PLANS.map(p=>(
          <div key={p.id} onClick={()=>setPlan(p.id)} style={{ border:`2px solid ${plan===p.id?C.black:C.border}`,borderRadius:10,padding:"14px 16px",marginBottom:10,cursor:"pointer",transition:"border-color 0.15s",background:plan===p.id?C.bg:C.white }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4 }}>
              <span style={{ fontSize:14,fontWeight:700,color:C.black }}>{p.label}</span>
              <span style={{ fontSize:15,fontWeight:800,color:C.black }}>KSh {p.price.toLocaleString()}<span style={{ fontSize:11,color:C.muted,fontWeight:500 }}>/trip</span></span>
            </div>
            <div style={{ fontSize:12,color:C.muted }}>{p.desc}</div>
          </div>
        ))}
        <div style={{ background:C.greenBg,border:`1px solid ${C.green}`,borderRadius:8,padding:"10px 14px",marginBottom:20,fontSize:12,color:C.green,fontWeight:600 }}>✓ Powered by APA Insurance · Underwritten by Kenya Re</div>
        <div style={{ display:"flex",gap:8 }}>
          <button onClick={onClose} style={{ flex:1,background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.black }}>Cancel</button>
          <button onClick={()=>setDone(true)} style={{ flex:2,background:C.black,color:C.white,border:"none",borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>Buy — KSh {selected?.price.toLocaleString()}</button>
        </div>
      </div>
    </div>
  );
}

/* ── TRIP HISTORY TAB (Feature 16) ─────────────────────── */
function TripHistoryTab({ myTrips = [] }) {
  const HIST_RATES = { KSh:1, USD:0.0077, UGX:28.5, TZS:10.2 };
  const [currency, setCurrency] = useState("KSh");
  const rate = HIST_RATES[currency];
  // Phase 3C: myTrips already carries live status — just filter to done ones.
  const all = myTrips.filter(t => DONE_STATUSES.has(t.status));
  const totalEarned = all.filter(t => t.status==="Delivered"||t.status==="Paid Out").reduce((s,t)=>s+t.pay,0);

  function fmt(ksh) {
    if (currency === "KSh") return `KSh ${ksh.toLocaleString()}`;
    return `${currency} ${Math.round(ksh * rate).toLocaleString()}`;
  }

  return (
    <div style={{ padding:12 }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 }}>
        <div style={{ fontSize:11,fontWeight:700,color:C.muted,letterSpacing:0.8,textTransform:"uppercase" }}>Trip History ({all.length})</div>
        <select value={currency} onChange={e=>setCurrency(e.target.value)} style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"5px 10px",fontSize:12,fontFamily:font,color:C.black,cursor:"pointer" }}>
          {Object.keys(HIST_RATES).map(c=><option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {all.length===0&&(
        <div style={{ textAlign:"center",padding:"60px 20px" }}>
          <div style={{ fontSize:40,marginBottom:12 }}>📋</div>
          <div style={{ fontSize:16,fontWeight:700,color:C.secondary }}>No trip history yet</div>
          <div style={{ fontSize:13,color:C.muted,marginTop:4 }}>Completed trips will appear here</div>
        </div>
      )}
      {all.map(t=>(
        <div key={t.id} style={{ ...card,padding:"14px 16px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"flex-start" }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:11,color:C.muted,marginBottom:3 }}>{t.id} · {t.date||"—"}</div>
            <div style={{ fontSize:15,fontWeight:700,color:C.black,marginBottom:2 }}>{t.cargo}</div>
            <div style={{ fontSize:13,color:C.secondary }}>{t.from} → {t.to}</div>
            {t.plate&&<div style={{ fontSize:12,color:C.muted,marginTop:2 }}>🚛 {t.plate}</div>}
            <div style={{ fontSize:12,fontWeight:700,marginTop:4,color:t.status==="Delivered"||t.status==="Paid Out"?C.green:t.status==="Cancelled"?C.red:C.amber }}>{t.status}</div>
          </div>
          <div style={{ textAlign:"right",flexShrink:0 }}>
            <div style={{ fontSize:16,fontWeight:800,color:C.black }}>{fmt(t.pay)}</div>
            {(t.status==="Delivered"||t.status==="Paid Out")&&<div style={{ fontSize:10,fontWeight:700,color:C.green }}>✓ PAID</div>}
            {t.status==="Cancelled"&&<div style={{ fontSize:10,fontWeight:700,color:C.red }}>CANCELLED</div>}
          </div>
        </div>
      ))}
      {all.length>0&&(
        <div style={{ ...card,padding:"14px 16px",marginTop:4,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <span style={{ fontSize:14,fontWeight:700,color:C.black }}>Total Earned</span>
          <span style={{ fontSize:16,fontWeight:800,color:C.green }}>{fmt(totalEarned)}</span>
        </div>
      )}
    </div>
  );
}

/* ── MY TRUCK — Declare Availability + Matches For Your Truck ───────────── *
 * This is the carrier's new first-experience tab. It replaces "browse a
 * marketplace" with "tell Behari where you are, and Behari finds cargo" —
 * the central Truck ↔ Cargo matching workflow (Flow A in the product spec).
 */
function fmtAvailShort(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const now = new Date();
    const time = d.toLocaleTimeString("en-KE",{hour:"2-digit",minute:"2-digit"});
    if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
    const tmrw = new Date(now); tmrw.setDate(now.getDate()+1);
    if (d.toDateString() === tmrw.toDateString()) return `Tomorrow, ${time}`;
    return `${d.toLocaleDateString("en-KE",{day:"numeric",month:"short"})}, ${time}`;
  } catch { return iso; }
}

const MY_CARRIER_ID_MT = "CARRIER-001";

/** Phase 4G.3 — one truck row; expands to live GPS if it has an active backend trip. */
function MyFleetTruckRow({ truck, driverName }) {
  const [expanded, setExpanded] = useState(false);
  const live = useLiveTripByTruckId(truck.id);
  const statusColor = truck.status === "Available" ? C.green : truck.status === "Maintenance" ? C.red : C.blue;

  return (
    <div style={{ ...card, padding:"12px 14px", marginBottom:8 }}>
      <div
        style={{ display:"flex", justifyContent:"space-between", alignItems:"center", cursor: live.trip ? "pointer" : "default" }}
        onClick={() => live.trip && setExpanded(v => !v)}
      >
        <div>
          <div style={{ fontSize:14, fontWeight:800, color:C.black }}>{truck.plate}</div>
          {driverName && <div style={{ fontSize:11, color:C.secondary, marginTop:2 }}>{driverName}</div>}
        </div>
        <div style={{ textAlign:"right" }}>
          <span style={{ fontSize:11, fontWeight:700, color:statusColor }}>{truck.status}</span>
          {live.trip && <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>{expanded ? "▲ hide" : "▼ live"}</div>}
        </div>
      </div>
      {expanded && live.trip && (
        <div style={{ marginTop:10 }}>
          <LiveTrackingPanel {...live} truckPlate={truck.plate} compact={false} />
        </div>
      )}
    </div>
  );
}

/** Phase 4G.3 — the real Truck/Driver assignment roster (fleetService.js, Phase 4B), not the legacy CARRIER_FLEET display list. */
function MyFleetLive() {
  const [trucks, setTrucks]   = useState([]);
  const [drivers, setDrivers] = useState([]);

  useEffect(() => { getTrucks().then(setTrucks); getDrivers().then(setDrivers); }, []);

  if (trucks.length === 0) return null;
  return (
    <div style={{ marginBottom:16 }}>
      <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>My Fleet</div>
      {trucks.map(t => (
        <MyFleetTruckRow key={t.id} truck={t} driverName={drivers.find(d => d.id === t.currentDriverId)?.name || null} />
      ))}
    </div>
  );
}

function MyTruck({ allLoads = [], truckAvailabilities = [], onDeclareAvailability = ()=>{}, onFindMatchesForTruck = ()=>{}, onAcceptMatch = ()=>{}, onBook = ()=>{} }) {
  const [declaring, setDeclaring]         = useState(false);
  const [showForm, setShowForm]           = useState(false);
  const [viewingId, setViewingId]         = useState(null);
  const [matchesForView, setMatchesForView] = useState([]);
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [radius, setRadius]               = useState(25);

  const myAvailabilities = truckAvailabilities.filter(t => t.carrierId === MY_CARRIER_ID_MT && t.status === "Active");
  const viewingTruck     = myAvailabilities.find(t => t.id === viewingId) || null;

  async function handleDeclare(formData) {
    setDeclaring(true);
    const ta = await onDeclareAvailability({ ...formData, carrierId: MY_CARRIER_ID_MT, carrierName:"James Mwangi" });
    setDeclaring(false);
    setShowForm(false);
    await viewMatches(ta);
  }

  async function viewMatches(truck) {
    setViewingId(truck.id);
    setLoadingMatches(true);
    const results = await onFindMatchesForTruck(truck, allLoads, {});
    setMatchesForView(results);
    setLoadingMatches(false);
  }

  const strongMatches = matchesForView.filter(m => m.matchScore >= 40);
  const nearbyCargo = viewingTruck
    ? allLoads
        .map(l => ({ ...l, distanceKm: null }))
        .filter(l => strongMatches.some(m => m.cargoId === l.id))
        .filter(l => radius === "route" ? true : true) // radius filter cosmetic — matches already route/proximity-scored
    : [];

  return (
    <div style={{ padding:12 }}>
      <MyFleetLive />
      {myAvailabilities.length > 0 && (
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Your Declared Availability</div>
          {myAvailabilities.map(truck => (
            <div key={truck.id} style={{ ...card, padding:14, marginBottom:8, border:viewingId===truck.id?`2px solid ${C.black}`:`1px solid ${C.border}` }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10 }}>
                <div>
                  <div style={{ fontSize:15,fontWeight:800,color:C.black }}>{truck.plate} · {truck.truckType}</div>
                  <div style={{ fontSize:12,color:C.secondary,marginTop:2 }}>{truck.currentLocation?.name || "—"} → going toward {truck.goingToward || "—"}</div>
                  <div style={{ fontSize:11,color:C.muted,marginTop:2 }}>⏱ Available {fmtAvailShort(truck.availableFrom)}{truck.acceptsPartial ? " · Accepts partial loads" : ""}</div>
                </div>
                <button onClick={()=>viewMatches(truck)} style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:"8px 12px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font,flexShrink:0 }}>
                  Find Matches
                </button>
              </div>
            </div>
          ))}
          <button onClick={()=>setShowForm(v=>!v)} style={{ width:"100%",background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>
            {showForm ? "▲ Hide form" : "+ Declare another availability"}
          </button>
        </div>
      )}

      {showForm ? (
        <div style={{ ...card,padding:16,marginBottom:16 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4 }}>
            <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase" }}>Declare Truck Availability</div>
            <button onClick={()=>setShowForm(false)} style={{ background:"none",border:"none",color:C.muted,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font,padding:"2px 4px" }}>
              ▲ Minimize
            </button>
          </div>
          <div style={{ fontSize:13,color:C.secondary,marginBottom:14,lineHeight:1.6 }}>
            Tell Behari where your truck will be free, when, and which way you're heading. We'll find cargo moving that direction — including return loads so you don't drive back empty.
          </div>
          <TruckAvailabilityForm fleet={CARRIER_FLEET} onSubmit={handleDeclare} submitting={declaring} />
        </div>
      ) : (
        <button onClick={()=>setShowForm(true)} style={{ width:"100%",background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font,marginBottom:16 }}>
          + Declare Truck Availability
        </button>
      )}

      {viewingId && (
        <>
          <EmptyReturnOpportunity direction={viewingTruck?.goingToward} matchCount={strongMatches.length} />

          {/* Cargo Near My Truck — filter bar */}
          <div style={{ display:"flex",gap:6,marginBottom:10,overflowX:"auto" }}>
            {[["5","Within 5 km"],["10","Within 10 km"],["25","Within 25 km"],["route","Along my route"]].map(([v,l])=>(
              <button key={v} onClick={()=>setRadius(v)} style={{ background:radius===v?C.black:C.white,color:radius===v?C.white:C.secondary,border:`1.5px solid ${radius===v?C.black:C.border}`,borderRadius:100,padding:"6px 12px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font,whiteSpace:"nowrap",flexShrink:0 }}>{l}</button>
            ))}
          </div>

          <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",margin:"12px 0 8px" }}>
            Matches For Your Truck {matchesForView.length>0 ? `(${matchesForView.length})` : ""}
          </div>
          {loadingMatches && <div style={{ textAlign:"center",padding:24,color:C.muted,fontSize:13 }}>Scoring cargo against your truck…</div>}
          {!loadingMatches && matchesForView.length === 0 && (
            <div style={{ ...card,padding:"28px 16px",textAlign:"center" }}>
              <div style={{ fontSize:28,marginBottom:8 }}>👀</div>
              <div style={{ fontSize:13,fontWeight:700,color:C.secondary,marginBottom:2 }}>WATCHING FOR MATCHES</div>
              <div style={{ fontSize:12,color:C.muted }}>Nothing compatible right now — you'll be notified when matching cargo appears.</div>
            </div>
          )}
          {!loadingMatches && matchesForView
            .filter(m => allLoads.some(l => l.id === m.cargoId))
            .map(m => {
              const cargo = allLoads.find(l => l.id === m.cargoId);
              return (
                <MatchCard
                  key={m.id} match={m} truck={viewingTruck} cargo={cargo}
                  primaryLabel={cargo.isBackend ? "View & Make Offer" : "Demo Load — booking unavailable"}
                  onPrimary={() => onBook(cargo)}
                />
              );
            })}
        </>
      )}
    </div>
  );
}

/* ── TOAST — matching-engine "new match found" alert (Flow C) ───────────── */
function Toast({ message, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{ position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",background:C.black,color:C.white,borderRadius:10,padding:"12px 20px",fontSize:13,fontWeight:600,fontFamily:font,zIndex:9999,maxWidth:340,textAlign:"center",boxShadow:"0 8px 24px rgba(0,0,0,0.3)",animation:"slideDown 0.3s ease" }}>
      <style>{`@keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`}</style>
      {message}
    </div>
  );
}

/* ── BACKEND BOOKINGS (5D-3) — agreed terms straight from the backend booking ─ */
function BackendBookings({ commerce }) {
  if (commerce.bookings.length === 0) return null;
  return (
    <div style={{ padding:"12px 12px 0" }} data-testid="backend-bookings">
      <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:0.8, textTransform:"uppercase", marginBottom:8 }}>Agreed Bookings</div>
      {commerce.bookings.map(b => {
        const l = commerce.bookedLoads[b.loadId];
        return (
          <div key={b.id} style={{ ...card, padding:14, marginBottom:8 }}>
            <div style={{ fontSize:15, fontWeight:800, color:C.black, marginBottom:2 }}>{l ? `${l.origin} → ${l.destination}` : b.loadId}</div>
            <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>{l?.cargo} · {b.id} · {b.status}</div>
            <AgreedPriceBlock booking={b} load={l} finance={commerce.finance[b.id]} adjActions={commerce.actions} />
          </div>
        );
      })}
    </div>
  );
}

/* ── ROOT ───────────────────────────────────────────────── */
const LANG_KEY_CARRIER = "behari_lang_carrier";
const I18N_CARRIER = {
  en: { myTruck:"My Truck", find:"Find Loads", myLoads:"My Loads", earnings:"Earnings", account:"Account", history:"History", carrier:"TRANSPORTER APP · KENYA" },
  sw: { myTruck:"Gari Yangu", find:"Tafuta Mzigo", myLoads:"Mizigo Yangu", earnings:"Mapato", account:"Akaunti", history:"Historia", carrier:"APP YA TRANSPORTER · KENYA" },
};

const NAV = [
  { id:1, label:"Find Loads", icon:"⊞" },
  { id:0, label:"My Truck",   icon:"🚛" },
  { id:2, label:"My Loads",   icon:"≡"  },
  { id:3, label:"Earnings",   icon:"◎"  },
  { id:4, label:"Account",    icon:"◯"  },
  { id:5, label:"History",    icon:"⏱"  },
];

export default function BehariFreight({
  postedLoads = [], notifications = [],
  deliveredLoadIds = new Set(), onLogout = ()=>{},
  loadStatuses = {},
  onAcceptLoad=()=>{}, onRejectLoad=()=>{}, onCancelShipment=()=>{},
  onConfirmLoading=()=>{}, onStartTrip=()=>{},
  onMarkBorderCrossing=()=>{}, onMarkDelay=()=>{}, onMarkArrived=()=>{},
  // Step 7: Disputes
  onOpenDispute=()=>{},
  // Step 8: Ratings
  onSubmitRating=()=>{}, onCheckHasRated=()=>false,
  // Step 5: Multi-truck
  bookingSlots={},
  // Legal modal trigger (passed from App.jsx)
  onShowLegal=()=>{},
  // Feature 18: Blacklist
  fraudFlags={},
  // Dark mode (lifted to App.jsx — uniform across all portals)
  darkMode=false, toggleDark=()=>{},
  // Matching engine (Truck ↔ Cargo) — see hooks/useMatching.js
  truckAvailabilities=[], onDeclareAvailability=()=>{}, onFindMatchesForTruck=()=>{}, onAcceptMatch=()=>{},
  matchNotifications=[], onMarkNotificationRead=()=>{},
}) {
  const [tab, setTab]       = useState(1);
  const commerce = useCommerce("fleet_owner");
  const [focusId, setFocusId] = useState(null);
  const [demoToast, setDemoToast] = useState(null);
  const seenBookings = useRef(null);
  useEffect(() => {
    if (!commerce.ready) return;
    const ids = new Set(commerce.bookings.map(b => b.id));
    if (seenBookings.current) {
      const fresh = commerce.bookings.filter(b => !seenBookings.current.has(b.id));
      if (fresh.length) { setDemoToast(`Price agreed: ${ksh(fresh[0].agreedAmount)}. Awaiting shipper payment.`); setTab(2); }
    }
    seenBookings.current = ids;
  }, [commerce.bookings, commerce.ready]);
  function openCargo(load) {
    if (!load.isBackend) { setDemoToast("Demo Load — booking unavailable"); return; }
    setFocusId(load.id); setTab(1);
  }
  function openNotification(n) {
    const offer = commerce.offers.find(o => o.id === n.relatedEntityId);
    const loadId = offer?.loadId ?? commerce.bookings.find(b => b.id === n.relatedEntityId || b.payment?.paymentId === n.relatedEntityId || b.payment?.escrowId === n.relatedEntityId || (commerce.finance[b.id]?.adjustments || []).some(a => a.id === n.relatedEntityId))?.loadId;
    if (loadId && commerce.bookings.some(b => b.loadId === loadId)) { setTab(2); return; }
    if (loadId) { setFocusId(null); setTimeout(() => setFocusId(loadId), 0); setTab(1); }
  }
  // Flow C — "new match found" toast. Checks for any unread notification
  // (not just growth since last render) because this portal fully remounts
  // whenever the carrier switches away and back — a match created while
  // "away" must still surface the next time this portal is open, same as a
  // driver opening the app and seeing they were notified while offline.
  const [matchToast, setMatchToast] = useState(null);
  const shownMatchNotifIds = useRef(new Set());
  useEffect(() => {
    const unread = matchNotifications.filter(n => !n.read && !shownMatchNotifIds.current.has(n.id));
    if (unread.length === 0) return;
    unread.forEach(n => shownMatchNotifIds.current.add(n.id));
    const best = unread.reduce((a, b) => (b.score > a.score ? b : a), unread[0]);
    setMatchToast(
      unread.length > 1
        ? `🔔 ${unread.length} new matches found — best: ${best.message.replace("New match: ", "")}`
        : `🔔 ${best.message}`
    );
    unread.forEach(n => onMarkNotificationRead(n.id));
  }, [matchNotifications]); // eslint-disable-line
  /* Feature 28 — Onboarding walkthrough */
  const TOUR_KEY = "behari_tour_done";
  const [tourStep, setTourStep] = useState(() => {
    try { return localStorage.getItem(TOUR_KEY) ? -1 : 0; } catch { return -1; }
  });
  function tourNext() {
    if (tourStep >= 2) {
      setTourStep(-1);
      try { localStorage.setItem(TOUR_KEY, "1"); } catch {}
    } else {
      setTourStep(s => s + 1);
    }
  }
  function tourSkip() {
    setTourStep(-1);
    try { localStorage.setItem(TOUR_KEY, "1"); } catch {}
  }
  const TOUR_STEPS = [
    { title:"Declare Your Truck 🚛", body:"Tell Behari where your truck is, when it's free, and which way you're heading. We'll find cargo moving that direction — including return loads.", anchor:"bottom" },
    { title:"Find Loads 🔍", body:"Browse available cargo across Kenya. Filter by truck type, route, and pay range.", anchor:"bottom" },
    { title:"My Loads 📋",   body:"Track all your active trips here. Use the GPS button to share your live location with the shipper.", anchor:"bottom" },
    { title:"Get Paid Fast 💸", body:"Complete delivery → Shipper confirms → M-Pesa pays you instantly. Check Earnings for your advance pay option.", anchor:"bottom" },
  ];
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem(LANG_KEY_CARRIER) || "en"; } catch { return "en"; }
  });
  function toggleLang() {
    const next = lang === "en" ? "sw" : "en";
    setLang(next);
    try { localStorage.setItem(LANG_KEY_CARRIER, next); } catch (_) {}
  }
  const tl = I18N_CARRIER[lang];

  // Phase 3C — the marketplace list now comes from the centralized pipeline
  // instead of a separately-authored MARKETPLACE_LOADS array. Bookability is
  // still an explicit rule applied here (not something getAllKnownLoads()
  // decides): only loads with no live booking yet — status "Escrow Held" (or
  // legacy "Open"/undefined for records that never set a status) — should
  // ever be offered for booking. This is what correctly EXCLUDES KE-2041
  // (canonical status "In Transit") from Find Loads even though it's still
  // present in the underlying MARKETPLACE_LOADS array — a case the old code
  // got wrong, since MARKETPLACE_LOADS never tracked status at all and would
  // have shown every one of its 8 loads as bookable regardless of reality.
  const BOOKABLE_STATUSES = new Set(["Open", undefined, null, "Escrow Held"]);
  // 5D-3 — the backend is the only commercial source. Local records are demo
  // listings (browse/maps only); any local record already linked to a backend
  // load is dropped in favour of the backend's canonical copy.
  const demoLoads = getAllKnownLoads()
    .map(l => toCarrierMarketplaceView(l))
    .filter(l => BOOKABLE_STATUSES.has(l.status) && !l.backendLoadId)
    .map(l => ({ ...l, isDemo: true, isBackend: false }));
  const backendLoads = commerce.loads.filter(l => l.status === "Open").map(fromBackendLoad);
  const allLoads = [...backendLoads, ...demoLoads];

  // Matching engine cargo pool — adds the deliberately-crafted, deliberately
  // SEPARATE matching demo cargo (network.js) on top of the canonical
  // bookable marketplace, so "Matches for Your Truck" has exact/along-route/
  // detour/partial scenarios to find. DEMO_MATCH_CARGO is synthetic cargo,
  // not real load identities, so it is not part of SEED_LOADS.
  const matchCargoPool = [...allLoads, ...DEMO_MATCH_CARGO.map(l => ({
    ...l, status: loadStatuses[l.id] ?? l.status, isDemo: true, isBackend: false,
  }))].filter(l => BOOKABLE_STATUSES.has(l.status) || l.status === undefined);

  // Phase 3C — "my trips" replaces the old myBookedLoads (postedLoads-only)
  // + MY_TRIPS_SEED (hardcoded) split. A trip belongs to this carrier
  // (demo identity "James Mwangi") if either a live booking notification
  // exists for it, or the canonical record's own driver field already says
  // so (KE-2037/2039 — KE-2038's canonical driver was corrected to Samuel
  // Kamau in Phase 1, so it correctly no longer appears here; see the
  // Phase 3C test notes). KE-2041 (canonical driver: James Mwangi, status:
  // In Transit) now correctly appears as an active trip here too, which the
  // old MY_TRIPS_SEED-based list never did.
  const MY_CARRIER_NAME = "James Mwangi";
  const myTrips = getAllKnownLoads()
    .map(l => toCarrierTripView(l, notifications))
    .filter(l => l.driver === MY_CARRIER_NAME || notifications.some(n => n.loadId === l.id));

  // Plates of trucks currently on an active (non-terminal) trip — used to
  // compute live truck availability rather than relying on the static fleet seed.
  const ACTIVE_TRIP_STATUSES = new Set(["Accepted","Loading","In Transit","Arrived","Delivery Confirmed"]);
  const activePlates = new Set(
    myTrips
      .filter(l => ACTIVE_TRIP_STATUSES.has(l.status))
      .map(l => l.plate)
      .filter(Boolean)
  );

  return (
    <div style={{ background:C.bg, minHeight:"100vh", fontFamily:font, color:C.black, paddingBottom:68 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{display:none}
        input::placeholder{color:#9E9E9E}
        button:active{opacity:0.82}
      `}</style>

      {/* App bar */}
      <div style={{ background:C.white,borderBottom:`1px solid ${C.border}`,padding:"0 16px",position:"sticky",top:0,zIndex:100 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",height:52 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <div style={{ width:5,height:22,background:C.green,borderRadius:3 }} />
            <div>
              <div style={{ fontSize:15,fontWeight:800,color:C.black,letterSpacing:-0.3 }}>Behari Freight</div>
              <div style={{ fontSize:10,color:C.muted,fontWeight:600,letterSpacing:0.5 }}>{tl.carrier}</div>
            </div>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <button onClick={toggleLang} style={{ background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font,color:C.secondary }}>
              {lang === "en" ? "🇰🇪 SW" : "🇬🇧 EN"}
            </button>
            {/* Dark mode toggle — near bell */}
            <button onClick={toggleDark} title={darkMode?"Switch to light mode":"Switch to dark mode"} style={{ background:"none",border:`1px solid transparent`,borderRadius:8,width:36,height:36,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18,flexShrink:0 }}>
              {darkMode ? "☀️" : "🌙"}
            </button>
            <CommerceBell notifications={commerce.notifications} onOpen={openNotification} onMarkRead={commerce.markRead} />
            <div onClick={onLogout} style={{ width:34,height:34,borderRadius:"50%",background:C.black,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,color:C.white,cursor:"pointer" }} title="Account / Sign out">{(commerce.identity?.name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase()}</div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div>
        {tab===0 && <MyTruck allLoads={matchCargoPool} truckAvailabilities={truckAvailabilities} onDeclareAvailability={onDeclareAvailability} onFindMatchesForTruck={onFindMatchesForTruck} onAcceptMatch={onAcceptMatch} onBook={openCargo} />}
        {tab===1 && <FindLoads commerce={commerce} focusId={focusId} allLoads={allLoads} />}
        {tab===2 && <BackendBookings commerce={commerce} />}
        {tab===2 && <MyLoads myTrips={myTrips}
          onAcceptLoad={onAcceptLoad} onRejectLoad={onRejectLoad} onCancelShipment={onCancelShipment}
          onConfirmLoading={onConfirmLoading} onStartTrip={onStartTrip}
          onMarkBorderCrossing={onMarkBorderCrossing} onMarkDelay={onMarkDelay} onMarkArrived={onMarkArrived}
          onOpenDispute={onOpenDispute} onSubmitRating={onSubmitRating} onCheckHasRated={onCheckHasRated}
        />}
        {tab===3 && <Earnings myTrips={myTrips} />}
        {tab===4 && <Account onLogout={onLogout} onShowLegal={onShowLegal} darkMode={darkMode} toggleDark={toggleDark} />}
        {tab===5 && <TripHistoryTab myTrips={myTrips} />}
      </div>

      {/* Carrier notifications panel */}

      {/* Feature 28 — Onboarding tour overlay */}
      {tourStep >= 0 && tourStep < TOUR_STEPS.length && (
        <div style={{ position:"fixed",inset:0,zIndex:9990,pointerEvents:"none" }}>
          {/* Dim overlay */}
          <div style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.6)" }} />
          {/* Tooltip card — appears above bottom nav */}
          <div style={{ position:"absolute",bottom:80,left:16,right:16,background:C.white,borderRadius:14,padding:"20px 18px",pointerEvents:"all",boxShadow:"0 12px 40px rgba(0,0,0,0.3)" }}>
            {/* Step dots */}
            <div style={{ display:"flex",gap:5,marginBottom:14,justifyContent:"center" }}>
              {TOUR_STEPS.map((_,i)=>(
                <div key={i} style={{ width:i===tourStep?20:6,height:6,borderRadius:3,background:i===tourStep?C.black:C.border,transition:"width .2s" }} />
              ))}
            </div>
            <div style={{ fontSize:18,fontWeight:800,color:C.black,marginBottom:6 }}>{TOUR_STEPS[tourStep].title}</div>
            <div style={{ fontSize:13,color:C.secondary,lineHeight:1.65,marginBottom:16 }}>{TOUR_STEPS[tourStep].body}</div>
            <div style={{ display:"flex",gap:8 }}>
              <button onClick={tourSkip} style={{ flex:1,background:C.bg,color:C.secondary,border:`1px solid ${C.border}`,borderRadius:8,padding:"11px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font }}>Skip tour</button>
              <button onClick={()=>{ setTab(tourStep); tourNext(); }} style={{ flex:2,background:C.black,color:C.white,border:"none",borderRadius:8,padding:"11px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font }}>
                {tourStep < TOUR_STEPS.length - 1 ? "Next →" : "Get started! →"}
              </button>
            </div>
          </div>
          {/* Step indicator arrow pointing to highlighted tab */}
          <div style={{ position:"absolute",bottom:68,left:`${8 + tourStep * 17}%`,transform:"translateX(-50%)",fontSize:20,animation:"pulse 1s infinite" }}>▼</div>
        </div>
      )}

      {/* Bottom tab bar */}
      <div style={{ position:"fixed",bottom:0,left:0,right:0,background:C.white,borderTop:`1px solid ${C.border}`,display:"flex",zIndex:200 }}>
        {NAV.map(n => {
          const navLabel = [tl.myTruck,tl.find,tl.myLoads,tl.earnings,tl.account,tl.history][n.id] || n.label;
          return (
            <button key={n.id} onClick={()=>setTab(n.id)} style={{
              flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2,
              padding:"10px 4px 12px",background:"none",border:"none",cursor:"pointer",fontFamily:font
            }}>
              <span style={{ fontSize:20,lineHeight:1 }}>{n.icon}</span>
              <span style={{ fontSize:10,fontWeight:tab===n.id?700:500,color:tab===n.id?C.black:C.muted,letterSpacing:0.2 }}>{navLabel}</span>
              {tab===n.id && <div style={{ width:18,height:2.5,background:C.black,borderRadius:2,marginTop:1 }} />}
            </button>
          );
        })}
      </div>

      {demoToast && <Toast message={demoToast} onDone={()=>setDemoToast(null)} />}
      {matchToast && <Toast message={matchToast} onDone={()=>setMatchToast(null)} />}
    </div>
  );
}

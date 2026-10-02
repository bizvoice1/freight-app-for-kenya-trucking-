import { useState, useEffect, useRef, useCallback } from "react";
const TRUCK_FILTERS = ["All", "Flatbed", "Reefer", "Lowbed", "Box Truck", "Open Truck", "Tipper"];
import { sortNewestFirst, distLabel, decodePolyline, metersToKm } from "./src/models/geo.js";
import { fetchBackendLoad } from "./src/services/routeApi.js";
import { useCommerce } from "./src/hooks/useCommerce.js";
import { fromBackendLoad, ksh } from "./src/models/backendLoad.js";
import { MakeOfferForm, OfferThread, AgreedPriceBlock, CommerceBell } from "./src/components/negotiation/negotiation.jsx";
import GoogleMap from "./src/components/maps/GoogleMap.jsx";
import { hasMapsKey } from "./src/services/googleMaps.js";
// Step 6: GPS simulation engine
import { buildTripSnapshot } from "./src/services/gpsService.js";
// Step 8: Rating dimensions
import { CARRIER_RATING_DIMS, SHIPPER_RATING_DIMS } from "./src/models/rating.js";
// Phase 4G.3 — Transporter/Fleet tracking. fleetService.js (Phase 4B) has
// never been wired into this portal's UI before now — CARRIER_FLEET above
// is the legacy display-only list (see src/data/fleetSeed.js's own note on
// the two disconnected fleet representations); this is the real
// Truck/Driver assignment layer, with live GPS layered on top of it here.
import { getTrucks, getDrivers, addTruck, addDriver, pairDriver } from "./src/services/fleetService.js";
import { TRUCK_TYPES } from "./src/data/reference.js";
import { assignBooking, createTripForBooking } from "./src/services/marketplaceService.js";
import { useLiveTripByTruckId, useTripList } from "./src/hooks/useLiveTrip.js";
import { ACTIVE_TRIP_STATUSES, TERMINAL_TRIP_STATUSES } from "./src/models/trip.js";
import TripTrackingModal from "./src/components/tracking/TripTrackingModal.jsx";
import NotLive from "./src/components/NotLive.jsx";
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

          {load.isBackend ? <CargoCommerce load={load} commerce={commerce} /> : null}
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


/* ── ACTION MINI-MODAL ───────────────────────────────────── */

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




/* ── EARNINGS ───────────────────────────────────────────── */
function Earnings({ bookings = [] }) {
  // 5P-2: backend truth only — settled escrows (money actually paid out).
  const paid = bookings.filter(b => b.payment?.escrowStatus === "Settled");
  const total = paid.reduce((s, b) => s + (b.agreedAmount || 0), 0);
  return (
    <div style={{ padding:12 }}>
      <div style={{ background:C.black,borderRadius:12,padding:"20px 16px",marginBottom:12 }}>
        <div style={{ fontSize:11,color:"rgba(255,255,255,0.45)",fontWeight:700,letterSpacing:1,marginBottom:4 }}>EARNINGS</div>
        <div style={{ fontSize:38,fontWeight:800,color:C.white,letterSpacing:-1 }}>KSh {total.toLocaleString()}</div>
        <div style={{ fontSize:13,color:C.green,marginTop:6,fontWeight:600 }}>{paid.length} trip{paid.length!==1?"s":""} paid out</div>
      </div>
      {paid.length === 0 && (
        <div style={{ textAlign:"center",padding:"32px 20px",fontSize:13,color:C.muted }}>No payouts yet. Completed, settled trips appear here.</div>
      )}
      {paid.map(b => (
        <div key={b.id} style={{ background:C.greenBg,border:`1px solid ${C.green}`,borderRadius:10,padding:"12px 14px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <div style={{ fontSize:13,fontWeight:700,color:C.black }}>Booking {b.id}</div>
          <div style={{ fontSize:18,fontWeight:800,color:C.green }}>+KSh {(b.agreedAmount||0).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

/* ── ACCOUNT ────────────────────────────────────────────── */
function Account({ onLogout = ()=>{}, onShowLegal = ()=>{}, darkMode = false, toggleDark = ()=>{}, identity = null }) {
  const name = identity?.name || "—";
  const initials = (identity?.name || "?").split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();

  return (
    <div style={{ padding:12 }}>
      <div style={{ ...card,padding:20,marginBottom:12,display:"flex",alignItems:"center",gap:16 }}>
        <div style={{ width:56,height:56,borderRadius:"50%",background:C.black,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,color:C.white,fontWeight:800,flexShrink:0 }}>{initials}</div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:18,fontWeight:700,color:C.black }}>{name}</div>
          {identity?.company && <div style={{ fontSize:13,color:C.secondary }}>{identity.company}</div>}
          <div style={{ fontSize:13,color:C.muted }}>{identity?.phone || ""}</div>
        </div>
        <Pill color={C.muted} bg={C.bg}>{identity?.phoneVerified ? "Phone verified" : "Not verified"}</Pill>
      </div>

      <div style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Planned modules</div>
      {PLANNED_MODULES.map(m => <NotLive key={m.title} compact icon={m.icon} title={m.title} body={m.body} />)}
      <div style={{ height:4 }} />

      <div style={{ ...card,overflow:"hidden" }}>
        {[
          { label:"Privacy & Legal",  action:()=>onShowLegal("privacy") },
          { label:"Terms of Service", action:()=>onShowLegal("terms") },
          { label:"Sign Out",         action:onLogout },
        ].map(({ label, action }, i, a) => (
          <div key={label} onClick={action} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"15px 16px",borderBottom:`1px solid ${C.border}`,cursor:"pointer" }}>
            <span style={{ fontSize:14,fontWeight:600,color:label==="Sign Out"?C.red:C.black }}>{label}</span>
            {label!=="Sign Out" && <span style={{ color:C.muted,fontSize:18 }}>›</span>}
          </div>
        ))}
        <div onClick={toggleDark} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"15px 16px",cursor:"pointer" }}>
          <span style={{ fontSize:14,fontWeight:600,color:C.black }}>{darkMode?"☀ Light Mode":"🌙 Dark Mode"}</span>
          <div style={{ width:42,height:24,borderRadius:12,background:darkMode?C.black:C.border,position:"relative",flexShrink:0,transition:"background .2s" }}>
            <div style={{ width:18,height:18,borderRadius:"50%",background:C.white,position:"absolute",top:3,left:darkMode?21:3,transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.2)" }} />
          </div>
        </div>
      </div>
    </div>
  );
}

const PLANNED_MODULES = [
  { icon:"🪪", title:"KYC & documents",      body:"Identity, licence and vehicle document verification will live here." },
  { icon:"🛡️", title:"Cargo insurance",      body:"Optional cover for loads you carry." },
  { icon:"💬", title:"Chat",                  body:"Message shippers and drivers inside a booking." },
  { icon:"🆘", title:"Breakdown / SOS",       body:"Report a breakdown or emergency from the road." },
  { icon:"⚡", title:"Advance pay",           body:"Request part of a payout before delivery." },
  { icon:"⭐", title:"Ratings",               body:"Shipper and transporter ratings after delivery." },
  { icon:"⚖️", title:"Disputes",              body:"Raise and track a dispute on a booking." },
];

const TRIP_ORDER = ["Assigned","Dispatched","At Pickup","Loading","In Transit","At Delivery","Delivered"];
const tripProgress = (st) => st === "Cancelled" ? 0 : Math.round(((TRIP_ORDER.indexOf(st) + 1) / TRIP_ORDER.length) * 100);

/** Fleet management: backend trucks/drivers only. */
function MyTruckTab() {
  const [trucks, setTrucks]   = useState(null);
  const [drivers, setDrivers] = useState(null);
  const reloadFleet = useCallback(() => Promise.all([getTrucks().then(setTrucks), getDrivers().then(setDrivers)]), []);
  useEffect(() => { reloadFleet(); }, [reloadFleet]);
  return (
    <div style={{ padding:12 }}>
      <NotLive icon="🧭" title="Cargo Matching" body="Behari will automatically match available trucks with suitable cargo along their routes." />
      <div style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>
        My Trucks ({(trucks || []).length} truck{(trucks || []).length!==1?"s":""})
      </div>
      <div style={{ ...card,overflow:"hidden",marginBottom:12 }}>
        {trucks && trucks.length === 0 && (
          <div style={{ padding:"24px 16px",textAlign:"center" }}>
            <div style={{ fontSize:32,marginBottom:8 }}>🚛</div>
            <div style={{ fontSize:14,fontWeight:700,color:C.secondary,marginBottom:4 }}>No trucks yet.</div>
            <div style={{ fontSize:12,color:C.muted }}>Add your first truck to start taking loads.</div>
          </div>
        )}
        <div style={{ padding:(trucks||[]).length?8:0 }}>
          {(trucks || []).map(t => (
            <MyFleetTruckRow key={t.id} truck={t} driverName={(drivers || []).find(d => d.id === t.currentDriverId)?.name || null}
              drivers={drivers || []} onPair={async (driverId) => { const r = await pairDriver(t.id, driverId); await reloadFleet(); return r; }} />
          ))}
        </div>
        <AddTruckForm onAdded={reloadFleet} />
      </div>
      <div style={{ fontSize:11,fontWeight:700,color:C.secondary,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Drivers ({(drivers || []).length})</div>
      <div style={{ ...card,overflow:"hidden",marginBottom:12 }}>
        {drivers && drivers.length === 0 && (
          <div style={{ padding:"20px 16px",textAlign:"center",fontSize:13,color:C.muted }}>No drivers yet.</div>
        )}
        {(drivers || []).map((d, i, a) => (
          <div key={d.id} style={{ display:"flex",justifyContent:"space-between",padding:"14px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
            <div>
              <div style={{ fontSize:14,fontWeight:600,color:C.black }}>{d.name}</div>
              <div style={{ fontSize:11,color:C.muted }}>{d.phone}{d.assignedTruckId ? ` · ${(trucks||[]).find(t=>t.id===d.assignedTruckId)?.plate || ""}` : " · no truck"}</div>
            </div>
            <span style={{ fontSize:11,fontWeight:700,color:C.secondary }}>{d.status}</span>
          </div>
        ))}
        <AddDriverForm trucks={trucks || []} onAdded={reloadFleet} />
      </div>

    </div>
  );
}

/** One backend trip, with status + progress and a Track button. */
function TripCard({ trip, trucks, drivers, onTrack, load }) {
  const truck = trucks.find(t => t.id === trip.truckId);
  const driver = drivers.find(d => d.id === trip.driverId);
  const pct = tripProgress(trip.status);
  const cancelled = trip.status === "Cancelled";
  return (
    <div style={{ ...card, padding:14, marginBottom:8 }} data-testid={`trip-${trip.id}`}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:800, color:C.black }}>{trip.pickup} → {trip.delivery}</div>
          <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>{load?.cargo ? `${load.cargo} · ` : ""}{trip.id} · {truck?.plate || trip.truckId}{driver ? ` · ${driver.name}` : ""}</div>
        </div>
        <Pill color={cancelled ? C.red : trip.status === "Delivered" ? C.green : C.blue} bg={C.bg}>{trip.status}</Pill>
      </div>
      {!cancelled && (
        <div style={{ height:6, borderRadius:3, background:C.border, margin:"12px 0 4px", overflow:"hidden" }}>
          <div style={{ width:`${pct}%`, height:"100%", background:C.green }} />
        </div>
      )}
      {onTrack && (
        <button onClick={() => onTrack(trip)} data-testid={`track-${trip.id}`}
          style={{ marginTop:8, width:"100%", padding:10, borderRadius:8, border:"none", background:C.black, color:C.white, fontWeight:700, fontFamily:font, cursor:"pointer" }}>
          Track live
        </button>
      )}
    </div>
  );
}

function useFleetLookups() {
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  useEffect(() => { getTrucks().then(setTrucks).catch(()=>{}); getDrivers().then(setDrivers).catch(()=>{}); }, []);
  return { trucks, drivers };
}

function TripsSection({ commerce, mode }) {
  const { trips, loading, error } = useTripList("fleet_owner");
  const { trucks, drivers } = useFleetLookups();
  const [tracking, setTracking] = useState(null);
  const active = mode === "history"
    ? trips.filter(t => TERMINAL_TRIP_STATUSES.has(t.status))
    : trips.filter(t => ACTIVE_TRIP_STATUSES.has(t.status));
  const trackedTruck = tracking && trucks.find(t => t.id === tracking.truckId);
  const trackedDriver = tracking && drivers.find(d => d.id === tracking.driverId);
  return (
    <div style={{ padding:"12px 12px 0" }} data-testid={mode === "history" ? "trip-history" : "active-trips"}>
      <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:0.8, textTransform:"uppercase", marginBottom:8 }}>{mode === "history" ? "Completed & past trips" : "Active trips"}</div>
      {error && <div style={{ fontSize:12, color:C.red, marginBottom:8 }}>Could not load trips: {error}</div>}
      {!loading && !error && active.length === 0 && (
        <div style={{ ...card, padding:"24px 16px", textAlign:"center", fontSize:13, color:C.muted, marginBottom:8 }}>
          {mode === "history" ? "No completed trips yet." : "No active trips. Assign a truck to an agreed booking and create the trip."}
        </div>
      )}
      {active.map(t => (
        <TripCard key={t.id} trip={t} trucks={trucks} drivers={drivers} load={commerce.bookedLoads[t.loadId]}
          onTrack={mode === "history" ? null : setTracking} />
      ))}
      {tracking && (
        <TripTrackingModal trip={tracking} role="fleet_owner" truckPlate={trackedTruck?.plate} driverName={trackedDriver?.name} onClose={() => setTracking(null)} />
      )}
    </div>
  );
}

function MyLoadsTab({ commerce }) {
  return (<><TripsSection commerce={commerce} mode="active" /><BackendBookings commerce={commerce} /></>);
}

/* ── 5P-3 fleet forms: every write goes to the backend; the list is re-read afterwards ── */
const fieldStyle = { width:"100%", boxSizing:"border-box", padding:"10px 12px", borderRadius:8, border:`1px solid ${C.border}`, fontFamily:font, fontSize:14, marginBottom:8, background:C.white, color:C.black };
function AddTruckForm({ onAdded }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ plate:"", truckType:TRUCK_TYPES[0], capacity:"" });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  if (!open) return <div onClick={() => setOpen(true)} data-testid="add-truck-open" style={{ padding:"14px 16px", fontSize:14, fontWeight:700, color:C.blue, cursor:"pointer", borderTop:`1px solid ${C.border}` }}>+ Add Truck</div>;
  const submit = async () => {
    setBusy(true); setErr("");
    const r = await addTruck(f);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setF({ plate:"", truckType:TRUCK_TYPES[0], capacity:"" }); setOpen(false); onAdded();
  };
  return (
    <div style={{ padding:14, borderTop:`1px solid ${C.border}` }} data-testid="add-truck-form">
      <input style={fieldStyle} placeholder="Number plate, e.g. KDJ 441Z" value={f.plate} onChange={e => setF({ ...f, plate:e.target.value })} />
      <select style={fieldStyle} value={f.truckType} onChange={e => setF({ ...f, truckType:e.target.value })}>{TRUCK_TYPES.map(t => <option key={t}>{t}</option>)}</select>
      <input style={fieldStyle} placeholder="Capacity (optional), e.g. 10 tonnes" value={f.capacity} onChange={e => setF({ ...f, capacity:e.target.value })} />
      {err && <div style={{ color:C.red, fontSize:12, marginBottom:8 }}>{err}</div>}
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={submit} disabled={busy} style={{ flex:1, padding:12, borderRadius:8, border:"none", background:C.black, color:C.white, fontWeight:700, fontFamily:font, cursor:"pointer" }}>{busy ? "Saving…" : "Save Truck"}</button>
        <button onClick={() => { setOpen(false); setErr(""); }} style={{ padding:12, borderRadius:8, border:`1px solid ${C.border}`, background:"none", fontFamily:font, cursor:"pointer", color:C.secondary }}>Cancel</button>
      </div>
    </div>
  );
}

function AddDriverForm({ trucks, onAdded }) {
  const [open, setOpen] = useState(false);
  const blank = { name:"", phone:"", pin:"", licenseNumber:"", truckId:"" };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState(""); const [done, setDone] = useState(""); const [busy, setBusy] = useState(false);
  if (!open) return (
    <div>
      {done && <div style={{ padding:"10px 16px", fontSize:12, color:C.green, borderTop:`1px solid ${C.border}` }}>{done}</div>}
      <div onClick={() => { setOpen(true); setDone(""); }} data-testid="add-driver-open" style={{ padding:"14px 16px", fontSize:14, fontWeight:700, color:C.blue, cursor:"pointer", borderTop:`1px solid ${C.border}` }}>+ Add Driver</div>
    </div>
  );
  const submit = async () => {
    setBusy(true); setErr("");
    const r = await addDriver(f);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setDone(`${r.data.name} can now sign in to Driver Tracker with phone ${r.data.phone} and the PIN you set.`);
    setF(blank); setOpen(false); onAdded();
  };
  return (
    <div style={{ padding:14, borderTop:`1px solid ${C.border}` }} data-testid="add-driver-form">
      <input style={fieldStyle} placeholder="Driver full name" value={f.name} onChange={e => setF({ ...f, name:e.target.value })} />
      <input style={fieldStyle} placeholder="Driver phone (their login), 07XXXXXXXX" inputMode="tel" value={f.phone} onChange={e => setF({ ...f, phone:e.target.value })} />
      <input style={fieldStyle} placeholder="Initial PIN (4-6 digits)" type="password" inputMode="numeric" value={f.pin} onChange={e => setF({ ...f, pin:e.target.value })} />
      <input style={fieldStyle} placeholder="Licence number (optional)" value={f.licenseNumber} onChange={e => setF({ ...f, licenseNumber:e.target.value })} />
      <select style={fieldStyle} value={f.truckId} onChange={e => setF({ ...f, truckId:e.target.value })}>
        <option value="">Don't assign a truck yet</option>
        {trucks.map(t => <option key={t.id} value={t.id}>{t.plate} ({t.truckType})</option>)}
      </select>
      {err && <div style={{ color:C.red, fontSize:12, marginBottom:8 }}>{err}</div>}
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={submit} disabled={busy} style={{ flex:1, padding:12, borderRadius:8, border:"none", background:C.black, color:C.white, fontWeight:700, fontFamily:font, cursor:"pointer" }}>{busy ? "Saving…" : "Create Driver + Login"}</button>
        <button onClick={() => { setOpen(false); setErr(""); }} style={{ padding:12, borderRadius:8, border:`1px solid ${C.border}`, background:"none", fontFamily:font, cursor:"pointer", color:C.secondary }}>Cancel</button>
      </div>
    </div>
  );
}

/* ── GPS TRIP MODAL (Step 6) ────────────────────────────── */

/* ── RATING MODAL (Step 8) ───────────────────────────────── */

/* ── DISPUTE OPEN MODAL (Step 7) ─────────────────────────── */

/* ── ADVANCE PAY MODAL ──────────────────────────────────── */

/* ── CARRIER PUBLIC PROFILE ─────────────────────────────── */

/* ── BREAKDOWN MODAL (Feature 20) ───────────────────────── */

/* ── CARGO INSURANCE MODAL (Feature 12) ─────────────────── */

/* ── TRIP HISTORY TAB (Feature 16) ─────────────────────── */

/* ── MY TRUCK — Declare Availability + Matches For Your Truck ───────────── *
 * This is the carrier's new first-experience tab. It replaces "browse a
 * marketplace" with "tell Behari where you are, and Behari finds cargo" —
 * the central Truck ↔ Cargo matching workflow (Flow A in the product spec).
 */


/** Phase 4G.3 — one truck row; expands to live GPS if it has an active backend trip. */
function MyFleetTruckRow({ truck, driverName, drivers = [], onPair = async () => ({}) }) {
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
          <div style={{ fontSize:11, color:C.secondary, marginTop:2 }}>{truck.truckType}{truck.capacity ? ` · ${truck.capacity}` : ""}</div>
          <div style={{ fontSize:11, color:driverName ? C.secondary : C.muted, marginTop:2 }}>{driverName ? `Driver: ${driverName}` : "No driver assigned"}</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <span style={{ fontSize:11, fontWeight:700, color:statusColor }}>{truck.status}</span>
          {live.trip && <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>{expanded ? "▲ hide" : "▼ live"}</div>}
        </div>
      </div>
      {drivers.length > 0 && !live.trip && (
        <select value={truck.currentDriverId || ""} onChange={e => onPair(e.target.value || null)} data-testid={`pair-${truck.id}`}
          style={{ marginTop:8, width:"100%", padding:"8px 10px", borderRadius:8, border:`1px solid ${C.border}`, fontFamily:font, fontSize:12, background:C.white, color:C.black }}>
          <option value="">No driver</option>
          {drivers.map(d => <option key={d.id} value={d.id}>{d.name}{d.assignedTruckId && d.assignedTruckId !== truck.id ? " (on another truck)" : ""}</option>)}
        </select>
      )}
      {expanded && live.trip && (
        <div style={{ marginTop:10 }}>
          <LiveTrackingPanel {...live} truckPlate={truck.plate} compact={false} />
        </div>
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
            <AssignTripPanel booking={b} onChanged={commerce.refresh} />
          </div>
        );
      })}
    </div>
  );
}

/* ── 5P-3: assign a real truck + its driver to a booking, then create the Trip (backend state machine) ── */
function AssignTripPanel({ booking, onChanged }) {
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [truckId, setTruckId] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const status = booking.status;
  useEffect(() => {
    if (status !== "Accepted") return;
    Promise.all([getTrucks(), getDrivers()]).then(([t, d]) => { setTrucks(t); setDrivers(d); });
  }, [status]);
  const run = async (fn) => {
    setBusy(true); setErr("");
    try { await fn(); await onChanged(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const ready = trucks.filter(t => t.currentDriverId && drivers.some(d => d.id === t.currentDriverId));
  const funded = booking.payment?.escrowStatus === "Held";
  const box = { marginTop:12, paddingTop:12, borderTop:`1px solid ${C.border}` };
  if (status === "Accepted") return (
    <div style={box} data-testid="assign-panel">
      <div style={{ fontSize:11, fontWeight:700, color:C.secondary, letterSpacing:0.8, textTransform:"uppercase", marginBottom:6 }}>Assign truck & driver</div>
      {ready.length === 0 ? (
        <div style={{ fontSize:12, color:C.muted }}>You need a truck with a driver assigned. Add them in the My Truck tab.</div>
      ) : (
        <>
          <select value={truckId} onChange={e => setTruckId(e.target.value)} style={fieldStyle} data-testid="assign-truck">
            <option value="">Choose truck…</option>
            {ready.map(t => <option key={t.id} value={t.id}>{t.plate} — {drivers.find(d => d.id === t.currentDriverId)?.name}</option>)}
          </select>
          <button disabled={!truckId || busy} data-testid="assign-btn"
            onClick={() => run(() => assignBooking(booking.id, { truckId, driverId: ready.find(t => t.id === truckId).currentDriverId }))}
            style={{ width:"100%", padding:12, borderRadius:8, border:"none", background:truckId ? C.black : C.border, color:C.white, fontWeight:700, fontFamily:font, cursor:"pointer" }}>
            {busy ? "Assigning…" : "Assign"}
          </button>
        </>
      )}
      {err && <div style={{ color:C.red, fontSize:12, marginTop:6 }}>{err}</div>}
    </div>
  );
  if (status === "Assigned") return (
    <div style={box} data-testid="trip-panel">
      <div style={{ fontSize:12, color:C.secondary, marginBottom:8 }}>Truck and driver assigned. {funded ? "Escrow is funded." : "Waiting for the shipper to fund escrow before the trip can start."}</div>
      <button disabled={!funded || busy} data-testid="create-trip-btn" onClick={() => run(() => createTripForBooking(booking.id))}
        style={{ width:"100%", padding:12, borderRadius:8, border:"none", background:funded ? C.black : C.border, color:C.white, fontWeight:700, fontFamily:font, cursor:"pointer" }}>
        {busy ? "Creating…" : "Create Trip"}
      </button>
      {err && <div style={{ color:C.red, fontSize:12, marginTop:6 }}>{err}</div>}
    </div>
  );
  return null;
}

/* ── ROOT ───────────────────────────────────────────────── */
const LANG_KEY_CARRIER = "behari_lang_carrier";
const I18N_CARRIER = {
  en: { myTruck:"My Truck", find:"Find Loads", myLoads:"My Loads", earnings:"Earnings", account:"Account", history:"History", carrier:"TRANSPORTER APP · KENYA" },
  sw: { myTruck:"Gari Yangu", find:"Tafuta Mzigo", myLoads:"Mizigo Yangu", earnings:"Mapato", account:"Akaunti", history:"Historia", carrier:"APP YA TRANSPORTER · KENYA" },
};

const NAV = [
  { id:0, label:"My Truck",   icon:"🚛" },
  { id:1, label:"Find Loads", icon:"⊞" },
  { id:2, label:"My Loads",   icon:"≡"  },
  { id:5, label:"History",    icon:"↺"  },
  { id:3, label:"Earnings",   icon:"◎"  },
  { id:4, label:"Account",    icon:"◯"  },
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
    setFocusId(load.id); setTab(1);
  }
  function openNotification(n) {
    const offer = commerce.offers.find(o => o.id === n.relatedEntityId);
    const loadId = offer?.loadId ?? commerce.bookings.find(b => b.id === n.relatedEntityId || b.payment?.paymentId === n.relatedEntityId || b.payment?.escrowId === n.relatedEntityId || (commerce.finance[b.id]?.adjustments || []).some(a => a.id === n.relatedEntityId))?.loadId;
    if (loadId && commerce.bookings.some(b => b.loadId === loadId)) { setTab(2); return; }
    if (loadId) { setFocusId(null); setTimeout(() => setFocusId(loadId), 0); setTab(1); }
  }
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
    { title:"Find Loads 🔍", body:"Browse available cargo across Kenya. Filter by truck type, route, and pay range.", anchor:"bottom" },
    { title:"My Loads 📋",   body:"Track all your active trips here. Use the GPS button to share your live location with the shipper.", anchor:"bottom" },
    { title:"Get Paid Fast 💸", body:"Complete delivery → Shipper confirms → M-Pesa pays you instantly. Check Earnings for your payouts.", anchor:"bottom" },
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
  // 5P-2: the backend is the only source. No seeded/demo loads, no local trips.
  const backendLoads = commerce.loads.filter(l => l.status === "Open").map(fromBackendLoad);
  const allLoads = backendLoads;

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
        {tab===1 && <FindLoads commerce={commerce} focusId={focusId} allLoads={allLoads} />}
        {tab===0 && <MyTruckTab />}
        {tab===2 && <MyLoadsTab commerce={commerce} />}
        {tab===5 && <TripsSection commerce={commerce} mode="history" />}
        {tab===3 && <Earnings bookings={commerce.bookings} />}
        {tab===4 && <Account onLogout={onLogout} onShowLegal={onShowLegal} darkMode={darkMode} toggleDark={toggleDark} identity={commerce.identity} />}
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
              <button onClick={()=>{ setTab([1,2,3][tourStep] ?? 1); tourNext(); }} style={{ flex:2,background:C.black,color:C.white,border:"none",borderRadius:8,padding:"11px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font }}>
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
    </div>
  );
}

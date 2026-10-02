import { useState, useEffect, lazy, Suspense } from "react";
import AuthModal from "./components/AuthModal.jsx";
import * as session from "./services/session.js";
import { useLoads } from "./hooks/useLoads.js";
import { FreightContext } from "./context/FreightContext.jsx";
import { COLORS as C, FONT as font } from "./constants/theme.js";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { getAllKnownLoads } from "./services/loadViews.js";

// Code-split portals: each bundle loads only when its tab is first opened.
const BehariFreight = lazy(() => import("../behari-freight-v2.jsx"));
const BehariAdmin   = lazy(() => import("../behari-admin-v2.jsx"));
const BehariShipper = lazy(() => import("../behari-shipper-v2.jsx"));
// Phase 4E — the Driver Tracking surface. Deliberately separate from the
// Carrier portal above: this is the truck DRIVER's own device, which may
// not be the fleet owner at all (see models/fleetOwner.js's whole reason
// for existing). One job only: start/stop location sharing for a trip.
const BehariDriverTracker = lazy(() => import("../behari-driver-tracker.jsx"));
// Phase 4H — the real Load/Booking/Trip marketplace, backed by backend/.
// Standalone, same precedent as the Driver Tracker: new backend-connected
// capability, not a rewrite of the existing escrow-simulated demo flows.
const BehariMarketplace = lazy(() => import("../behari-marketplace.jsx"));


function useWindowWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

/* ── About Modal ───────────────────────────────────────────── */
function AboutModal({ onClose }) {
  const isMobile = useWindowWidth() < 480;
  return (
    <div style={{ position:"fixed",inset:0,zIndex:9999,overflowY:"auto",fontFamily:font }}>
      {/* Close bar */}
      <div style={{ position:"sticky",top:0,zIndex:10,background:"rgba(0,0,0,0.92)",backdropFilter:"blur(8px)",borderBottom:"1px solid #222",padding:"0 24px",height:56,display:"flex",alignItems:"center",justifyContent:"space-between" }}>
        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
          <div style={{ width:4,height:18,background:C.green,borderRadius:3 }} />
          <span style={{ fontSize:14,fontWeight:800,color:C.white }}>Behari Freight</span>
        </div>
        <button onClick={onClose} style={{ background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,padding:"6px 14px",fontSize:13,fontWeight:700,color:C.white,cursor:"pointer",fontFamily:font }}>✕ Close</button>
      </div>

      {/* Hero */}
      <div style={{ background:"#000",padding:"72px 24px 64px",textAlign:"center" }}>
        <div style={{ display:"inline-flex",alignItems:"center",gap:8,background:"#111",border:"1px solid #2a2a2a",borderRadius:100,padding:"6px 18px",marginBottom:28 }}>
          <div style={{ width:7,height:7,borderRadius:"50%",background:C.green }} />
          <span style={{ fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.6)",letterSpacing:0.8 }}>EST. NAIROBI, 2024</span>
        </div>
        <h1 style={{ fontSize:isMobile?28:42,fontWeight:900,color:C.white,letterSpacing:-1,lineHeight:1.08,marginBottom:20,maxWidth:560,margin:"0 auto 20px" }}>
          Kenya's freight market<br />
          <span style={{ color:C.green }}>deserves better.</span>
        </h1>
        <p style={{ fontSize:16,color:"rgba(255,255,255,0.5)",lineHeight:1.75,maxWidth:480,margin:"0 auto 40px",fontWeight:400 }}>
          We built Behari Freight because too many Kenyan truck drivers finish a job and wait weeks to be paid — if they're paid at all. We're fixing that, one load at a time.
        </p>
        {/* Stat pills */}
        <div style={{ display:"flex",justifyContent:"center",gap:12,flexWrap:"wrap" }}>
          {[["312","Active trucks"],["148","Loads delivered"],["24 hrs","Approval time"]].map(([v,l])=>(
            <div key={l} style={{ background:"#111",border:"1px solid #2a2a2a",borderRadius:12,padding:"14px 20px",minWidth:100 }}>
              <div style={{ fontSize:22,fontWeight:800,color:C.white,letterSpacing:-0.5 }}>{v}</div>
              <div style={{ fontSize:11,color:"rgba(255,255,255,0.4)",fontWeight:600,marginTop:2 }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Mission */}
      <div style={{ background:C.white,padding:"60px 24px" }}>
        <div style={{ maxWidth:640,margin:"0 auto" }}>
          <div style={{ fontSize:11,fontWeight:700,color:C.green,letterSpacing:1.2,textTransform:"uppercase",marginBottom:12 }}>Our Mission</div>
          <h2 style={{ fontSize:30,fontWeight:800,color:C.black,letterSpacing:-0.8,lineHeight:1.2,marginBottom:20 }}>
            Fair pay, on time, every time — for every truck on Kenya's roads.
          </h2>
          <p style={{ fontSize:15,color:C.secondary,lineHeight:1.8,marginBottom:16 }}>
            Kenya's logistics sector moves over <strong>KSh 800 billion</strong> in goods every year, yet the carriers who make it happen — the owner-operators, the small fleet managers, the long-haul drivers — often operate on thin margins, late payments, and zero financial safety net.
          </p>
          <p style={{ fontSize:15,color:C.secondary,lineHeight:1.8 }}>
            Behari Freight introduces <strong>M-Pesa escrow</strong> to every transaction: shippers fund the load before a truck moves, and drivers receive their payment the moment delivery is confirmed — no chasing, no disputes, no delays.
          </p>
        </div>
      </div>

      {/* How it works */}
      <div style={{ background:C.bg,padding:"60px 24px" }}>
        <div style={{ maxWidth:640,margin:"0 auto" }}>
          <div style={{ fontSize:11,fontWeight:700,color:C.green,letterSpacing:1.2,textTransform:"uppercase",marginBottom:12 }}>How It Works</div>
          <h2 style={{ fontSize:28,fontWeight:800,color:C.black,letterSpacing:-0.5,marginBottom:36 }}>Simple for shippers. Liberating for transporters.</h2>

          <div style={{ display:"flex",flexDirection:"column",gap:0 }}>
            {[
              { n:"01", title:"Shipper posts a load",     body:"A company in Nairobi needs 10 tonnes of steel coils moved to Mombasa. They post the load on Behari — cargo type, route, budget, pickup time. It goes live in under 2 minutes.", icon:"📦" },
              { n:"02", title:"Transporter books & escrow locks", body:"A verified transporter sees the load, accepts it, and M-Pesa instantly locks the full payment in escrow. The driver knows the money is real and waiting. No more ghosting.", icon:"🔒" },
              { n:"03", title:"Goods move, payment releases", body:"The truck picks up, the shipper tracks delivery in real time. The moment the delivery is confirmed — on both sides — M-Pesa releases the funds straight to the driver's number. Same day.", icon:"🚛" },
              { n:"04", title:"KYC keeps everyone safe",    body:"Every transporter goes through document verification before their first load — National ID, Driver's Licence CE, GIT Insurance, NTSA Inspection, Truck Logbook, and KRA PIN. Shippers know exactly who is driving their goods.", icon:"✅" },
            ].map((s,i,a) => (
              <div key={s.n} style={{ display:"flex",gap:20,paddingBottom: i<a.length-1?32:0,marginBottom: i<a.length-1?32:0,borderBottom: i<a.length-1?`1px solid ${C.border}`:"none" }}>
                <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:0,flexShrink:0 }}>
                  <div style={{ width:44,height:44,borderRadius:12,background:C.black,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20 }}>{s.icon}</div>
                  {i<a.length-1 && <div style={{ width:2,flex:1,background:C.border,marginTop:8 }} />}
                </div>
                <div style={{ paddingTop:4 }}>
                  <div style={{ fontSize:11,fontWeight:700,color:C.muted,letterSpacing:0.8,marginBottom:4 }}>STEP {s.n}</div>
                  <div style={{ fontSize:17,fontWeight:800,color:C.black,marginBottom:8 }}>{s.title}</div>
                  <div style={{ fontSize:14,color:C.secondary,lineHeight:1.7 }}>{s.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Why Behari */}
      <div style={{ background:C.white,padding:"60px 24px" }}>
        <div style={{ maxWidth:640,margin:"0 auto" }}>
          <div style={{ fontSize:11,fontWeight:700,color:C.green,letterSpacing:1.2,textTransform:"uppercase",marginBottom:12 }}>Why Behari</div>
          <h2 style={{ fontSize:28,fontWeight:800,color:C.black,letterSpacing:-0.5,marginBottom:32 }}>Built for the realities of Kenyan logistics.</h2>
          <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:16 }}>
            {[
              { icon:"📱", title:"M-Pesa Native",      body:"Every payment flows through Safaricom's Daraja API. No bank account needed — for shippers or drivers." },
              { icon:"🔐", title:"Escrow Protection",  body:"Funds are held in a secure escrow until delivery is confirmed. Neither party can lose out." },
              { icon:"📋", title:"Digital KYC",        body:"Full document verification online — ID, licence, insurance, logbook. Approve transporters in under 24 hours." },
              { icon:"📍", title:"Live Tracking",      body:"Shippers see where their cargo is in real time. Drivers get turn-by-turn visibility on active loads." },
              { icon:"⚖",  title:"Dispute Resolution", body:"Our ops team mediates any delivery dispute within 2 business hours with a clear resolution process." },
              { icon:"🌍", title:"Built for Kenya",    body:"Nairobi–Mombasa. Eldoret–Kisumu. Kampala corridor. Routes, rates, and regulations designed for East Africa." },
            ].map(f => (
              <div key={f.title} style={{ background:C.bg,borderRadius:12,padding:"20px 18px",border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:24,marginBottom:10 }}>{f.icon}</div>
                <div style={{ fontSize:14,fontWeight:800,color:C.black,marginBottom:6 }}>{f.title}</div>
                <div style={{ fontSize:13,color:C.secondary,lineHeight:1.6 }}>{f.body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CTA footer */}
      <div style={{ background:C.black,padding:"60px 24px",textAlign:"center" }}>
        <div style={{ maxWidth:480,margin:"0 auto" }}>
          <h2 style={{ fontSize:30,fontWeight:900,color:C.white,letterSpacing:-0.8,lineHeight:1.1,marginBottom:16 }}>
            Ready to move freight<br />the <span style={{ color:C.green }}>right way?</span>
          </h2>
          <p style={{ fontSize:15,color:"rgba(255,255,255,0.5)",lineHeight:1.7,marginBottom:32 }}>Join 312 verified transporters and dozens of shippers already using Behari Freight across Kenya.</p>
          <div style={{ display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap",marginBottom:32 }}>
            <button onClick={onClose} style={{ background:C.green,color:C.black,border:"none",borderRadius:8,padding:"13px 28px",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:font }}>
              Get Started →
            </button>
            <a href="mailto:hello@beharifreight.co.ke" style={{ background:"transparent",color:C.white,border:"1.5px solid rgba(255,255,255,0.2)",borderRadius:8,padding:"13px 28px",fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font,textDecoration:"none",display:"inline-flex",alignItems:"center" }}>
              hello@beharifreight.co.ke
            </a>
          </div>
          <div style={{ fontSize:12,color:"rgba(255,255,255,0.25)" }}>© 2026 Behari Freight Ltd · Nairobi, Kenya · M-Pesa Powered · NTSA Registered</div>
        </div>
      </div>
    </div>
  );
}

/* ── Legal Modal (Terms of Service + Privacy Policy) ────────── */
function LegalModal({ onClose, initialTab = "terms" }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <div style={{ position:"fixed",inset:0,zIndex:10000,overflowY:"auto",fontFamily:font }}>
      {/* Header bar */}
      <div style={{ position:"sticky",top:0,zIndex:10,background:"rgba(255,255,255,0.97)",backdropFilter:"blur(8px)",borderBottom:`1px solid #EBEBEB`,padding:"0 20px",height:52,display:"flex",alignItems:"center",justifyContent:"space-between" }}>
        <div style={{ display:"flex",gap:4,background:"#F6F6F6",borderRadius:8,padding:3 }}>
          {[["terms","Terms of Service"],["privacy","Privacy Policy"]].map(([id,label]) => (
            <button key={id} onClick={()=>setTab(id)} style={{ padding:"6px 14px",borderRadius:6,border:"none",background:tab===id?C.white:"transparent",fontFamily:font,fontSize:12,fontWeight:700,color:tab===id?C.black:C.muted,cursor:"pointer",boxShadow:tab===id?"0 1px 3px rgba(0,0,0,0.1)":"none",transition:"all 0.15s" }}>
              {label}
            </button>
          ))}
        </div>
        <button onClick={onClose} style={{ background:"none",border:"none",fontSize:20,cursor:"pointer",color:C.muted,lineHeight:1 }}>✕</button>
      </div>

      <div style={{ maxWidth:640,margin:"0 auto",padding:"32px 20px 64px" }}>
        {tab === "terms" && (
          <>
            <h1 style={{ fontSize:26,fontWeight:800,color:C.black,letterSpacing:-0.5,marginBottom:6 }}>Terms of Service</h1>
            <p style={{ fontSize:12,color:C.muted,marginBottom:28 }}>Last updated: 1 May 2026 · Effective immediately</p>
            {[
              { title:"1. Acceptance", body:'By accessing or using the Behari Freight platform ("Platform"), you agree to be bound by these Terms of Service and all applicable laws and regulations of the Republic of Kenya. If you do not agree, do not use the Platform.' },
              { title:"2. Services Provided", body:"Behari Freight provides a digital marketplace connecting shippers (cargo owners) with transporters (truck operators). We do not own, operate, or insure any trucks. We provide the matching, escrow, and communication infrastructure." },
              { title:"3. Escrow Payments", body:"All payments are held in M-Pesa escrow via Safaricom's Daraja API. Funds are released to the transporter only after the shipper confirms delivery via OTP and photo proof. Behari retains a 2% platform fee on each transaction." },
              { title:"4. KYC & Verification", body:"Transporters must complete Know Your Customer (KYC) verification before their first booking, including National ID, Driver's Licence (Class CE), GIT Insurance certificate, NTSA vehicle inspection, and KRA PIN. Shippers must provide a valid M-Pesa-registered phone number." },
              { title:"5. Dispute Resolution", body:"Disputes are reviewed by Behari's operations team within 2 business hours. Both parties must respond within 24 hours of being contacted. The Platform's decision on escrow distribution following a dispute investigation is final." },
              { title:"6. Transporter Obligations", body:"Transporters are responsible for maintaining valid insurance, roadworthiness certificates, and a current NTSA inspection sticker. Transporters must handle cargo with due care and report any incidents immediately via the app." },
              { title:"7. Shipper Obligations", body:"Shippers must accurately describe cargo — type, weight, hazardous classification, and packaging. Misrepresentation that causes transporter losses may result in forfeiture of the shipper's escrow refund." },
              { title:"8. Prohibited Uses", body:"The Platform may not be used to transport contraband, weapons, controlled substances, or any goods prohibited under Kenyan law. Behari reserves the right to terminate accounts and report violations to relevant authorities." },
              { title:"9. Limitation of Liability", body:"Behari Freight Ltd's liability is limited to the transaction value of the disputed load. We are not liable for consequential, indirect, or incidental damages arising from use of the Platform." },
              { title:"10. Governing Law", body:"These Terms are governed by the laws of Kenya. Any disputes shall be subject to the jurisdiction of the courts of Nairobi, Kenya." },
            ].map(s => (
              <div key={s.title} style={{ marginBottom:24 }}>
                <div style={{ fontSize:15,fontWeight:800,color:C.black,marginBottom:6 }}>{s.title}</div>
                <p style={{ fontSize:14,color:C.secondary,lineHeight:1.75,margin:0 }}>{s.body}</p>
              </div>
            ))}
            <div style={{ background:"#F6F6F6",borderRadius:10,padding:"16px 18px",fontSize:13,color:C.secondary }}>
              Questions? Contact <a href="mailto:legal@beharifreight.co.ke" style={{ color:C.black,fontWeight:700 }}>legal@beharifreight.co.ke</a>
            </div>
          </>
        )}

        {tab === "privacy" && (
          <>
            <h1 style={{ fontSize:26,fontWeight:800,color:C.black,letterSpacing:-0.5,marginBottom:6 }}>Privacy Policy</h1>
            <p style={{ fontSize:12,color:C.muted,marginBottom:28 }}>Last updated: 1 May 2026 · Behari Freight Ltd, Nairobi</p>
            {[
              { title:"Data We Collect", body:"We collect your phone number (for M-Pesa and OTP), name, ID number, vehicle registration, GPS location during active trips, and usage data within the app. Transporters additionally provide licence and insurance documents." },
              { title:"How We Use Your Data", body:"Your data is used to match loads and transporters, process payments, verify identity, investigate disputes, and improve the Platform. We do not sell your data to third parties." },
              { title:"M-Pesa & Financial Data", body:"Payment processing is handled by Safaricom via the Daraja API. Behari does not store full M-Pesa credentials. Transaction records are retained for 7 years per Kenyan financial regulations." },
              { title:"Location Data", body:"GPS coordinates are collected during active trips only. Location data is visible to the shipper of the active load and the Behari operations team. Location is not collected when you are not on an active trip." },
              { title:"Document Storage", body:"KYC documents (ID scans, licences, insurance) are stored on encrypted servers. Documents are deleted 30 days after account termination." },
              { title:"Your Rights", body:"Under the Kenya Data Protection Act 2019, you have the right to access, correct, or delete your personal data. Submit requests to privacy@beharifreight.co.ke. We respond within 7 business days." },
              { title:"Security", body:"All data is encrypted in transit (TLS 1.3) and at rest (AES-256). We conduct quarterly security audits and require multi-factor authentication for all admin access." },
              { title:"Cookies & Analytics", body:"We use minimal cookies for session management only. We do not use advertising trackers. Analytics are collected in aggregate and cannot identify individual users." },
              { title:"Contact", body:"Behari Freight Ltd · Upperhill, Nairobi, Kenya · privacy@beharifreight.co.ke · +254 700 BEHARI" },
            ].map(s => (
              <div key={s.title} style={{ marginBottom:24 }}>
                <div style={{ fontSize:15,fontWeight:800,color:C.black,marginBottom:6 }}>{s.title}</div>
                <p style={{ fontSize:14,color:C.secondary,lineHeight:1.75,margin:0 }}>{s.body}</p>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const PORTALS = [
  { id:"driver",  label:"Transporter App",     sub:"Find & book loads",         icon:"🚛", component:BehariFreight },
  { id:"shipper", label:"Shipper Portal",   sub:"Post cargo & track loads",  icon:"📦", component:BehariShipper },
  { id:"admin",   label:"Admin Dashboard",  sub:"Operations & KYC centre",   icon:"⚙", component:BehariAdmin   },
  { id:"tracker", label:"Driver Tracker",   sub:"Live location sharing",     icon:"📍", component:BehariDriverTracker },
  { id:"marketplace", label:"Marketplace",  sub:"Real loads & bookings (backend)", icon:"🏪", component:BehariMarketplace },
];

const NAV_LABELS = {
  driver:"Transporter", shipper:"Shipper", admin:"Admin", tracker:"Driver Tracker", marketplace:"Marketplace"
};

// Portals reachable per signed-in identity (derived from the backend role, never chosen).
const BACKEND_TO_APP_ROLE = { shipper:"shipper", fleet_owner:"driver", driver:"tracker", admin:"admin" };
const ROLE_ACCESS = {
  driver:  ["driver", "marketplace"],
  shipper: ["shipper", "marketplace"],
  admin:   ["admin"],
  tracker: ["tracker"],
};

const ROLE_NAMES = {
  driver:"Transporter", shipper:"Shipper", admin:"Admin", tracker:"Driver", marketplace:"Marketplace"
};

export default function App() {
  const isMobile = useWindowWidth() < 480;
  const [sess, setSess]           = useState(() => session.currentSession());
  const [pickedPortal, setPickedPortal] = useState(null);
  const [auth, setAuth]               = useState(null); // null | {mode, role}
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [showAbout, setShowAbout]     = useState(false);
  const [showLegal, setShowLegal]     = useState(null);  // null | "terms" | "privacy"
  const [portalOpen, setPortalOpen]   = useState(false); // collapsible portal switcher
  /* Dark mode — single source of truth for all portals */
  const [darkMode, setDarkMode] = useState(() => {
    try { return localStorage.getItem("behari_dark_mode") === "1"; } catch { return false; }
  });
  function toggleDark() {
    const next = !darkMode;
    setDarkMode(next);
    try { localStorage.setItem("behari_dark_mode", next ? "1" : "0"); } catch {}
  }
  useEffect(() => {
    document.documentElement.style.filter = darkMode ? "invert(1) hue-rotate(180deg)" : "";
  }, [darkMode]);
  /* Feature 1 — cross-tab real-time notification badge */
  const [crossTabAlert, setCrossTabAlert] = useState(null);
  useEffect(() => {
    function onStorage(e) {
      if (e.key === "behari_carrier_notifs" && e.newValue) {
        try {
          const next = JSON.parse(e.newValue);
          const unread = next.filter(n => !n.read).length;
          if (unread > 0) setCrossTabAlert(`🔔 ${unread} new transporter notification${unread>1?"s":""}`);
        } catch {}
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    if (!crossTabAlert) return;
    const t = setTimeout(() => setCrossTabAlert(null), 4000);
    return () => clearTimeout(t);
  }, [crossTabAlert]);

  // ── Load lifecycle state (previously 3× useState + 3× inline handlers) ──
  // All business logic (ID generation, notification assembly, timestamp
  // formatting, model construction) is now in loadService.js + models/load.js.
  // App.jsx's job is only routing + auth + prop-threading to portals.
  const {
    postedLoads,
    notifications,
    deliveredLoadIds,
    loadStatuses,
    escrowData,
    milestones,
    disputes,
    bookingSlots,
    ratings,
    carrierRatings,
    shipperRatings,
    fraudFlags,
    postLoad:           handlePostLoad,
    bookLoad:           handleBookLoad,
    confirmDelivery:    handleConfirmDelivery,
    acceptLoad:         handleAcceptLoad,
    rejectLoad:         handleRejectLoad,
    cancelShipment:     handleCancelShipment,
    reassignTruck:      handleReassignTruck,
    confirmLoading:     handleConfirmLoading,
    startTrip:          handleStartTrip,
    markBorderCrossing: handleMarkBorderCrossing,
    markDelay:          handleMarkDelay,
    markArrived:        handleMarkArrived,
    releaseEscrow:      handleReleaseEscrow,
    refundEscrow:       handleRefundEscrow,
    adminHoldEscrow:    handleAdminHoldEscrow,
    openDispute:        handleOpenDispute,
    closeDispute:       handleCloseDispute,
    submitRating:       handleSubmitRating,
    checkHasRated:      handleCheckHasRated,
    flagFraud:          handleFlagFraud,
    resolveFraudFlag:   handleResolveFraudFlag,
    adminForceStatus:   handleAdminForceStatus,
  } = useLoads();

  useEffect(() => {
    const un = session.subscribe(setSess);
    session.restore();
    return un;
  }, []);

  const role = sess ? (BACKEND_TO_APP_ROLE[sess.user.role] ?? null) : null;

  function openAuth(mode, backendRole) { setAuth({ mode, role: backendRole }); }

  function doLogout() {
    setLogoutConfirm(false);
    setPickedPortal(null);
    session.logout();
  }

  // Portals this identity is allowed to see
  const allowedPortals = role ? PORTALS.filter(p => ROLE_ACCESS[role].includes(p.id)) : [];
  const active = role ? (allowedPortals.some(p => p.id === pickedPortal) ? pickedPortal : allowedPortals[0]?.id) : null;

  if (active) {
    const Portal = PORTALS.find(p => p.id === active).component;
    const roleName = ROLE_NAMES[role] ?? "User";
    const who = sess?.user;
    const multiPortal = allowedPortals.length > 1;

    const triggerLogout = () => setLogoutConfirm(true);

    // Single object — replaces 35 explicit props. Portals receive this spread.
    // FreightContext also exposes the same values to any deep descendant.
    const sharedProps = {
      postedLoads, notifications, deliveredLoadIds, loadStatuses, escrowData,
      milestones, disputes, bookingSlots, ratings, carrierRatings, shipperRatings,
      fraudFlags,
      darkMode, toggleDark,
      onPostLoad:           handlePostLoad,
      onConfirmDelivery:    handleConfirmDelivery,
      onLogout:             triggerLogout,
      onAcceptLoad:         handleAcceptLoad,
      onRejectLoad:         handleRejectLoad,
      onCancelShipment:     handleCancelShipment,
      onReassignTruck:      handleReassignTruck,
      onConfirmLoading:     handleConfirmLoading,
      onStartTrip:          handleStartTrip,
      onMarkBorderCrossing: handleMarkBorderCrossing,
      onMarkDelay:          handleMarkDelay,
      onMarkArrived:        handleMarkArrived,
      onReleaseEscrow:      handleReleaseEscrow,
      onRefundEscrow:       handleRefundEscrow,
      onAdminHoldEscrow:    handleAdminHoldEscrow,
      onOpenDispute:        handleOpenDispute,
      onCloseDispute:       handleCloseDispute,
      onSubmitRating:       handleSubmitRating,
      onCheckHasRated:      handleCheckHasRated,
      onFlagFraud:          handleFlagFraud,
      onResolveFraudFlag:   handleResolveFraudFlag,
      onAdminForceStatus:   handleAdminForceStatus,
    };

    return (
      <FreightContext.Provider value={sharedProps}>
      <div style={{ position:"relative" }}>
        {/* Legal modal — available from any portal (Account > Privacy & Legal) */}
        {showLegal && <LegalModal initialTab={showLegal} onClose={()=>setShowLegal(null)} />}
        {/* Feature 1 — cross-tab real-time notification toast */}
        {crossTabAlert && (
          <div style={{ position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",zIndex:99999,background:C.black,color:C.white,borderRadius:100,padding:"10px 20px",fontSize:13,fontWeight:700,fontFamily:font,boxShadow:"0 4px 20px rgba(0,0,0,0.3)",whiteSpace:"nowrap",pointerEvents:"none" }}>
            {crossTabAlert}
          </div>
        )}

        {/* Portals handle their own bottom nav. The new collapsible portal
            switcher floats as a pill — no reserved bar space needed. */}
        <div style={{ paddingBottom: multiPortal ? 80 : 0 }}>
          <Suspense fallback={
            <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", fontFamily:font, color:C.muted, fontSize:14, fontWeight:600 }}>
              Loading…
            </div>
          }>
            <ErrorBoundary>
              <Portal {...sharedProps} onShowLegal={setShowLegal} />
            </ErrorBoundary>
          </Suspense>
        </div>

        {/* Logout / portal-switch bottom sheet */}
        {logoutConfirm && (
          <div style={{ position:"fixed",inset:0,zIndex:10000,display:"flex",alignItems:"flex-end",justifyContent:"center" }}>
            <div onClick={()=>setLogoutConfirm(false)} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.45)",backdropFilter:"blur(3px)" }} />
            <div style={{ position:"relative",background:C.white,borderRadius:"20px 20px 0 0",padding:"24px 20px 36px",width:"100%",maxWidth:480,fontFamily:font }}>
              <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"0 auto 20px" }} />
              <div style={{ fontSize:18,fontWeight:800,color:C.black,marginBottom:6 }}>Account</div>
              <div style={{ fontSize:14,color:C.muted,marginBottom:20 }}>
                Signed in as <strong style={{ color:C.black }}>{who?.name}</strong> · {roleName}
              </div>

              <div style={{ display:"flex",gap:10 }}>
                <button onClick={()=>setLogoutConfirm(false)} style={{ flex:1,background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>
                  Cancel
                </button>
                <button onClick={doLogout} style={{ flex:1,background:C.red,color:C.white,border:"none",borderRadius:10,padding:"13px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>
                  Log Out
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Collapsible portal switcher — Admin only.
            Replaces the old fixed bottom bar with a floating pill that
            expands into a panel when tapped. Carrier/Shipper portals have
            their own bottom nav rendered inside their own bundle. */}
        {multiPortal && (
          <div style={{ position:"fixed",bottom:20,left:"50%",transform:"translateX(-50%)",zIndex:9999,display:"flex",flexDirection:"column",alignItems:"center",gap:0,maxWidth:400,width:"calc(100% - 32px)" }}>

            {/* Expanded panel — slides up, then collapses */}
            <div style={{
              overflow:"hidden",
              maxHeight: portalOpen ? 260 : 0,
              opacity:   portalOpen ? 1 : 0,
              transition:"max-height 0.28s cubic-bezier(0.4,0,0.2,1), opacity 0.2s ease",
              width:"100%",
              marginBottom: portalOpen ? 8 : 0,
            }}>
              <div style={{ background:C.white,borderRadius:14,boxShadow:"0 8px 32px rgba(0,0,0,0.18)",border:`1px solid ${C.border}`,padding:"14px 14px 10px",backdropFilter:"blur(12px)" }}>
                <div style={{ fontSize:10,fontWeight:700,color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:10 }}>Switch Portal</div>
                <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                  {allowedPortals.map(p => {
                    const isCurrent = active === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => { setPickedPortal(p.id); setPortalOpen(false); }}
                        style={{
                          display:"flex",alignItems:"center",gap:10,
                          background: isCurrent ? C.black : C.bg,
                          color:      isCurrent ? C.white : C.black,
                          border:`1.5px solid ${isCurrent ? C.black : C.border}`,
                          borderRadius:10,padding:"11px 14px",fontSize:13,fontWeight:700,
                          cursor:"pointer",fontFamily:font,textAlign:"left",transition:"all 0.15s",
                        }}
                      >
                        <span style={{ fontSize:16 }}>{p.icon}</span>
                        <span style={{ flex:1 }}>{NAV_LABELS[p.id]}</span>
                        {isCurrent && <span style={{ fontSize:11,color:C.green,fontWeight:800 }}>● Active</span>}
                      </button>
                    );
                  })}
                </div>
                <div style={{ borderTop:`1px solid ${C.border}`,marginTop:10,paddingTop:10 }}>
                  <button
                    onClick={() => { setPortalOpen(false); triggerLogout(); }}
                    style={{ width:"100%",background:C.redBg,color:C.red,border:`1px solid ${C.red}33`,borderRadius:10,padding:"10px 14px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font,display:"flex",alignItems:"center",gap:8,justifyContent:"center" }}
                  >⏻ Log Out</button>
                </div>
              </div>
            </div>

            {/* Toggle pill */}
            <button
              onClick={() => setPortalOpen(o => !o)}
              style={{
                display:"flex",alignItems:"center",gap:8,
                background: portalOpen ? C.black : "rgba(255,255,255,0.96)",
                color:      portalOpen ? C.white : C.black,
                border:`1.5px solid ${portalOpen ? C.black : C.border}`,
                borderRadius:100,padding:"9px 18px",fontSize:12,fontWeight:700,
                cursor:"pointer",fontFamily:font,
                boxShadow:"0 4px 20px rgba(0,0,0,0.15)",
                backdropFilter:"blur(8px)",
                transition:"all 0.2s ease",
                letterSpacing:0.2,
              }}
            >
              <span style={{ fontSize:14 }}>{allowedPortals.find(p=>p.id===active)?.icon ?? "⚙"}</span>
              <span>{NAV_LABELS[active] ?? "Portals"}</span>
              <span style={{ fontSize:10, opacity:0.7, marginLeft:2 }}>{portalOpen ? "▲" : "▼"}</span>
            </button>
          </div>
        )}
      </div>
      </FreightContext.Provider>
    );
  }

  /* ── Launcher ── */
  return (
    <div style={{ minHeight:"100vh",background:C.white,fontFamily:font,display:"flex",flexDirection:"column" }}>
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      {showLegal && <LegalModal initialTab={showLegal} onClose={()=>setShowLegal(null)} />}
      {auth && (
        <AuthModal
          initialMode={auth.mode}
          initialRole={auth.role}
          onClose={() => setAuth(null)}
          onDone={() => { setAuth(null); setPickedPortal(null); }}
        />
      )}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#FFFFFF}
      `}</style>

      {/* Nav bar */}
      <div style={{ background:C.white,borderBottom:`1px solid ${C.border}`,padding:"0 24px",display:"flex",alignItems:"center",justifyContent:"space-between",height:60,position:"sticky",top:0,zIndex:10 }}>
        <div style={{ display:"flex",alignItems:"center",gap:10 }}>
          <div style={{ width:5,height:22,background:C.green,borderRadius:3 }} />
          <span style={{ fontSize:16,fontWeight:800,color:C.black,letterSpacing:-0.3 }}>Behari Freight</span>
          <span style={{ fontSize:11,color:C.muted,fontWeight:500,marginLeft:4 }}>Kenya</span>
        </div>
        <div style={{ display:"flex",gap:16,alignItems:"center" }}>
          {!isMobile && <span onClick={() => setShowAbout(true)} style={{ fontSize:13,color:C.secondary,fontWeight:500,cursor:"pointer" }}>About</span>}
          {!isMobile && <span style={{ fontSize:13,color:C.secondary,fontWeight:500,cursor:"pointer" }}>Transporters</span>}
          {!isMobile && <span style={{ fontSize:13,color:C.secondary,fontWeight:500,cursor:"pointer" }}>Shippers</span>}
          <button onClick={() => openAuth("login","shipper")} style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:"8px 18px",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font }}>Sign In</button>
        </div>
      </div>

      {/* Hero */}
      <div style={{ background:C.black,padding:"80px 24px 72px",textAlign:"center" }}>
        <div style={{ maxWidth:560,margin:"0 auto" }}>
          <div style={{ display:"inline-flex",alignItems:"center",gap:8,background:"#111",border:`1px solid #222`,borderRadius:100,padding:"6px 16px",marginBottom:24 }}>
            <div style={{ width:7,height:7,borderRadius:"50%",background:C.green }} />
            <span style={{ fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.7)",letterSpacing:0.5 }}>Kenya's truck ↔ cargo matching network</span>
          </div>
          <h1 style={{ fontSize:isMobile?30:46,fontWeight:900,color:C.white,letterSpacing:-1,lineHeight:1.05,marginBottom:20 }}>
            Find Cargo.<br />
            <span style={{ color:C.green }}>Fill Empty Trips.</span>
          </h1>
          <p style={{ fontSize:16,color:"rgba(255,255,255,0.55)",lineHeight:1.7,marginBottom:36,fontWeight:400,maxWidth:460,margin:"0 auto 36px" }}>
            Behari connects available trucks with cargo that needs moving — including return loads and cargo along the route. M-Pesa escrow protects the payment once a match is booked.
          </p>
          <div style={{ display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap" }}>
            <button onClick={()=>openAuth("register","fleet_owner")} style={{ background:C.white,color:C.black,border:"none",borderRadius:8,padding:"15px 30px",fontSize:16,fontWeight:800,cursor:"pointer",fontFamily:font }}>
              🚛 I Have a Truck
            </button>
            <button onClick={()=>openAuth("register","shipper")} style={{ background:C.green,color:C.black,border:"none",borderRadius:8,padding:"15px 30px",fontSize:16,fontWeight:800,cursor:"pointer",fontFamily:font }}>
              📦 I Have Cargo
            </button>
          </div>
          <div style={{ marginTop:16, display:"flex", gap:20, justifyContent:"center", flexWrap:"wrap" }}>
            <button onClick={()=>openAuth("login","shipper")} style={{ background:"transparent",color:C.green,border:"none",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,textDecoration:"underline",textUnderlineOffset:3 }}>
              Already registered? Sign in →
            </button>
            <button onClick={()=>openAuth("login","driver")} style={{ background:"transparent",color:"rgba(255,255,255,0.6)",border:"none",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,textDecoration:"underline",textUnderlineOffset:3 }}>
              📍 Driver sign in →
            </button>
          </div>
        </div>
      </div>

      {/* Portal cards */}
      <div style={{ flex:1,padding:"48px 24px",background:C.white }}>
        <div style={{ maxWidth:800,margin:"0 auto" }}>
          <div style={{ textAlign:"center",marginBottom:36 }}>
            <h2 style={{ fontSize:28,fontWeight:800,color:C.black,letterSpacing:-0.5,marginBottom:8 }}>Choose your portal</h2>
            <p style={{ fontSize:15,color:C.muted }}>Sign in with your Behari account to open your portal</p>
          </div>

          <div style={{ display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:16 }}>
            {PORTALS.filter(p => p.id !== "marketplace").map(p=>{
              const cardRole = { driver:"fleet_owner", shipper:"shipper", admin:"admin", tracker:"driver" }[p.id];
              return (
                <button key={p.id} onClick={()=>openAuth("login", cardRole)} style={{
                  background:C.white,border:`1.5px solid ${C.border}`,borderRadius:12,
                  padding:"28px 24px",textAlign:"left",cursor:"pointer",fontFamily:font,
                  transition:"all 0.15s",boxShadow:"0 1px 4px rgba(0,0,0,0.04)"
                }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=C.black;e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,0.1)";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.boxShadow="0 1px 4px rgba(0,0,0,0.04)";}}
                >
                  <div style={{ width:44,height:44,background:C.bg,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:16 }}>{p.icon}</div>
                  <div style={{ fontSize:18,fontWeight:700,color:C.black,marginBottom:4 }}>{p.label}</div>
                  <div style={{ fontSize:13,color:C.muted,fontWeight:400,marginBottom:16 }}>{p.sub}</div>
                  <div style={{ fontSize:12,fontWeight:700,color:C.black }}>Sign in →</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ borderTop:`1px solid ${C.border}`,padding:"20px 24px",display:"flex",flexDirection:isMobile?"column":"row",justifyContent:"space-between",alignItems:"center",gap:8,textAlign:isMobile?"center":undefined }}>
        <div style={{ fontSize:13,fontWeight:700,color:C.black }}>Behari Freight</div>
        <div style={{ display:"flex",gap:20,alignItems:"center",flexWrap:"wrap",justifyContent:"center" }}>
          <span onClick={()=>setShowLegal("terms")}   style={{ fontSize:12,color:C.muted,cursor:"pointer",fontWeight:500 }}>Terms of Service</span>
          <span onClick={()=>setShowLegal("privacy")} style={{ fontSize:12,color:C.muted,cursor:"pointer",fontWeight:500 }}>Privacy Policy</span>
          <span style={{ fontSize:12,color:C.muted }}>© 2026 · Nairobi, Kenya · M-Pesa Powered</span>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { currentSession } from "./src/services/session.js";
import {
  getAgentSites, getAgentTrips, scanGatePass,
  AGENT_EVENT_LABEL, nextStepLabel, SCAN_ERROR_TEXT,
} from "./src/services/gateApi.js";

// Phase 5E-4B — Loading Agent surface. Deliberately narrow: it can show the agent's own site(s), scan a gate pass,
// and list trucks that are at those sites. Everything displayed comes from the backend's loading-agent read model;
// no cargo price, shipper contact, escrow, negotiation or fleet data exists on this screen or in its API.

const C = {
  bg: "#0B0B0B", card: "#151515", border: "#262626", white: "#FFFFFF", muted: "#8A8A8A",
  green: "#06C167", greenBg: "rgba(6,193,103,0.12)", red: "#E5484D", redBg: "rgba(229,72,77,0.12)", amber: "#E0A639",
};
const font = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";
const READER_ID = "gate-reader";
const FILE_READER_ID = "gate-reader-file";

function cameraErrorText(err) {
  const name = err?.name || "";
  const msg = String(err?.message || err || "");
  if (name === "NotAllowedError" || /permission|denied/i.test(msg)) return "Camera permission was denied. Allow camera access for this site in your browser settings, then try again.";
  if (name === "NotFoundError" || /no camera|requested device not found|not found/i.test(msg)) return "No camera was found on this device.";
  if (name === "NotReadableError") return "The camera is in use by another app.";
  if (!window.isSecureContext) return "The camera needs a secure (https) connection.";
  return "The camera could not be started.";
}

const card = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: 16 };
const label = { fontSize: 11, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 6 };
const btn = { width: "100%", background: C.green, color: "#00220F", border: "none", borderRadius: 10, padding: "14px", fontSize: 14, fontWeight: 800, fontFamily: font, cursor: "pointer" };
const btn2 = { ...btn, background: "transparent", color: C.white, border: `1px solid ${C.border}` };

function ResultCard({ result }) {
  const { event, trip } = result;
  return (
    <div data-testid="scan-result" style={{ ...card, borderColor: C.green }}>
      <div style={{ ...label, color: C.green }}>VERIFIED</div>
      <div data-testid="scan-result-event" style={{ fontSize: 17, fontWeight: 800 }}>{AGENT_EVENT_LABEL[event.eventType] || "Recorded"}</div>
      <div style={{ fontSize: 13, color: C.muted, marginTop: 10, lineHeight: 1.7 }}>
        Truck: <span data-testid="scan-result-truck" style={{ color: C.white, fontWeight: 700 }}>{trip?.truck?.registration || "—"}</span><br />
        Driver: <span data-testid="scan-result-driver" style={{ color: C.white }}>{trip?.driver?.name || "—"}</span><br />
        Trip: <span data-testid="scan-result-trip" style={{ color: C.white }}>{event.tripId}</span><br />
        Site: <span style={{ color: C.white }}>{trip?.site?.name || "—"}</span><br />
        Trip status: <span data-testid="scan-result-status" style={{ color: C.green, fontWeight: 700 }}>{event.tripStatusAfter}</span>
      </div>
      {event.location && !event.location.available && (
        <div style={{ fontSize: 12, color: C.amber, marginTop: 10 }}>Driver location was not available at the time of scan.</div>
      )}
      {event.location?.available && event.location.insideGeofence === false && (
        <div style={{ fontSize: 12, color: C.amber, marginTop: 10 }}>Driver location was outside the site area at the time of scan.</div>
      )}
    </div>
  );
}

export default function BehariLoadingAgent({ onLogout }) {
  const user = currentSession()?.user;
  const [sites, setSites] = useState(null);
  const [trips, setTrips] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState("idle");   // idle | starting | scanning | camera-error
  const [cameraError, setCameraError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [scanError, setScanError] = useState("");
  const [result, setResult] = useState(null);
  const scannerRef = useRef(null);
  const busyRef = useRef(false);
  const tripsRef = useRef(null);

  const load = useCallback(async () => {
    const [s, t] = await Promise.all([getAgentSites(), getAgentTrips()]);
    if (!s.ok || !t.ok) { setLoadError((s.ok ? t : s).error || "Could not load your loading site."); return; }
    setLoadError(""); setSites(s.data); setTrips(t.data); tripsRef.current = t.data;
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 10000); return () => clearInterval(iv); }, [load]);

  const stopCamera = useCallback(async () => {
    const sc = scannerRef.current;
    scannerRef.current = null;
    if (!sc) return;
    try { if (sc.isScanning) await sc.stop(); } catch { /* already stopped */ }
    try { sc.clear(); } catch { /* ignore */ }
  }, []);
  useEffect(() => () => { stopCamera(); }, [stopCamera]);

  const submit = useCallback(async (decodedText) => {
    if (busyRef.current) return;
    busyRef.current = true; setSubmitting(true); setScanError(""); setResult(null);
    await stopCamera(); setMode("idle");
    const before = tripsRef.current || [];
    const r = await scanGatePass(decodedText);
    if (r.ok) {
      const { event, trip } = r.data;
      // After loading completes the trip leaves the agent's list, so fall back to what was on screen before the scan.
      setResult({ event, trip: trip || before.find((x) => x.tripId === event.tripId) || null });
      await load();
    } else {
      setScanError(SCAN_ERROR_TEXT[r.code] || r.error || "Scan failed.");
    }
    setSubmitting(false); busyRef.current = false;
  }, [load, stopCamera]);

  async function startCamera() {
    setScanError(""); setResult(null); setCameraError(""); setMode("starting");
    await stopCamera();
    // The reader element only exists once mode leaves "idle"; wait a frame for it to mount.
    await new Promise((res) => requestAnimationFrame(() => res()));
    try {
      const sc = new Html5Qrcode(READER_ID, { verbose: false });
      scannerRef.current = sc;
      await sc.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (text) => submit(text),
        () => {},
      );
      setMode("scanning");
    } catch (err) {
      await stopCamera();
      setCameraError(cameraErrorText(err)); setMode("camera-error");
    }
  }

  async function cancelCamera() { await stopCamera(); setMode("idle"); }

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setScanError(""); setResult(null);
    let text;
    try {
      const reader = new Html5Qrcode(FILE_READER_ID, { verbose: false });
      text = await reader.scanFile(file, false);
      try { reader.clear(); } catch { /* ignore */ }
    } catch {
      setScanError("No QR code was found in that image."); return;
    }
    await submit(text);
  }

  const noSite = sites && sites.length === 0;
  const showReader = mode === "starting" || mode === "scanning";

  return (
    <div data-testid="loading-agent" style={{ minHeight: "100vh", background: C.bg, color: C.white, fontFamily: font, padding: "28px 20px 40px", maxWidth: 520, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 1.4 }}>LOADING AGENT</div>
          {user?.name && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{user.name}</div>}
        </div>
        {onLogout && <button onClick={onLogout} style={{ marginLeft: "auto", background: "transparent", border: "none", color: C.muted, fontFamily: font, fontSize: 12, textDecoration: "underline", cursor: "pointer" }}>Sign out</button>}
      </div>

      <div style={card}>
        <div style={label}>ASSIGNED SITE</div>
        {!sites && !loadError && <div style={{ fontSize: 14, color: C.muted }}>Loading…</div>}
        {noSite && <div data-testid="agent-no-site" style={{ fontSize: 14, color: C.amber }}>No loading site is assigned to your account. Contact Behari operations.</div>}
        {sites?.map((s) => (
          <div key={s.id} data-testid="agent-site" style={{ fontSize: 16, fontWeight: 800 }}>
            {s.name}{!s.active && <span style={{ fontSize: 12, color: C.red, fontWeight: 600 }}> · inactive</span>}
          </div>
        ))}
      </div>
      {loadError && <div style={{ background: C.redBg, color: C.red, fontSize: 12, borderRadius: 8, padding: "10px 12px", marginBottom: 16 }}>{loadError}</div>}

      <div style={{ display: showReader ? "block" : "none", marginBottom: 16 }}>
        <div id={READER_ID} data-testid="gate-reader" style={{ width: "100%", borderRadius: 12, overflow: "hidden", background: "#000", minHeight: showReader ? 260 : 0 }} />
        {mode === "starting" && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Starting camera…</div>}
        {mode === "scanning" && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Point the camera at the driver's gate pass.</div>}
        <button onClick={cancelCamera} style={{ ...btn2, marginTop: 10 }}>CANCEL</button>
      </div>
      <div id={FILE_READER_ID} style={{ display: "none" }} />

      {mode === "camera-error" && (
        <div data-testid="camera-error" style={{ background: C.redBg, color: C.red, fontSize: 13, borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>{cameraError}</div>
      )}

      {!showReader && (
        <div style={{ marginBottom: 16 }}>
          <button data-testid="scan-gate-pass" disabled={noSite || submitting} onClick={startCamera} style={{ ...btn, opacity: noSite || submitting ? 0.5 : 1 }}>
            {submitting ? "Verifying…" : mode === "camera-error" ? "TRY CAMERA AGAIN" : "SCAN GATE PASS"}
          </button>
          <label style={{ display: "block", textAlign: "center", marginTop: 10, fontSize: 12, color: C.muted, textDecoration: "underline", cursor: "pointer" }}>
            Scan from a photo instead
            <input data-testid="scan-image-input" type="file" accept="image/*" onChange={onFile} disabled={noSite || submitting} style={{ display: "none" }} />
          </label>
        </div>
      )}

      {scanError && <div data-testid="scan-error" style={{ background: C.redBg, color: C.red, fontSize: 13, borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>{scanError}</div>}
      {result && <ResultCard result={result} />}

      <div style={card}>
        <div style={label}>TODAY'S TRUCKS</div>
        {trips && trips.length === 0 && <div data-testid="agent-no-trucks" style={{ fontSize: 13, color: C.muted }}>No trucks are waiting at your site.</div>}
        {trips?.map((t) => (
          <div key={t.tripId} data-testid="agent-truck" style={{ padding: "10px 0", borderTop: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>{t.truck?.registration || "—"}</div>
              <div style={{ marginLeft: "auto", fontSize: 12, color: C.green, fontWeight: 700 }}>{t.status}</div>
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              {t.driver?.name || "—"} · {t.site?.name}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              {t.gate?.allowedAction ? `Next: ${nextStepLabel(t.gate.allowedAction)}` : "No step available right now"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

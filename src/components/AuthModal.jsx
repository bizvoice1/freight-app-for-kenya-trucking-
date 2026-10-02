import { useState } from "react";
import { COLORS as C, FONT as font } from "../constants/theme.js";
import * as session from "../services/session.js";

const LOGIN_ROLES = [
  { id: "shipper",     label: "Shipper",     icon: "📦" },
  { id: "fleet_owner", label: "Transporter", icon: "🚛" },
  { id: "driver",      label: "Driver",      icon: "📍" },
  { id: "admin",       label: "Admin",       icon: "⚙" },
];
const REGISTER_ROLES = LOGIN_ROLES.filter((r) => r.id === "shipper" || r.id === "fleet_owner");

const label = { display: "block", fontSize: 11, fontWeight: 700, color: C.secondary, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 5 };
const input = { width: "100%", background: C.bg, border: `1.5px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", fontSize: 14, fontFamily: font, color: C.black, outline: "none" };

export default function AuthModal({ initialMode = "login", initialRole = "shipper", onClose, onDone }) {
  const [mode, setMode] = useState(initialMode);
  const [role, setRole] = useState(initialRole);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const registering = mode === "register";
  const roles = registering ? REGISTER_ROLES : LOGIN_ROLES;

  function switchMode(m) {
    setMode(m); setError("");
    if (m === "register" && role !== "shipper" && role !== "fleet_owner") setRole("shipper");
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (registering) {
      if (name.trim().length < 2) return setError("Enter your full name.");
      if (pin !== pin2) return setError("The two PINs do not match.");
    }
    setBusy(true);
    const r = registering
      ? await session.register({ name: name.trim(), phone, pin, role, company: role === "fleet_owner" ? company.trim() : "" })
      : await session.login(phone, pin, role);
    setBusy(false);
    if (r.ok) onDone?.(r.user);
    else setError(r.error || "Something went wrong.");
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }} />
      <div style={{ position: "relative", background: C.white, borderRadius: 16, padding: "28px 24px", width: "100%", maxWidth: 420, boxShadow: "0 24px 64px rgba(0,0,0,0.18)", fontFamily: font, margin: "auto" }}>
        <button onClick={onClose} aria-label="Close" style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.muted, lineHeight: 1 }}>✕</button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
          <div style={{ width: 5, height: 20, background: C.green, borderRadius: 3 }} />
          <span style={{ fontSize: 15, fontWeight: 800, color: C.black }}>Behari Freight</span>
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 18, background: C.bg, borderRadius: 10, padding: 4 }}>
          {[["login", "Sign in"], ["register", "Create account"]].map(([m, t]) => (
            <button key={m} type="button" onClick={() => switchMode(m)} style={{ flex: 1, padding: "9px 6px", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: font, fontSize: 13, fontWeight: 700, background: mode === m ? C.black : "transparent", color: mode === m ? C.white : C.secondary }}>{t}</button>
          ))}
        </div>

        <div style={label}>{registering ? "I want to…" : "I am a…"}</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          {roles.map((r) => (
            <button key={r.id} type="button" onClick={() => setRole(r.id)} style={{ flex: 1, padding: "10px 4px", borderRadius: 10, cursor: "pointer", fontFamily: font, border: `1.5px solid ${role === r.id ? C.black : C.border}`, background: role === r.id ? C.black : C.white, color: role === r.id ? C.white : C.secondary }}>
              <div style={{ fontSize: 18, marginBottom: 2 }}>{r.icon}</div>
              <div style={{ fontSize: 11, fontWeight: 700 }}>{registering ? (r.id === "shipper" ? "Ship cargo" : "Haul cargo") : r.label}</div>
            </button>
          ))}
        </div>

        <form onSubmit={submit}>
          {registering && (
            <div style={{ marginBottom: 14 }}>
              <label style={label}>Full name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" style={input} />
            </div>
          )}
          {registering && role === "fleet_owner" && (
            <div style={{ marginBottom: 14 }}>
              <label style={label}>Company (optional)</label>
              <input value={company} onChange={(e) => setCompany(e.target.value)} style={input} />
            </div>
          )}
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Phone number</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX" style={input} />
          </div>
          <div style={{ marginBottom: registering ? 14 : 18 }}>
            <label style={label}>PIN (4–6 digits)</label>
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} type="password" inputMode="numeric" autoComplete={registering ? "new-password" : "current-password"} style={{ ...input, fontSize: 18, letterSpacing: 6 }} />
          </div>
          {registering && (
            <div style={{ marginBottom: 18 }}>
              <label style={label}>Confirm PIN</label>
              <input value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 6))} type="password" inputMode="numeric" autoComplete="new-password" style={{ ...input, fontSize: 18, letterSpacing: 6 }} />
            </div>
          )}

          {error && <div role="alert" style={{ background: "#FDE8E3", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.red, fontWeight: 600, marginBottom: 14 }}>⚠ {error}</div>}

          <button type="submit" disabled={busy} style={{ width: "100%", background: busy ? C.muted : C.black, color: C.white, border: "none", borderRadius: 8, padding: 14, fontSize: 15, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer", fontFamily: font }}>
            {busy ? "Please wait…" : registering ? "Create account" : "Sign in"}
          </button>
        </form>

        <div style={{ marginTop: 14, fontSize: 11, color: C.muted, lineHeight: 1.5, textAlign: "center" }}>
          Development sign-in: phone + PIN. SMS phone verification is not enabled yet.
          {registering && " Driver and staff accounts are created by Behari, not self-registered."}
        </div>
      </div>
    </div>
  );
}

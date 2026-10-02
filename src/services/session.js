/**
 * src/services/session.js
 * ------------------------
 * 5P-1 — the ONE frontend session. One human session -> one backend user ->
 * one JWT -> one role/tenant identity. Every API client reads its token from
 * here; nothing else stores a token or silently logs in as someone else.
 * Dev auth mode is phone + PIN (no phone verification) — see GET /api/auth/config.
 */
export const API_BASE = (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL)
  || (typeof window !== "undefined" && `http://${window.location.hostname}:4000`)
  || "http://localhost:4000";

const KEY = "behari_session";
const listeners = new Set();
let _session = _load();

function _load() {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s?.token && s?.user?.id ? s : null;
  } catch { return null; }
}
function _set(s) {
  _session = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* ignore */ }
  listeners.forEach((fn) => fn(_session));
}

export function currentSession() { return _session; }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

async function _post(path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || "Request failed.", code: data.code };
    _set({ token: data.token, user: data.user });
    await restore();
    return { ok: true, user: _session?.user ?? data.user };
  } catch {
    return { ok: false, error: `Could not reach the backend at ${API_BASE}.` };
  }
}

export const login = (phone, pin, role) => _post("/api/auth/login", { phone, pin, role });
export const register = ({ name, phone, pin, role, company }) =>
  _post("/api/auth/register", { name, phone, pin, role, ...(company ? { company } : {}) });
export function logout() { _set(null); }

/** Re-reads the canonical identity from GET /api/me. A 401 ends the session. */
export async function restore() {
  if (!_session) return null;
  try {
    const res = await fetch(`${API_BASE}/api/me`, { headers: { Authorization: `Bearer ${_session.token}` } });
    if (res.status === 401) { _set(null); return null; }
    if (!res.ok) return _session;
    const me = await res.json();
    _set({ token: _session.token, user: { ...me } });
  } catch { /* offline: keep the stored session */ }
  return _session;
}

export function authAuthHeader() {
  return _session ? { Authorization: `Bearer ${_session.token}` } : {};
}

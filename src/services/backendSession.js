/**
 * src/services/backendSession.js
 * -------------------------------
 * 5D-3 — the demo-credential bridge. Owns API_BASE, the demo logins and the
 * per-role session ({token, user}) so every API client shares one login and
 * every portal can read the authenticated backend identity (id + name)
 * instead of hardcoding one. Real portal authentication replaces this later.
 */
export const API_BASE = (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL)
  || (typeof window !== "undefined" && `http://${window.location.hostname}:4000`)
  || "http://localhost:4000";

// Matches backend/src/db/seed.js — see backend/README.md's dev login table.
const DEMO_CREDENTIALS = {
  shipper:     { phone: "0700000001", pin: "1234" },
  admin:       { phone: "0700000002", pin: "1234" },
  fleet_owner: { phone: "0722100200", pin: "1234" },
};

const _sessions = new Map(); // role -> Promise<{token, user}>

export function getSession(role) {
  if (_sessions.has(role)) return _sessions.get(role);
  const creds = DEMO_CREDENTIALS[role];
  if (!creds) return Promise.reject(new Error(`No demo credentials configured for role "${role}".`));
  const p = fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...creds, role }),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`Could not authenticate with the backend as ${role}.`);
    const data = await res.json();
    return { token: data.token, user: data.user };
  }).catch((err) => { _sessions.delete(role); throw err; });
  _sessions.set(role, p);
  return p;
}

export async function getToken(role) { return (await getSession(role)).token; }

/** Authenticated JSON request. Returns {status, json}; never throws on an HTTP error status. */
export async function apiRequest(role, method, path, body, headers = {}) {
  const { token } = await getSession(role);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

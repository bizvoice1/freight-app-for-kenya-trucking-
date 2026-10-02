/**
 * src/services/backendSession.js
 * -------------------------------
 * 5P-1 — API clients get their identity from the ONE real session
 * (services/session.js). There are no demo credentials: if nobody is signed
 * in as the requested role, calls fail loudly instead of authenticating as a
 * seeded user the UI never showed.
 */
import { currentSession, API_BASE } from "./session.js";
export { API_BASE };

export async function getSession(role) {
  const s = currentSession();
  if (!s) throw new Error("Not signed in.");
  if (role && s.user.role !== role) throw new Error(`Signed in as ${s.user.role}, not ${role}.`);
  return s;
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

// Phase 5E-2 test support — Loading and In Transit are now reachable ONLY through verified gate evidence,
// so lifecycle walks in older suites go through the real gate API (driver QR -> agent scan) instead of the status route.
const BASE = process.env.BASE_URL || "http://localhost:4000";
async function call(token, method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function loginAs(phone, role) {
  const r = await call(null, "POST", "/api/auth/login", { phone, pin: "1234", role });
  if (r.status !== 200) throw new Error(`gate-helper login ${role} failed: ${JSON.stringify(r.json)}`);
  return r.json.token;
}

/** At Pickup -> GATE_IN -> LOADING_STARTED -> LOADING_COMPLETED (In Transit), via the real endpoints. */
export async function passLoadingGate({ tripId, driverToken, siteId = "LS-1000", agentPhone = "0700000010" }) {
  const adminToken = await loginAs("0700000002", "admin");
  const g = await call(adminToken, "GET", `/api/trips/${tripId}/gate`);
  if (g.status !== 200) throw new Error(`gate state failed: ${JSON.stringify(g.json)}`);
  if (!g.json.site) {
    const trip = (await call(adminToken, "GET", `/api/trips/${tripId}`)).json;
    const r = await call(adminToken, "PUT", `/api/loads/${trip.loadId}/pickup-site`, { siteId });
    if (r.status !== 200) throw new Error(`set pickup site failed: ${JSON.stringify(r.json)}`);
  }
  const agentToken = await loginAs(agentPhone, "loading_agent");
  for (let i = 0; i < 3; i++) {
    const t = await call(driverToken, "POST", `/api/trips/${tripId}/gate-token`, {});
    if (t.status !== 201) throw new Error(`gate token failed: ${JSON.stringify(t.json)}`);
    const s = await call(agentToken, "POST", "/api/gate/scan", { token: t.json.qrText });
    if (s.status !== 201) throw new Error(`gate scan failed: ${JSON.stringify(s.json)}`);
    if (s.json.event.eventType === "LOADING_COMPLETED") return s.json;
  }
  throw new Error("gate did not complete in 3 scans");
}

/** Walks a driver through `statuses` on the status route, substituting the gate for Loading / In Transit. */
export async function driveSteps({ tripId, driverToken, statuses }) {
  for (const status of statuses) {
    if (status === "Loading") continue; // produced by the gate
    if (status === "In Transit") { await passLoadingGate({ tripId, driverToken }); continue; }
    const r = await call(driverToken, "POST", `/api/trips/${tripId}/status`, { status });
    if (r.status !== 200) throw new Error(`driver step ${status} failed: ${JSON.stringify(r.json)}`);
  }
}

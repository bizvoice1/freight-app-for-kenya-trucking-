// 5E-4B — thin client for the 5E gate backend. Holds no gate state: every call returns what the backend decided.
import { API_BASE, authAuthHeader } from "./session.js";

async function call(method, path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...authAuthHeader() },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, code: data.code, error: data.error || "Request failed." };
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, code: "NETWORK", error: `Could not reach the backend at ${API_BASE}.` };
  }
}

export const getGateState   = (tripId) => call("GET", `/api/trips/${encodeURIComponent(tripId)}/gate`);
export const issueGatePass  = (tripId, purpose) => call("POST", `/api/trips/${encodeURIComponent(tripId)}/gate-token`, purpose ? { purpose } : {});
export const scanGatePass   = (token) => call("POST", "/api/gate/scan", { token });
export const getAgentSites  = () => call("GET", "/api/gate/agent/sites");
export const getAgentTrips  = () => call("GET", "/api/gate/agent/trips");

/** Operational wording for an agent. Domain event names never reach the driver screen. */
export const AGENT_EVENT_LABEL = {
  GATE_IN: "Gate entry recorded",
  LOADING_STARTED: "Loading started",
  LOADING_COMPLETED: "Loading completed",
};
const NEXT_STEP_LABEL = { GATE_IN: "Gate entry", LOADING_STARTED: "Start loading", LOADING_COMPLETED: "Complete loading" };
export const nextStepLabel = (e) => NEXT_STEP_LABEL[e] || null;

export const SCAN_ERROR_TEXT = {
  GATE_TOKEN_INVALID: "This is not a valid Behari gate pass.",
  GATE_TOKEN_USED: "This gate pass was already used. Ask the driver to show the current pass.",
  GATE_TOKEN_REVOKED: "This gate pass was replaced by a newer one. Ask the driver to show the current pass.",
  GATE_TOKEN_EXPIRED: "This gate pass has expired. Ask the driver to refresh it.",
  GATE_AGENT_NOT_AUTHORIZED: "This truck is not booked at your loading site.",
  GATE_SITE_INACTIVE: "This loading site is not active.",
  GATE_ASSIGNMENT_MISMATCH: "This pass was issued to a driver who is no longer assigned to this trip.",
  GATE_NOT_FUNDED: "This trip is not cleared for loading.",
  GATE_WRONG_TRIP_STATE: "This truck is not at a stage where this step is allowed.",
  GATE_DUPLICATE_EVENT: "This step was already recorded.",
  GATE_SEQUENCE: "This step is out of order.",
};

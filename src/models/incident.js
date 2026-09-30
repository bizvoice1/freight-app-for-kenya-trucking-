/**
 * src/models/incident.js
 * ----------------------
 * Domain model for operational incidents on the Behari Freight network.
 *
 * Incidents are admin-only records — they are NOT part of the shared
 * load lifecycle (loadService.js). They live in adminService._adminStore.
 *
 * Lifecycle: OPEN → IN_PROGRESS → RESOLVED
 *
 * Supported types: accident, theft, cargo damage, police incident,
 *   border detention, severe weather, road closure, truck breakdown.
 */

/* ── Incident type registry ────────────────────────────────────────────── */

export const INCIDENT_TYPES = {
  ACCIDENT:     { id:"ACCIDENT",     label:"Road Accident",    icon:"🚨", color:"#C0392B" },
  THEFT:        { id:"THEFT",        label:"Cargo Theft",      icon:"🔓", color:"#C0392B" },
  CARGO_DAMAGE: { id:"CARGO_DAMAGE", label:"Cargo Damage",     icon:"📦", color:"#E07B39" },
  POLICE:       { id:"POLICE",       label:"Police Incident",  icon:"👮", color:"#E07B39" },
  BORDER:       { id:"BORDER",       label:"Border Detention", icon:"🛃", color:"#E07B39" },
  WEATHER:      { id:"WEATHER",      label:"Severe Weather",   icon:"⛈",  color:"#9B59B6" },
  ROAD_CLOSURE: { id:"ROAD_CLOSURE", label:"Road Closure",     icon:"🚧", color:"#E07B39" },
  BREAKDOWN:    { id:"BREAKDOWN",    label:"Truck Breakdown",  icon:"🔧", color:"#276EF1" },
};

export const INCIDENT_SEVERITY = {
  CRITICAL: { id:"CRITICAL", label:"Critical", color:"#C0392B", bg:"#FDE8E3", priority:0 },
  HIGH:     { id:"HIGH",     label:"High",     color:"#C0392B", bg:"#FDE8E3", priority:1 },
  MEDIUM:   { id:"MEDIUM",   label:"Medium",   color:"#E07B39", bg:"#FFF3E0", priority:2 },
  LOW:      { id:"LOW",      label:"Low",      color:"#06C167", bg:"#E6F9F0", priority:3 },
};

export const INCIDENT_STATUS = {
  OPEN:        "Open",
  IN_PROGRESS: "In Progress",
  RESOLVED:    "Resolved",
};

/* ── Factory ───────────────────────────────────────────────────────────── */

/**
 * Creates a new incident record.
 * @param {Object} params
 * @param {string} params.type        - key from INCIDENT_TYPES
 * @param {string} params.severity    - key from INCIDENT_SEVERITY
 * @param {string} [params.loadId]    - affected load ID (null for network-wide)
 * @param {string} params.location    - human-readable location
 * @param {string} params.description - full incident description
 * @param {Object} [params.gps]       - { lat, lng } coordinates
 * @param {string} [params.officer]   - assigned operations officer
 */
export function createIncident({ type, severity, loadId, location, description, gps, officer }) {
  const now = new Date();
  const stamp = now.toLocaleDateString("en-KE", { day:"numeric", month:"short" }) + ", " +
                now.toLocaleTimeString("en-KE", { hour:"2-digit", minute:"2-digit" });
  return {
    id:          `INC-${Date.now().toString().slice(-5)}`,
    type:        type || "BREAKDOWN",
    severity:    severity || "MEDIUM",
    loadId:      loadId   || null,
    location:    location || "Unknown",
    description: description || "",
    gps:         gps      || null,
    officer:     officer  || "Unassigned",
    status:      INCIDENT_STATUS.OPEN,
    timeline:    [{ event:"Incident reported", at: now.toLocaleTimeString("en-KE",{hour:"2-digit",minute:"2-digit"}) }],
    evidence:    [],
    createdAt:   stamp,
    resolvedAt:  null,
    resolution:  null,
  };
}

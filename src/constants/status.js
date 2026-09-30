/**
 * src/constants/status.js
 * Shared label→color maps used by all three portals.
 * Keeps status badge styling consistent across carrier, shipper, and admin views.
 */

import { COLORS as C } from "./theme.js";

export const STATUS_MAP = {
  "Accepted":           { c: C.blue,   b: C.blueBg   },
  "Loading":            { c: C.amber,  b: C.amberBg  },
  "In Transit":         { c: C.blue,   b: C.blueBg   },
  "Arrived":            { c: C.teal,   b: C.tealBg   },
  "Delivery Confirmed": { c: C.green,  b: C.greenBg  },
  "Delivered":          { c: C.green,  b: C.greenBg  },
  "Paid Out":           { c: C.green,  b: C.greenBg  },
  "Escrow Held":        { c: C.amber,  b: C.amberBg  },
  "Cancelled":          { c: C.red,    b: C.redBg    },
  "Open":               { c: C.red,    b: C.redBg    },
  "In Review":          { c: C.amber,  b: C.amberBg  },
  "Resolved":           { c: C.green,  b: C.greenBg  },
  "In Progress":        { c: C.blue,   b: C.blueBg   },
  "OPEN":               { c: C.red,    b: C.redBg    },
  "IN_PROGRESS":        { c: C.blue,   b: C.blueBg   },
  "RESOLVED":           { c: C.green,  b: C.greenBg  },
};

export const RISK_MAP = {
  "Low":    { c: C.green, b: C.greenBg },
  "Medium": { c: C.amber, b: C.amberBg },
  "High":   { c: C.red,   b: C.redBg   },
};

export const PRI_MAP = {
  "High":   { c: C.red,   b: C.redBg   },
  "Medium": { c: C.amber, b: C.amberBg },
  "Low":    { c: C.green, b: C.greenBg },
};

export const SEV_MAP = {
  "CRITICAL": { c: C.red,   b: C.redBg   },
  "HIGH":     { c: C.red,   b: C.redBg   },
  "MEDIUM":   { c: C.amber, b: C.amberBg },
  "LOW":      { c: C.green, b: C.greenBg },
};

/**
 * src/context/FreightContext.jsx
 * Shared context for all load-lifecycle state and callbacks.
 * Eliminates the 35-prop drilling chain from App.jsx → portals.
 *
 * Usage:
 *   // Provider (App.jsx):
 *   <FreightContext.Provider value={sharedProps}>
 *     <Portal />
 *   </FreightContext.Provider>
 *
 *   // Consumer (any component):
 *   const { postedLoads, onPostLoad } = useFreight();
 */

import { createContext, useContext } from "react";

export const FreightContext = createContext(null);

export function useFreight() {
  const ctx = useContext(FreightContext);
  if (!ctx) throw new Error("useFreight must be used inside FreightContext.Provider");
  return ctx;
}

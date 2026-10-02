/**
 * src/services/googleMaps.js
 * ---------------------------
 * Phase 5C-2 — loads the Google Maps JavaScript API once, only when
 * VITE_GOOGLE_MAPS_API_KEY is set. With no key (or a key Google rejects) every
 * caller gets `null` and falls back to plain text fields / the existing maps.
 */

const KEY = (typeof import.meta !== "undefined" && import.meta.env?.VITE_GOOGLE_MAPS_API_KEY) || "";

export const hasMapsKey = () => Boolean(KEY);

let _promise = null;
let _authFailed = false;

/** Resolves to `window.google.maps` or `null` when unavailable. Never rejects. */
export function loadGoogleMaps() {
  if (!KEY || _authFailed || typeof window === "undefined") return Promise.resolve(null);
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google.maps);
  if (_promise) return _promise;

  _promise = new Promise((resolve) => {
    window.gm_authFailure = () => { _authFailed = true; _promise = null; resolve(null); };
    const cb = "__behariMapsReady";
    window[cb] = () => resolve(window.google?.maps || null);
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY)}&loading=async&callback=${cb}&v=weekly`;
    s.async = true;
    s.onerror = () => { _promise = null; resolve(null); };
    document.head.appendChild(s);
  }).then(async (maps) => {
    if (!maps) return null;
    try {
      await Promise.all([maps.importLibrary("maps"), maps.importLibrary("marker"), maps.importLibrary("places")]);
      return maps;
    } catch { return null; }
  });
  return _promise;
}

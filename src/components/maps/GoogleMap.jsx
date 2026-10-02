/**
 * GoogleMap — thin wrapper over the Maps JavaScript API.
 *
 * props:
 *   markers  [{ id, lat, lng, label?, color?, title?, onClick? }]
 *   path     [{lat,lng}] — polyline (the road route), optional
 *   pathColor
 *   fit      fit bounds to markers + path (default true)
 *   follow   keep the first marker centred as it moves (live positions)
 *   height   css height
 *   onUnavailable()  called once if Maps can't load (no key / rejected key)
 *
 * Markers are plain DOM pins (AdvancedMarkerElement with Google's DEMO_MAP_ID),
 * updated in place on prop change so a live truck marker moves without the
 * map re-initialising.
 */
import { useEffect, useRef } from "react";
import { loadGoogleMaps } from "../../services/googleMaps.js";

const KENYA = { lat: -0.5, lng: 37.5 };

function pinEl(m) {
  const el = document.createElement("div");
  const c = m.color || "#E8541A";
  el.style.cssText = `display:flex;align-items:center;gap:4px;transform:translateY(-4px);cursor:${m.onClick ? "pointer" : "default"}`;
  const dot = document.createElement("div");
  dot.style.cssText = `width:16px;height:16px;border-radius:50%;background:${c};border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);flex:none`;
  el.appendChild(dot);
  if (m.label) {
    const t = document.createElement("div");
    t.textContent = m.label;
    t.style.cssText = "background:#fff;color:#111;font:700 11px system-ui,sans-serif;padding:2px 6px;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.35);white-space:nowrap";
    el.appendChild(t);
  }
  return el;
}

export default function GoogleMap({ markers = [], path = null, pathColor = "#E8541A", fit = true, follow = false, height = 220, onUnavailable, style }) {
  const hostRef = useRef(null);
  const mapRef  = useRef(null);
  const mapsRef = useRef(null);
  const pinsRef = useRef(new Map());
  const lineRef = useRef(null);
  const fittedRef = useRef(false);
  const unavailRef = useRef(onUnavailable);
  unavailRef.current = onUnavailable;

  useEffect(() => {
    let alive = true;
    loadGoogleMaps().then(maps => {
      if (!alive) return;
      if (!maps) { unavailRef.current?.(); return; }
      mapsRef.current = maps;
      mapRef.current = new maps.Map(hostRef.current, {
        center: KENYA, zoom: 6, mapId: "DEMO_MAP_ID",
        disableDefaultUI: true, zoomControl: true, gestureHandling: "cooperative",
      });
      sync();
    });
    return () => {
      alive = false;
      pinsRef.current.forEach(p => { p.map = null; });
      pinsRef.current.clear();
      lineRef.current?.setMap(null);
      lineRef.current = null;
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sync() {
    const maps = mapsRef.current, map = mapRef.current;
    if (!maps || !map) return;
    const seen = new Set();
    markers.forEach(m => {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) return;
      seen.add(m.id);
      let pin = pinsRef.current.get(m.id);
      if (!pin) {
        pin = new maps.marker.AdvancedMarkerElement({ map, position: { lat: m.lat, lng: m.lng }, content: pinEl(m), title: m.title || m.label || "" });
        if (m.onClick) pin.addListener("click", () => m.onClick(m));
        pinsRef.current.set(m.id, pin);
      } else {
        pin.position = { lat: m.lat, lng: m.lng };
      }
    });
    pinsRef.current.forEach((pin, id) => { if (!seen.has(id)) { pin.map = null; pinsRef.current.delete(id); } });

    if (path && path.length > 1) {
      if (!lineRef.current) lineRef.current = new maps.Polyline({ map, strokeColor: pathColor, strokeOpacity: 0.9, strokeWeight: 5 });
      lineRef.current.setPath(path);
    } else if (lineRef.current) {
      lineRef.current.setMap(null); lineRef.current = null;
    }

    if (follow && markers[0] && Number.isFinite(markers[0].lat)) {
      const pos = { lat: markers[0].lat, lng: markers[0].lng };
      if (!fittedRef.current) { map.setCenter(pos); map.setZoom(13); fittedRef.current = true; }
      else map.panTo(pos);
    } else if (fit && !fittedRef.current) {
      const b = new maps.LatLngBounds();
      let n = 0;
      markers.forEach(m => { if (Number.isFinite(m.lat) && Number.isFinite(m.lng)) { b.extend({ lat: m.lat, lng: m.lng }); n++; } });
      (path || []).forEach(p => { b.extend(p); n++; });
      if (n > 1) { map.fitBounds(b, 40); fittedRef.current = true; }
      else if (n === 1) { map.setCenter(b.getCenter()); map.setZoom(9); fittedRef.current = true; }
    }
  }

  useEffect(sync); // every render: cheap diff against existing pins

  return <div ref={hostRef} style={{ width: "100%", height, ...style }} />;
}

/**
 * PlaceInput — text input with Google Places autocomplete (Places API New).
 * Without a Maps key, or if Google rejects the call, it is a plain text input,
 * so posting a load never depends on Google.
 *
 * onChange(text, place) — place is {name, placeId, lat, lng} once the user picks
 * a suggestion, and null as soon as they edit the text afterwards.
 */
import { useEffect, useRef, useState } from "react";
import { hasMapsKey, loadGoogleMaps } from "../../services/googleMaps.js";

const REGIONS = ["ke", "ug", "tz", "rw", "ss", "et"];

export default function PlaceInput({ value, onChange, placeholder, style, marginBottom = 12, pinned = false, theme = {} }) {
  const [items, setItems]   = useState([]);
  const [open, setOpen]     = useState(false);
  const [active, setActive] = useState(-1);
  const [usable, setUsable] = useState(hasMapsKey());
  const placesRef = useRef(null);
  const tokenRef  = useRef(null);
  const timerRef  = useRef(null);
  const seqRef    = useRef(0);
  const wrapRef   = useRef(null);

  useEffect(() => {
    let alive = true;
    if (!hasMapsKey()) return;
    loadGoogleMaps().then(maps => {
      if (!alive) return;
      if (!maps?.places?.AutocompleteSuggestion) { setUsable(false); return; }
      placesRef.current = maps.places;
      tokenRef.current = new maps.places.AutocompleteSessionToken();
    });
    return () => { alive = false; clearTimeout(timerRef.current); };
  }, []);

  useEffect(() => {
    const close = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function onType(text) {
    onChange(text, null);
    clearTimeout(timerRef.current);
    if (!usable || !placesRef.current || text.trim().length < 3) { setItems([]); setOpen(false); return; }
    timerRef.current = setTimeout(async () => {
      const seq = ++seqRef.current;
      try {
        const { suggestions } = await placesRef.current.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: text, sessionToken: tokenRef.current, includedRegionCodes: REGIONS,
        });
        if (seq !== seqRef.current) return;
        setItems(suggestions.filter(s => s.placePrediction).slice(0, 5));
        setActive(-1);
        setOpen(true);
      } catch {
        if (seq === seqRef.current) { setUsable(false); setItems([]); setOpen(false); }
      }
    }, 250);
  }

  async function choose(s) {
    const pred = s.placePrediction;
    const label = pred.text?.text || "";
    setOpen(false); setItems([]);
    onChange(label, null);
    try {
      const place = pred.toPlace();
      await place.fetchFields({ fields: ["id", "displayName", "location"] });
      const loc = place.location;
      onChange(label, { name: label, placeId: place.id, lat: loc.lat(), lng: loc.lng() });
      tokenRef.current = new placesRef.current.AutocompleteSessionToken();
    } catch {
      onChange(label, null);
    }
  }

  function onKey(e) {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => (a + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => (a <= 0 ? items.length - 1 : a - 1)); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
  }

  const { bg = "#fff", border = "#ddd", text = "#111", muted = "#888", ok = "#0a7d3b" } = theme;
  return (
    <div ref={wrapRef} style={{ position: "relative", marginBottom }}>
      <input
        style={{ ...style, marginBottom: 0 }}
        placeholder={placeholder}
        value={value}
        onChange={e => onType(e.target.value)}
        onKeyDown={onKey}
        onFocus={() => items.length && setOpen(true)}
        autoComplete="off"
        role={usable ? "combobox" : undefined}
        aria-expanded={usable ? open : undefined}
      />
      {pinned && <div style={{ fontSize: 11, color: ok, fontWeight: 600, marginTop: 4 }}>✓ Location pinned on map</div>}
      {open && items.length > 0 && (
        <div role="listbox" style={{ position: "absolute", left: 0, right: 0, top: "100%", marginTop: 2, background: bg, border: `1px solid ${border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.18)", zIndex: 50, overflow: "hidden" }}>
          {items.map((s, i) => (
            <div key={s.placePrediction.placeId || i} role="option" aria-selected={i === active}
              onMouseDown={e => { e.preventDefault(); choose(s); }}
              onMouseEnter={() => setActive(i)}
              style={{ padding: "10px 12px", fontSize: 13, color: text, cursor: "pointer", background: i === active ? border : "transparent", lineHeight: 1.3 }}>
              {s.placePrediction.text?.text}
            </div>
          ))}
          <div style={{ padding: "4px 12px", fontSize: 10, color: muted, textAlign: "right" }}>Powered by Google</div>
        </div>
      )}
    </div>
  );
}

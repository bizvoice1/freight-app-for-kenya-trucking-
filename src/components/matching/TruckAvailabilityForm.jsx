/**
 * src/components/matching/TruckAvailabilityForm.jsx
 * "Declare Truck Availability" — the carrier tells Behari where their truck
 * will be free, when, and which way it's heading. This feeds directly into
 * the matching engine (useMatching().declareAvailability).
 *
 * Plain props only — the parent owns fleet/cargo-type option lists (which
 * live in data/*.js) and passes them down, keeping this component free of
 * any data/service imports.
 */
import { useState } from "react";
import { COLORS as C, FONT as font } from "../../constants/theme.js";

const TOWNS = ["Nairobi", "Mombasa", "Nakuru", "Eldoret", "Kisumu", "Naivasha", "Athi River", "Thika", "Kericho", "Kampala"];

const inp = { width:"100%", background:C.bg, border:`1.5px solid ${C.border}`, borderRadius:8, padding:"11px 13px", fontSize:13, fontFamily:font, color:C.black, outline:"none", marginBottom:12, boxSizing:"border-box" };
const lbl = { display:"block", fontSize:11, fontWeight:700, color:C.secondary, letterSpacing:0.6, textTransform:"uppercase", marginBottom:5 };

export default function TruckAvailabilityForm({ fleet = [], onSubmit = () => {}, submitting = false }) {
  const [form, setForm] = useState({
    plate: fleet[0]?.plate || "",
    truckType: fleet[0]?.type || "",
    capacity: "",
    currentLocationName: "",
    currentTripFrom: "",
    currentTripTo: "",
    availableDate: "",
    availableTime: "",
    goingToward: "",
    acceptsPartial: false,
    maxDetourKm: 30,
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const valid = form.currentLocationName.trim() && form.goingToward.trim() && form.truckType.trim();

  function handleSubmit() {
    if (!valid) return;
    let availableFrom = new Date().toISOString();
    if (form.availableDate) {
      const [h, m] = (form.availableTime || "00:00").split(":").map(Number);
      const d = new Date(form.availableDate);
      d.setHours(h || 0, m || 0, 0, 0);
      availableFrom = d.toISOString();
    }
    onSubmit({ ...form, availableFrom, maxDetourKm: Number(form.maxDetourKm) || 30 });
  }

  return (
    <div>
      <label style={lbl}>Truck</label>
      {fleet.length > 0 ? (
        <select style={inp} value={form.plate} onChange={e => {
          const t = fleet.find(f => f.plate === e.target.value);
          setForm(f => ({ ...f, plate: e.target.value, truckType: t?.type || f.truckType }));
        }}>
          {fleet.map(t => <option key={t.plate} value={t.plate}>{t.plate} · {t.type}</option>)}
        </select>
      ) : (
        <input style={inp} placeholder="e.g. KDJ 441Z" value={form.plate} onChange={e => set("plate", e.target.value.toUpperCase())} />
      )}

      <div style={{ display:"grid", gridTemplateColumns:"1fr 100px", gap:10 }}>
        <div>
          <label style={lbl}>Truck Type</label>
          <input style={inp} placeholder="e.g. 10-Tonne Rigid" value={form.truckType} onChange={e => set("truckType", e.target.value)} />
        </div>
        <div>
          <label style={lbl}>Capacity</label>
          <input style={inp} placeholder="10T" value={form.capacity} onChange={e => set("capacity", e.target.value)} />
        </div>
      </div>

      <label style={lbl}>Current Location</label>
      <input style={inp} list="behari-towns" placeholder="e.g. Nakuru" value={form.currentLocationName} onChange={e => set("currentLocationName", e.target.value)} />

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        <div>
          <label style={lbl}>Current Trip From</label>
          <input style={inp} list="behari-towns" placeholder="e.g. Nairobi" value={form.currentTripFrom} onChange={e => set("currentTripFrom", e.target.value)} />
        </div>
        <div>
          <label style={lbl}>Current Trip To</label>
          <input style={inp} list="behari-towns" placeholder="e.g. Nakuru" value={form.currentTripTo} onChange={e => set("currentTripTo", e.target.value)} />
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        <div>
          <label style={lbl}>Available From (date)</label>
          <input type="date" style={inp} value={form.availableDate} onChange={e => set("availableDate", e.target.value)} />
        </div>
        <div>
          <label style={lbl}>Time</label>
          <input type="time" style={inp} value={form.availableTime} onChange={e => set("availableTime", e.target.value)} />
        </div>
      </div>

      <label style={lbl}>Going Toward / Return Direction</label>
      <input style={inp} list="behari-towns" placeholder="e.g. Nairobi" value={form.goingToward} onChange={e => set("goingToward", e.target.value)} />
      <datalist id="behari-towns">{TOWNS.map(t => <option key={t} value={t} />)}</datalist>

      <label style={lbl}>Maximum Acceptable Detour (km)</label>
      <input type="number" min="0" style={inp} value={form.maxDetourKm} onChange={e => set("maxDetourKm", e.target.value)} />

      <div
        onClick={() => set("acceptsPartial", !form.acceptsPartial)}
        style={{ display:"flex", alignItems:"center", gap:10, background:C.bg, border:`1.5px solid ${form.acceptsPartial ? C.black : C.border}`, borderRadius:8, padding:"11px 13px", marginBottom:16, cursor:"pointer" }}
      >
        <div style={{ width:38, height:22, borderRadius:11, background:form.acceptsPartial ? C.black : C.border, position:"relative", flexShrink:0, transition:"background .15s" }}>
          <div style={{ width:16, height:16, borderRadius:"50%", background:C.white, position:"absolute", top:3, left:form.acceptsPartial ? 19 : 3, transition:"left .15s" }} />
        </div>
        <div style={{ fontSize:13, fontWeight:600, color:C.black }}>Accept partial loads</div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={!valid || submitting}
        style={{ width:"100%", background:valid && !submitting ? C.black : C.border, color:valid && !submitting ? C.white : C.muted, border:"none", borderRadius:8, padding:14, fontSize:14, fontWeight:800, cursor:valid && !submitting ? "pointer" : "not-allowed", fontFamily:font }}
      >
        {submitting ? "Declaring…" : "Declare Truck Availability →"}
      </button>
    </div>
  );
}

import { useState, useRef } from "react";
import { TRUCK_TYPES } from "./data/reference.js";

const C = {
  white:"#FFFFFF", bg:"#F6F6F6", border:"#EBEBEB",
  muted:"#9E9E9E", secondary:"#545454", black:"#000000",
  green:"#06C167", greenBg:"#E6F9F0",
  red:"#C0392B",   redBg:"#FDE8E3",
  amber:"#E07B39", amberBg:"#FFF3E0",
  blue:"#276EF1",  blueBg:"#EFF3FE",
};
const card  = { background:C.white, borderRadius:12, border:`1px solid ${C.border}`, boxShadow:"0 1px 4px rgba(0,0,0,0.06)" };
const font  = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";
const inp   = { width:"100%", background:C.bg, border:`1.5px solid ${C.border}`, borderRadius:8, padding:"12px 14px", fontSize:14, fontFamily:font, color:C.black, outline:"none", fontWeight:500, transition:"border-color 0.15s" };
const lbl   = { display:"block", fontSize:11, fontWeight:700, color:C.secondary, letterSpacing:0.8, textTransform:"uppercase", marginBottom:5 };

// TRUCK_TYPES is imported from the data layer — same vocabulary a shipper
// picks from when specifying a load's required truck type (src/data/reference.js),
// so a transporter can always register the type of truck a shipper might need.
const CAPACITIES    = ["3T","5T","7T","10T","14T","18T","22T","26T","28T","30T","34T"];

const DOCS = [
  { key:"id",       label:"National ID",               hint:"Both sides · JPG, PNG or PDF",       required:true  },
  { key:"licence",  label:"Driver's Licence (CE)",     hint:"Current valid licence · JPG or PDF", required:true  },
  { key:"logbook",  label:"Truck Logbook",             hint:"Vehicle registration logbook · PDF", required:true  },
  { key:"git",      label:"GIT Insurance Certificate", hint:"Goods in Transit policy · PDF",      required:true  },
  { key:"ntsa",     label:"NTSA Inspection Certificate",hint:"Current year · PDF",               required:true  },
  { key:"kra",      label:"KRA PIN Certificate",       hint:"For tax compliance · PDF",           required:true  },
  { key:"gvl",      label:"Goods Vehicle Licence",     hint:"Issued by NTSA · PDF",               required:false },
];

const STEPS = ["Personal Info","Truck Details","Documents","Review & Submit"];

/* ── Helpers ────────────────────────────────────────────── */
function Field({ label, required, children }) {
  return (
    <div style={{ marginBottom:14 }}>
      <label style={lbl}>{label}{required && <span style={{ color:C.red }}> *</span>}</label>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, type="text", ...rest }) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      value={value} onChange={onChange} placeholder={placeholder} type={type}
      onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
      style={{ ...inp, borderColor: focused ? C.black : C.border }}
      {...rest}
    />
  );
}

function Select({ value, onChange, children }) {
  return (
    <select value={value} onChange={onChange}
      style={{ ...inp, appearance:"none", backgroundImage:"url(\"data:image/svg+xml,%3Csvg width='12' height='8' viewBox='0 0 12 8' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L6 7L11 1' stroke='%23545454' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")", backgroundRepeat:"no-repeat", backgroundPosition:"right 14px center", paddingRight:36 }}>
      {children}
    </select>
  );
}

/* ── Date of Birth picker (3 dropdowns, unified border) ─── */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const chevron = "url(\"data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%23545454' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

const segSel = {
  background:"transparent", border:"none", outline:"none",
  fontFamily:"Inter, -apple-system, sans-serif", fontSize:14, fontWeight:500,
  color:"#000", cursor:"pointer", appearance:"none",
  backgroundImage: chevron, backgroundRepeat:"no-repeat",
  backgroundPosition:"right 6px center", paddingRight:22,
  height:"100%", width:"100%",
};

function DobPicker({ value, onChange }) {
  const [focused, setFocused] = useState(false);

  // Own internal state so partial picks aren't lost on re-render
  const init = value ? value.split("-") : ["","",""];
  const [year,  setYear]  = useState(init[0] || "");
  const [month, setMonth] = useState(init[1] || "");
  const [day,   setDay]   = useState(init[2] || "");

  function commit(y, m, d) {
    // Only surface a value to the parent when all three are chosen
    onChange(y && m && d ? `${y}-${m}-${d}` : "");
  }

  const daysInMonth = year && month ? new Date(+year, +month, 0).getDate() : 31;
  const days  = Array.from({ length: daysInMonth }, (_, i) => String(i + 1).padStart(2,"0"));
  const years = Array.from({ length: 76 }, (_, i) => String(2005 - i));

  const divider = (
    <div style={{ width:1, background: focused ? "#aaa" : C.border, alignSelf:"stretch", margin:"8px 0", flexShrink:0 }} />
  );

  return (
    <div
      onFocus={() => setFocused(true)}
      onBlur={()  => setFocused(false)}
      style={{
        display:"flex", alignItems:"center",
        background:C.bg, border:`1.5px solid ${focused ? C.black : C.border}`,
        borderRadius:8, height:46, overflow:"hidden", transition:"border-color 0.15s",
      }}
    >
      {/* Day */}
      <select
        value={day}
        onChange={e => { setDay(e.target.value); commit(year, month, e.target.value); }}
        style={{ ...segSel, paddingLeft:14, flex:"0 0 72px" }}
      >
        <option value="">DD</option>
        {days.map(d => <option key={d} value={d}>{d}</option>)}
      </select>

      {divider}

      {/* Month */}
      <select
        value={MONTHS[+month - 1] || ""}
        onChange={e => {
          const idx = String(MONTHS.indexOf(e.target.value) + 1).padStart(2,"0");
          setMonth(idx);
          commit(year, idx, day);
        }}
        style={{ ...segSel, paddingLeft:10, flex:"1 1 0", minWidth:0 }}
      >
        <option value="">Month</option>
        {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
      </select>

      {divider}

      {/* Year */}
      <select
        value={year}
        onChange={e => { setYear(e.target.value); commit(e.target.value, month, day); }}
        style={{ ...segSel, paddingLeft:10, flex:"0 0 88px" }}
      >
        <option value="">Year</option>
        {years.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}

/* ── Document Upload Row ────────────────────────────────── */
function DocUpload({ doc, uploaded, onUpload }) {
  const ref = useRef();
  const [uploading, setUploading] = useState(false);
  const [fileName,  setFileName]  = useState(null);
  const [preview,   setPreview]   = useState(null); // dataURL for images

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = ev => {
      const isImg = file.type.startsWith("image/");
      setPreview(isImg ? ev.target.result : null);
      // Simulate brief upload delay then commit
      setTimeout(() => {
        setUploading(false);
        onUpload(doc.key, file.name);
      }, 600);
    };
    reader.readAsDataURL(file);
    e.target.value = ""; // allow re-select of same file
  }

  const done = uploaded[doc.key];

  return (
    <div style={{ ...card, padding:"14px 16px", marginBottom:8 }}>
      <div style={{ display:"flex", alignItems:"center", gap:14 }}>
        {/* Thumbnail or status icon */}
        <div style={{
          width:44, height:44, borderRadius:10, flexShrink:0, overflow:"hidden",
          display:"flex", alignItems:"center", justifyContent:"center",
          background: done ? C.greenBg : uploading ? C.amberBg : C.bg,
          border: done && preview ? "none" : `1px solid ${C.border}`,
          fontSize:18,
        }}>
          {done && preview
            ? <img src={preview} alt={doc.label} style={{ width:"100%",height:"100%",objectFit:"cover" }} />
            : uploading ? "⏳" : done ? "✓" : "📄"
          }
        </div>

        {/* Info */}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
            <span style={{ fontSize:14, fontWeight:700, color:C.black }}>{doc.label}</span>
            {doc.required && <span style={{ fontSize:10, fontWeight:700, color:C.red, background:C.redBg, borderRadius:100, padding:"1px 7px" }}>Required</span>}
          </div>
          {done
            ? <div style={{ fontSize:12, color:C.green, fontWeight:600 }}>✓ {done}</div>
            : uploading
              ? <div style={{ fontSize:12, color:C.amber, fontWeight:600 }}>Reading {fileName}…</div>
              : <div style={{ fontSize:12, color:C.muted }}>{doc.hint}</div>
          }
        </div>

        {/* Upload button */}
        <input ref={ref} type="file" accept=".jpg,.jpeg,.png,.pdf" style={{ display:"none" }} onChange={handleFile} />
        <button
          onClick={()=>ref.current.click()}
          disabled={uploading}
          style={{
            background: done ? C.white : C.black, color: done ? C.black : C.white,
            border: `1.5px solid ${done ? C.border : C.black}`,
            borderRadius:8, padding:"8px 14px", fontSize:12, fontWeight:700,
            cursor:"pointer", fontFamily:font, flexShrink:0, opacity:uploading?0.5:1,
          }}
        >
          {done ? "Replace" : "Upload"}
        </button>
      </div>

      {/* Full-width image preview strip when it's an image file */}
      {done && preview && (
        <div style={{ marginTop:10, borderRadius:8, overflow:"hidden", height:80, background:C.bg }}>
          <img src={preview} alt={`${doc.label} preview`} style={{ width:"100%",height:"100%",objectFit:"cover" }} />
        </div>
      )}
    </div>
  );
}

/* ── Step 1: Personal Info ──────────────────────────────── */
function StepPersonal({ form, set }) {
  return (
    <>
      <div style={{ fontSize:22, fontWeight:800, color:C.black, marginBottom:4 }}>Personal Information</div>
      <div style={{ fontSize:14, color:C.muted, marginBottom:24 }}>We need to verify your identity before you can start hauling.</div>

      <Field label="Full Legal Name" required>
        <Input value={form.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. James Kiprotich Mwangi" />
      </Field>
      <Field label="Phone Number" required>
        <Input value={form.phone} onChange={e=>set("phone",e.target.value)} placeholder="+254 7XX XXX XXX" type="tel" />
      </Field>
      <Field label="Email Address">
        <Input value={form.email} onChange={e=>set("email",e.target.value)} placeholder="james@example.com" type="email" />
      </Field>

      <Field label="National ID Number" required>
        <Input value={form.idNumber} onChange={e=>set("idNumber",e.target.value)} placeholder="e.g. 12345678" />
      </Field>
      <Field label="Date of Birth" required>
        <DobPicker value={form.dob} onChange={v=>set("dob",v)} />
      </Field>

      <Field label="County / Region" required>
        <Select value={form.county} onChange={e=>set("county",e.target.value)}>
          <option value="">Select county…</option>
          {["Nairobi","Mombasa","Kisumu","Nakuru","Eldoret (Uasin Gishu)","Machakos","Kajiado","Muranga","Nyeri","Other"].map(c=><option key={c}>{c}</option>)}
        </Select>
      </Field>

      <Field label="Years of Driving Experience" required>
        <Select value={form.experience} onChange={e=>set("experience",e.target.value)}>
          <option value="">Select…</option>
          {["Less than 1 year","1–2 years","3–5 years","6–10 years","More than 10 years"].map(x=><option key={x}>{x}</option>)}
        </Select>
      </Field>

      <Field label="Referral Code (optional)">
        <Input value={form.referral} onChange={e=>set("referral",e.target.value)} placeholder="e.g. BF-2024-REF" />
      </Field>
    </>
  );
}

/* ── Step 2: Truck Details ──────────────────────────────── */
function StepTruck({ form, set }) {
  return (
    <>
      <div style={{ fontSize:22, fontWeight:800, color:C.black, marginBottom:4 }}>Truck Details</div>
      <div style={{ fontSize:14, color:C.muted, marginBottom:24 }}>Tell us about the vehicle you'll be using on the platform.</div>

      <Field label="Number Plate" required>
        <Input value={form.plate} onChange={e=>set("plate",e.target.value.toUpperCase())} placeholder="e.g. KDJ 441Z" />
      </Field>

      <Field label="Truck Type" required>
        <Select value={form.truckType} onChange={e=>set("truckType",e.target.value)}>
          <option value="">Select type…</option>
          {TRUCK_TYPES.map(t=><option key={t}>{t}</option>)}
        </Select>
      </Field>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
        <Field label="Load Capacity" required>
          <Select value={form.capacity} onChange={e=>set("capacity",e.target.value)}>
            <option value="">Select…</option>
            {CAPACITIES.map(c=><option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Year of Manufacture" required>
          <Select value={form.year} onChange={e=>set("year",e.target.value)}>
            <option value="">Year…</option>
            {Array.from({length:20},(_,i)=>2024-i).map(y=><option key={y}>{y}</option>)}
          </Select>
        </Field>
      </div>

      <Field label="Make & Model" required>
        <Input value={form.makeModel} onChange={e=>set("makeModel",e.target.value)} placeholder="e.g. Isuzu FVZ 34, Mercedes Actros" />
      </Field>

      <Field label="Number of Trucks on this Account">
        <Select value={form.fleetSize} onChange={e=>set("fleetSize",e.target.value)}>
          <option value="">Select…</option>
          {["1 (owner-operator)","2–5","6–10","11–20","20+"].map(s=><option key={s}>{s}</option>)}
        </Select>
      </Field>

      <Field label="Primary Operating Routes">
        <Select value={form.routes} onChange={e=>set("routes",e.target.value)}>
          <option value="">Select main corridor…</option>
          {["Mombasa → Nairobi","Nairobi → Kisumu","Eldoret → Nairobi","Nairobi → Kampala","Nairobi → Dar es Salaam","Countrywide"].map(r=><option key={r}>{r}</option>)}
        </Select>
      </Field>

      <div style={{ background:C.blueBg, borderRadius:8, padding:"12px 14px", fontSize:13, color:C.blue, fontWeight:600 }}>
        ℹ️ All trucks must have valid NTSA inspection and GIT insurance to be activated on the platform.
      </div>
    </>
  );
}

/* ── Step 3: Documents ──────────────────────────────────── */
function StepDocs({ uploaded, onUpload }) {
  const required = DOCS.filter(d=>d.required);
  const optional = DOCS.filter(d=>!d.required);
  const doneCount = Object.keys(uploaded).length;
  const reqDone   = required.filter(d=>uploaded[d.key]).length;

  return (
    <>
      <div style={{ fontSize:22, fontWeight:800, color:C.black, marginBottom:4 }}>Supporting Documents</div>
      <div style={{ fontSize:14, color:C.muted, marginBottom:16 }}>Upload clear, legible copies. Max 5 MB per file.</div>

      {/* Progress */}
      <div style={{ ...card, padding:"14px 16px", marginBottom:20, display:"flex", alignItems:"center", gap:14 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:12, color:C.muted, fontWeight:600, marginBottom:6 }}>{doneCount} of {DOCS.length} documents uploaded · {reqDone}/{required.length} required</div>
          <div style={{ height:4, background:C.border, borderRadius:2, overflow:"hidden" }}>
            <div style={{ height:"100%", width:`${(doneCount/DOCS.length)*100}%`, background:doneCount===DOCS.length?C.green:C.black, transition:"width 0.4s" }} />
          </div>
        </div>
        <div style={{ fontSize:24, fontWeight:800, color:doneCount===DOCS.length?C.green:C.black }}>{Math.round((doneCount/DOCS.length)*100)}%</div>
      </div>

      <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:0.8, textTransform:"uppercase", marginBottom:8 }}>Required</div>
      {required.map(d=><DocUpload key={d.key} doc={d} uploaded={uploaded} onUpload={onUpload} />)}

      <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:0.8, textTransform:"uppercase", margin:"16px 0 8px" }}>Optional (speeds up approval)</div>
      {optional.map(d=><DocUpload key={d.key} doc={d} uploaded={uploaded} onUpload={onUpload} />)}

      <div style={{ background:C.amberBg, borderRadius:8, padding:"12px 14px", marginTop:12, fontSize:13, color:C.amber, fontWeight:600 }}>
        ⚠ Incomplete or blurry documents will delay your approval. Ensure all text is clearly readable.
      </div>
    </>
  );
}

/* ── Step 4: Review ─────────────────────────────────────── */
function StepReview({ form, uploaded }) {
  const reqDocs  = DOCS.filter(d=>d.required);
  const missing  = reqDocs.filter(d=>!uploaded[d.key]);

  return (
    <>
      <div style={{ fontSize:22, fontWeight:800, color:C.black, marginBottom:4 }}>Review Your Application</div>
      <div style={{ fontSize:14, color:C.muted, marginBottom:20 }}>Confirm your details before submitting.</div>

      {missing.length > 0 && (
        <div style={{ background:C.redBg, border:`1px solid ${C.red}33`, borderRadius:8, padding:"12px 14px", marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.red, marginBottom:6 }}>⚠ Missing required documents:</div>
          {missing.map(d=><div key={d.key} style={{ fontSize:12, color:C.red, marginBottom:2 }}>· {d.label}</div>)}
        </div>
      )}

      {/* Personal summary */}
      <div style={{ fontSize:11, color:C.muted, fontWeight:700, letterSpacing:0.8, textTransform:"uppercase", marginBottom:8 }}>Personal Information</div>
      <div style={{ ...card, overflow:"hidden", marginBottom:14 }}>
        {[["Full Name",form.name||"—"],["Phone",form.phone||"—"],["Email",form.email||"—"],["National ID",form.idNumber||"—"],["Date of Birth",form.dob||"—"],["County",form.county||"—"],["Experience",form.experience||"—"]].map(([k,v],i,a)=>(
          <div key={k} style={{ display:"flex",justifyContent:"space-between",padding:"11px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none",background:i%2===0?C.white:C.bg }}>
            <span style={{ fontSize:13,color:C.secondary }}>{k}</span>
            <span style={{ fontSize:13,fontWeight:700,color:v==="—"?C.muted:C.black }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Truck summary */}
      <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Truck Details</div>
      <div style={{ ...card,overflow:"hidden",marginBottom:14 }}>
        {[["Number Plate",form.plate||"—"],["Truck Type",form.truckType||"—"],["Capacity",form.capacity||"—"],["Year",form.year||"—"],["Make & Model",form.makeModel||"—"],["Fleet Size",form.fleetSize||"—"],["Main Route",form.routes||"—"]].map(([k,v],i,a)=>(
          <div key={k} style={{ display:"flex",justifyContent:"space-between",padding:"11px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none",background:i%2===0?C.white:C.bg }}>
            <span style={{ fontSize:13,color:C.secondary }}>{k}</span>
            <span style={{ fontSize:13,fontWeight:700,color:v==="—"?C.muted:C.black }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Documents summary */}
      <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:8 }}>Documents</div>
      <div style={{ ...card,overflow:"hidden",marginBottom:20 }}>
        {DOCS.map((d,i,a)=>(
          <div key={d.key} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none" }}>
            <span style={{ fontSize:13,color:C.secondary }}>{d.label}</span>
            {uploaded[d.key]
              ? <span style={{ fontSize:12,fontWeight:700,color:C.green }}>✓ Uploaded</span>
              : <span style={{ fontSize:12,fontWeight:700,color:d.required?C.red:C.muted }}>{d.required?"Missing":"Not provided"}</span>
            }
          </div>
        ))}
      </div>

      <div style={{ background:C.bg,borderRadius:8,padding:"12px 14px",fontSize:12,color:C.secondary,lineHeight:1.6 }}>
        By submitting this application you confirm that all information provided is accurate and that you agree to Behari Freight's <span style={{ color:C.black,fontWeight:700 }}>Terms of Service</span> and <span style={{ color:C.black,fontWeight:700 }}>Driver Policy</span>.
      </div>
    </>
  );
}

/* ── Pending Screen ─────────────────────────────────────── */
function PendingScreen({ form, onClose }) {
  const ref = `BF-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  return (
    <div style={{ minHeight:"100vh",background:C.bg,fontFamily:font,display:"flex",flexDirection:"column" }}>
      <div style={{ background:C.white,borderBottom:`1px solid ${C.border}`,padding:"0 16px",height:56,display:"flex",alignItems:"center",gap:10 }}>
        <div style={{ width:5,height:22,background:C.green,borderRadius:3 }} />
        <span style={{ fontSize:15,fontWeight:800,color:C.black }}>Behari Freight</span>
      </div>

      <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,textAlign:"center" }}>
        {/* Animated checkmark */}
        <div style={{ width:80,height:80,borderRadius:"50%",background:C.greenBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:36,marginBottom:24 }}>✓</div>

        <div style={{ fontSize:26,fontWeight:800,color:C.black,letterSpacing:-0.5,marginBottom:8 }}>Application Submitted!</div>
        <div style={{ fontSize:15,color:C.secondary,lineHeight:1.6,maxWidth:340,marginBottom:28 }}>
          Thank you, <strong>{form.name || "Transporter"}</strong>. Your application is now under review by our KYC team.
        </div>

        {/* Reference card */}
        <div style={{ ...card,padding:"16px 20px",width:"100%",maxWidth:360,marginBottom:24,textAlign:"left" }}>
          <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:4 }}>Application Reference</div>
          <div style={{ fontSize:22,fontWeight:800,color:C.black,letterSpacing:-0.3,marginBottom:12,fontFamily:"monospace" }}>{ref}</div>
          <div style={{ fontSize:12,color:C.muted }}>Save this number for tracking your application status.</div>
        </div>

        {/* Timeline */}
        <div style={{ ...card,padding:"16px 20px",width:"100%",maxWidth:360,marginBottom:24,textAlign:"left" }}>
          <div style={{ fontSize:11,color:C.muted,fontWeight:700,letterSpacing:0.8,textTransform:"uppercase",marginBottom:14 }}>What happens next</div>
          {[
            { icon:"📋", title:"Document Review",    sub:"Our team reviews your documents",       time:"Within 2 hours",  done:true  },
            { icon:"📞", title:"Verification Call",   sub:"A quick call to confirm your details",  time:"Same day",        done:false },
            { icon:"✅", title:"Account Activation",  sub:"Your account goes live on the platform",time:"Within 24 hours", done:false },
            { icon:"📱", title:"SMS Notification",    sub:"You'll be notified via "+form.phone,    time:"Upon approval",   done:false },
          ].map((s,i,a)=>(
            <div key={i} style={{ display:"flex",gap:12,marginBottom:i<a.length-1?12:0 }}>
              <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:2 }}>
                <div style={{ width:32,height:32,borderRadius:"50%",background:s.done?C.black:C.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0 }}>{s.done?<span style={{color:C.green}}>✓</span>:s.icon}</div>
                {i<a.length-1&&<div style={{ width:1,height:16,background:C.border }} />}
              </div>
              <div style={{ paddingTop:4 }}>
                <div style={{ fontSize:13,fontWeight:700,color:C.black }}>{s.title}</div>
                <div style={{ fontSize:11,color:C.muted }}>{s.sub}</div>
                <div style={{ fontSize:11,color:C.blue,fontWeight:600,marginTop:1 }}>{s.time}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Notification note */}
        <div style={{ background:C.greenBg,borderRadius:8,padding:"12px 16px",width:"100%",maxWidth:360,marginBottom:24,fontSize:13,color:C.green,fontWeight:600,textAlign:"left" }}>
          📱 You'll receive an SMS to <strong>{form.phone||"your number"}</strong> with your approval status.
        </div>

        <button onClick={onClose} style={{ width:"100%",maxWidth:360,background:C.black,color:C.white,border:"none",borderRadius:8,padding:15,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:font }}>
          Back to Home
        </button>
      </div>
    </div>
  );
}

/* ── ROOT ───────────────────────────────────────────────── */
export default function Onboarding({ onClose }) {
  const [step, setStep]         = useState(0);
  const [submitted, setSub]     = useState(false);
  const [uploaded, setUploaded] = useState({});
  const [form, setFormRaw]      = useState({
    name:"", phone:"+254 ", email:"", idNumber:"", dob:"", county:"", experience:"", referral:"",
    plate:"", truckType:"", capacity:"", year:"", makeModel:"", fleetSize:"", routes:"",
  });
  /* OTP verification (Update) */
  const [otpStep,     setOtpStep]     = useState(false);   // show OTP screen
  const [otpCode,     setOtpCode]     = useState("");       // generated code
  const [otpEntry,    setOtpEntry]    = useState("");       // user input
  const [otpVerified, setOtpVerified] = useState(false);   // passed once
  const [otpError,    setOtpError]    = useState("");
  const [otpSending,  setOtpSending]  = useState(false);

  const set = (k,v) => setFormRaw(f=>({...f,[k]:v}));
  const onUpload = (key, name) => setUploaded(u=>({...u,[key]:name}));

  const reqDocs     = DOCS.filter(d=>d.required);
  const reqUploaded = reqDocs.filter(d=>uploaded[d.key]).length;
  /* Update — missing doc names list */
  const missingDocs = reqDocs.filter(d=>!uploaded[d.key]).map(d=>d.label);

  /* Validation per step */
  function canProceed() {
    if (step===0) return form.name && form.phone && form.idNumber && form.dob && form.county && form.experience;
    if (step===1) return form.plate && form.truckType && form.capacity && form.year && form.makeModel;
    if (step===2) return reqUploaded === reqDocs.length;
    return true;
  }

  function handleNext() {
    /* After step 0 personal info, require OTP verification first */
    if (step === 0 && !otpVerified) {
      setOtpSending(true);
      setTimeout(() => {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        setOtpCode(code);
        setOtpSending(false);
        setOtpStep(true);
        window.scrollTo(0, 0);
      }, 900);
      return;
    }
    if (step < STEPS.length - 1) { setStep(s=>s+1); window.scrollTo(0,0); }
    else { setSub(true); }
  }

  function handleVerifyOtp(e) {
    e.preventDefault();
    setOtpError("");
    if (otpEntry.trim() === otpCode) {
      setOtpVerified(true);
      setOtpStep(false);
      setStep(1);
      window.scrollTo(0, 0);
    } else {
      setOtpError("Incorrect code. Check the SMS and try again.");
    }
  }

  if (submitted) return <PendingScreen form={form} onClose={onClose} />;

  /* OTP interstitial screen */
  if (otpStep) return (
    <div style={{ minHeight:"100vh", background:C.bg, fontFamily:font }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{ background:C.white,borderBottom:`1px solid ${C.border}`,padding:"0 16px",position:"sticky",top:0,zIndex:100 }}>
        <div style={{ display:"flex",alignItems:"center",gap:12,height:52 }}>
          <button onClick={()=>{setOtpStep(false);setOtpEntry("");setOtpError("");}} style={{ background:"none",border:"none",cursor:"pointer",color:C.secondary,fontSize:20,lineHeight:1 }}>←</button>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13,fontWeight:700,color:C.black }}>Verify Your Phone</div>
            <div style={{ fontSize:11,color:C.muted }}>Step 1 of 4 · Personal Info</div>
          </div>
        </div>
        <div style={{ height:3,background:C.border,margin:"0 -16px" }}><div style={{ height:"100%",width:"0%",background:C.black }} /></div>
      </div>
      <div style={{ padding:"32px 16px", maxWidth:560, margin:"0 auto" }}>
        <div style={{ fontSize:24,fontWeight:800,color:C.black,marginBottom:6 }}>Check your phone</div>
        <div style={{ fontSize:14,color:C.secondary,marginBottom:24,lineHeight:1.6 }}>
          We sent a 6-digit verification code to <strong>{form.phone.trim()}</strong>
        </div>
        {/* Simulated SMS */}
        <div style={{ background:C.greenBg,border:`1px solid ${C.green}`,borderRadius:12,padding:"16px",marginBottom:24,display:"flex",gap:12,alignItems:"center" }}>
          <span style={{ fontSize:24 }}>📱</span>
          <div>
            <div style={{ fontSize:11,fontWeight:700,color:C.green,marginBottom:4 }}>DEMO — SMS from Behari Freight</div>
            <div style={{ fontSize:22,fontWeight:800,color:"#14532D",letterSpacing:6 }}>{otpCode}</div>
            <div style={{ fontSize:11,color:C.green,marginTop:2 }}>Valid for 10 minutes</div>
          </div>
        </div>
        <form onSubmit={handleVerifyOtp}>
          <label style={lbl}>Enter OTP Code</label>
          <input
            value={otpEntry} onChange={e=>setOtpEntry(e.target.value.replace(/\D/g,"").slice(0,6))}
            type="text" inputMode="numeric" placeholder="123456" maxLength={6} autoFocus
            style={{ ...inp, fontSize:32, letterSpacing:12, textAlign:"center", marginBottom:16, borderColor:otpError?C.red:C.border }}
          />
          {otpError && (
            <div style={{ background:C.redBg,border:`1px solid ${C.red}`,borderRadius:8,padding:"10px 14px",fontSize:13,color:C.red,fontWeight:600,marginBottom:16 }}>
              ⚠ {otpError}
            </div>
          )}
          <button type="submit" disabled={otpEntry.length<6} style={{ width:"100%",background:otpEntry.length>=6?C.black:"#C8C8C8",color:C.white,border:"none",borderRadius:8,padding:14,fontSize:15,fontWeight:700,cursor:otpEntry.length>=6?"pointer":"not-allowed",fontFamily:font }}>
            ✓ Verify & Continue
          </button>
        </form>
        <button onClick={()=>{const code=String(Math.floor(100000+Math.random()*900000));setOtpCode(code);setOtpEntry("");setOtpError("");}} style={{ width:"100%",background:"none",border:"none",color:C.green,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:font,marginTop:14,textAlign:"center" }}>
          Resend Code
        </button>
      </div>
    </div>
  );

  const progress = (step / (STEPS.length - 1)) * 100;

  return (
    <div style={{ minHeight:"100vh", background:C.bg, fontFamily:font }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        input::placeholder,select::placeholder{color:#9E9E9E}
        select option{color:#000}
      `}</style>

      {/* Sticky header */}
      <div style={{ background:C.white,borderBottom:`1px solid ${C.border}`,padding:"0 16px",position:"sticky",top:0,zIndex:100 }}>
        <div style={{ display:"flex",alignItems:"center",gap:12,height:52 }}>
          <button onClick={onClose} style={{ background:"none",border:"none",cursor:"pointer",color:C.secondary,fontSize:20,lineHeight:1,padding:"4px 2px" }}>←</button>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13,fontWeight:700,color:C.black }}>Transporter Registration</div>
            <div style={{ fontSize:11,color:C.muted }}>Step {step+1} of {STEPS.length} · {STEPS[step]}</div>
          </div>
          <div style={{ fontSize:12,fontWeight:700,color:C.black }}>{step+1}/{STEPS.length}</div>
        </div>

        {/* Progress bar */}
        <div style={{ height:3,background:C.border,margin:"0 -16px" }}>
          <div style={{ height:"100%",width:`${progress}%`,background:C.black,transition:"width 0.3s" }} />
        </div>

        {/* Step pills */}
        <div style={{ display:"flex",gap:4,padding:"8px 0",overflowX:"auto",scrollbarWidth:"none" }}>
          {STEPS.map((s,i)=>(
            <div key={s} style={{
              borderRadius:100, padding:"4px 12px", fontSize:11, fontWeight:700, whiteSpace:"nowrap",
              background: i===step?C.black:i<step?C.greenBg:"transparent",
              color: i===step?C.white:i<step?C.green:C.muted,
              border: `1px solid ${i===step?C.black:i<step?C.green:C.border}`,
              flexShrink:0,
            }}>
              {i<step?"✓ ":""}{s}
            </div>
          ))}
        </div>
      </div>

      {/* Form content */}
      <div style={{ padding:"20px 16px 100px", maxWidth:560, margin:"0 auto" }}>
        {step===0 && <StepPersonal form={form} set={set} />}
        {step===1 && <StepTruck    form={form} set={set} />}
        {step===2 && <StepDocs     uploaded={uploaded} onUpload={onUpload} />}
        {step===3 && <StepReview   form={form} uploaded={uploaded} />}
      </div>

      {/* Sticky footer */}
      <div style={{ position:"fixed",bottom:0,left:0,right:0,background:C.white,borderTop:`1px solid ${C.border}`,padding:"12px 16px 16px" }}>
        <div style={{ maxWidth:560, margin:"0 auto", display:"flex", gap:8 }}>
          {step > 0 && (
            <button onClick={()=>{setStep(s=>s-1);window.scrollTo(0,0);}} style={{ flex:1,background:C.bg,color:C.black,border:`1px solid ${C.border}`,borderRadius:8,padding:14,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>
              ← Back
            </button>
          )}
          <button
            onClick={handleNext}
            disabled={!canProceed() || otpSending}
            style={{
              flex:2, background:canProceed()&&!otpSending?C.black:"#C8C8C8", color:C.white,
              border:"none", borderRadius:8, padding:14, fontSize:15, fontWeight:700,
              cursor:canProceed()&&!otpSending?"pointer":"not-allowed", fontFamily:font, transition:"background 0.15s",
            }}
          >
            {otpSending ? "Sending OTP…" : step===0&&!otpVerified ? "Continue → Verify Phone" : step===STEPS.length-1 ? "Submit Application →" : "Continue →"}
          </button>
        </div>
        {/* Update — show missing doc names */}
        {step===2 && !canProceed() && (
          <div style={{ marginTop:8 }}>
            <div style={{ textAlign:"center",fontSize:12,color:C.red,fontWeight:600,marginBottom:4 }}>
              {reqUploaded}/{reqDocs.length} required docs uploaded · Missing:
            </div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:4,justifyContent:"center" }}>
              {missingDocs.map(name=>(
                <span key={name} style={{ background:C.redBg,color:C.red,fontSize:10,fontWeight:700,borderRadius:100,padding:"2px 8px" }}>{name}</span>
              ))}
            </div>
          </div>
        )}
        {step===0 && !canProceed() && form.name && (
          <div style={{ textAlign:"center",fontSize:12,color:C.muted,marginTop:8 }}>
            Fill in all required fields to continue
          </div>
        )}
      </div>
    </div>
  );
}

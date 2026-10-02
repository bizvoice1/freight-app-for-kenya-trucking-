/**
 * src/components/negotiation/negotiation.jsx
 * -------------------------------------------
 * 5D-3 — shared negotiation UI used by both the transporter and shipper
 * portals. Plain props only: every amount shown comes from backend records.
 */
import { useState } from "react";
import { ksh, agreedRatePerKm } from "../../models/backendLoad.js";
import { metersToKm } from "../../models/geo.js";

const P = {
  black:"#000", white:"#fff", bg:"#F6F6F6", border:"#E2E2E2", muted:"#6B6B6B", secondary:"#4B4B4B",
  green:"#06C167", greenBg:"#E6F8EF", amber:"#B26A00", amberBg:"#FFF4E0", red:"#D93025", redBg:"#FDECEA",
  blue:"#276EF1", blueBg:"#EAF1FE",
};
const font = "Inter, system-ui, sans-serif";
const btn = (bg, color, extra = {}) => ({ background:bg, color, border:"none", borderRadius:8, padding:"10px 14px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:font, ...extra });

const STATUS_STYLE = {
  PENDING:   { label:"Open", bg:P.blueBg, color:P.blue },
  ACCEPTED:  { label:"Accepted", bg:P.greenBg, color:P.green },
  REJECTED:  { label:"Rejected", bg:P.redBg, color:P.red },
  WITHDRAWN: { label:"Withdrawn", bg:P.bg, color:P.muted },
  EXPIRED:   { label:"Expired", bg:P.bg, color:P.muted },
  COUNTERED: { label:"Countered", bg:P.bg, color:P.muted },
};

function AmountInput({ value, onChange, placeholder }) {
  return (
    <input type="number" inputMode="numeric" min="1" step="1" value={value} placeholder={placeholder}
      onChange={e => onChange(e.target.value)} data-testid="offer-amount"
      style={{ flex:1, minWidth:0, padding:"10px 12px", fontSize:14, fontFamily:font, border:`1.5px solid ${P.border}`, borderRadius:8, outline:"none", color:P.black, background:P.white }} />
  );
}

/** "Make an Offer" form — opens a thread (round 1). */
export function MakeOfferForm({ postedPrice, onSubmit, onCancel }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit() {
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) { setError("Enter a whole-number amount in KSh."); return; }
    setBusy(true); setError(null);
    const r = await onSubmit(n, note.trim() || undefined);
    setBusy(false);
    if (!r.ok) setError(r.error);
  }
  return (
    <div style={{ background:P.bg, borderRadius:10, padding:12, marginTop:8 }}>
      <div style={{ fontSize:12, fontWeight:700, color:P.black, marginBottom:8 }}>Round 1 · Your offer{postedPrice ? ` (posted ${ksh(postedPrice)})` : ""}</div>
      <div style={{ display:"flex", gap:8, marginBottom:8 }}>
        <AmountInput value={amount} onChange={setAmount} placeholder="Amount in KSh" />
      </div>
      <input value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)"
        style={{ width:"100%", padding:"10px 12px", fontSize:13, fontFamily:font, border:`1.5px solid ${P.border}`, borderRadius:8, outline:"none", marginBottom:8, boxSizing:"border-box" }} />
      {error && <div style={{ fontSize:12, color:P.red, fontWeight:600, marginBottom:8 }} data-testid="offer-error">{error}</div>}
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={onCancel} style={btn(P.white, P.secondary, { border:`1px solid ${P.border}`, flex:1 })}>Cancel</button>
        <button onClick={submit} disabled={busy} style={btn(P.black, P.white, { flex:2, opacity:busy ? 0.6 : 1 })} data-testid="send-offer">{busy ? "Sending…" : "Send Offer"}</button>
      </div>
    </div>
  );
}

/**
 * One transporter's negotiation on one load: the full round history plus the
 * actions the backend allows the viewer to take on the latest round.
 */
export function OfferThread({ thread, partyLabel, onAccept, onCounter, onReject, onWithdraw, highlight }) {
  const { rows, latest } = thread;
  const [countering, setCountering] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const pending = latest.effectiveStatus === "PENDING";
  const st = STATUS_STYLE[latest.effectiveStatus] || STATUS_STYLE.PENDING;
  const waiting = pending && latest.mine;

  async function run(fn) {
    setBusy(true); setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error); else { setCountering(false); setAmount(""); setNote(""); }
  }
  function sendCounter() {
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) { setError("Enter a whole-number amount in KSh."); return; }
    run(() => onCounter(latest.id, n, note.trim() || undefined));
  }

  const who = (o) => (o.mine ? "You" : partyLabel(o));
  return (
    <div style={{ border:`1.5px solid ${highlight ? P.blue : P.border}`, borderRadius:10, padding:12, marginTop:8, background:P.white }} data-testid="offer-thread">
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8, gap:8 }}>
        <div style={{ fontSize:13, fontWeight:800, color:P.black }}>{thread.title}</div>
        <span style={{ background:st.bg, color:st.color, fontSize:10, fontWeight:800, borderRadius:100, padding:"3px 9px", textTransform:"uppercase", letterSpacing:0.4 }}>
          {waiting ? "Awaiting reply" : pending ? "Needs your reply" : st.label}
        </span>
      </div>

      {rows.map(o => (
        <div key={o.id} style={{ display:"flex", justifyContent:"space-between", gap:8, padding:"6px 0", borderTop:`1px solid ${P.bg}`, fontSize:13 }} data-testid="offer-round">
          <div style={{ color:P.secondary }}>
            <strong style={{ color:P.black }}>Round {o.round}</strong> · {who(o)}
            {o.note ? <div style={{ fontSize:11, color:P.muted, marginTop:2 }}>“{o.note}”</div> : null}
          </div>
          <div style={{ fontWeight:800, color:P.black, whiteSpace:"nowrap" }}>{ksh(o.amount)}</div>
        </div>
      ))}

      {pending && latest.isFinalRound && (
        <div style={{ background:P.amberBg, color:P.amber, borderRadius:8, padding:"8px 10px", fontSize:12, fontWeight:800, marginTop:6 }}>
          FINAL OFFER — {latest.mine ? "the other party can accept or reject it" : "accept, reject or let it lapse; no more counters"}
        </div>
      )}
      {latest.effectiveStatus === "REJECTED" && latest.closeReason && (
        <div style={{ fontSize:11, color:P.muted, marginTop:6 }}>Closed: {String(latest.closeReason).replace(/_/g, " ").toLowerCase()}</div>
      )}
      {latest.effectiveStatus === "ACCEPTED" && (
        <div style={{ background:P.greenBg, color:P.green, borderRadius:8, padding:"8px 10px", fontSize:12, fontWeight:700, marginTop:6 }}>
          Price agreed: {ksh(latest.amount)}. Payment required to secure this booking.
        </div>
      )}

      {error && <div style={{ fontSize:12, color:P.red, fontWeight:600, marginTop:8 }} data-testid="thread-error">{error}</div>}

      {pending && !latest.mine && !countering && (
        <div style={{ display:"flex", gap:6, marginTop:10, flexWrap:"wrap" }}>
          <button disabled={busy} onClick={() => run(() => onAccept(latest.id))} style={btn(P.green, P.black, { flex:"1 1 100%" })} data-testid="accept-offer">Accept {ksh(latest.amount)}</button>
          {!latest.isFinalRound && <button disabled={busy} onClick={() => { setCountering(true); setError(null); }} style={btn(P.black, P.white, { flex:1 })} data-testid="counter-offer">Counter</button>}
          <button disabled={busy} onClick={() => run(() => onReject(latest.id))} style={btn(P.redBg, P.red, { flex:1 })} data-testid="reject-offer">Reject</button>
        </div>
      )}
      {pending && !latest.mine && countering && (
        <div style={{ marginTop:10 }}>
          <div style={{ fontSize:12, fontWeight:700, color:P.black, marginBottom:6 }}>Round {latest.round + 1} · Your counter</div>
          <div style={{ display:"flex", gap:8, marginBottom:8 }}><AmountInput value={amount} onChange={setAmount} placeholder="Amount in KSh" /></div>
          <input value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)"
            style={{ width:"100%", padding:"10px 12px", fontSize:13, fontFamily:font, border:`1.5px solid ${P.border}`, borderRadius:8, outline:"none", marginBottom:8, boxSizing:"border-box" }} />
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={() => setCountering(false)} style={btn(P.white, P.secondary, { border:`1px solid ${P.border}`, flex:1 })}>Back</button>
            <button disabled={busy} onClick={sendCounter} style={btn(P.black, P.white, { flex:2 })} data-testid="send-counter">{busy ? "Sending…" : "Send Counter"}</button>
          </div>
        </div>
      )}
      {pending && latest.mine && (
        <div style={{ marginTop:10 }}>
          <button disabled={busy} onClick={() => run(() => onWithdraw(latest.id))} style={btn(P.bg, P.secondary, { border:`1px solid ${P.border}`, width:"100%" })} data-testid="withdraw-offer">Withdraw offer</button>
        </div>
      )}
    </div>
  );
}

/** Posted vs agreed commercial terms for a booking — all values from the backend booking/load. */
export function AgreedPriceBlock({ booking, load }) {
  const rate = agreedRatePerKm(booking.agreedAmount, booking.agreedRoadDistanceMeters);
  const rows = [
    ["Posted Price", load?.price ? ksh(load.price) : "—"],
    ["Agreed Price", ksh(booking.agreedAmount)],
    ["Agreed Road Distance", booking.agreedRoadDistanceMeters > 0 ? `${metersToKm(booking.agreedRoadDistanceMeters)} km` : "—"],
    ["Agreed Rate", rate ? `KSh ${rate.toLocaleString("en-US")}/km` : "—"],
  ];
  return (
    <div data-testid="agreed-block">
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ background:P.bg, borderRadius:8, padding:"10px 12px" }}>
            <div style={{ fontSize:10, color:P.muted, fontWeight:700, textTransform:"uppercase", letterSpacing:0.5, marginBottom:3 }}>{k}</div>
            <div style={{ fontSize:14, fontWeight:800, color:k === "Agreed Price" ? P.green : P.black }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ background:P.amberBg, color:P.amber, borderRadius:8, padding:"9px 12px", fontSize:12, fontWeight:700, marginTop:8 }}>
        Price agreed: {ksh(booking.agreedAmount)}. Payment required to secure this booking.
      </div>
    </div>
  );
}

const NOTIF_ICON = { offer_received:"💬", offer_countered:"↔️", offer_accepted:"✅", offer_rejected:"✖️", booking_confirmed:"📦" };

/** Bell + dropdown of backend offer/booking notifications. */
export function CommerceBell({ notifications, onOpen, onMarkRead }) {
  const [open, setOpen] = useState(false);
  const unread = notifications.filter(n => !n.read).length;
  return (
    <div style={{ position:"relative" }}>
      <button onClick={() => setOpen(v => !v)} data-testid="commerce-bell" title="Offer notifications"
        style={{ position:"relative", background:open ? P.bg : "none", border:`1px solid ${open ? P.border : "transparent"}`, borderRadius:8, width:36, height:36, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:18 }}>
        🔔
        {unread > 0 && <span data-testid="commerce-unread" style={{ position:"absolute", top:3, right:3, background:P.red, color:P.white, fontSize:9, fontWeight:800, borderRadius:"50%", width:16, height:16, display:"flex", alignItems:"center", justifyContent:"center" }}>{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position:"fixed", inset:0, zIndex:900 }} />
          <div style={{ position:"fixed", right:8, top:56, width:310, maxWidth:"calc(100vw - 16px)", maxHeight:420, overflowY:"auto", background:P.white, border:`1px solid ${P.border}`, borderRadius:12, boxShadow:"0 12px 40px rgba(0,0,0,0.18)", zIndex:901, fontFamily:font }}>
            <div style={{ padding:"12px 14px", fontSize:13, fontWeight:800, borderBottom:`1px solid ${P.border}`, display:"flex", justifyContent:"space-between", color:P.black }}>
              <span>Offers & bookings</span>
              {unread > 0 && <span style={{ color:P.muted, fontWeight:600 }}>{unread} new</span>}
            </div>
            {notifications.length === 0 && <div style={{ padding:20, fontSize:13, color:P.muted, textAlign:"center" }}>No offer activity yet.</div>}
            {notifications.map(n => (
              <div key={n.id} data-testid="commerce-notif"
                onClick={() => { onMarkRead(n.id); setOpen(false); onOpen(n); }}
                style={{ padding:"10px 14px", borderBottom:`1px solid ${P.bg}`, cursor:"pointer", background:n.read ? P.white : P.blueBg, display:"flex", gap:10 }}>
                <span style={{ fontSize:16 }}>{NOTIF_ICON[n.type] || "🔔"}</span>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:n.read ? 600 : 800, color:P.black }}>{n.title}</div>
                  <div style={{ fontSize:12, color:P.secondary, marginTop:1 }}>{n.body}</div>
                  <div style={{ fontSize:10, color:P.muted, marginTop:3 }}>{new Date(n.createdAt).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export const DemoBadge = () => (
  <div data-testid="demo-badge" style={{ background:P.bg, color:P.muted, border:`1px dashed ${P.border}`, borderRadius:8, padding:"10px 12px", fontSize:12, fontWeight:700, textAlign:"center" }}>
    Demo Load — booking unavailable
  </div>
);

/**
 * src/components/negotiation/negotiation.jsx
 * -------------------------------------------
 * 5D-3 — shared negotiation UI used by both the transporter and shipper
 * portals. Plain props only: every amount shown comes from backend records.
 */
import { useState } from "react";
import { ksh, agreedRatePerKm, normalizeKenyanPhone, paymentView, adjustmentStatusLabel } from "../../models/backendLoad.js";
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
          Price agreed: {ksh(latest.amount)}.
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
export function AgreedPriceBlock({ booking, load, viewer = "transporter", onFund, finance, adjActions }) {
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
      <BookingPayment booking={booking} viewer={viewer} onFund={onFund} />
      {finance && adjActions && <BookingAdjustments booking={booking} postedPrice={load?.price} finance={finance} viewer={viewer} actions={adjActions} />}
    </div>
  );
}

/** Funding panel driven only by the backend `booking.payment` summary. viewer: "shipper" | "transporter". */
export function BookingPayment({ booking, viewer, onFund }) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pay = booking.payment;
  const v = paymentView(pay);
  const amount = ksh(booking.agreedAmount);
  const box = (bg, color, extra) => ({ background:bg, color, borderRadius:8, padding:"9px 12px", fontSize:12, fontWeight:700, marginTop:8, ...extra });

  if (v.key === "funded" || v.key === "paid") {
    return (
      <div style={box(P.greenBg, P.green)} data-testid="payment-funded">
        {viewer === "shipper" ? `${v.label} · ${amount} funded` : `${amount} funded · Escrow held`}
      </div>
    );
  }
  if (viewer !== "shipper") {
    return (
      <div style={box(P.amberBg, P.amber)} data-testid="payment-transporter-wait">
        {v.key === "awaiting" ? "Awaiting payment — M-Pesa confirmation pending" : "Awaiting shipper payment"}
      </div>
    );
  }
  if (v.key === "awaiting") {
    return <div style={box(P.blueBg, P.blue)} data-testid="payment-awaiting">Awaiting M-Pesa confirmation — approve the prompt on your phone.</div>;
  }

  async function submit() {
    const n = normalizeKenyanPhone(phone);
    if (!n) { setError("Enter a valid Kenyan M-Pesa number, e.g. 0712 345 678."); return; }
    setBusy(true); setError(null);
    const r = await onFund(booking.id, n);
    setBusy(false);
    if (!r.ok) setError(r.error);
  }
  return (
    <div style={{ marginTop:8 }} data-testid="payment-form">
      <div style={box(v.key === "unsuccessful" ? P.redBg : P.amberBg, v.key === "unsuccessful" ? P.red : P.amber, { marginTop:0 })} data-testid="payment-state">
        {v.label}{v.key === "unsuccessful" ? " · Retry" : ""}
      </div>
      <input type="tel" inputMode="tel" value={phone} onChange={e => { setPhone(e.target.value); setError(null); }} placeholder="M-Pesa number, e.g. 0712 345 678"
        data-testid="payment-phone"
        style={{ width:"100%", marginTop:8, padding:"10px 12px", fontSize:14, fontFamily:font, border:`1.5px solid ${P.border}`, borderRadius:8, outline:"none", color:P.black, background:P.white }} />
      <button disabled={busy || !phone.trim()} onClick={submit} data-testid="fund-booking"
        style={btn(P.green, P.black, { width:"100%", marginTop:8, opacity: busy || !phone.trim() ? 0.6 : 1 })}>
        {busy ? "Sending M-Pesa prompt…" : v.key === "unsuccessful" ? `Retry — ${amount}` : `Fund Booking — ${amount}`}
      </button>
      <div style={{ fontSize:11, color:P.muted, marginTop:6 }}>The agreed amount will be held in escrow until the applicable release conditions are met.</div>
      {error && <div style={{ fontSize:12, color:P.red, fontWeight:600, marginTop:6 }} data-testid="payment-error">{error}</div>}
    </div>
  );
}

const NOTIF_ICON = { offer_received:"💬", offer_countered:"↔️", offer_accepted:"✅", offer_rejected:"✖️", booking_confirmed:"📦", payment_confirmed:"💳", payment_failed:"⚠️", escrow_held:"🔒", adjustment_proposed:"➕", adjustment_decided:"☑️", adjustment_funded:"💳" };

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

const OPEN_ADJ = new Set(["PROPOSED", "APPROVED", "FUNDING"]);

/** Ledger + adjustment workflow. Every figure is read from the backend ledger / adjustment rows. */
export function BookingAdjustments({ booking, postedPrice, finance, viewer, actions }) {
  const { ledger, adjustments } = finance;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const sorted = [...adjustments].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const active = sorted.find(a => OPEN_ADJ.has(a.status));
  const allow = ledger.allowance;
  const money = (n) => ksh(n);

  const run = async (fn) => {
    setBusy(true); setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error);
    return r;
  };
  async function submitRequest() {
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) { setError("Enter a whole number of KSh."); return; }
    const r = await run(() => actions.requestAdjustment(booking.id, n, reason.trim()));
    if (r.ok) { setOpen(false); setAmount(""); setReason(""); }
  }
  async function fundAdj(a) {
    const n = normalizeKenyanPhone(phone);
    if (!n) { setError("Enter a valid Kenyan M-Pesa number, e.g. 0712 345 678."); return; }
    await run(() => actions.fundAdjustment(a.id, n));
  }
  const row = (k, v, strong) => (
    <div key={k} style={{ display:"flex", justifyContent:"space-between", fontSize:12, padding:"4px 0", fontWeight: strong ? 800 : 500, color: strong ? P.black : P.secondary }}>
      <span>{k}</span><span>{v}</span>
    </div>
  );
  const hasAdj = ledger.approvedAdjustments > 0;

  return (
    <div style={{ marginTop:12, borderTop:`1px solid ${P.border}`, paddingTop:10 }} data-testid="adjustments">
      <div style={{ fontSize:11, fontWeight:700, color:P.muted, letterSpacing:0.8, textTransform:"uppercase", marginBottom:6 }}>Price adjustments</div>
      <div style={{ background:P.bg, borderRadius:8, padding:"8px 12px" }} data-testid="ledger">
        {postedPrice ? row("Original posted price", money(postedPrice)) : null}
        {row("Agreed booking price", money(ledger.agreedAmount))}
        {hasAdj && row("Approved adjustment", `+${money(ledger.approvedAdjustments)}`)}
        {row("Total obligation", money(ledger.totalObligation), true)}
        {row("Confirmed funding", money(ledger.confirmedFunding))}
        {ledger.outstanding > 0 && row("Outstanding", money(ledger.outstanding), true)}
        {ledger.outstanding <= 0 && row("Escrow", ledger.escrowAmount != null ? `Held · ${money(ledger.escrowAmount)}` : "Held", true)}
      </div>

      {sorted.map(a => (
        <div key={a.id} style={{ border:`1px solid ${P.border}`, borderRadius:8, padding:"10px 12px", marginTop:8 }} data-testid="adjustment-item">
          <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
            <div style={{ fontWeight:800, fontSize:13 }}>+{money(a.amount)}</div>
            <div style={{ fontSize:11, fontWeight:700, color: a.status === "FUNDED" ? P.green : ["REJECTED","WITHDRAWN","EXPIRED"].includes(a.status) ? P.muted : P.amber }} data-testid="adjustment-status">
              {adjustmentStatusLabel(a.status, viewer)}
            </div>
          </div>
          <div style={{ fontSize:12, color:P.secondary, marginTop:4 }}>{a.reason}</div>
          {viewer === "shipper" && a.status === "PROPOSED" && (
            <>
              <div style={{ fontSize:12, color:P.muted, marginTop:6 }}>If approved, total obligation becomes {money(ledger.totalObligation + a.amount)}.</div>
              <div style={{ display:"flex", gap:6, marginTop:8 }}>
                <button disabled={busy} onClick={() => run(() => actions.approveAdjustment(a.id))} style={btn(P.green, P.black, { flex:1 })} data-testid="approve-adjustment">Approve</button>
                <button disabled={busy} onClick={() => run(() => actions.rejectAdjustment(a.id))} style={btn(P.redBg, P.red, { flex:1 })} data-testid="reject-adjustment">Reject</button>
              </div>
            </>
          )}
          {viewer === "shipper" && a.status === "APPROVED" && (
            <div style={{ marginTop:8 }}>
              <div style={{ background:P.amberBg, color:P.amber, borderRadius:8, padding:"8px 10px", fontSize:12, fontWeight:700 }}>Adjustment approved — {money(a.amount)} payment required</div>
              <input type="tel" inputMode="tel" value={phone} onChange={e => { setPhone(e.target.value); setError(null); }} placeholder="M-Pesa number, e.g. 0712 345 678" data-testid="adjustment-phone"
                style={{ width:"100%", marginTop:8, padding:"10px 12px", fontSize:14, fontFamily:font, border:`1.5px solid ${P.border}`, borderRadius:8, outline:"none", color:P.black, background:P.white }} />
              <button disabled={busy || !phone.trim()} onClick={() => fundAdj(a)} style={btn(P.green, P.black, { width:"100%", marginTop:8, opacity: busy || !phone.trim() ? 0.6 : 1 })} data-testid="fund-adjustment">Fund Difference — {money(a.amount)}</button>
              <div style={{ fontSize:11, color:P.muted, marginTop:6 }}>The difference is added to the booking's escrow until the applicable release conditions are met.</div>
            </div>
          )}
          {viewer !== "shipper" && a.status === "PROPOSED" && (
            <button disabled={busy} onClick={() => run(() => actions.withdrawAdjustment(a.id))} style={btn(P.bg, P.black, { marginTop:8 })} data-testid="withdraw-adjustment">Withdraw request</button>
          )}
        </div>
      ))}

      {viewer !== "shipper" && !active && !open && (
        <button onClick={() => { setOpen(true); setError(null); }} style={btn(P.black, P.white, { width:"100%", marginTop:8 })} data-testid="request-adjustment">Request Adjustment</button>
      )}
      {viewer !== "shipper" && open && (
        <div style={{ marginTop:8 }} data-testid="adjustment-form">
          <div style={{ fontSize:12, color:P.secondary, marginBottom:6 }}>
            Current agreed price {money(ledger.agreedAmount)}. Approved adjustments so far {money(ledger.approvedAdjustments)}.
            {allow && <> Remaining allowance {money(allow.remaining)} (max {allow.capPct}%).</>}
          </div>
          <AmountInput value={amount} onChange={setAmount} placeholder="Additional amount (KSh)" />
          <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (min. 10 characters)" rows={3} data-testid="adjustment-reason"
            style={{ width:"100%", marginTop:8, padding:"10px 12px", fontSize:13, fontFamily:font, border:`1.5px solid ${P.border}`, borderRadius:8, outline:"none", resize:"vertical" }} />
          <div style={{ display:"flex", gap:6, marginTop:8 }}>
            <button disabled={busy || !amount || !reason.trim()} onClick={submitRequest} style={btn(P.green, P.black, { flex:1, opacity: busy || !amount || !reason.trim() ? 0.6 : 1 })} data-testid="submit-adjustment">Send request</button>
            <button disabled={busy} onClick={() => { setOpen(false); setError(null); }} style={btn(P.bg, P.black)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <div style={{ fontSize:12, color:P.red, fontWeight:600, marginTop:6 }} data-testid="adjustment-error">{error}</div>}
    </div>
  );
}

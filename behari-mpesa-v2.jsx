import { useState, useEffect, useRef } from "react";

const C = {
  white:"#FFFFFF", bg:"#F6F6F6", border:"#EBEBEB",
  muted:"#9E9E9E", secondary:"#545454", black:"#000000",
  green:"#06C167", greenBg:"#E6F9F0",
  red:"#C0392B",   redBg:"#FDE8E3",
  amber:"#E07B39", amberBg:"#FFF3E0",
};
const card = { background:C.white, borderRadius:8, boxShadow:"0 1px 4px rgba(0,0,0,0.08)", border:`1px solid ${C.border}` };
const font = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";

const LOAD = { ref:"KE-2041", cargo:"Bagged Maize – 28 tonnes", from:"Eldoret", to:"Nairobi (Wakulima)", driver:"James Mwangi", plate:"KDJ 441Z", amount:42000, phone:"+254 722 100 200" };

const CODE = {
  stk:`async function stkPush({ phone, amount, loadRef }) {
  const token = await getAccessToken();
  const timestamp = new Date()
    .toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const password = Buffer.from(
    SHORTCODE + PASSKEY + timestamp
  ).toString("base64");

  return axios.post(
    "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
    {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: "https://api.beharifreight.co.ke/mpesa/stk-callback",
      AccountReference: loadRef,
    },
    { headers: { Authorization: \`Bearer \${token}\` } }
  );
}`,
  cb:`app.post("/mpesa/stk-callback", async (req, res) => {
  const cb = req.body.Body.stkCallback;
  if (cb.ResultCode === 0) {
    const items = cb.CallbackMetadata.Item;
    const mpesaRef = items.find(
      i => i.Name === "MpesaReceiptNumber"
    ).Value;
    await db.loads.update(
      { checkoutRequestId: cb.CheckoutRequestID },
      { status: "ESCROW_HELD", mpesaRef }
    );
    await sms.send({
      to: driver.phone,
      message: \`Load confirmed. KSh \${amount} in escrow. –BehariFreight\`
    });
  }
  res.json({ ResultCode: 0 });
});`,
  b2c:`async function payoutDriver({ driverPhone, grossAmount, loadRef }) {
  const net = Math.round(grossAmount * 0.94);
  return axios.post(
    "https://api.safaricom.co.ke/mpesa/b2c/v3/paymentrequest",
    {
      InitiatorName: INITIATOR_NAME,
      SecurityCredential: SECURITY_CREDENTIAL,
      CommandID: "BusinessPayment",
      Amount: net,
      PartyA: SHORTCODE,
      PartyB: driverPhone,
      Remarks: \`Payout for \${loadRef}\`,
      ResultURL: "https://api.beharifreight.co.ke/mpesa/b2c-result",
      QueueTimeOutURL: "https://api.beharifreight.co.ke/mpesa/b2c-timeout",
    },
    { headers: { Authorization: \`Bearer \${token}\` } }
  );
}`,
};

const STEPS = [
  { label:"Shipper posts load",              done:s=>s>=0 },
  { label:"STK Push sent to shipper's phone",done:s=>s>=1 },
  { label:"KSh 42,000 held in escrow",       done:s=>s>=1 },
  { label:"Driver picks up & transits",       done:s=>s>=2 },
  { label:"Shipper confirms delivery",        done:s=>s>=3 },
  { label:"KSh 39,480 paid to driver via B2C",done:s=>s>=4 },
  { label:"KSh 2,520 platform fee retained", done:s=>s>=4 },
];

function useTick(active, max, onDone) {
  const [n,setN] = useState(0);
  const r = useRef();
  useEffect(()=>{
    if (!active){ setN(0); return; }
    r.current = setInterval(()=>{
      setN(e=>{ if(e>=max){ clearInterval(r.current); onDone?.(); return max; } return e+1; });
    },1000);
    return ()=>clearInterval(r.current);
  },[active]);
  return n;
}

function DetailRow({ label, value, accent }) {
  return (
    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",borderBottom:`1px solid ${C.border}` }}>
      <span style={{ fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:0.8 }}>{label}</span>
      <span style={{ fontSize:13,fontWeight:700,color:accent||C.black }}>{value}</span>
    </div>
  );
}

/* ── STK Push Modal ─────────────────────────────────────── */
function StkModal({ onSuccess, onCancel }) {
  const [stage,setStage] = useState("prompt");
  const [fail,setFail]   = useState(false);
  const elapsed = useTick(stage==="waiting"&&!fail, 20, ()=>setStage("success"));

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400,padding:16 }}>
      <div style={{ background:C.white,borderRadius:16,width:"100%",maxWidth:380,padding:"28px 24px" }}>
        {/* M-Pesa header */}
        <div style={{ borderBottom:`1px solid ${C.border}`,paddingBottom:16,marginBottom:20,display:"flex",alignItems:"center",gap:12 }}>
          <div style={{ width:40,height:40,background:C.green,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20 }}>📱</div>
          <div>
            <div style={{ fontSize:14,fontWeight:800,color:C.black }}>M-PESA</div>
            <div style={{ fontSize:10,fontWeight:700,color:C.muted,letterSpacing:0.8 }}>SAFARICOM · LIPA NA M-PESA</div>
          </div>
        </div>

        {stage==="prompt" && <>
          <div style={{ background:C.bg,borderRadius:12,padding:"0 16px",marginBottom:16 }}>
            <DetailRow label="Payee" value="BehariFreight Escrow" />
            <DetailRow label="Load"  value={LOAD.ref} />
            <DetailRow label="From"  value={LOAD.phone} />
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0" }}>
              <span style={{ fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:0.8 }}>Amount</span>
              <span style={{ fontSize:26,fontWeight:800,color:C.black,letterSpacing:-0.5 }}>KSh {LOAD.amount.toLocaleString()}</span>
            </div>
          </div>
          <div style={{ fontSize:13,color:C.secondary,marginBottom:20,lineHeight:1.6 }}>
            A PIN prompt will be sent to <strong>{LOAD.phone}</strong>. Enter your M-Pesa PIN to authorise.
          </div>
          <button onClick={()=>setStage("waiting")} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:8,padding:14,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,marginBottom:8 }}>
            Send STK Push
          </button>
          <button onClick={()=>{setFail(true);setStage("waiting");setTimeout(()=>setStage("fail"),5000);}} style={{ width:"100%",background:C.white,color:C.secondary,border:`1px solid ${C.border}`,borderRadius:8,padding:11,fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:font,marginBottom:8 }}>
            Simulate Timeout
          </button>
          <button onClick={onCancel} style={{ width:"100%",background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer",fontFamily:font,padding:6 }}>Cancel</button>
        </>}

        {stage==="waiting" && (
          <div style={{ textAlign:"center",padding:"20px 0" }}>
            <div style={{ fontSize:48,marginBottom:16 }}>📲</div>
            <div style={{ fontSize:18,fontWeight:800,color:C.black,marginBottom:6 }}>Waiting for PIN…</div>
            <div style={{ fontSize:13,color:C.secondary,marginBottom:24 }}>Check {LOAD.phone} for the M-Pesa prompt.</div>
            <div style={{ width:72,height:72,borderRadius:"50%",margin:"0 auto 16px",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",background:`conic-gradient(${C.black} ${((fail?5:elapsed)/20)*360}deg, ${C.border} 0deg)` }}>
              <div style={{ width:56,height:56,borderRadius:"50%",background:C.white,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,fontWeight:900,color:C.black }}>
                {fail?"—":20-elapsed}
              </div>
            </div>
            <div style={{ fontSize:11,fontWeight:700,color:C.muted }}>{fail?"Timing out…":`Expires in ${20-elapsed}s`}</div>
          </div>
        )}

        {stage==="success" && (
          <div style={{ textAlign:"center" }}>
            <div style={{ width:64,height:64,background:C.greenBg,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,margin:"0 auto 16px" }}>✓</div>
            <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:4 }}>Payment Received</div>
            <div style={{ fontSize:13,color:C.secondary,marginBottom:20 }}>KSh {LOAD.amount.toLocaleString()} held in escrow for {LOAD.ref}</div>
            <div style={{ background:C.bg,borderRadius:12,padding:"0 16px",marginBottom:20 }}>
              <DetailRow label="M-Pesa Ref" value="QKL4X8F9WZ" />
              <DetailRow label="Status"     value="Escrow Held" accent={C.green} />
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0" }}>
                <span style={{ fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:0.8 }}>Released on</span>
                <span style={{ fontSize:13,fontWeight:700,color:C.black }}>Delivery Confirmation</span>
              </div>
            </div>
            <button onClick={onSuccess} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:8,padding:14,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>Continue</button>
          </div>
        )}

        {stage==="fail" && (
          <div style={{ textAlign:"center" }}>
            <div style={{ width:64,height:64,background:C.redBg,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,margin:"0 auto 16px" }}>✕</div>
            <div style={{ fontSize:20,fontWeight:800,color:C.red,marginBottom:4 }}>Payment Failed</div>
            <div style={{ fontSize:13,color:C.secondary,marginBottom:20 }}>Request timed out. No funds were deducted.</div>
            <button onClick={()=>{setStage("prompt");setFail(false);}} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:8,padding:14,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font,marginBottom:8 }}>Try Again</button>
            <button onClick={onCancel} style={{ width:"100%",background:C.white,color:C.secondary,border:`1px solid ${C.border}`,borderRadius:8,padding:11,fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:font }}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Payout Modal ───────────────────────────────────────── */
function PayoutModal({ onDone }) {
  const [stage,setStage] = useState("ready");
  useTick(stage==="sending", 4, ()=>setStage("done"));
  const net = Math.round(LOAD.amount*0.94);
  const fee = LOAD.amount - net;

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400,padding:16 }}>
      <div style={{ background:C.white,borderRadius:16,width:"100%",maxWidth:380,padding:"28px 24px" }}>
        <div style={{ borderBottom:`1px solid ${C.border}`,paddingBottom:16,marginBottom:20 }}>
          <div style={{ fontSize:10,fontWeight:800,color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:3 }}>M-Pesa B2C Payout</div>
          <div style={{ fontSize:22,fontWeight:800,color:C.black }}>Pay Driver</div>
        </div>

        {stage==="ready" && <>
          <div style={{ background:C.bg,borderRadius:12,padding:"0 16px",marginBottom:16 }}>
            <DetailRow label="Driver"          value={LOAD.driver} />
            <DetailRow label="Truck"           value={LOAD.plate} />
            <DetailRow label="Gross Amount"    value={`KSh ${LOAD.amount.toLocaleString()}`} />
            <DetailRow label="Platform Fee 6%" value={`− KSh ${fee.toLocaleString()}`} accent={C.amber} />
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0" }}>
              <span style={{ fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:0.8 }}>Driver Receives</span>
              <span style={{ fontSize:26,fontWeight:800,color:C.green,letterSpacing:-0.5 }}>KSh {net.toLocaleString()}</span>
            </div>
          </div>
          <div style={{ background:C.greenBg,borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:12,fontWeight:600,color:C.green }}>
            📲 Sent instantly to {LOAD.driver}'s M-Pesa via Daraja B2C API
          </div>
          <button onClick={()=>setStage("sending")} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:8,padding:14,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>
            Confirm & Pay Driver
          </button>
        </>}

        {stage==="sending" && (
          <div style={{ textAlign:"center",padding:"20px 0" }}>
            <div style={{ fontSize:48,marginBottom:12,display:"inline-block",animation:"spin 1s linear infinite" }}>⚙</div>
            <div style={{ fontSize:16,fontWeight:700,color:C.black,marginBottom:4 }}>Processing…</div>
            <div style={{ fontSize:13,color:C.secondary }}>Sending KSh {net.toLocaleString()} to {LOAD.driver}</div>
            <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {stage==="done" && (
          <div style={{ textAlign:"center" }}>
            <div style={{ width:64,height:64,background:C.greenBg,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32,margin:"0 auto 16px" }}>✓</div>
            <div style={{ fontSize:20,fontWeight:800,color:C.black,marginBottom:4 }}>Payout Sent!</div>
            <div style={{ fontSize:13,color:C.secondary,marginBottom:20 }}>{LOAD.driver} received KSh {net.toLocaleString()}</div>
            <div style={{ background:C.bg,borderRadius:12,padding:"0 16px",marginBottom:20 }}>
              <DetailRow label="Transaction ID" value="OLP8K3V7NQ" />
              <DetailRow label="Amount"         value={`KSh ${net.toLocaleString()}`} accent={C.green} />
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0" }}>
                <span style={{ fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:0.8 }}>Sent to</span>
                <span style={{ fontSize:13,fontWeight:700,color:C.black }}>+254 712 345 678</span>
              </div>
            </div>
            <button onClick={onDone} style={{ width:"100%",background:C.black,color:C.white,border:"none",borderRadius:8,padding:14,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── ROOT ───────────────────────────────────────────────── */
export default function BehariPay() {
  const [flowStep,setFlowStep]   = useState(0);
  const [showStk,setShowStk]     = useState(false);
  const [showPayout,setShowPayout] = useState(false);
  const [activeTab,setActiveTab]  = useState("flow");
  const [codeSection,setCodeSection] = useState("stk");

  return (
    <div style={{ background:C.bg, minHeight:"100vh", fontFamily:font, color:C.black }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-thumb{background:${C.border}}
        pre{white-space:pre-wrap;word-break:break-word}
      `}</style>

      {/* App bar */}
      <div style={{ background:C.white,borderBottom:`1px solid ${C.border}`,padding:"0 16px",position:"sticky",top:0,zIndex:100 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",height:52 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <div style={{ width:5,height:22,background:C.green,borderRadius:3 }} />
            <div>
              <div style={{ fontSize:15,fontWeight:800,color:C.black,letterSpacing:-0.3 }}>Behari Pay</div>
              <div style={{ fontSize:10,color:C.muted,fontWeight:600,letterSpacing:0.5 }}>M-PESA ESCROW ENGINE</div>
            </div>
          </div>
          <span style={{ background:C.greenBg,color:C.green,fontSize:10,fontWeight:700,borderRadius:100,padding:"4px 12px",letterSpacing:0.5 }}>DARAJA API</span>
        </div>
        <div style={{ display:"flex",borderTop:`1px solid ${C.border}` }}>
          {[["flow","Payment Flow"],["code","Integration Code"]].map(([t,l])=>(
            <button key={t} onClick={()=>setActiveTab(t)} style={{ flex:1,padding:"11px 4px",fontSize:12,fontWeight:700,fontFamily:font,border:"none",background:"transparent",color:activeTab===t?C.black:C.muted,borderBottom:activeTab===t?`2.5px solid ${C.black}`:"2.5px solid transparent",cursor:"pointer",transition:"color 0.15s" }}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ padding:"12px 12px 32px",maxWidth:640,margin:"0 auto" }}>
        {activeTab==="flow" && <>
          {/* Load summary */}
          <div style={{ ...card,padding:"16px 16px",marginBottom:12 }}>
            <div style={{ fontSize:10,fontWeight:700,color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:4 }}>Active Load</div>
            <div style={{ fontSize:19,fontWeight:800,color:C.black,letterSpacing:-0.3,marginBottom:2 }}>{LOAD.cargo}</div>
            <div style={{ fontSize:13,color:C.secondary,marginBottom:12 }}>{LOAD.from} → {LOAD.to} · {LOAD.ref}</div>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
              <div style={{ fontSize:12,fontWeight:600,color:C.muted }}>{LOAD.driver} · {LOAD.plate}</div>
              <div style={{ fontSize:22,fontWeight:800,color:C.black,letterSpacing:-0.5 }}>KSh {LOAD.amount.toLocaleString()}</div>
            </div>
          </div>

          {/* Escrow breakdown */}
          <div style={{ ...card,overflow:"hidden",marginBottom:12 }}>
            {[
              { label:"Shipper Pays",      value:`KSh ${LOAD.amount.toLocaleString()}`,                              color:C.black },
              { label:"Platform Fee (6%)", value:`− KSh ${Math.round(LOAD.amount*0.06).toLocaleString()}`,            color:C.amber },
              { label:"Driver Receives",   value:`KSh ${Math.round(LOAD.amount*0.94).toLocaleString()}`,              color:C.green },
            ].map(({ label,value,color },i,a)=>(
              <div key={label} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"13px 16px",borderBottom:i<a.length-1?`1px solid ${C.border}`:"none",background:i%2===0?C.white:C.bg }}>
                <span style={{ fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:0.8 }}>{label}</span>
                <span style={{ fontSize:18,fontWeight:800,color,letterSpacing:-0.3 }}>{value}</span>
              </div>
            ))}
          </div>

          {/* Step tracker */}
          <div style={{ ...card,padding:"16px 16px",marginBottom:12 }}>
            <div style={{ fontSize:10,fontWeight:700,color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:14 }}>Transaction Steps</div>
            {STEPS.map((s,i)=>(
              <div key={i} style={{ display:"flex",gap:12,marginBottom:4 }}>
                <div style={{ display:"flex",flexDirection:"column",alignItems:"center" }}>
                  <div style={{ width:22,height:22,borderRadius:"50%",background:s.done(flowStep)?C.black:C.border,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                    <span style={{ fontSize:10,fontWeight:900,color:s.done(flowStep)?C.green:"#fff" }}>{s.done(flowStep)?"✓":i+1}</span>
                  </div>
                  {i<STEPS.length-1 && <div style={{ width:1,height:18,background:s.done(flowStep)?C.black:C.border,margin:"2px 0" }} />}
                </div>
                <div style={{ paddingTop:2,paddingBottom:6 }}>
                  <span style={{ fontSize:13,fontWeight:600,color:s.done(flowStep)?C.black:C.muted }}>{s.label}</span>
                </div>
              </div>
            ))}
          </div>

          {/* CTAs */}
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {flowStep===0 && <button onClick={()=>setShowStk(true)} style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:15,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>📱 Step 1: Shipper Pays Escrow via M-Pesa</button>}
            {flowStep===1 && <button onClick={()=>setFlowStep(2)} style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:15,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>🚛 Step 2: Mark Load as In Transit</button>}
            {flowStep===2 && <button onClick={()=>setFlowStep(3)} style={{ background:C.black,color:C.white,border:"none",borderRadius:8,padding:15,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>✓ Step 3: Shipper Confirms Delivery</button>}
            {flowStep===3 && <button onClick={()=>setShowPayout(true)} style={{ background:C.green,color:C.white,border:"none",borderRadius:8,padding:15,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:font }}>💸 Step 4: Release Escrow → Pay Driver</button>}
            {flowStep===4 && <div style={{ background:C.greenBg,borderRadius:8,padding:20,textAlign:"center" }}><div style={{ fontSize:18,fontWeight:800,color:C.green }}>Transaction Complete ✓</div><div style={{ fontSize:12,color:C.secondary,marginTop:4 }}>Load {LOAD.ref} fully settled via M-Pesa</div></div>}
            {flowStep>0 && flowStep<4 && <div style={{ textAlign:"center",fontSize:11,fontWeight:700,color:C.muted,letterSpacing:0.5 }}>{["","ESCROW HELD","IN TRANSIT","AWAITING PAYOUT"][flowStep]}</div>}
            {flowStep>0 && <button onClick={()=>setFlowStep(0)} style={{ background:C.white,color:C.secondary,border:`1px solid ${C.border}`,borderRadius:8,padding:11,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:font }}>↺ Reset Demo</button>}
          </div>
        </>}

        {activeTab==="code" && <>
          <div style={{ display:"flex",gap:4,marginBottom:12 }}>
            {[["stk","STK Push"],["cb","Callback"],["b2c","B2C Payout"]].map(([k,l])=>(
              <button key={k} onClick={()=>setCodeSection(k)} style={{ flex:1,background:codeSection===k?C.black:C.white,color:codeSection===k?C.white:C.secondary,border:`1px solid ${codeSection===k?C.black:C.border}`,borderRadius:8,padding:"9px 4px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:font }}>{l}</button>
            ))}
          </div>

          <div style={{ background:"#0D1117",borderRadius:12,overflow:"hidden",marginBottom:12 }}>
            <div style={{ padding:"10px 16px",borderBottom:"1px solid #21262D",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
              <span style={{ fontSize:11,fontWeight:600,color:"#8B949E",fontFamily:"monospace" }}>
                {codeSection==="stk"?"stkPush.js":codeSection==="cb"?"stkCallback.js":"b2cPayout.js"}
              </span>
              <span style={{ background:"#1F6FEB22",color:"#58A6FF",fontSize:10,fontWeight:700,borderRadius:100,padding:"2px 10px" }}>Node.js</span>
            </div>
            <pre style={{ padding:"16px",fontSize:12,color:"#A5D6FF",lineHeight:1.7,overflowX:"auto",fontFamily:"'Fira Code', monospace" }}>{CODE[codeSection]}</pre>
          </div>

          <div style={{ ...card,padding:"16px 16px" }}>
            <div style={{ fontSize:10,fontWeight:700,color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:12 }}>Required ENV Variables</div>
            {["CONSUMER_KEY","CONSUMER_SECRET","SHORTCODE","PASSKEY","INITIATOR_NAME","SECURITY_CREDENTIAL"].map(k=>(
              <div key={k} style={{ fontFamily:"monospace",fontSize:12,color:C.black,background:C.bg,borderRadius:6,padding:"7px 12px",marginBottom:5 }}>
                {k}<span style={{ color:C.muted }}>=your_value_here</span>
              </div>
            ))}
            <div style={{ fontSize:11,color:C.muted,marginTop:10 }}>Get credentials at developer.safaricom.co.ke</div>
          </div>
        </>}
      </div>

      {showStk    && <StkModal onSuccess={()=>{setShowStk(false);setFlowStep(1);}} onCancel={()=>setShowStk(false)} />}
      {showPayout && <PayoutModal onDone={()=>{setShowPayout(false);setFlowStep(4);}} />}
    </div>
  );
}

/**
 * backend/src/services/daraja.js
 * -----------------------------------
 * THE boundary named in docs/4K-DARAJA-SPEC.md Section 0.5: every route that
 * needs to talk to Daraja calls a function here, never the simulator or the
 * real Safaricom API directly. Which one actually answers is decided once,
 * by DARAJA_ENV, in exactly one place.
 *
 * DARAJA_ENV=simulate (default, and the only mode exercised by this repo's
 * own acceptance tests, per Section 8 — the real sandbox is reported
 * happy-path-only as of the spec's research) | sandbox | production.
 *
 * The sandbox/production path below is structurally complete against
 * Daraja's documented request shapes (Section 0/6's Sources) but has not
 * been exercised against the real API in this environment — that needs
 * real Safaricom credentials and a publicly reachable callback URL (a
 * tunnel in dev), neither of which this environment has. Per the user's own
 * operational caveat: treat it as unverified until run against the live
 * sandbox, exactly like the two reversal scenarios in the simulator.
 */

import * as simulator from "./darajaSimulator.js";

function currentEnv() {
  return process.env.DARAJA_ENV || "simulate";
}

/** The base URL Daraja (real or simulated) calls back to — Section 10's DARAJA_CALLBACK_BASE_URL. */
export function callbackUrl(path) {
  const base = process.env.DARAJA_CALLBACK_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  return `${base}${path}`;
}

/**
 * @param {{amount:number, phoneNumber:string, callbackUrl:string, accountReference?:string, testOutcome?:string, testForceReceipt?:string, testDelayMs?:number}} args
 */
export async function stkPush({ amount, phoneNumber, callbackUrl, accountReference, testOutcome, testForceReceipt, testDelayMs }) {
  if (currentEnv() === "simulate") {
    return simulator.simulateStkPush({
      amount, phoneNumber, callbackUrl,
      outcome: testOutcome || "success",
      forceReceipt: testForceReceipt,
      delayMs: testDelayMs,
    });
  }
  return realStkPush({ amount, phoneNumber, callbackUrl, accountReference });
}

/**
 * @param {{amount:number, receiverName?:string, phoneNumber:string, callbackUrl:string, testOutcome?:string, testForceReceipt?:string, testDelayMs?:number}} args
 */
export async function b2cPayment({ amount, receiverName, phoneNumber, callbackUrl, testOutcome, testForceReceipt, testDelayMs }) {
  if (currentEnv() === "simulate") {
    return simulator.simulateB2c({
      amount, receiverName, callbackUrl,
      outcome: testOutcome || "success",
      forceReceipt: testForceReceipt,
      delayMs: testDelayMs,
    });
  }
  return realB2cPayment({ amount, receiverName, phoneNumber, callbackUrl });
}

/* ── Real Daraja integration (sandbox/production) — unexercised here ─────── */

const BASE_URL = () =>
  currentEnv() === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

async function getOAuthToken() {
  const key = process.env.DARAJA_CONSUMER_KEY;
  const secret = process.env.DARAJA_CONSUMER_SECRET;
  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  const res = await fetch(`${BASE_URL()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Daraja OAuth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

function darajaTimestamp() {
  return new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
}

async function realStkPush({ amount, phoneNumber, callbackUrl, accountReference }) {
  const token = await getOAuthToken();
  const shortcode = process.env.DARAJA_SHORTCODE;
  const timestamp = darajaTimestamp();
  const password = Buffer.from(`${shortcode}${process.env.DARAJA_PASSKEY}${timestamp}`).toString("base64");

  const res = await fetch(`${BASE_URL()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phoneNumber,
      PartyB: shortcode,
      PhoneNumber: phoneNumber,
      CallBackURL: callbackUrl,
      AccountReference: accountReference || "Behari",
      TransactionDesc: "Behari Freight booking payment",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Daraja STK push failed: ${JSON.stringify(data)}`);
  return {
    merchantRequestId: data.MerchantRequestID,
    checkoutRequestId: data.CheckoutRequestID,
    responseCode: data.ResponseCode,
    responseDescription: data.ResponseDescription,
  };
}

async function realB2cPayment({ amount, receiverName, phoneNumber, callbackUrl }) {
  const token = await getOAuthToken();
  const res = await fetch(`${BASE_URL()}/mpesa/b2c/v1/paymentrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      InitiatorName: process.env.DARAJA_INITIATOR_NAME,
      SecurityCredential: process.env.DARAJA_SECURITY_CREDENTIAL,
      CommandID: "BusinessPayment",
      Amount: amount,
      PartyA: process.env.DARAJA_SHORTCODE,
      PartyB: phoneNumber,
      Remarks: `Behari Freight payout${receiverName ? ` to ${receiverName}` : ""}`,
      QueueTimeOutURL: callbackUrl,
      ResultURL: callbackUrl,
      Occasion: "Behari Freight escrow release",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Daraja B2C request failed: ${JSON.stringify(data)}`);
  return {
    conversationId: data.ConversationID,
    originatorConversationId: data.OriginatorConversationID,
    responseCode: data.ResponseCode,
    responseDescription: data.ResponseDescription,
  };
}

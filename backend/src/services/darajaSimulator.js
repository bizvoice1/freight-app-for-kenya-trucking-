/**
 * backend/src/services/darajaSimulator.js
 * --------------------------------------------
 * Phase 4K, Section 8 of docs/4K-DARAJA-SPEC.md — a local, in-process fake of
 * the two Daraja calls Behari makes (STK push, B2C). Selected via
 * DARAJA_ENV=simulate (see services/daraja.js). Returns a realistic
 * synchronous response immediately, then — exactly like the real thing —
 * schedules a genuine HTTP POST to OUR OWN callback endpoint after a
 * configurable delay, so the exact same route code handles a simulated
 * callback and a real one. Never a shortcut that writes to the database
 * directly.
 *
 * Implementation decision (not a spec deviation): the spec flagged
 * `payout_reversal`/`payment_reversal` as unverified against real Daraja
 * behavior — no confirmed webhook exists for either. Rather than have this
 * simulator fabricate a callback shape nobody can confirm is real, those two
 * scenarios are implemented as explicit admin-triggered manual transitions
 * (POST /api/escrows/:id/mark-payment-reversed and .../mark-payout-reversed
 * — see routes/escrows.js), exactly the fallback the spec's own Section 8
 * describes for the "no webhook exists" case. This simulator covers the
 * nine outcomes that DO correspond to a real Daraja callback.
 */

let counter = 0;
function nextId(prefix) {
  counter += 1;
  return `${prefix}-SIM-${Date.now().toString(36)}-${counter}`;
}

function mpesaTimestamp() {
  return Number(new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14));
}

async function deliverCallback(url, body) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[darajaSimulator] callback delivery failed:", err.message);
  }
}

function buildStkBody({ merchantRequestId, checkoutRequestId, amount, phoneNumber, outcome, forceReceipt }) {
  if (outcome === "cancelled_by_user") {
    return { Body: { stkCallback: {
      MerchantRequestID: merchantRequestId,
      CheckoutRequestID: checkoutRequestId,
      ResultCode: 1032,
      ResultDesc: "Request cancelled by user",
    } } };
  }
  const reportedAmount = outcome === "wrong_amount" ? Number(amount) + 1 : amount;
  const receipt = forceReceipt || nextId("MPESA");
  return { Body: { stkCallback: {
    MerchantRequestID: merchantRequestId,
    CheckoutRequestID: checkoutRequestId,
    ResultCode: 0,
    ResultDesc: "The service request is processed successfully.",
    CallbackMetadata: { Item: [
      { Name: "Amount", Value: reportedAmount },
      { Name: "MpesaReceiptNumber", Value: receipt },
      { Name: "TransactionDate", Value: mpesaTimestamp() },
      { Name: "PhoneNumber", Value: phoneNumber },
    ] },
  } } };
}

/**
 * @param {{amount:number, phoneNumber:string, callbackUrl:string, outcome?:string, forceReceipt?:string, delayMs?:number}} args
 * outcome: "success" (default) | "cancelled_by_user" | "timeout" | "wrong_amount"
 *        | "duplicate_callback" | "delayed_callback"
 * @returns {{merchantRequestId:string, checkoutRequestId:string, responseCode:string, responseDescription:string}}
 */
export function simulateStkPush({ amount, phoneNumber, callbackUrl, outcome = "success", forceReceipt, delayMs }) {
  const merchantRequestId = nextId("MR");
  const checkoutRequestId = nextId("CR");

  if (outcome !== "timeout") {
    const delay = delayMs ?? (outcome === "delayed_callback" ? 2000 : 120);
    setTimeout(() => {
      const body = buildStkBody({ merchantRequestId, checkoutRequestId, amount, phoneNumber, outcome, forceReceipt });
      deliverCallback(callbackUrl, body);
      if (outcome === "duplicate_callback") {
        setTimeout(() => deliverCallback(callbackUrl, body), 150);
      }
    }, delay);
  }

  return {
    merchantRequestId,
    checkoutRequestId,
    responseCode: "0",
    responseDescription: "Success. Request accepted for processing",
  };
}

function buildB2cBody({ conversationId, originatorConversationId, amount, receiverName, outcome, forceReceipt }) {
  if (outcome === "failed_payout") {
    return { Result: {
      ConversationID: conversationId,
      OriginatorConversationID: originatorConversationId,
      ResultCode: 1,
      ResultDesc: "The initiator information is invalid.",
    } };
  }
  const receipt = forceReceipt || nextId("MPESAB2C");
  return { Result: {
    ConversationID: conversationId,
    OriginatorConversationID: originatorConversationId,
    ResultCode: 0,
    ResultDesc: "The service request has been accepted successfully.",
    ResultParameters: { ResultParameter: [
      { Key: "TransactionAmount", Value: amount },
      { Key: "TransactionReceipt", Value: receipt },
      { Key: "ReceiverPartyPublicName", Value: receiverName || "Recipient" },
    ] },
  } };
}

/**
 * @param {{amount:number, receiverName?:string, callbackUrl:string, outcome?:string, forceReceipt?:string, delayMs?:number}} args
 * outcome: "success" (default) | "failed_payout" | "timeout"
 *        | "repeated_b2c_callback" | "delayed_callback"
 * @returns {{conversationId:string, originatorConversationId:string, responseCode:string, responseDescription:string}}
 */
export function simulateB2c({ amount, receiverName, callbackUrl, outcome = "success", forceReceipt, delayMs }) {
  const conversationId = nextId("CONV");
  const originatorConversationId = nextId("OCONV");

  if (outcome !== "timeout") {
    const delay = delayMs ?? (outcome === "delayed_callback" ? 2000 : 120);
    setTimeout(() => {
      const body = buildB2cBody({ conversationId, originatorConversationId, amount, receiverName, outcome, forceReceipt });
      deliverCallback(callbackUrl, body);
      if (outcome === "repeated_b2c_callback") {
        setTimeout(() => deliverCallback(callbackUrl, body), 150);
      }
    }, delay);
  }

  return {
    conversationId,
    originatorConversationId,
    responseCode: "0",
    responseDescription: "Accept the service request successfully.",
  };
}

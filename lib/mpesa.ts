import "server-only";

// Safaricom Daraja API integration (M-Pesa). This performs REAL calls to
// Safaricom's servers — there is no simulated/fake success path. Until the
// environment variables below are set, every function here throws a clear
// "not configured" error instead of pretending a payment succeeded.
//
// Required env vars (see .env.example):
//   MPESA_ENV                 "sandbox" | "production"
//   MPESA_CONSUMER_KEY
//   MPESA_CONSUMER_SECRET
//   MPESA_SHORTCODE            Paybill number (CustomerPayBillOnline only — see README)
//   MPESA_PASSKEY              Lipa Na M-Pesa Online passkey
//   MPESA_CALLBACK_URL         Public HTTPS URL to /api/mpesa/callback/<secret>
//
// Get these from https://developer.safaricom.co.ke after registering an app
// and (for production) an approved Paybill with Safaricom.
//
// Everything here fails CLOSED: a missing setting, an out-of-range amount, a
// malformed phone number, or a slow/unreachable Daraja never falls back to a
// "probably fine" guess — it throws, and the caller must treat that as "no
// payment happened."

// Daraja's own field limits for the STK Push request. Both are display text
// shown to the payer / merchant — not the amount or the parties — but a
// value that's too long is REJECTED by Daraja outright, so callers must stay
// within them.
export const ACCOUNT_REFERENCE_MAX_LENGTH = 12;
export const TRANSACTION_DESC_MAX_LENGTH = 13;

// Whole Kenyan shillings only: Daraja's Amount field for STK Push takes no
// decimals, and 250,000 is Safaricom's per-transaction cap.
export const MIN_PAYMENT_AMOUNT_KES = 1;
export const MAX_PAYMENT_AMOUNT_KES = 250_000;

const TOKEN_TIMEOUT_MS = 15_000;
const STK_PUSH_TIMEOUT_MS = 20_000;
const STK_QUERY_TIMEOUT_MS = 15_000;

const KENYAN_MSISDN = /^254[17][0-9]{8}$/;

function baseUrl() {
  return process.env.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

export function isMpesaConfigured() {
  return Boolean(
    process.env.MPESA_CONSUMER_KEY &&
      process.env.MPESA_CONSUMER_SECRET &&
      process.env.MPESA_SHORTCODE &&
      process.env.MPESA_PASSKEY &&
      process.env.MPESA_CALLBACK_URL,
  );
}

function requireConfigured() {
  if (!isMpesaConfigured()) {
    throw new Error(
      "M-Pesa is not configured on this deployment. Set MPESA_CONSUMER_KEY, " +
        "MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY and MPESA_CALLBACK_URL.",
    );
  }
}

/**
 * Whole shillings, 1..250,000 — Daraja's own limits for a single STK Push.
 * Throws on anything else (fractional, zero, negative, NaN, above the cap)
 * rather than rounding or clamping: a coerced amount is a silently WRONG
 * amount, and this is money.
 */
export function validatePaymentAmount(amount: unknown): number {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) {
    throw new Error("Payment amount is invalid.");
  }
  if (!Number.isInteger(n)) {
    throw new Error("Payment amount must be a whole number of shillings (no cents).");
  }
  if (n < MIN_PAYMENT_AMOUNT_KES || n > MAX_PAYMENT_AMOUNT_KES) {
    throw new Error(
      `Payment amount must be between KES ${MIN_PAYMENT_AMOUNT_KES} and KES ${MAX_PAYMENT_AMOUNT_KES}.`,
    );
  }
  return n;
}

/** 2547XXXXXXXX / 2541XXXXXXXX only — the exact shape Daraja's PartyA/PhoneNumber require. */
export function isValidMsisdn(phone: string): boolean {
  return KENYAN_MSISDN.test(phone);
}

// Wraps a fetch call so a slow/unreachable Daraja fails clearly and quickly
// instead of hanging the request indefinitely, and never lets a raw network
// error (which can include request internals) reach the caller unfiltered.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`M-Pesa ${what} timed out.`);
    }
    throw new Error(`M-Pesa ${what} failed: could not reach Safaricom.`);
  }
}

async function getAccessToken(): Promise<string> {
  requireConfigured();
  const credentials = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`,
  ).toString("base64");

  const res = await fetchWithTimeout(
    `${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` }, cache: "no-store" },
    TOKEN_TIMEOUT_MS,
    "authentication",
  );

  if (!res.ok) {
    // Deliberately no response body in this message: Daraja's OAuth error
    // payloads can echo back request details, and this must never leak
    // anywhere near the consumer key/secret used to obtain the token.
    throw new Error(`Failed to obtain M-Pesa access token (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("M-Pesa authentication succeeded but returned no access token.");
  }
  return data.access_token;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function password(ts: string): string {
  return Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${ts}`).toString("base64");
}

export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseDescription: string;
}

/**
 * Initiates a real Lipa Na M-Pesa Online (STK Push) prompt on the payer's
 * phone, as a PayBill payment (CustomerPayBillOnline — not Buy Goods/Till).
 * Validates everything Daraja would otherwise silently reject or (worse)
 * accept with the wrong meaning: a fractional/out-of-range amount, a
 * malformed phone number, or an AccountReference/TransactionDesc that's too
 * long for the field Daraja gives it.
 */
export async function initiateStkPush(params: {
  phoneNumber: string; // format 2547XXXXXXXX
  amount: number;
  accountReference: string;
  transactionDesc: string;
}): Promise<StkPushResult> {
  requireConfigured();

  const amount = validatePaymentAmount(params.amount);

  if (!isValidMsisdn(params.phoneNumber)) {
    throw new Error("Phone number must be a valid Kenyan M-Pesa number (2547XXXXXXXX or 2541XXXXXXXX).");
  }

  if (!params.accountReference || params.accountReference.length > ACCOUNT_REFERENCE_MAX_LENGTH) {
    throw new Error(`AccountReference must be 1-${ACCOUNT_REFERENCE_MAX_LENGTH} characters for Daraja.`);
  }
  if (!params.transactionDesc || params.transactionDesc.length > TRANSACTION_DESC_MAX_LENGTH) {
    throw new Error(`TransactionDesc must be 1-${TRANSACTION_DESC_MAX_LENGTH} characters for Daraja.`);
  }

  const token = await getAccessToken();
  const ts = timestamp();

  const res = await fetchWithTimeout(
    `${baseUrl()}/mpesa/stkpush/v1/processrequest`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password(ts),
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: params.phoneNumber,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: params.phoneNumber,
        CallBackURL: process.env.MPESA_CALLBACK_URL,
        AccountReference: params.accountReference,
        TransactionDesc: params.transactionDesc,
      }),
    },
    STK_PUSH_TIMEOUT_MS,
    "STK push",
  );

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ResponseCode !== "0") {
    throw new Error(data?.errorMessage || data?.ResponseDescription || "STK push request failed");
  }

  return {
    merchantRequestId: data.MerchantRequestID,
    checkoutRequestId: data.CheckoutRequestID,
    responseDescription: data.ResponseDescription,
  };
}

export interface StkQueryResult {
  merchantRequestId?: string;
  checkoutRequestId: string;
  /**
   * null means Daraja reports the transaction is still being processed — NOT
   * a result. Only 0 (success) or a non-zero code (a real, final failure —
   * cancelled, timed out, insufficient funds, etc.) is an actual outcome.
   */
  resultCode: number | null;
  resultDesc: string;
}

// Daraja returns HTTP 500 with this errorCode while an STK push is still
// mid-flight (the payer hasn't answered the prompt yet). That is NOT a query
// failure — it's the expected shape of "no result yet."
const STILL_PROCESSING_ERROR_CODE = "500.001.1001";

/**
 * Actively asks Daraja for the real outcome of a previously-sent STK Push,
 * by CheckoutRequestID — for when the payer answered the prompt but our
 * callback never arrived (a lost webhook, not a decision either way).
 *
 * Returning successfully from this function means Daraja was reachable and
 * answered — it does NOT by itself mean the payment succeeded. Callers must
 * check `resultCode === 0` before treating the payment as paid, and must
 * treat `resultCode === null` as "still nothing to report," not as failure.
 */
export async function queryStkPushStatus(checkoutRequestId: string): Promise<StkQueryResult> {
  requireConfigured();
  if (!checkoutRequestId) {
    throw new Error("checkoutRequestId is required for an STK status query.");
  }

  const token = await getAccessToken();
  const ts = timestamp();

  const res = await fetchWithTimeout(
    `${baseUrl()}/mpesa/stkpushquery/v1/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password(ts),
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      }),
    },
    STK_QUERY_TIMEOUT_MS,
    "STK status query",
  );

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    if (data && typeof data.errorCode === "string" && data.errorCode === STILL_PROCESSING_ERROR_CODE) {
      return { checkoutRequestId, resultCode: null, resultDesc: "still processing" };
    }
    throw new Error(data?.errorMessage || `M-Pesa STK status query failed (HTTP ${res.status})`);
  }
  if (!data) {
    throw new Error("M-Pesa STK status query returned an unreadable response.");
  }

  return {
    merchantRequestId: typeof data.MerchantRequestID === "string" ? data.MerchantRequestID : undefined,
    checkoutRequestId: typeof data.CheckoutRequestID === "string" ? data.CheckoutRequestID : checkoutRequestId,
    resultCode:
      data.ResultCode === undefined || data.ResultCode === null || data.ResultCode === ""
        ? null
        : Number(data.ResultCode),
    resultDesc: data.ResultDesc ?? data.ResponseDescription ?? "",
  };
}

const B2C_TIMEOUT_MS = 20_000;

// B2C needs credentials beyond the PayBill STK ones above: Safaricom issues these
// separately, only once a Paybill has B2C enabled (a distinct production application
// review from plain collections). See .env.example for how to obtain them.
export function isB2CConfigured() {
  return Boolean(
    isMpesaConfigured() &&
      process.env.MPESA_INITIATOR_NAME &&
      process.env.MPESA_SECURITY_CREDENTIAL &&
      process.env.MPESA_B2C_RESULT_URL &&
      process.env.MPESA_B2C_TIMEOUT_URL,
  );
}

function requireB2CConfigured() {
  if (!isB2CConfigured()) {
    throw new Error(
      "M-Pesa B2C payouts are not configured on this deployment. Set MPESA_INITIATOR_NAME, " +
        "MPESA_SECURITY_CREDENTIAL, MPESA_B2C_RESULT_URL and MPESA_B2C_TIMEOUT_URL (in addition " +
        "to the base MPESA_* settings).",
    );
  }
}

export interface B2CPayoutResult {
  conversationId: string;
  originatorConversationId: string;
  responseDescription: string;
}

/**
 * Business-to-Customer payout (coach withdrawal to M-Pesa).
 *
 * Returns once Daraja has ACCEPTED the request for processing — this is not
 * proof the coach received the money. The actual outcome (success or
 * failure) only ever arrives via the B2C result callback
 * (app/api/mpesa/b2c-callback/[secret]/route.ts); nothing here marks a
 * withdrawal completed.
 */
export async function initiateB2CPayout(params: {
  phoneNumber: string; // format 2547XXXXXXXX
  amount: number;
  remarks: string;
  originatorConversationId: string; // our own idempotency key for this attempt
}): Promise<B2CPayoutResult> {
  requireB2CConfigured();

  const amount = validatePaymentAmount(params.amount);

  if (!isValidMsisdn(params.phoneNumber)) {
    throw new Error("Phone number must be a valid Kenyan M-Pesa number (2547XXXXXXXX or 2541XXXXXXXX).");
  }
  if (!params.originatorConversationId) {
    throw new Error("originatorConversationId is required for a B2C payout.");
  }

  const token = await getAccessToken();

  const res = await fetchWithTimeout(
    `${baseUrl()}/mpesa/b2c/v3/paymentrequest`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        OriginatorConversationID: params.originatorConversationId,
        InitiatorName: process.env.MPESA_INITIATOR_NAME,
        SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
        CommandID: "BusinessPayment",
        Amount: amount,
        PartyA: process.env.MPESA_SHORTCODE,
        PartyB: params.phoneNumber,
        Remarks: params.remarks.slice(0, 100),
        QueueTimeOutURL: process.env.MPESA_B2C_TIMEOUT_URL,
        ResultURL: process.env.MPESA_B2C_RESULT_URL,
        Occasion: "",
      }),
    },
    B2C_TIMEOUT_MS,
    "B2C payout",
  );

  const data = await res.json().catch(() => null);
  // Deliberately no response body in errors beyond ResponseDescription: Daraja's B2C
  // error payloads can echo request details, and SecurityCredential must never surface
  // in a log or an error message a caller might display.
  if (!res.ok || !data || String(data.ResponseCode) !== "0") {
    throw new Error(data?.errorMessage || data?.ResponseDescription || "B2C payout request failed");
  }

  return {
    conversationId: data.ConversationID,
    originatorConversationId: data.OriginatorConversationID,
    responseDescription: data.ResponseDescription,
  };
}

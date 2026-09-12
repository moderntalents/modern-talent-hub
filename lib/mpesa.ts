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
//   MPESA_SHORTCODE            Paybill / till number
//   MPESA_PASSKEY              Lipa Na M-Pesa Online passkey
//   MPESA_CALLBACK_URL         Public HTTPS URL to /api/mpesa/callback
//
// Get these from https://developer.safaricom.co.ke after registering an app
// and (for production) an approved Paybill/Till with Safaricom.

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

async function getAccessToken(): Promise<string> {
  requireConfigured();
  const credentials = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`,
  ).toString("base64");

  const res = await fetch(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Failed to obtain M-Pesa access token (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { access_token: string };
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

export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseDescription: string;
}

/** Initiates a real Lipa Na M-Pesa Online (STK Push) prompt on the payer's phone. */
export async function initiateStkPush(params: {
  phoneNumber: string; // format 2547XXXXXXXX
  amount: number;
  accountReference: string;
  transactionDesc: string;
}): Promise<StkPushResult> {
  requireConfigured();
  const token = await getAccessToken();
  const ts = timestamp();
  const password = Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${ts}`,
  ).toString("base64");

  const res = await fetch(`${baseUrl()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: ts,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(params.amount),
      PartyA: params.phoneNumber,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: params.phoneNumber,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: params.accountReference,
      TransactionDesc: params.transactionDesc,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.ResponseCode !== "0") {
    throw new Error(data.errorMessage || data.ResponseDescription || "STK push request failed");
  }

  return {
    merchantRequestId: data.MerchantRequestID,
    checkoutRequestId: data.CheckoutRequestID,
    responseDescription: data.ResponseDescription,
  };
}

/**
 * Business-to-Customer payout (teacher withdrawal to M-Pesa).
 *
 * NOT YET IMPLEMENTED. Safaricom's B2C API requires a separate production
 * application review (a registered Paybill with B2C enabled, an initiator
 * name/credential, and a security-credential generated from Safaricom's
 * public certificate) that most new developer accounts don't have by
 * default. Wire this up once that approval is in place — the withdrawal
 * ledger (supabase/migrations/0001_init.sql, withdrawal_requests table) is
 * already built to record a real "processing" -> "completed" transition
 * once this function actually moves money; nothing in this codebase marks
 * a withdrawal completed on its own.
 */
export async function initiateB2CPayout(_params: {
  phoneNumber: string;
  amount: number;
  remarks: string;
}): Promise<never> {
  throw new Error(
    "M-Pesa B2C payouts are not implemented yet. Withdrawals must be reviewed " +
      "and processed manually (see /admin/withdrawals) until this is wired up.",
  );
}

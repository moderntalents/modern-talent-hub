import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeKenyanPhone } from "@/lib/phone";
import { queryStkPushStatus } from "@/lib/mpesa";
import type { Json, MpesaCallbackOutcome } from "@/lib/supabase/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// ============================================================================
// Parsing — turning Daraja's callback shape into plain, typed values. Pure
// and easy to unit-test: no I/O, no database, no fetch.
// ============================================================================

export interface ParsedStkCallback {
  checkoutRequestId: string;
  merchantRequestId?: string;
  resultCode: number;
  resultDesc: string;
  amount: number | null;
  receipt: string | null;
  phone: string | null;
  transactionDate: string | null; // raw Daraja YYYYMMDDHHmmss, Africa/Nairobi local time
}

type CallbackItem = { Name: string; Value: string | number };

/** Returns null for anything that isn't a recognisable Daraja STK callback payload. */
export function parseStkCallback(payload: unknown): ParsedStkCallback | null {
  if (!payload || typeof payload !== "object") return null;
  const stkCallback = (payload as { Body?: { stkCallback?: unknown } }).Body?.stkCallback as
    | {
        CheckoutRequestID?: unknown;
        MerchantRequestID?: unknown;
        ResultCode?: unknown;
        ResultDesc?: unknown;
        CallbackMetadata?: { Item?: CallbackItem[] };
      }
    | undefined;

  if (!stkCallback || typeof stkCallback.CheckoutRequestID !== "string" || !stkCallback.CheckoutRequestID) {
    return null;
  }
  const resultCode = Number(stkCallback.ResultCode);
  if (!Number.isFinite(resultCode)) return null;

  const items: CallbackItem[] = Array.isArray(stkCallback.CallbackMetadata?.Item)
    ? (stkCallback.CallbackMetadata!.Item as CallbackItem[])
    : [];
  const find = (name: string) => items.find((i) => i && i.Name === name)?.Value;

  const rawAmount = find("Amount");
  const rawReceipt = find("MpesaReceiptNumber");
  const rawPhone = find("PhoneNumber");
  const rawDate = find("TransactionDate");

  return {
    checkoutRequestId: stkCallback.CheckoutRequestID,
    merchantRequestId: typeof stkCallback.MerchantRequestID === "string" ? stkCallback.MerchantRequestID : undefined,
    resultCode,
    resultDesc: typeof stkCallback.ResultDesc === "string" ? stkCallback.ResultDesc : "",
    amount: rawAmount === undefined ? null : Number(rawAmount),
    receipt: rawReceipt === undefined ? null : String(rawReceipt),
    phone: rawPhone === undefined ? null : String(rawPhone),
    transactionDate: rawDate === undefined ? null : String(rawDate),
  };
}

/**
 * Daraja's TransactionDate is YYYYMMDDHHmmss in Africa/Nairobi local time
 * (UTC+3), with no timezone marker. Returns null for anything that doesn't
 * match rather than guessing.
 */
export function parseDarajaTimestamp(value: string | null): Date | null {
  if (!value || !/^\d{14}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - 3 * 60 * 60 * 1000;
  const d = new Date(utcMs);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when there's nothing to compare (nothing recorded, or nothing in the callback) or the two amounts agree exactly. */
export function amountMatches(expectedAmount: number, callbackAmount: number | null): boolean {
  if (callbackAmount === null || !Number.isFinite(callbackAmount)) return false;
  return Math.abs(callbackAmount - expectedAmount) < 0.005;
}

/** True when there's nothing to compare against, or the two phone numbers agree once normalized. */
export function phoneMatches(expectedPhone: string | null, callbackPhone: string | null): boolean {
  if (!expectedPhone || !callbackPhone) return true; // nothing available to verify against — not a mismatch
  return normalizeKenyanPhone(callbackPhone) === expectedPhone;
}

// ============================================================================
// mpesa_callbacks audit log
// ============================================================================

async function logCallback(
  admin: AdminClient,
  fields: {
    outcome: MpesaCallbackOutcome;
    outcomeDetail?: string | null;
    parentId?: number | null;
    checkoutRequestId: string;
    merchantRequestId?: string | null;
    resultCode: number | null;
    payload: Json;
    paymentTransactionId?: string | null;
  },
): Promise<number | null> {
  const { data, error } = await admin
    .from("mpesa_callbacks")
    .insert({
      outcome: fields.outcome,
      outcome_detail: fields.outcomeDetail ?? null,
      parent_id: fields.parentId ?? null,
      checkout_request_id: fields.checkoutRequestId,
      merchant_request_id: fields.merchantRequestId ?? null,
      result_code: fields.resultCode,
      payload: fields.payload,
      payment_transaction_id: fields.paymentTransactionId ?? null,
    })
    .select("id")
    .single();

  if (error) {
    // The callback itself is still handled below; losing the audit row is a
    // problem, but it must never stop a real payment from being recorded.
    console.error(`[mpesa] could not write mpesa_callbacks row (outcome=${fields.outcome}):`, error.message);
    return null;
  }
  return (data as { id: number } | null)?.id ?? null;
}

// ============================================================================
// Coach activation payments — a separate table/flow, unchanged from Phase 1.
// ============================================================================

interface ActivationCallbackShape {
  ResultDesc?: string;
  CallbackMetadata?: { Item?: CallbackItem[] };
}

/** Applies a Daraja result to a coach activation payment. Unchanged from Phase 1. */
export async function reconcileActivationPayment(
  admin: AdminClient,
  checkoutRequestId: string,
  resultCode: number,
  stkCallback: ActivationCallbackShape,
): Promise<boolean> {
  const { data: payment } = await admin
    .from("coach_activation_payments")
    .select("id, status")
    .eq("checkout_request_id", checkoutRequestId)
    .maybeSingle();

  if (!payment) return false;
  if ((payment as { status: string }).status === "completed") return true;

  const paymentRow = payment as { id: string; status: string };

  if (resultCode === 0) {
    const receipt = stkCallback.CallbackMetadata?.Item?.find((i) => i.Name === "MpesaReceiptNumber")?.Value;
    const { error } = await admin
      .from("coach_activation_payments")
      .update({
        status: "completed",
        provider_reference: String(receipt ?? ""),
        result_desc: stkCallback.ResultDesc ?? null,
      })
      .eq("id", paymentRow.id)
      .neq("status", "completed");
    if (error) {
      console.error(
        `[activation] PAID but could not complete payment ${paymentRow.id} (${checkoutRequestId}):`,
        error.message,
      );
    }
  } else if (paymentRow.status === "pending") {
    await admin
      .from("coach_activation_payments")
      .update({ status: "failed", result_desc: stkCallback.ResultDesc ?? null })
      .eq("id", paymentRow.id)
      .eq("status", "pending");
  }
  return true;
}

// ============================================================================
// Subscription payments — the Phase 2 hardened callback path.
// ============================================================================

export type CallbackOutcome =
  | "credited"
  | "duplicate"
  | "failed_recorded"
  | "amount_mismatch"
  | "unmatched"
  | "rejected";

/**
 * Applies one Daraja STK callback to `payment_transactions`, end to end:
 * logs it, matches it to a payment by CheckoutRequestID (falling back to the
 * separate coach-activation flow), verifies amount and phone where a value
 * exists to check against, and only then completes the payment — atomically
 * crediting both wallets via the Phase 1 database trigger. Never throws for
 * an ordinary "nothing to do" case (unmatched, duplicate, already final);
 * Daraja still gets a 200 either way so it stops retrying.
 */
export async function applyStkCallback(
  admin: AdminClient,
  parsed: ParsedStkCallback,
  rawPayload: unknown,
): Promise<CallbackOutcome> {
  const parentId = await logCallback(admin, {
    outcome: "received",
    checkoutRequestId: parsed.checkoutRequestId,
    merchantRequestId: parsed.merchantRequestId,
    resultCode: parsed.resultCode,
    payload: rawPayload as Json,
  });

  const logOutcome = (outcome: CallbackOutcome, detail?: string, paymentTransactionId?: string) =>
    logCallback(admin, {
      outcome,
      outcomeDetail: detail,
      parentId,
      checkoutRequestId: parsed.checkoutRequestId,
      merchantRequestId: parsed.merchantRequestId,
      resultCode: parsed.resultCode,
      payload: rawPayload as Json,
      paymentTransactionId,
    });

  const { data: transaction, error: fetchError } = await admin
    .from("payment_transactions")
    .select("id, status, expected_amount, phone")
    .eq("checkout_request_id", parsed.checkoutRequestId)
    .maybeSingle();

  if (fetchError) {
    console.error("[mpesa callback] payment lookup failed:", fetchError.message);
    await logOutcome("rejected", "database lookup failed");
    return "rejected";
  }

  if (!transaction) {
    // Not a subscription payment — it may be a coach activation payment
    // (a separate table with its own, unchanged, reconciliation). That flow
    // needs the raw CallbackMetadata shape (to pull the receipt number), so
    // it's re-derived from the original payload rather than from `parsed`.
    const rawStkCallback = (rawPayload as { Body?: { stkCallback?: ActivationCallbackShape } })?.Body?.stkCallback ?? {};
    const handled = await reconcileActivationPayment(admin, parsed.checkoutRequestId, parsed.resultCode, rawStkCallback);
    await logOutcome(
      "unmatched",
      handled
        ? "matched a coach activation payment, not a subscription payment"
        : "no matching payment_transactions or coach_activation_payments row",
    );
    return "unmatched";
  }

  const row = transaction as { id: string; status: string; expected_amount: number; phone: string | null };

  // Idempotency: anything not still open is a duplicate/replay. A late failure
  // report on an already-`expired` row is informational only — `expired` may
  // legally become only `completed` (Phase 1 state machine), so recording a
  // failure on it would be an illegal transition; treat it the same as a
  // duplicate rather than attempting (and failing) that update.
  const isOpen = row.status === "pending" || row.status === "expired";
  if (!isOpen || (row.status === "expired" && parsed.resultCode !== 0)) {
    await logOutcome("duplicate", `payment already ${row.status}`, row.id);
    return "duplicate";
  }

  if (parsed.resultCode !== 0) {
    const { error } = await admin
      .from("payment_transactions")
      .update({
        status: "failed",
        result_code: parsed.resultCode,
        result_desc: parsed.resultDesc || null,
        callback_received_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "pending");
    if (error) {
      console.error(`[mpesa callback] could not record failure for payment ${row.id}:`, error.message);
      await logOutcome("rejected", "failure update failed", row.id);
      return "rejected";
    }
    await logOutcome("failed_recorded", parsed.resultDesc, row.id);
    return "failed_recorded";
  }

  // resultCode === 0: Daraja is claiming success. Verify BEFORE crediting
  // anything — a claim of success is not proof of success.
  if (!amountMatches(row.expected_amount, parsed.amount)) {
    const { error } = await admin
      .from("payment_transactions")
      .update({
        status: "review",
        result_code: parsed.resultCode,
        result_desc: `Callback amount ${parsed.amount ?? "missing"} did not match expected ${row.expected_amount}.`,
        callback_amount: parsed.amount,
        callback_received_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .in("status", ["pending", "expired"]);
    if (error) console.error(`[mpesa callback] could not flag amount mismatch for payment ${row.id}:`, error.message);
    await logOutcome("amount_mismatch", undefined, row.id);
    return "amount_mismatch";
  }

  if (!phoneMatches(row.phone, parsed.phone)) {
    const { error } = await admin
      .from("payment_transactions")
      .update({
        status: "review",
        result_code: parsed.resultCode,
        result_desc: "Callback phone did not match the number the STK prompt was sent to.",
        callback_amount: parsed.amount,
        callback_phone: parsed.phone,
        phone_mismatch: true,
        callback_received_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .in("status", ["pending", "expired"]);
    if (error) console.error(`[mpesa callback] could not flag phone mismatch for payment ${row.id}:`, error.message);
    await logOutcome("rejected", "callback phone did not match", row.id);
    return "rejected";
  }

  const paidAt = parseDarajaTimestamp(parsed.transactionDate) ?? new Date();

  const { error: completeError } = await admin
    .from("payment_transactions")
    .update({
      status: "completed",
      result_code: 0,
      result_desc: parsed.resultDesc || null,
      confirmed_via: "callback",
      provider_reference: parsed.receipt ?? "",
      callback_amount: parsed.amount,
      callback_phone: parsed.phone,
      merchant_request_id: parsed.merchantRequestId ?? null,
      paid_at: paidAt.toISOString(),
      callback_received_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .in("status", ["pending", "expired"]);

  if (completeError) {
    // The money really moved (result_code 0, amount and phone verified) but
    // the database write failed — this needs a human, urgently, not a retry
    // that might double-process. Loud and specific on purpose.
    console.error(
      `[mpesa callback] PAID but could not complete payment ${row.id} (${parsed.checkoutRequestId}):`,
      completeError.message,
    );
    await logOutcome("rejected", "completion update failed — needs manual review", row.id);
    return "rejected";
  }

  await logOutcome("credited", undefined, row.id);
  return "credited";
}

// ============================================================================
// STK Query — the server-side mechanism for actively checking a pending
// payment when the callback hasn't (yet) arrived.
// ============================================================================

export type ReconcileOutcome = "already_final" | "completed" | "failed" | "still_pending" | "query_unavailable" | "rejected";

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  status: string;
}

/**
 * Actively queries Daraja for a payment that is still `pending` (or
 * `expired` with no callback ever received) and applies a DEFINITE result.
 * Never completes a payment just because the HTTP query succeeded — only a
 * confirmed Daraja ResultCode 0 does that; `resultCode === null` ("still
 * processing") changes nothing. Bumps `query_attempts` / `last_queried_at`
 * on every real attempt so repeated polling is visible and boundable.
 *
 * `queryFn` defaults to the real Daraja call (queryStkPushStatus) and exists
 * as a parameter purely so tests can substitute a controlled fake — ES
 * module exports can't be monkey-patched, so this is the seam instead.
 */
export async function reconcilePendingPayment(
  admin: AdminClient,
  transactionId: string,
  queryFn: (checkoutRequestId: string) => ReturnType<typeof queryStkPushStatus> = queryStkPushStatus,
): Promise<ReconcileResult> {
  const { data, error } = await admin
    .from("payment_transactions")
    .select("id, status, checkout_request_id, query_attempts")
    .eq("id", transactionId)
    .maybeSingle();

  if (error) {
    console.error(`[mpesa query] lookup failed for payment ${transactionId}:`, error.message);
    return { outcome: "rejected", status: "unknown" };
  }
  if (!data) {
    return { outcome: "rejected", status: "unknown" };
  }

  const row = data as { id: string; status: string; checkout_request_id: string | null; query_attempts: number };

  if (row.status !== "pending" && row.status !== "expired") {
    return { outcome: "already_final", status: row.status };
  }
  if (!row.checkout_request_id) {
    return { outcome: "query_unavailable", status: row.status };
  }

  let result;
  try {
    result = await queryFn(row.checkout_request_id);
  } catch (err) {
    console.error(`[mpesa query] STK query failed for payment ${transactionId}:`, err instanceof Error ? err.message : err);
    await bumpQueryAttempt(admin, row.id, row.query_attempts);
    return { outcome: "query_unavailable", status: row.status };
  }

  await bumpQueryAttempt(admin, row.id, row.query_attempts);

  if (result.resultCode === null) {
    return { outcome: "still_pending", status: row.status };
  }

  // Illegal transition guard, same reasoning as the callback path: an
  // `expired` row may only ever legally become `completed`.
  if (row.status === "expired" && result.resultCode !== 0) {
    return { outcome: "already_final", status: row.status };
  }

  if (result.resultCode !== 0) {
    const { error: failError } = await admin
      .from("payment_transactions")
      .update({ status: "failed", result_code: result.resultCode, result_desc: result.resultDesc || null })
      .eq("id", row.id)
      .eq("status", "pending");
    if (failError) {
      console.error(`[mpesa query] could not record failure for payment ${transactionId}:`, failError.message);
      return { outcome: "rejected", status: row.status };
    }
    return { outcome: "failed", status: "failed" };
  }

  // resultCode === 0: Daraja itself confirms success. Unlike a callback,
  // Daraja's STK query response carries no Amount, phone or receipt number
  // to verify — so this can only ever record *that* Safaricom confirmed it,
  // not the transaction detail a callback would carry. That's recorded via
  // confirmed_via = 'query', which the database itself treats differently
  // (it does not require provider_reference/callback_amount for a
  // query-confirmed completion — see 0013's payment_state_machine()).
  const { error: completeError } = await admin
    .from("payment_transactions")
    .update({
      status: "completed",
      result_code: 0,
      result_desc: result.resultDesc || null,
      confirmed_via: "query",
      merchant_request_id: result.merchantRequestId ?? null,
      paid_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .in("status", ["pending", "expired"]);

  if (completeError) {
    console.error(`[mpesa query] PAID (per query) but could not complete payment ${transactionId}:`, completeError.message);
    return { outcome: "rejected", status: row.status };
  }

  return { outcome: "completed", status: "completed" };
}

async function bumpQueryAttempt(admin: AdminClient, id: string, currentAttempts: number): Promise<void> {
  const { error } = await admin
    .from("payment_transactions")
    .update({ last_queried_at: new Date().toISOString(), query_attempts: currentAttempts + 1 })
    .eq("id", id);
  if (error) {
    console.error(`[mpesa query] could not record query attempt for payment ${id}:`, error.message);
  }
}

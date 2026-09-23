import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

// ============================================================================
// Parsing — Daraja's B2C Result callback shape. Pure, no I/O.
// ============================================================================

export interface ParsedB2CCallback {
  conversationId: string;
  originatorConversationId: string | null;
  resultCode: number;
  resultDesc: string;
  transactionReceipt: string | null;
  transactionAmount: number | null;
}

type ResultParameter = { Key: string; Value: string | number };

/** Returns null for anything that isn't a recognisable Daraja B2C result callback. */
export function parseB2CCallback(payload: unknown): ParsedB2CCallback | null {
  if (!payload || typeof payload !== "object") return null;
  const result = (payload as { Result?: unknown }).Result as
    | {
        ConversationID?: unknown;
        OriginatorConversationID?: unknown;
        ResultCode?: unknown;
        ResultDesc?: unknown;
        ResultParameters?: { ResultParameter?: ResultParameter[] };
      }
    | undefined;

  if (!result || typeof result.ConversationID !== "string" || !result.ConversationID) return null;
  const resultCode = Number(result.ResultCode);
  if (!Number.isFinite(resultCode)) return null;

  const items: ResultParameter[] = Array.isArray(result.ResultParameters?.ResultParameter)
    ? (result.ResultParameters!.ResultParameter as ResultParameter[])
    : [];
  const find = (name: string) => items.find((i) => i && i.Key === name)?.Value;

  const receipt = find("TransactionReceipt");
  const txAmount = find("TransactionAmount");

  return {
    conversationId: result.ConversationID,
    originatorConversationId: typeof result.OriginatorConversationID === "string" ? result.OriginatorConversationID : null,
    resultCode,
    resultDesc: typeof result.ResultDesc === "string" ? result.ResultDesc : "",
    transactionReceipt: receipt === undefined ? null : String(receipt),
    transactionAmount: txAmount === undefined ? null : Number(txAmount),
  };
}

// ============================================================================
// Applying a B2C result to withdrawal_requests
// ============================================================================

export type B2CCallbackOutcome = "successful" | "duplicate" | "failed_recorded" | "unmatched" | "rejected";

/**
 * Applies one Daraja B2C result callback to `withdrawal_requests`. Matches by
 * ConversationID (stored when the payout was initiated), and only ever acts
 * on a row still in `processing` — anything else (already `successful`,
 * `failed`, `reversed`, or simply not found) is a safe no-op, so a duplicate
 * or replayed callback can never move money twice. The reservation made at
 * withdrawal creation already covers the debit; this function only ever
 * finalizes the row (`successful`) or releases the reservation (`failed`,
 * via the database's own state-machine trigger — see 0016's
 * handle_withdrawal_status_change()). It never touches a wallet balance or
 * wallet_ledger directly.
 */
export async function applyB2CCallback(admin: AdminClient, parsed: ParsedB2CCallback): Promise<B2CCallbackOutcome> {
  const { data, error: fetchError } = await admin
    .from("withdrawal_requests")
    .select("id, status, amount")
    .eq("conversation_id", parsed.conversationId)
    .maybeSingle();

  if (fetchError) {
    console.error("[b2c callback] withdrawal lookup failed:", fetchError.message);
    return "rejected";
  }
  if (!data) {
    console.error(`[b2c callback] no withdrawal matches ConversationID ${parsed.conversationId}`);
    return "unmatched";
  }

  const row = data as { id: string; status: string; amount: number };

  if (row.status !== "processing") {
    // Already finalized (successful/failed/reversed) — a duplicate delivery,
    // handled safely without touching anything.
    return "duplicate";
  }

  if (parsed.resultCode !== 0) {
    const { error } = await admin
      .from("withdrawal_requests")
      .update({ status: "failed", result_code: parsed.resultCode, result_desc: parsed.resultDesc || null })
      .eq("id", row.id)
      .eq("status", "processing");
    if (error) {
      console.error(`[b2c callback] could not record failure for withdrawal ${row.id}:`, error.message);
      return "rejected";
    }
    return "failed_recorded";
  }

  // resultCode === 0: Daraja confirms the payout succeeded. If it also reported the
  // amount actually paid and it doesn't match what we authorized, the money has
  // already moved (B2C is not reversible from our side) — record it as successful
  // regardless, but log loudly: this would mean a real discrepancy on Safaricom's
  // side that needs a human, not something the app can safely "fix" by refusing
  // the update.
  if (parsed.transactionAmount !== null && Math.abs(parsed.transactionAmount - row.amount) >= 0.005) {
    console.error(
      `[b2c callback] AMOUNT MISMATCH for withdrawal ${row.id}: authorized ${row.amount}, Daraja reported ${parsed.transactionAmount} paid — needs manual review.`,
    );
  }

  const { error } = await admin
    .from("withdrawal_requests")
    .update({
      status: "successful",
      result_code: 0,
      result_desc: parsed.resultDesc || null,
      provider_reference: parsed.transactionReceipt ?? null,
    })
    .eq("id", row.id)
    .eq("status", "processing");

  if (error) {
    console.error(`[b2c callback] PAID but could not finalize withdrawal ${row.id}:`, error.message);
    return "rejected";
  }
  return "successful";
}

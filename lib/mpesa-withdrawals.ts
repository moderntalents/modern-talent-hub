import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

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
  transactionId: string | null;
}

type ResultParameter = { Key: string; Value: string | number };

/** Returns null for anything that isn't a recognisable Daraja B2C result callback. */
export function parseB2CCallback(payload: unknown): ParsedB2CCallback | null {
  if (!payload || typeof payload !== "object") return null;
  const result = (payload as { Result?: unknown }).Result as
    | {
        ConversationID?: unknown;
        OriginatorConversationID?: unknown;
        TransactionID?: unknown;
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
    // Daraja's top-level Result.TransactionID — not assumed identical to
    // TransactionReceipt above; both are stored separately (see 0017's design notes).
    transactionId: typeof result.TransactionID === "string" ? result.TransactionID : null,
  };
}

// ============================================================================
// B2C attempts — creation, identifier attachment, ambiguous handling
// ============================================================================

export interface B2CAttempt {
  id: string;
  withdrawal_request_id: string;
  attempt_number: number;
  status: string;
}

/**
 * Starts a new B2C attempt for a withdrawal that's currently `processing`
 * (true immediately after reservation for attempt 1; true again right after
 * `authorizeB2CRetry` flips `review` back to `processing` for a retry).
 * Atomically supersedes any attempt still live for this withdrawal first —
 * see 0017's create_b2c_attempt(), which is where the actual guarantee
 * lives (a row lock on the parent, so this can never race unsafely with a
 * callback resolving the previous attempt).
 */
export async function createB2CAttempt(admin: AdminClient, withdrawalId: string): Promise<B2CAttempt> {
  const { data, error } = await admin.rpc("create_b2c_attempt", { p_withdrawal_id: withdrawalId });
  if (error || !data) {
    throw new Error(error?.message || "Could not create a B2C attempt.");
  }
  return data as unknown as B2CAttempt;
}

/** Attaches Daraja's identifiers to an attempt right after its synchronous accept — does not resolve anything. */
export async function attachB2CIdentifiers(
  admin: AdminClient,
  attemptId: string,
  conversationId: string,
  originatorConversationId: string,
): Promise<void> {
  const { error } = await admin.rpc("resolve_b2c_attempt", {
    p_attempt_id: attemptId,
    p_conversation_id: conversationId,
    p_originator_conversation_id: originatorConversationId,
    p_result_code: null,
    p_result_desc: null,
    p_provider_reference: null,
    p_transaction_id: null,
    p_raw_response: null,
  });
  if (error) {
    console.error(`[b2c] could not attach identifiers to attempt ${attemptId}:`, error.message);
  }
}

/**
 * Records that a B2C request could not be confirmed (network/timeout calling
 * Daraja) — the attempt is marked `ambiguous`, but the PARENT withdrawal is
 * deliberately left untouched (still `processing`): we do not know whether
 * Safaricom received the request, so we must not assume it did or didn't.
 * The reconciliation sweep (see below) is what eventually moves a withdrawal
 * stuck like this into `review`.
 */
export async function markAttemptAmbiguous(admin: AdminClient, attemptId: string, detail: string): Promise<void> {
  const { error } = await admin.rpc("mark_attempt_ambiguous", { p_attempt_id: attemptId, p_detail: detail });
  if (error) {
    console.error(`[b2c] could not mark attempt ${attemptId} ambiguous:`, error.message);
  }
}

// ============================================================================
// Applying a B2C result callback — matched to the ATTEMPT, not the parent
// ============================================================================

export type B2CCallbackOutcome =
  | "resolved_successful"
  | "resolved_failed"
  | "accepted"
  | "duplicate"
  | "superseded_recorded"
  | "unmatched"
  | "rejected";

/**
 * Applies one Daraja B2C result callback. Matches by ConversationID against
 * `withdrawal_b2c_attempts` — never against the parent withdrawal directly,
 * which is exactly what lets a late callback for a superseded attempt be
 * recorded (for audit) without ever touching the wallet or the parent's
 * status: 0017's resolve_b2c_attempt() only lets an attempt affect its
 * parent while that attempt's own status is still `requested`/`accepted`.
 * The moment a retry creates a new attempt, the old one is atomically
 * superseded — so this function itself doesn't need to re-derive "is this
 * still the active attempt," it just calls resolve_b2c_attempt() and trusts
 * the database's own row-locked decision.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function applyB2CCallback(admin: AdminClient, parsed: ParsedB2CCallback): Promise<B2CCallbackOutcome> {
  type AttemptRow = { id: string; withdrawal_request_id: string; status: string };

  const { data: byConversationId, error: fetchError } = await admin
    .from("withdrawal_b2c_attempts")
    .select("id, withdrawal_request_id, status")
    .eq("conversation_id", parsed.conversationId)
    .maybeSingle();

  if (fetchError) {
    console.error("[b2c callback] attempt lookup failed:", fetchError.message);
    return "rejected";
  }

  let row = byConversationId as AttemptRow | null;

  // Fallback: OriginatorConversationID is OUR OWN attempt id (see where it's sent, in
  // app/api/withdrawals/route.ts and the retry route) — generated and persisted BEFORE
  // Daraja is ever called, unlike conversation_id, which only exists locally once
  // initiateB2CPayout's response has been written back via attachB2CIdentifiers. If the
  // server crashes in that exact window (Daraja already accepted the request and handed
  // back a real ConversationID, but the process died before persisting it), conversation_id
  // stays null forever and the primary lookup above can never match. OriginatorConversationID
  // has no such window — it's always in the database first — so it's what recovers this case.
  if (!row && parsed.originatorConversationId && UUID_RE.test(parsed.originatorConversationId)) {
    const { data: byOriginatorId, error: fallbackError } = await admin
      .from("withdrawal_b2c_attempts")
      .select("id, withdrawal_request_id, status")
      .eq("id", parsed.originatorConversationId)
      .maybeSingle();
    if (fallbackError) {
      console.error("[b2c callback] fallback attempt lookup by OriginatorConversationID failed:", fallbackError.message);
      return "rejected";
    }
    row = byOriginatorId as AttemptRow | null;
  }

  if (!row) {
    console.error(`[b2c callback] no B2C attempt matches ConversationID ${parsed.conversationId}`);
    return "unmatched";
  }

  // If Daraja reported the amount it actually paid and it doesn't match what we
  // authorized, the money has already moved (B2C is not reversible from our side) —
  // resolve the attempt normally regardless, but log loudly: this is purely an
  // observability signal for a human, never a reason to reject the callback, change
  // the outcome, or touch the wallet/ledger/attempt count.
  if (parsed.resultCode === 0 && parsed.transactionAmount !== null) {
    const { data: withdrawal } = await admin
      .from("withdrawal_requests")
      .select("amount")
      .eq("id", row.withdrawal_request_id)
      .maybeSingle();
    const authorizedAmount = (withdrawal as { amount: number } | null)?.amount;
    if (authorizedAmount !== undefined && authorizedAmount !== null && Math.abs(parsed.transactionAmount - authorizedAmount) >= 0.005) {
      console.error(
        `[b2c callback] AMOUNT MISMATCH for withdrawal ${row.withdrawal_request_id} (attempt ${row.id}): authorized ${authorizedAmount}, Daraja reported ${parsed.transactionAmount} paid — needs manual review.`,
      );
    }
  }

  const { data: outcome, error } = await admin.rpc("resolve_b2c_attempt", {
    p_attempt_id: row.id,
    p_conversation_id: parsed.conversationId,
    p_originator_conversation_id: parsed.originatorConversationId,
    p_result_code: parsed.resultCode,
    p_result_desc: parsed.resultDesc || null,
    p_provider_reference: parsed.transactionReceipt,
    p_transaction_id: parsed.transactionId,
    p_raw_response: parsed as unknown as Json,
  });

  if (error) {
    console.error(`[b2c callback] could not resolve attempt ${row.id}:`, error.message);
    return "rejected";
  }

  return (outcome as B2CCallbackOutcome | null) ?? "rejected";
}

// ============================================================================
// Reconciliation: stale-processing sweep, admin retry, admin manual resolution
// ============================================================================

export interface StaleWithdrawal {
  id: string;
  attempt_id: string | null;
  requested_at: string | null;
}

/**
 * Finds `processing` withdrawals whose current live attempt has been
 * waiting past `staleMinutes`. Elapsed time alone is never treated as
 * evidence of failure here — it only ever identifies a CANDIDATE for
 * `review`; nothing is marked `failed` by this function. Returns the
 * withdrawals that were actually claimed-and-swept this run.
 */
export async function sweepStaleProcessingWithdrawals(
  admin: AdminClient,
  options: { staleMinutes: number; leaseMinutes: number; actorId?: string | null },
): Promise<{ withdrawalId: string; swept: boolean }[]> {
  const cutoffMs = Date.now() - options.staleMinutes * 60_000;

  const { data: candidates, error } = await admin
    .from("withdrawal_requests")
    .select("id")
    .eq("status", "processing");
  if (error || !candidates) {
    if (error) console.error("[reconciliation] could not list processing withdrawals:", error.message);
    return [];
  }

  const results: { withdrawalId: string; swept: boolean }[] = [];
  for (const c of candidates as { id: string }[]) {
    const { data: attempts } = await admin
      .from("withdrawal_b2c_attempts")
      .select("id, requested_at")
      .eq("withdrawal_request_id", c.id)
      .in("status", ["requested", "accepted"]);
    const live = (attempts as { id: string; requested_at: string }[] | null)?.[0];
    // No live attempt at all (e.g. the very first insert crashed before an attempt was
    // ever created) is exactly as stale as one that's been waiting — use the withdrawal's
    // own reserved_at as the fallback age reference in that case.
    let ageReference: string | Date | null = live?.requested_at ?? null;
    if (!ageReference) {
      const { data: w } = await admin.from("withdrawal_requests").select("reserved_at").eq("id", c.id).maybeSingle();
      ageReference = (w as { reserved_at: string | null } | null)?.reserved_at ?? null;
    }
    // Compare as actual instants, not raw values: the Supabase/PGlite driver may hand back
    // a timestamptz as either a string or a Date depending on the client, and comparing
    // those with `>` directly is unreliable (a Date's default ToPrimitive conversion for
    // relational operators uses its toString() format, not an ISO string, so `Date > string`
    // silently compares the wrong thing).
    if (!ageReference || new Date(ageReference).getTime() > cutoffMs) continue; // not stale yet

    const { data: claimed } = await admin.rpc("claim_withdrawal_for_reconciliation", {
      p_withdrawal_id: c.id,
      p_actor: options.actorId ?? null,
      p_lease_minutes: options.leaseMinutes,
    });
    if (!claimed) {
      results.push({ withdrawalId: c.id, swept: false }); // already claimed by another worker
      continue;
    }

    const { data: swept } = await admin.rpc("sweep_withdrawal_to_review", {
      p_withdrawal_id: c.id,
      p_reason: `No confirmed B2C result within ${options.staleMinutes} minutes of the request.`,
    });
    results.push({ withdrawalId: c.id, swept: Boolean(swept) });
  }
  return results;
}

/**
 * Admin-only, requires `review`, requires a written justification (enforced
 * again at the database level by authorize_b2c_retry — this is not merely a
 * client-side check). Creates a new attempt, reusing the SAME reservation —
 * never a new withdrawal row, never a new wallet_ledger debit.
 */
export async function authorizeB2CRetry(
  admin: AdminClient,
  withdrawalId: string,
  adminId: string,
  reason: string,
): Promise<B2CAttempt> {
  const { data, error } = await admin.rpc("authorize_b2c_retry", {
    p_withdrawal_id: withdrawalId,
    p_admin_id: adminId,
    p_reason: reason,
  });
  if (error || !data) {
    throw new Error(error?.message || "Could not authorize a B2C retry.");
  }
  return data as unknown as B2CAttempt;
}

/**
 * A direct admin override with no new B2C attempt — e.g. the admin confirmed
 * via Safaricom's own records that a prior attempt did (or did not) pay,
 * without sending anything new. Still goes through the existing state-machine
 * trigger for any financial effect (a 'failed' outcome still runs the normal
 * reversal) — this function never touches wallet_balance or wallet_ledger itself.
 */
export async function adminResolveWithdrawal(
  admin: AdminClient,
  withdrawalId: string,
  outcome: "successful" | "failed",
  adminId: string,
  reason: string,
  providerReference: string | null = null,
): Promise<void> {
  const { error } = await admin.rpc("admin_resolve_withdrawal", {
    p_withdrawal_id: withdrawalId,
    p_outcome: outcome,
    p_admin_id: adminId,
    p_reason: reason,
    p_provider_reference: providerReference,
  });
  if (error) {
    throw new Error(error.message || "Could not resolve the withdrawal.");
  }
}

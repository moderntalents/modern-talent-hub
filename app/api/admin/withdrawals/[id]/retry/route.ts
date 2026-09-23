import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { B2CAmbiguousError, initiateB2CPayout } from "@/lib/mpesa";
import { attachB2CIdentifiers, authorizeB2CRetry, markAttemptAmbiguous } from "@/lib/mpesa-withdrawals";

// Admin-only: authorizes a new B2C attempt for a withdrawal stuck in `review`.
// Requires a written reason (also enforced in the database by
// authorize_b2c_retry — this is not merely a client-side check). Reuses the
// EXISTING reservation: no new withdrawal row, no new wallet debit. If the
// retry itself times out or can't be confirmed, the new attempt is marked
// ambiguous and the withdrawal is left in `processing` for the sweep to
// pick up again — never assumed to have failed.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const reason: string | undefined = body?.reason;
  if (!reason || reason.trim().length < 10) {
    return NextResponse.json(
      { error: "A written justification of at least 10 characters is required to authorize a retry." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  const { data: withdrawal, error: fetchError } = await admin
    .from("withdrawal_requests")
    .select("id, destination, amount, status")
    .eq("id", id)
    .maybeSingle();
  if (fetchError || !withdrawal) {
    return NextResponse.json({ error: "Withdrawal not found." }, { status: 404 });
  }

  let attempt;
  try {
    attempt = await authorizeB2CRetry(admin, id, user.id, reason.trim());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not authorize a retry." },
      { status: 400 },
    );
  }

  try {
    const payout = await initiateB2CPayout({
      phoneNumber: withdrawal.destination,
      amount: withdrawal.amount,
      remarks: `MTH withdrawal ${withdrawal.id.slice(0, 8)} retry`,
      // See app/api/withdrawals/route.ts for why this is the attempt's own id, not a
      // derived string — it's already persisted before Daraja is ever called.
      originatorConversationId: attempt.id,
    });

    await attachB2CIdentifiers(admin, attempt.id, payout.conversationId, payout.originatorConversationId);

    return NextResponse.json({
      message: "Retry authorized and submitted — the withdrawal is processing again.",
      attempt,
    });
  } catch (err) {
    if (err instanceof B2CAmbiguousError) {
      // Same rule as the original attempt: we don't know whether Safaricom
      // received the retry, so the parent stays `processing` (reservation
      // untouched) until the sweep or another admin decision resolves it.
      await markAttemptAmbiguous(admin, attempt.id, err.message);
      return NextResponse.json(
        { message: "Retry authorized, but the request to Safaricom could not be confirmed. It's being reviewed.", ambiguous: true, attempt },
        { status: 202 },
      );
    }

    const { error: failError } = await admin.rpc("resolve_b2c_attempt", {
      p_attempt_id: attempt.id,
      p_conversation_id: null,
      p_originator_conversation_id: null,
      p_result_code: -1,
      p_result_desc: err instanceof Error ? err.message : "B2C retry request failed",
      p_provider_reference: null,
      p_transaction_id: null,
      p_raw_response: null,
    });
    if (failError) {
      console.error(`[retry] could not resolve rejected retry attempt for withdrawal ${id}:`, failError.message);
    }

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "B2C retry failed." },
      { status: 502 },
    );
  }
}

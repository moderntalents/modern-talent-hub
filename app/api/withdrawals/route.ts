import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { initiateB2CPayout, isB2CConfigured, validatePaymentAmount } from "@/lib/mpesa";

// Creates a withdrawal request.
//
// method "bank": UNCHANGED from Phase 1 — records a "pending" request; an admin
// reviews and processes it manually from /admin/withdrawals. Not touched by this route
// beyond using the admin client to perform the same insert RLS already allowed.
//
// method "mpesa": the database (0016_coach_b2c_withdrawal.sql, check_withdrawal_amount())
// atomically reserves the amount from the wallet, writes the withdrawal_debit ledger row,
// and returns the row already "processing" — using the teacher's OWN registered
// teacher_profiles.mpesa_number as the destination, never whatever the client sent. Once
// that succeeds, this route initiates the real B2C payout and records Daraja's
// identifiers. The final outcome (success or failure) only ever comes from the B2C
// result callback (app/api/mpesa/b2c-callback/[secret]/route.ts) — never from this
// route's own response.
//
// The insert uses the SERVICE ROLE (not the caller's session) because the reservation
// trigger needs to change teacher_profiles.wallet_balance, which 0012's guard trigger
// refuses for any 'anon'/'authenticated' caller — exactly the protection that stops a
// browser from forging a wallet change. Authorization is instead enforced here, in code,
// before the service role is ever used: the signed-in session is checked first, and
// teacher_id is always the verified user's own id, never client input.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "teacher") {
    return NextResponse.json({ error: "Only teacher accounts can request withdrawals." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const rawAmount = body?.amount;
  const destinationInput: string | undefined = body?.destination;
  const method: "mpesa" | "bank" = body?.method === "bank" ? "bank" : "mpesa";

  let amount: number;
  try {
    amount = validatePaymentAmount(rawAmount);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Enter a valid amount." }, { status: 400 });
  }

  if (method === "bank" && !destinationInput?.trim()) {
    return NextResponse.json({ error: "Enter your bank account details." }, { status: 400 });
  }
  if (method === "mpesa" && !isB2CConfigured()) {
    return NextResponse.json(
      { error: "M-Pesa withdrawals are not configured on this deployment yet. An administrator needs to set the MPESA_B2C_* environment variables." },
      { status: 503 },
    );
  }

  const admin = createAdminClient();

  // For "mpesa", `destination` is intentionally NOT the client's input — the database
  // trigger overrides it with the coach's own registered number regardless of what's
  // sent here. It's included only to satisfy the column's NOT NULL constraint before
  // the trigger runs; for "bank" it's exactly what the coach typed, unchanged.
  const { data: withdrawal, error } = await admin
    .from("withdrawal_requests")
    .insert({
      teacher_id: user.id,
      amount,
      destination: method === "mpesa" ? "pending-reservation" : destinationInput!.trim(),
      method,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    // check_withdrawal_amount raises a Postgres exception if the amount exceeds the
    // available balance, or if no M-Pesa number is registered — surfaced as a normal
    // validation error rather than a generic 500.
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (method === "bank") {
    return NextResponse.json({ withdrawal });
  }

  // method === "mpesa": the row above is already "processing" (reserved) — now
  // actually send the money.
  try {
    const payout = await initiateB2CPayout({
      phoneNumber: withdrawal.destination,
      amount: withdrawal.amount,
      remarks: `MTH withdrawal ${withdrawal.id.slice(0, 8)}`,
      originatorConversationId: withdrawal.id,
    });

    const { error: linkError } = await admin
      .from("withdrawal_requests")
      .update({ conversation_id: payout.conversationId, originator_conversation_id: payout.originatorConversationId })
      .eq("id", withdrawal.id);
    if (linkError) {
      // The payout is already in flight at Safaricom; without this link the callback
      // can't find the row. Surface it loudly for manual reconciliation.
      console.error(
        `[withdrawals] B2C sent but could not store conversation_id ${payout.conversationId} for withdrawal ${withdrawal.id}:`,
        linkError.message,
      );
    }

    return NextResponse.json({
      message: "Withdrawal submitted — you'll be paid out via M-Pesa shortly.",
      withdrawal: { ...withdrawal, conversation_id: payout.conversationId, status: "processing" },
    });
  } catch (err) {
    // Daraja refused the request outright (bad number, B2C not approved, network
    // error, etc.) — the reservation must not be left stranded. Marking the row
    // "failed" runs the database's own reversal path (0016), crediting the amount
    // back and writing exactly one withdrawal_reversal ledger entry.
    const { error: failError } = await admin
      .from("withdrawal_requests")
      .update({ status: "failed", result_desc: err instanceof Error ? err.message : "B2C payout failed" })
      .eq("id", withdrawal.id)
      .eq("status", "processing");
    if (failError) {
      console.error(`[withdrawals] could not release reservation for withdrawal ${withdrawal.id} after B2C failure:`, failError.message);
    }

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "B2C payout failed." },
      { status: 502 },
    );
  }
}

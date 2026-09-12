import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { WithdrawalStatus } from "@/lib/supabase/types";

const ALLOWED: WithdrawalStatus[] = ["processing", "successful", "failed", "reversed"];

// Admin-only: transition a withdrawal request's status. Marking a request
// "successful" here only updates the ledger — it asserts that the admin has
// actually sent the money (e.g. via the business's own M-Pesa/bank channel,
// or later, once wired up, via lib/mpesa.ts's B2C payout). Nothing in this
// codebase disburses funds automatically.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  const status: WithdrawalStatus | undefined = body?.status;
  const providerReference: string | undefined = body?.providerReference;
  const notes: string | undefined = body?.notes;

  if (!status || !ALLOWED.includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${ALLOWED.join(", ")}` }, { status: 400 });
  }
  if (status === "successful" && !providerReference?.trim()) {
    return NextResponse.json(
      { error: "providerReference is required when marking a withdrawal successful (e.g. the M-Pesa transaction code you sent it with)." },
      { status: 400 },
    );
  }

  // Uses the admin client because the wallet-debit/credit-back trigger on
  // this table needs to run with certainty regardless of the caller's RLS
  // grants; the admin role check above already gates who can reach this code path.
  const admin = createAdminClient();

  if (status === "reversed") {
    const { data: current } = await admin
      .from("withdrawal_requests")
      .select("status")
      .eq("id", id)
      .single();
    if (current?.status !== "successful") {
      return NextResponse.json(
        { error: "Only a withdrawal already marked successful can be reversed." },
        { status: 400 },
      );
    }
  }

  const { data, error } = await admin
    .from("withdrawal_requests")
    .update({ status, provider_reference: providerReference, notes })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ withdrawal: data });
}

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcilePendingPayment } from "@/lib/mpesa-payments";

/**
 * Lets the student's own browser (or, later, a scheduled job) ask the server
 * to actively check Daraja for a payment's real outcome — for when the STK
 * prompt was answered but Safaricom's callback never arrived (a lost
 * webhook, not a decision either way). This is a deliberately narrow,
 * on-demand mechanism: it queries and reconciles exactly one payment per
 * call, and does not by itself schedule or retry anything.
 *
 * Never trusts the mere fact that the HTTP query succeeded: only a
 * confirmed Daraja result (ResultCode 0, or a definite non-zero failure
 * code) can move the payment — see lib/mpesa-payments.ts. "Still
 * processing" leaves the payment exactly as it was.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  // RLS (transactions_read_own) already restricts reads to the student or
  // teacher on the transaction (or an admin), so this confirms the caller
  // may even see the payment before letting them trigger a Daraja query for it.
  const { data: owned, error: ownError } = await supabase
    .from("payment_transactions")
    .select("id")
    .eq("id", transactionId)
    .maybeSingle();

  if (ownError || !owned) {
    return NextResponse.json({ error: "Transaction not found." }, { status: 404 });
  }

  const admin = createAdminClient();
  const result = await reconcilePendingPayment(admin, transactionId);

  return NextResponse.json(result);
}

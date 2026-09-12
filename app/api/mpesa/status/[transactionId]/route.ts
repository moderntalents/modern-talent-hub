import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Lets the student's own browser poll for the real, server-confirmed outcome
// of a payment it initiated — never trust a client-side timer to assume
// success. RLS (transactions_read_own) already restricts this to the
// student or teacher on the transaction, so no extra authorization needed
// beyond the standard session check.
export async function GET(_request: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { data: transaction, error } = await supabase
    .from("payment_transactions")
    .select("status")
    .eq("id", transactionId)
    .single();

  if (error || !transaction) {
    return NextResponse.json({ error: "Transaction not found." }, { status: 404 });
  }

  return NextResponse.json({ status: transaction.status });
}

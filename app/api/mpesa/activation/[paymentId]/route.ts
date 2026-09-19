import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Lets the coach's browser poll for the real, server-confirmed outcome of an
// activation payment. Only the M-Pesa callback can flip a payment to
// "completed"; RLS (activation_payments_read_own) limits reads to its owner.
export async function GET(_request: Request, { params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { data: payment, error } = await supabase
    .from("coach_activation_payments")
    .select("status")
    .eq("id", paymentId)
    .single();

  if (error || !payment) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }

  return NextResponse.json({ status: payment.status });
}

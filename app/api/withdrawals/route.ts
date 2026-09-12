import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Creates a withdrawal request. This does NOT move any money — it only
// records the teacher's request as "pending". An admin reviews and processes
// it from /admin/withdrawals (manually, until lib/mpesa.ts's B2C payout is
// wired up to a Safaricom-approved Paybill). The database itself refuses to
// accept a request larger than the teacher's real wallet balance
// (trg_check_withdrawal_amount in supabase/migrations/0001_init.sql).
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
  const amount = Number(body?.amount);
  const destination: string | undefined = body?.destination;
  const method: "mpesa" | "bank" = body?.method === "bank" ? "bank" : "mpesa";

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: "Enter a valid amount." }, { status: 400 });
  }
  if (!destination?.trim()) {
    return NextResponse.json(
      { error: method === "mpesa" ? "Enter your M-Pesa number." : "Enter your bank account details." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("withdrawal_requests")
    .insert({ teacher_id: user.id, amount, destination, method, status: "pending" })
    .select()
    .single();

  if (error) {
    // trg_check_withdrawal_amount raises a Postgres exception if the amount
    // exceeds the wallet balance — surface it as a normal validation error.
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ withdrawal: data });
}

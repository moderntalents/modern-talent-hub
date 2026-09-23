import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminResolveWithdrawal } from "@/lib/mpesa-withdrawals";

const OUTCOMES = ["successful", "failed"] as const;
type Outcome = (typeof OUTCOMES)[number];

// Admin-only: a direct manual resolution of a withdrawal stuck in `review` —
// e.g. the admin confirmed via Safaricom's own records (outside this system)
// whether a prior attempt actually paid out. Requires a written reason
// (also enforced in the database by admin_resolve_withdrawal). Never touches
// wallet_balance or wallet_ledger directly — goes through the existing
// state-machine trigger, so a 'failed' outcome still runs the normal,
// exactly-once reversal.
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
  const outcome: Outcome | undefined = body?.outcome;
  const reason: string | undefined = body?.reason;
  const providerReference: string | undefined = body?.providerReference;

  if (!outcome || !OUTCOMES.includes(outcome)) {
    return NextResponse.json({ error: `outcome must be one of: ${OUTCOMES.join(", ")}` }, { status: 400 });
  }
  if (!reason || reason.trim().length < 10) {
    return NextResponse.json(
      { error: "A written justification of at least 10 characters is required to manually resolve a withdrawal." },
      { status: 400 },
    );
  }
  if (outcome === "successful" && !providerReference?.trim()) {
    return NextResponse.json(
      { error: "providerReference is required when resolving a withdrawal as successful (the M-Pesa transaction code confirmed with Safaricom)." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  try {
    await adminResolveWithdrawal(admin, id, outcome, user.id, reason.trim(), providerReference?.trim() ?? null);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not resolve the withdrawal." },
      { status: 400 },
    );
  }

  const { data: withdrawal, error } = await admin.from("withdrawal_requests").select().eq("id", id).single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ withdrawal });
}

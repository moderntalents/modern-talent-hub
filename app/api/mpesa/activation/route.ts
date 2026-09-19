import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { initiateStkPush, isMpesaConfigured } from "@/lib/mpesa";
import { normalizeKenyanPhone } from "@/lib/phone";
import { arePaymentsEnabled, getCoachActivationFee } from "@/lib/settings";
import { formatKes } from "@/lib/constants";

// A prompt left unanswered this long is treated as abandoned so the coach can
// try again. Daraja prompts themselves lapse after ~60-90s.
const PENDING_TTL_MS = 2 * 60 * 1000;

// Starts the coach activation payment. The price is NEVER taken from the
// request: it is read from the platform_settings table (editable at
// /admin/settings) at the moment of payment, snapshotted onto the payment row,
// and that same number is sent to Daraja as the STK Push `Amount`.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  if (!isMpesaConfigured()) {
    return NextResponse.json(
      {
        error:
          "M-Pesa payments are not configured on this deployment yet. " +
          "An administrator needs to set the MPESA_* environment variables.",
      },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  const phoneNumber = normalizeKenyanPhone(String(body?.phoneNumber ?? ""));
  if (!phoneNumber) {
    return NextResponse.json(
      { error: "Enter a valid Kenyan phone number, e.g. 0712 345 678." },
      { status: 400 },
    );
  }

  const { data: coach } = await supabase
    .from("teacher_profiles")
    .select("activated")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (!coach) {
    return NextResponse.json({ error: "Only coach accounts pay the activation fee." }, { status: 403 });
  }
  if (coach.activated) {
    return NextResponse.json({ error: "Your account is already activated." }, { status: 409 });
  }

  const admin = createAdminClient();

  try {
    if (!(await arePaymentsEnabled(admin))) {
      return NextResponse.json(
        { error: "Payments are switched off, so activation is free — no payment needed." },
        { status: 403 },
      );
    }
  } catch (err) {
    console.error("[activation] payments setting lookup failed:", err);
    return NextResponse.json({ error: "Could not check payment settings. Try again shortly." }, { status: 500 });
  }

  let fee: number | null = null;
  try {
    fee = await getCoachActivationFee(admin);
  } catch (err) {
    console.error("[activation] fee lookup failed:", err);
    return NextResponse.json({ error: "Could not load the activation fee. Try again shortly." }, { status: 500 });
  }
  if (fee === null) {
    return NextResponse.json(
      { error: "Activation isn't open yet — the fee hasn't been set. Please contact support." },
      { status: 503 },
    );
  }

  // Retire abandoned prompts so they don't block a retry (the partial unique
  // index allows only one pending payment per coach).
  await admin
    .from("coach_activation_payments")
    .update({ status: "expired" })
    .eq("teacher_id", user.id)
    .eq("status", "pending")
    .lt("created_at", new Date(Date.now() - PENDING_TTL_MS).toISOString());

  const { data: payment, error: insertError } = await admin
    .from("coach_activation_payments")
    .insert({ teacher_id: user.id, amount: fee, phone: phoneNumber })
    .select("id")
    .single();

  if (insertError || !payment) {
    // 23505 = the one-pending-payment-per-coach index: a prompt is already out.
    if (insertError?.code === "23505") {
      return NextResponse.json(
        { error: "A payment prompt is already on your phone. Complete it, or wait a minute and try again." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: insertError?.message ?? "Could not create payment record." },
      { status: 500 },
    );
  }

  try {
    const stk = await initiateStkPush({
      phoneNumber,
      amount: fee,
      // Daraja limits: AccountReference 12 chars, TransactionDesc 13 chars.
      accountReference: `ACT-${user.id.slice(0, 8)}`,
      transactionDesc: "Activation",
    });

    const { error: linkError } = await admin
      .from("coach_activation_payments")
      .update({
        checkout_request_id: stk.checkoutRequestId,
        merchant_request_id: stk.merchantRequestId,
      })
      .eq("id", payment.id);
    if (linkError) {
      // The prompt is already on the coach's phone; without this link the
      // callback can't find the row. Surface it loudly for manual reconciliation.
      console.error(
        `[activation] STK sent but could not store checkout_request_id ${stk.checkoutRequestId} for payment ${payment.id}:`,
        linkError.message,
      );
    }

    return NextResponse.json({
      message: `Check your phone and enter your M-Pesa PIN to pay ${formatKes(fee)}.`,
      paymentId: payment.id,
      amount: fee,
    });
  } catch (err) {
    await admin
      .from("coach_activation_payments")
      .update({ status: "failed", result_desc: err instanceof Error ? err.message : "STK push failed" })
      .eq("id", payment.id);

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "STK push failed." },
      { status: 502 },
    );
  }
}

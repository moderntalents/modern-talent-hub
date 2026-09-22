import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { initiateStkPush, isMpesaConfigured, validatePaymentAmount, TRANSACTION_DESC_MAX_LENGTH } from "@/lib/mpesa";
import { normalizeKenyanPhone as normalizePhone } from "@/lib/phone";
import { arePaymentsEnabled } from "@/lib/settings";
import { AGE_GATE_MESSAGE, isAgeCleared } from "@/lib/age-gate";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  if (!(await isAgeCleared(user.id))) {
    return NextResponse.json({ error: AGE_GATE_MESSAGE }, { status: 403 });
  }

  try {
    if (!(await arePaymentsEnabled())) {
      return NextResponse.json(
        { error: "Payments are switched off — activities are free to join right now." },
        { status: 403 },
      );
    }
  } catch (err) {
    console.error("[stkpush] payments setting lookup failed:", err);
    return NextResponse.json({ error: "Could not check payment settings. Try again shortly." }, { status: 500 });
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
  const activityId: string | undefined = body?.activityId;
  const phoneInput: string | undefined = body?.phoneNumber;

  if (!activityId || !phoneInput) {
    return NextResponse.json(
      { error: "activityId and phoneNumber are required." },
      { status: 400 },
    );
  }

  const phoneNumber = normalizePhone(phoneInput);
  if (!phoneNumber) {
    return NextResponse.json(
      { error: "Enter a valid Kenyan phone number, e.g. 0712 345 678." },
      { status: 400 },
    );
  }

  const { data: activity, error: activityError } = await supabase
    .from("activities")
    .select("id, teacher_id, title, price, status")
    .eq("id", activityId)
    .single();

  if (activityError || !activity) {
    return NextResponse.json({ error: "Activity not found." }, { status: 404 });
  }
  if (activity.status !== "published") {
    return NextResponse.json({ error: "This activity is not available." }, { status: 400 });
  }
  if (activity.price <= 0) {
    return NextResponse.json(
      { error: "This activity is free — use the enrol action instead of paying." },
      { status: 400 },
    );
  }

  // Fail closed on a bad price rather than letting an invalid amount reach
  // Daraja (or get silently rounded): this is money, not a display value.
  try {
    validatePaymentAmount(activity.price);
  } catch (err) {
    console.error(`[stkpush] activity ${activity.id} has an invalid price (${activity.price}):`, err);
    return NextResponse.json(
      { error: "This activity's price is invalid. Please contact support." },
      { status: 500 },
    );
  }

  // Reuse an existing pending/active subscription row for this student+activity
  // rather than creating duplicates (subscriptions has a unique constraint).
  const { data: subscription, error: subError } = await supabase
    .from("subscriptions")
    .upsert(
      {
        student_id: user.id,
        activity_id: activity.id,
        teacher_id: activity.teacher_id,
        status: "pending_payment",
      },
      { onConflict: "student_id,activity_id", ignoreDuplicates: false },
    )
    .select()
    .single();

  if (subError || !subscription) {
    return NextResponse.json(
      { error: subError?.message ?? "Could not create subscription." },
      { status: 500 },
    );
  }

  // payment_transactions has no client-facing RLS write policy at all — every
  // row is created and mutated exclusively through this trusted server code
  // path (using the service role), never by the signed-in user's own session,
  // so a payment's existence and amount can never be forged from the browser.
  const admin = createAdminClient();

  const { data: transaction, error: txError } = await admin
    .from("payment_transactions")
    .insert({
      subscription_id: subscription.id,
      student_id: user.id,
      teacher_id: activity.teacher_id,
      amount: activity.price,
      provider: "mpesa",
      status: "pending",
      // Recorded so the callback can later verify the payer's phone matches
      // the number the STK prompt was actually sent to.
      phone: phoneNumber,
    })
    .select()
    .single();

  if (txError || !transaction) {
    return NextResponse.json(
      { error: txError?.message ?? "Could not create transaction record." },
      { status: 500 },
    );
  }

  try {
    const stk = await initiateStkPush({
      phoneNumber,
      amount: activity.price,
      accountReference: `MTH-${activity.id.slice(0, 8)}`,
      // activity.title is free text with no length limit in the app; Daraja's
      // TransactionDesc is capped, so it's truncated here rather than left to
      // fail the STK push for any activity with a longer title.
      transactionDesc: activity.title.slice(0, TRANSACTION_DESC_MAX_LENGTH),
    });

    const { error: linkError } = await admin
      .from("payment_transactions")
      .update({ checkout_request_id: stk.checkoutRequestId, merchant_request_id: stk.merchantRequestId })
      .eq("id", transaction.id);
    if (linkError) {
      // The prompt is already on the student's phone; without this link the
      // callback can't find the row. Surface it loudly for manual reconciliation.
      console.error(
        `[stkpush] STK sent but could not store checkout_request_id ${stk.checkoutRequestId} for payment ${transaction.id}:`,
        linkError.message,
      );
    }

    return NextResponse.json({
      message: "Check your phone and enter your M-Pesa PIN to complete payment.",
      checkoutRequestId: stk.checkoutRequestId,
      transactionId: transaction.id,
    });
  } catch (err) {
    await admin.from("payment_transactions").update({ status: "failed" }).eq("id", transaction.id);

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "STK push failed." },
      { status: 502 },
    );
  }
}

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Safaricom Daraja calls this URL directly (server-to-server) after the payer
 * enters their M-Pesa PIN. Daraja does NOT cryptographically sign its
 * callbacks, so a bare `/api/mpesa/callback` would trust *any* caller who
 * knows a transaction's `checkoutRequestId` — and that ID is legitimately
 * returned to the paying student's own browser (so they can show "check your
 * phone"), meaning a student could otherwise forge their own "payment
 * successful" callback without ever paying.
 *
 * The fix: the callback path includes a long random secret that only this
 * server and Safaricom know (via MPESA_CALLBACK_URL, which is never sent to
 * the browser — only the transaction's checkoutRequestId is). Requests with
 * the wrong secret are rejected before touching any transaction.
 *
 * Generate one with: `openssl rand -hex 32`, then set
 *   MPESA_CALLBACK_SECRET=<that value>
 *   MPESA_CALLBACK_URL=https://<your-domain>/api/mpesa/callback/<that value>
 */
export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const expected = process.env.MPESA_CALLBACK_SECRET;

  if (!expected || secret !== expected) {
    // Deliberately generic response — don't reveal whether the secret was
    // close or the route exists at all.
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Rejected" }, { status: 404 });
  }

  const payload = await request.json().catch(() => null);
  const stkCallback = payload?.Body?.stkCallback;

  if (!stkCallback?.CheckoutRequestID) {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Invalid payload" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const checkoutRequestId: string = stkCallback.CheckoutRequestID;
  const resultCode: number = stkCallback.ResultCode;

  const { data: transaction } = await supabase
    .from("payment_transactions")
    .select("id, status")
    .eq("checkout_request_id", checkoutRequestId)
    .single();

  if (!transaction) {
    // Acknowledge anyway so Safaricom doesn't retry indefinitely for a
    // transaction we have no record of.
    return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  // Duplicate-callback guard #1: Safaricom can and does resend callbacks: if
  // we've already reconciled this transaction, stop here instead of touching
  // it again. Guard #2 lives in the database itself — trg_transaction_completed
  // only fires its wallet-credit logic `when old.status is distinct from
  // 'completed'`, and Postgres serializes concurrent UPDATEs to the same row
  // via row-level locking, so even two callbacks arriving at the exact same
  // instant cannot both win the "was pending" check. A wallet can only ever
  // be credited once per transaction row, no matter how many times Safaricom
  // (or anyone) POSTs this callback.
  if (transaction.status !== "pending") {
    return NextResponse.json({ ResultCode: 0, ResultDesc: "Already processed" });
  }

  if (resultCode === 0) {
    const items: { Name: string; Value: string | number }[] =
      stkCallback.CallbackMetadata?.Item ?? [];
    const receipt = items.find((i) => i.Name === "MpesaReceiptNumber")?.Value;

    // Flipping status to "completed" fires trg_transaction_completed, which
    // atomically applies the 70/30 split, credits the teacher's wallet, and
    // activates the subscription — see supabase/migrations/0001_init.sql.
    // The credited amount is always transaction.amount, set server-side at
    // STK-push time — nothing in this callback payload can alter it.
    await supabase
      .from("payment_transactions")
      .update({ status: "completed", provider_reference: String(receipt ?? "") })
      .eq("id", transaction.id);
  } else {
    await supabase.from("payment_transactions").update({ status: "failed" }).eq("id", transaction.id);
  }

  // Daraja requires a 200 with this exact shape to stop retrying.
  return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

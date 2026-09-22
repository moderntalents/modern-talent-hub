import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyStkCallback, parseStkCallback } from "@/lib/mpesa-payments";

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
 *
 * Everything past the secret check — matching, verifying, and crediting — is
 * done by lib/mpesa-payments.ts, so the exact same logic is what the tests
 * exercise directly against the database.
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
  const parsed = payload ? parseStkCallback(payload) : null;

  if (!parsed) {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Invalid payload" }, { status: 400 });
  }

  const admin = createAdminClient();
  try {
    await applyStkCallback(admin, parsed, payload);
  } catch (err) {
    // applyStkCallback handles its own expected error paths and never
    // throws for them; this is a last-resort net so an unexpected bug never
    // turns into an unhandled 500 that makes Daraja retry forever.
    console.error("[mpesa callback] unexpected error while applying callback:", err instanceof Error ? err.message : err);
  }

  // Daraja requires a 200 with this exact shape to stop retrying, regardless
  // of what actually happened internally (unmatched / duplicate / rejected
  // are all things Daraja itself can do nothing about by retrying).
  return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

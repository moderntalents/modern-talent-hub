import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyB2CCallback, parseB2CCallback } from "@/lib/mpesa-withdrawals";

/**
 * Safaricom Daraja calls this URL directly (server-to-server) with the final
 * outcome of a B2C payout. Same secret-gate reasoning as the STK callback
 * (app/api/mpesa/callback/[secret]/route.ts): Daraja doesn't sign callbacks,
 * so this path includes a long random secret only this server and Safaricom
 * know — MPESA_B2C_RESULT_URL is never sent to any browser.
 *
 * Generate one with: `openssl rand -hex 32`, then set
 *   MPESA_B2C_CALLBACK_SECRET=<that value>
 *   MPESA_B2C_RESULT_URL=https://<your-domain>/api/mpesa/b2c-callback/<that value>
 *   MPESA_B2C_TIMEOUT_URL=https://<your-domain>/api/mpesa/b2c-callback/<that value>
 *
 * A separate secret from MPESA_CALLBACK_SECRET on purpose: this path can
 * finalize a withdrawal, a different financial action from confirming a
 * student's payment, so a leak of one never compromises the other.
 *
 * All matching, verification and finalizing is done by lib/mpesa-withdrawals.ts,
 * so the exact same logic is what the tests exercise directly against the database.
 */
export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const expected = process.env.MPESA_B2C_CALLBACK_SECRET;

  if (!expected || secret !== expected) {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Rejected" }, { status: 404 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = payload ? parseB2CCallback(payload) : null;

  if (!parsed) {
    return NextResponse.json({ ResultCode: 1, ResultDesc: "Invalid payload" }, { status: 400 });
  }

  const admin = createAdminClient();
  try {
    await applyB2CCallback(admin, parsed);
  } catch (err) {
    // applyB2CCallback handles its own expected error paths and never throws
    // for them; this is a last-resort net so an unexpected bug never turns
    // into an unhandled 500 that makes Daraja retry forever.
    console.error("[b2c callback] unexpected error while applying callback:", err instanceof Error ? err.message : err);
  }

  // Daraja requires a 200 with this exact shape to stop retrying, regardless
  // of what actually happened internally.
  return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

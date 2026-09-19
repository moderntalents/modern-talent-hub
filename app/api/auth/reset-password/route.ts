import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClientIp } from "@/lib/verification";
import { missingDatabaseSetupResponse } from "@/lib/db-errors";

// Password recovery, step 2: the user arrives from the emailed link with a
// one-time token and chooses a new password.
//
// The token is only spent HERE, when they submit the form — merely opening the
// page (or an email scanner pre-fetching the link) does not use it up.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const tokenHash = typeof body?.tokenHash === "string" ? body.tokenHash : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!/^[\w-]{20,200}$/.test(tokenHash)) {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired. Please request a new one.", code: "invalid_link" },
      { status: 400 },
    );
  }
  if (password.length < 8 || password.length > 72) {
    return NextResponse.json({ error: "Password must be between 8 and 72 characters." }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error("[reset-password] Supabase env vars are not set.");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  const admin = createAdminClient();

  const { data: allowed, error: limitError } = await admin.rpc("hit_rate_limit", {
    p_key: `reset-submit:${getClientIp(request)}`,
    p_max: 20,
    p_window_seconds: 3600,
  });
  if (limitError) {
    const setupProblem = missingDatabaseSetupResponse("reset-password", limitError);
    if (setupProblem) return setupProblem;
    console.error("[reset-password] rate limit check failed:", limitError.message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
  if (!allowed) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  // Spend the one-time recovery token. A throwaway, unprivileged client is used
  // so no session is ever attached to the service-role client.
  const verifier = createSupabaseClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: verified, error: verifyError } = await verifier.auth.verifyOtp({
    token_hash: tokenHash,
    type: "recovery",
  });

  if (verifyError || !verified.user) {
    console.error("[reset-password] token rejected:", verifyError?.message);
    return NextResponse.json(
      { error: "This reset link is invalid or has expired. Please request a new one.", code: "invalid_link" },
      { status: 400 },
    );
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(verified.user.id, { password });
  if (updateError) {
    console.error("[reset-password] password update failed:", updateError.message);
    // The link is already spent, so the user needs a fresh one.
    return NextResponse.json(
      { error: `We couldn't update your password: ${updateError.message}. Please request a new reset link.` },
      { status: 422 },
    );
  }

  // Sign the account out everywhere, so whoever may have known the old
  // password (or held an old session) is kicked out. Best effort.
  if (verified.session?.access_token) {
    const { error: signOutError } = await admin.auth.admin.signOut(verified.session.access_token, "global");
    if (signOutError) console.error("[reset-password] global sign-out failed:", signOutError.message);
  }

  return NextResponse.json({ ok: true });
}

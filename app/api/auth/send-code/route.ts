import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CODE_TTL_SECONDS,
  generateCode,
  getClientIp,
  hashCode,
  isVerificationConfigured,
  missingVerificationConfig,
  normalizeEmail,
  sendVerificationEmail,
} from "@/lib/verification";
import { missingDatabaseSetupResponse } from "@/lib/db-errors";

// Issues a fresh 5-digit registration code and emails it. Used both for the
// first send and for "Resend code" — a new code replaces (and invalidates) the
// previous one. No account exists yet; it is created only after the code is
// verified (see /api/auth/verify-registration).
export async function POST(request: Request) {
  if (!isVerificationConfigured()) {
    console.error(`[send-code] not configured — missing: ${missingVerificationConfig().join(", ")}`);
    return NextResponse.json(
      { error: "Email verification isn't set up on this site yet. Please contact support." },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Coarse per-IP cap so this endpoint can't be used to spam inboxes or burn
  // through the mailbox's daily sending quota.
  const { data: allowed, error: limitError } = await admin.rpc("hit_rate_limit", {
    p_key: `send:${getClientIp(request)}`,
    p_max: 10,
    p_window_seconds: 3600,
  });
  if (limitError) {
    const setupProblem = missingDatabaseSetupResponse("send-code", limitError);
    if (setupProblem) return setupProblem;
    console.error("[send-code] rate limit check failed:", limitError.message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
  if (!allowed) {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
  }

  // Only a CONFIRMED account blocks registration. A leftover unconfirmed row
  // (e.g. from the old signup flow) is replaced once the new code is verified.
  const { data: existing } = await admin.rpc("auth_email_status", { p_email: email });
  if (existing?.[0]?.confirmed) {
    return NextResponse.json(
      { error: "An account with this email already exists. Try logging in instead." },
      { status: 409 },
    );
  }

  const code = generateCode();
  const { data: issued, error: issueError } = await admin.rpc("issue_registration_code", {
    p_email: email,
    p_code_hash: hashCode(email, code),
    p_ttl_seconds: CODE_TTL_SECONDS,
  });
  if (issueError || !issued?.[0]) {
    console.error("[send-code] issue failed:", issueError?.message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  const result = issued[0];
  if (result.status === "cooldown") {
    return NextResponse.json(
      { error: `Please wait ${result.retry_after} seconds before requesting another code.`, retryAfter: result.retry_after },
      { status: 429 },
    );
  }
  if (result.status === "limit") {
    return NextResponse.json(
      { error: "Too many codes requested for this email. Please try again later.", retryAfter: result.retry_after },
      { status: 429 },
    );
  }

  try {
    await sendVerificationEmail(email, code);
  } catch (err) {
    // Never claim the email was sent when it wasn't.
    console.error("[send-code] SMTP send failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "We couldn't send the verification email right now. Please try again in a few minutes." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, expiresInSeconds: CODE_TTL_SECONDS });
}

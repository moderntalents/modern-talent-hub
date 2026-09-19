import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClientIp, normalizeEmail } from "@/lib/verification";
import { isMailerConfigured, sendMail } from "@/lib/mailer";
import { getSiteUrl } from "@/lib/site";

// Password recovery, step 1: email the user a reset link.
//
// This uses Supabase's own recovery tokens (admin.generateLink) — the same
// auth system the rest of the app uses — but sends the email ourselves so that
//   * it is delivered by our SMTP mailer (Supabase's built-in mailer only
//     reaches your own team members), and
//   * the link is built from the fixed production URL (lib/site.ts), never from
//     the request's origin, so it can't point at a *.vercel.app address.
// Completely separate from the 5-digit REGISTRATION code (lib/verification.ts).

const GENERIC_OK = {
  ok: true,
  message: "If an account exists for that email, we've sent a password reset link.",
};

export async function POST(request: Request) {
  if (!isMailerConfigured()) {
    console.error("[forgot-password] SMTP_USER / SMTP_PASS are not set.");
    return NextResponse.json(
      { error: "Password reset isn't set up on this site yet. Please contact support." },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  let siteUrl: string;
  try {
    siteUrl = getSiteUrl();
  } catch (err) {
    console.error("[forgot-password]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  const admin = createAdminClient();

  // Limits count every request whether or not the account exists, so hitting
  // them reveals nothing about which emails are registered.
  const [{ data: ipOk, error: ipError }, { data: emailOk, error: emailError }] = await Promise.all([
    admin.rpc("hit_rate_limit", { p_key: `reset-ip:${getClientIp(request)}`, p_max: 10, p_window_seconds: 3600 }),
    admin.rpc("hit_rate_limit", { p_key: `reset-email:${email}`, p_max: 3, p_window_seconds: 3600 }),
  ]);
  if (ipError || emailError) {
    console.error("[forgot-password] rate limit check failed:", ipError?.message ?? emailError?.message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
  if (!ipOk || !emailOk) {
    return NextResponse.json(
      { error: "Too many reset requests. Please wait a while before trying again." },
      { status: 429 },
    );
  }

  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  const tokenHash = data?.properties?.hashed_token;

  if (error || !tokenHash) {
    // No such account: answer exactly as if we'd sent one, so this form can't
    // be used to discover who is registered.
    if (error && (error.code === "user_not_found" || /not found/i.test(error.message))) {
      return NextResponse.json(GENERIC_OK);
    }
    console.error("[forgot-password] generateLink failed:", error?.message ?? "no token returned");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  const link = `${siteUrl}/reset-password?token_hash=${encodeURIComponent(tokenHash)}`;

  try {
    await sendMail({
      to: email,
      subject: "Reset your Modern Talent Hub password",
      text:
        `We received a request to reset your Modern Talent Hub password.\n\n` +
        `Open this link to choose a new password:\n${link}\n\n` +
        `The link can be used once and expires soon. If you didn't ask for this, ` +
        `you can ignore this email — your password won't change.`,
      html:
        `<div style="font-family:Arial,sans-serif;font-size:16px;color:#111">` +
        `<p>We received a request to reset your Modern Talent Hub password.</p>` +
        `<p><a href="${link}" style="display:inline-block;background:#00a9ee;color:#111;` +
        `text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px">Reset password</a></p>` +
        `<p style="color:#555;font-size:14px">Or copy this link into your browser:<br>${link}</p>` +
        `<p style="color:#555;font-size:14px">The link can be used once and expires soon. ` +
        `If you didn't ask for this, you can ignore this email — your password won't change.</p>` +
        `</div>`,
    });
  } catch (err) {
    // Never claim an email was sent when it wasn't.
    console.error("[forgot-password] SMTP send failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "We couldn't send the reset email right now. Please try again in a few minutes." },
      { status: 502 },
    );
  }

  return NextResponse.json(GENERIC_OK);
}

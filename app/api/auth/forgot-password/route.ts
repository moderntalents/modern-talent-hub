import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClientIp, normalizeEmail } from "@/lib/verification";
import { isMailerConfigured, sendMail } from "@/lib/mailer";
import { getSiteUrl } from "@/lib/site";

// Password recovery, step 1: email the user a reset link. Always Supabase Auth
// recovery — there are two ways the email gets sent, both ending on
// /reset-password on the production site (lib/site.ts, never the request's
// origin, so never a *.vercel.app address):
//
//  1. Our SMTP mailer (SMTP_USER / SMTP_PASS set in Vercel): we mint a Supabase
//     recovery token with admin.generateLink and email a link ourselves.
//  2. Supabase's own email (no SMTP env set): auth.resetPasswordForEmail(), which
//     Supabase sends through the SMTP configured in ITS dashboard.
//
// Completely separate from the 5-digit REGISTRATION code (lib/verification.ts).

const GENERIC_OK = {
  ok: true,
  message: "If an account exists for that email, we've sent a password reset link.",
};

const SEND_FAILED = "We couldn't send the reset email right now. Please try again in a few minutes.";

export async function POST(request: Request) {
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

  // Route 2: no mailer configured here, so let Supabase Auth send its own
  // password-reset email.
  if (!isMailerConfigured()) {
    return sendViaSupabase(email, siteUrl);
  }

  // Route 1: our mailer.
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
    return NextResponse.json({ error: SEND_FAILED }, { status: 502 });
  }

  return NextResponse.json(GENERIC_OK);
}

async function sendViaSupabase(email: string, siteUrl: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error("[forgot-password] Supabase env vars are not set.");
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  // Unprivileged, session-less client; implicit flow so the emailed link works
  // from any browser or device (no PKCE verifier cookie is needed).
  const supabase = createSupabaseClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, flowType: "implicit" },
  });

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteUrl}/reset-password`,
  });

  if (error) {
    console.error("[forgot-password] Supabase resetPasswordForEmail failed:", error.status, error.message);
    if (error.status === 429 || /rate limit|security purposes|too many/i.test(error.message)) {
      return NextResponse.json(
        { error: "Too many reset requests. Please wait a minute before trying again." },
        { status: 429 },
      );
    }
    // "Error sending recovery email" / "Email address not authorized": Supabase's
    // own mailer isn't set up to deliver to this address (see README).
    if (/sending .*email|not authorized/i.test(error.message)) {
      return NextResponse.json({ error: SEND_FAILED }, { status: 502 });
    }
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  // Supabase answers success for unknown emails too, so this can't be used to
  // discover who is registered.
  return NextResponse.json(GENERIC_OK);
}

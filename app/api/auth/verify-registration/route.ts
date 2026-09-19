import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CODE_LENGTH,
  getClientIp,
  hashCode,
  isVerificationConfigured,
  normalizeEmail,
} from "@/lib/verification";

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Verifies the emailed code and ONLY THEN creates the account, already
// confirmed. The client sends the registration details again alongside the
// code (it still holds them in memory), so nothing about the person is stored
// server-side before their email is proven and no half-registered auth user
// can exist for someone to squat on.
export async function POST(request: Request) {
  if (!isVerificationConfigured()) {
    return NextResponse.json(
      { error: "Email verification isn't set up on this site yet. Please contact support." },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);

  const email = normalizeEmail(body?.email);
  const code = str(body?.code, 20);
  const password = typeof body?.password === "string" ? body.password : "";
  const fullName = str(body?.fullName, 100);
  const phone = str(body?.phone, 30);
  const role = body?.role === "teacher" ? "teacher" : body?.role === "student" ? "student" : null;
  const grade = str(body?.grade, 50);
  const schoolName = str(body?.schoolName, 150);
  const specialty = str(body?.specialty, 150);
  const bio = str(body?.bio, 500);

  // Mirrors the checks on the signup form — the server is the authority.
  if (!email) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) {
    return NextResponse.json({ error: "Invalid verification code.", code: "invalid" }, { status: 400 });
  }
  if (!fullName) return NextResponse.json({ error: "Enter your full name." }, { status: 400 });
  if (!phone) return NextResponse.json({ error: "Enter your phone number." }, { status: 400 });
  if (password.length < 8 || password.length > 72) {
    return NextResponse.json({ error: "Password must be between 8 and 72 characters." }, { status: 400 });
  }
  if (!role) return NextResponse.json({ error: "Choose student or teacher." }, { status: 400 });
  if (role === "student" && !grade) return NextResponse.json({ error: "Enter your grade/class." }, { status: 400 });
  if (role === "teacher" && !specialty) {
    return NextResponse.json({ error: "Enter what you teach." }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: allowed, error: limitError } = await admin.rpc("hit_rate_limit", {
    p_key: `verify:${getClientIp(request)}`,
    p_max: 30,
    p_window_seconds: 3600,
  });
  if (limitError) {
    console.error("[verify-registration] rate limit check failed:", limitError.message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
  if (!allowed) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  // Refuse before consuming the code if a confirmed account already owns this email.
  const { data: existing } = await admin.rpc("auth_email_status", { p_email: email });
  const existingUser = existing?.[0];
  if (existingUser?.confirmed) {
    return NextResponse.json(
      { error: "An account with this email already exists. Try logging in instead." },
      { status: 409 },
    );
  }

  // Atomic in the database: checks expiry, the 5-guess limit and the code,
  // and consumes the code on success.
  const { data: verdict, error: verifyError } = await admin.rpc("verify_registration_code", {
    p_email: email,
    p_code_hash: hashCode(email, code),
  });
  if (verifyError) {
    console.error("[verify-registration] verify failed:", verifyError.message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  switch (verdict) {
    case "ok":
      break;
    case "expired":
      return NextResponse.json(
        { error: "This code has expired. Request a new code.", code: "expired" },
        { status: 400 },
      );
    case "locked":
      return NextResponse.json(
        { error: "Too many incorrect attempts. Request a new code.", code: "locked" },
        { status: 400 },
      );
    case "none":
      return NextResponse.json(
        { error: "No code has been requested for this email. Request a new code.", code: "none" },
        { status: 400 },
      );
    default:
      return NextResponse.json({ error: "Invalid verification code.", code: "invalid" }, { status: 400 });
  }

  // The code proved this person controls the mailbox. If an old UNCONFIRMED
  // auth user is squatting on the address (e.g. from the previous signup flow,
  // or someone calling Supabase's public signUp directly), replace it.
  if (existingUser && !existingUser.confirmed) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(existingUser.id);
    if (deleteError) {
      console.error("[verify-registration] could not remove stale unconfirmed user:", deleteError.message);
      return NextResponse.json(
        { error: "We couldn't finish creating your account. Request a new code and try again." },
        { status: 500 },
      );
    }
  }

  // email_confirm: true — the email is verified by the code just checked.
  // Role is limited to student/teacher above (and again in the DB trigger).
  const { error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      role,
      full_name: fullName,
      phone,
      grade,
      school_name: schoolName,
      specialty,
      bio,
    },
  });

  if (createError) {
    console.error("[verify-registration] createUser failed:", createError.message);
    if (/already (been )?registered|already exists/i.test(createError.message)) {
      return NextResponse.json(
        { error: "An account with this email already exists. Try logging in instead." },
        { status: 409 },
      );
    }
    // The code is already consumed, so tell them to request another.
    return NextResponse.json(
      { error: `We couldn't create your account: ${createError.message}. Request a new code and try again.` },
      { status: 422 },
    );
  }

  return NextResponse.json({ ok: true });
}

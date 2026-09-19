"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card, Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { friendlyAuthError, retryAfterSeconds } from "@/lib/auth-errors";

type Role = "student" | "teacher";
type Stage = "form" | "verify";

// Supabase allows one auth email per address per 60 seconds; a shorter
// cooldown just invites "you can only request this after N seconds" errors.
const RESEND_COOLDOWN_SECONDS = 60;

// Where a brand-new account lands. Coaches go to the activation page: with
// payments ON it shows the fee + M-Pesa prompt; with payments OFF it activates
// them for free and forwards to the dashboard. Students go straight to theirs.
// The role can come from user metadata, so anything but "teacher" is treated
// as a student rather than trusted as a URL segment.
function postSignupPath(role: unknown): string {
  return role === "teacher" ? "/teacher/activate" : "/student";
}

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Lets /login send someone back here to finish verifying a previous
  // signup (?verify=1&email=...) instead of leaving them stuck with no way
  // to re-enter a code once the in-memory form state from their original
  // signup is gone (e.g. they closed the tab before verifying).
  const resumeEmail = searchParams.get("verify") === "1" ? searchParams.get("email") : null;
  const [stage, setStage] = useState<Stage>(resumeEmail ? "verify" : "form");
  const [role, setRole] = useState<Role>("student");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState(resumeEmail ?? "");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [grade, setGrade] = useState("");
  const [schoolName, setSchoolName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [bio, setBio] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(
    resumeEmail ? `Enter the code we sent to ${resumeEmail}, or request a new one.` : null,
  );

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  function validate(): string | null {
    if (!fullName.trim()) return "Enter your full name.";
    if (!/^\S+@\S+\.\S+$/.test(email)) return "Enter a valid email address.";
    if (!phone.trim()) return "Enter your phone number.";
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (password !== confirm) return "Passwords do not match.";
    if (role === "student" && !grade.trim()) return "Enter your grade/class.";
    if (role === "teacher" && !specialty.trim()) return "Enter what you teach.";
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError(null);
    setInfo(null);

    // Everything below can throw — a misconfigured Supabase client, a
    // network failure, whatever — and an uncaught throw here previously left
    // the button spinning forever with no feedback (loading never reset,
    // nothing to catch it). try/finally guarantees loading always clears.
    try {
      const supabase = createClient();

      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          // Only used if the "Confirm signup" email still contains a link: it
          // lands on the same callback that already exchanges auth codes, so a
          // clicked link works too. The 6-digit code is the primary path.
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          data: {
            role,
            full_name: fullName,
            phone,
            grade,
            school_name: schoolName,
            specialty,
            bio,
          },
        },
      });

      if (signUpError) {
        console.error("[signup] signUp failed:", signUpError.message);
        setError(friendlyAuthError(signUpError.message));
        return;
      }

      // When email confirmation is required and the email is already
      // registered & confirmed, Supabase deliberately doesn't return an
      // error (to avoid leaking which emails exist) — instead it returns a
      // user object with an empty identities array. This is the documented
      // way to detect that case client-side.
      if (data.user && data.user.identities && data.user.identities.length === 0) {
        setError("An account with this email already exists. Try logging in instead.");
        return;
      }

      // signUp() only returns a session when email confirmation is off. If
      // it's required, there's no session yet — move to the "enter the code
      // we emailed you" step instead of racing the dashboard's auth check
      // (which would just bounce back to /login).
      if (!data.session) {
        setStage("verify");
        setInfo(`We've sent a 6-digit verification code to ${email}. It can take a minute — check your spam folder too.`);
        setResendCooldown(RESEND_COOLDOWN_SECONDS);
        return;
      }

      // replace (not push) so Back doesn't return to a stale signup form.
      router.replace(postSignupPath(role));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    const code = otp.trim();
    if (code.length < 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }

    setLoading(true);
    setError(null);
    setInfo(null);

    try {
      const supabase = createClient();
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: "signup",
      });

      if (verifyError) {
        console.error("[signup] verifyOtp failed:", verifyError.message);
        setError(friendlyAuthError(verifyError.message));
        return;
      }

      if (!data.session) {
        setError("Verification succeeded but no session was returned — please try logging in.");
        return;
      }

      // Verified and Supabase returned a live session — log straight in, no
      // separate login step and no admin approval involved. Read the role
      // back from the verified session's own metadata rather than the local
      // `role` state: on the /login?verify=1 resume path, `role` is just the
      // component's default ("student") since the user never filled out the
      // form on this page load.
      const verifiedRole = data.session.user.user_metadata?.role ?? role;
      router.replace(postSignupPath(verifiedRole));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendCooldown > 0 || resending) return;

    setResending(true);
    setError(null);
    setInfo(null);

    try {
      const supabase = createClient();
      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });

      if (resendError) {
        console.error("[signup] resend failed:", resendError.message);
        setError(friendlyAuthError(resendError.message));
        // Supabase tells us exactly how long to wait — honour it in the button.
        const wait = retryAfterSeconds(resendError.message);
        if (wait) setResendCooldown(wait);
        return;
      }

      setInfo(`A new code has been sent to ${email}.`);
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend the code. Please try again.");
    } finally {
      setResending(false);
    }
  }

  if (stage === "verify") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
        <div className="text-center">
          <h1 className="font-head text-2xl font-extrabold">Verify your email</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Enter the 6-digit code we sent to <span className="font-semibold text-ink">{email}</span>.
          </p>
        </div>

        <Card>
          <form onSubmit={handleVerify} className="flex flex-col gap-4">
            <Field label="Verification code">
              <Input
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                className="text-center text-lg tracking-[0.5em]"
              />
            </Field>

            {info && (
              <p className="rounded-xl bg-success-tint px-4 py-3 text-sm font-medium text-[var(--success-text)]">
                {info}
              </p>
            )}
            {error && <ErrorBanner message={error} />}

            <Button type="submit" loading={loading} className="w-full">
              Verify &amp; continue
            </Button>

            <Button
              type="button"
              variant="outline"
              loading={resending}
              disabled={resendCooldown > 0}
              onClick={handleResend}
              className="w-full"
            >
              {resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : "Resend code"}
            </Button>

            <button
              type="button"
              onClick={() => {
                setStage("form");
                setOtp("");
                setError(null);
                setInfo(null);
              }}
              className="text-center text-sm font-semibold text-ink-soft hover:text-ink"
            >
              Use a different email
            </button>
          </form>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="text-center">
        <h1 className="font-head text-2xl font-extrabold">Create your account</h1>
        <p className="mt-1 text-sm text-ink-soft">Join Modern Talent Hub as a student or teacher.</p>
      </div>

      <Card>
        <div className="flex flex-col gap-4">
          <GoogleButton
            label="Continue with Google"
            onError={setError}
            disabled={loading}
          />
          <p className="-mt-2 text-center text-xs text-ink-faint">
            Creates a student account. Teachers should sign up with email below.
          </p>
          <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-ink-faint">
            <span className="h-px flex-1 bg-line" />
            or sign up with email
            <span className="h-px flex-1 bg-line" />
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            {(["student", "teacher"] as Role[]).map((r) => (
              <button
                type="button"
                key={r}
                onClick={() => setRole(r)}
                className={`min-h-11 rounded-xl border text-sm font-semibold capitalize ${
                  role === r
                    ? "border-brand-cyan-deep bg-brand-cyan text-ink"
                    : "border-line bg-surface text-ink-soft"
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          <Field label="Full name">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Amina Wanjiru" />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </Field>
          <Field label="Phone number">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XX XXX XXX" />
          </Field>

          {role === "student" ? (
            <>
              <Field label="Grade / Class">
                <Input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="Grade 6" />
              </Field>
              <Field label="School (optional)">
                <Input value={schoolName} onChange={(e) => setSchoolName(e.target.value)} placeholder="St. Luke's Primary" />
              </Field>
            </>
          ) : (
            <>
              <Field label="What do you teach?">
                <Input value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="Karate, Piano, Coding…" />
              </Field>
              <Field label="Short bio (optional)">
                <Input value={bio} onChange={(e) => setBio(e.target.value)} placeholder="A sentence about your experience" />
              </Field>
            </>
          )}

          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
          </Field>
          <Field label="Confirm password">
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>

          {error && <ErrorBanner message={error} />}

          <Button type="submit" loading={loading} className="w-full">
            Create account
          </Button>
        </form>
      </Card>

      <p className="text-center text-sm text-ink-soft">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-brand-cyan-deep">
          Log in
        </Link>
      </p>
    </main>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}

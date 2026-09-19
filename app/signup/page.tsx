"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card, Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { friendlyAuthError } from "@/lib/auth-errors";

type Role = "student" | "teacher";
type Stage = "form" | "verify";

// The server allows one new code per email every 60 seconds
// (issue_registration_code in migration 0005); the button mirrors that.
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
  const [stage, setStage] = useState<Stage>("form");
  const [role, setRole] = useState<Role>("student");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
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
  const [info, setInfo] = useState<string | null>(null);

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

    // Everything below can throw (network failure, etc.) — try/finally
    // guarantees the button never spins forever.
    try {
      // The account is NOT created yet: the server only emails a code. It is
      // created after the code is verified (see handleVerify).
      if (await requestCode()) {
        setStage("verify");
        setOtp("");
        setInfo(
          `We've sent a 5-digit verification code to ${email.trim()}. It expires in 10 minutes — check your spam folder too.`,
        );
      }
    } catch (err) {
      setError(friendlyAuthError(err instanceof Error ? err.message : "") || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // Shared by "Create account" and "Resend code". Asks the server to email a
  // fresh 5-digit code; returns true only if the server confirms it sent one
  // (we never claim an email went out when it didn't).
  async function requestCode(): Promise<boolean> {
    const res = await fetch("/api/auth/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setError(data.error || "We couldn't send the verification code. Please try again.");
      if (typeof data.retryAfter === "number") setResendCooldown(data.retryAfter);
      return false;
    }

    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    return true;
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    const code = otp.trim();
    if (!/^\d{5}$/.test(code)) {
      setError("Invalid verification code.");
      return;
    }

    setLoading(true);
    setError(null);
    setInfo(null);

    try {
      // The server checks the code and, only if it matches, creates the
      // (already confirmed) account from the details entered on the form.
      const res = await fetch("/api/auth/verify-registration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          code,
          password,
          fullName,
          phone,
          role,
          grade,
          schoolName,
          specialty,
          bio,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || "Invalid verification code.");
        return;
      }

      // Verified and created — sign in with the credentials they just chose.
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (signInError) {
        console.error("[signup] sign-in after verification failed:", signInError.message);
        router.replace("/login");
        return;
      }

      // replace (not push) so Back doesn't return to the signup form.
      router.replace(postSignupPath(role));
      router.refresh();
    } catch (err) {
      setError(friendlyAuthError(err instanceof Error ? err.message : "") || "Something went wrong. Please try again.");
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
      if (await requestCode()) {
        setOtp("");
        setInfo(`A new code has been sent to ${email.trim()}. Any earlier code no longer works.`);
      }
    } catch (err) {
      setError(friendlyAuthError(err instanceof Error ? err.message : "") || "Could not resend the code. Please try again.");
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
            Enter the 5-digit code we sent to <span className="font-semibold text-ink">{email.trim()}</span>.
          </p>
        </div>

        <Card>
          <form onSubmit={handleVerify} className="flex flex-col gap-4">
            <Field label="Verification code">
              <Input
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 5))}
                placeholder="12345"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={5}
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

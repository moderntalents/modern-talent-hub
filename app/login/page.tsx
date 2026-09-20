"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card, Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { friendlyAuthError, safeNextPath } from "@/lib/auth-errors";
import { useIsNativeApp } from "@/lib/native";

function LoginForm() {
  const router = useRouter();
  const inApp = useIsNativeApp();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);

  // /auth/callback redirects OAuth failures here as ?error=... — surface it
  // instead of silently landing on a blank login page.
  useEffect(() => {
    const oauthError = params.get("error");
    if (oauthError) setError(friendlyAuthError(oauthError));
  }, [params]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }

    setLoading(true);
    setError(null);
    setNeedsVerification(false);

    try {
      const supabase = createClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        console.error("[login] signInWithPassword failed:", signInError.message);
        setError(friendlyAuthError(signInError.message));
        setNeedsVerification(/email not confirmed/i.test(signInError.message));
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", data.user.id)
        .single();

      const next = safeNextPath(params.get("next"));
      router.push(next || `/${profile?.role ?? "student"}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="text-center">
        <h1 className="font-head text-2xl font-extrabold">Welcome back</h1>
        <p className="mt-1 text-sm text-ink-soft">Log in to Modern Talent Hub.</p>
      </div>

      <Card>
        {/* Google sign-in can't run inside the Android app, so the whole Google block is hidden there. */}
        {!inApp && (
          <div className="flex flex-col gap-4">
            <GoogleButton label="Continue with Google" onError={setError} disabled={loading} />
            <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-ink-faint">
              <span className="h-px flex-1 bg-line" />
              or log in with email
              <span className="h-px flex-1 bg-line" />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className={`${inApp ? "" : "mt-4 "}flex flex-col gap-4`}>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div className="-mt-2 text-right">
            <Link href="/forgot-password" className="text-sm font-semibold text-brand-cyan-deep">
              Forgot your password?
            </Link>
          </div>

          {error && <ErrorBanner message={error} />}
          {needsVerification && (
            <Link href="/signup" className="-mt-2 text-center text-sm font-semibold text-brand-cyan-deep">
              Register again to get a new verification code
            </Link>
          )}

          <Button type="submit" loading={loading} className="w-full">
            Log in
          </Button>
        </form>
      </Card>

      <p className="text-center text-sm text-ink-soft">
        New to Modern Talent Hub?{" "}
        <Link href="/signup" className="font-semibold text-brand-cyan-deep">
          Create an account
        </Link>
      </p>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

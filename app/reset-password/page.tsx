"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { friendlyAuthError } from "@/lib/auth-errors";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card, Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";

// The link can arrive in two shapes, both from Supabase Auth's recovery:
//  * ?token_hash=…            — sent by our own mailer (spent by /api/auth/reset-password)
//  * #access_token=…&refresh_token=…&type=recovery
//                             — sent by Supabase's own reset email (a fragment, so it
//                               only exists in the browser and is read here)
type Credential = { tokenHash: string } | { accessToken: string; refreshToken: string };

function ResetPasswordForm() {
  const params = useSearchParams();
  const tokenHash = params.get("token_hash");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credential, setCredential] = useState<Credential | null | undefined>(undefined); // undefined = still reading the link
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (tokenHash) {
      setCredential({ tokenHash });
      return;
    }
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = fragment.get("access_token");
    const refreshToken = fragment.get("refresh_token");
    if (accessToken && refreshToken && fragment.get("type") === "recovery") {
      setCredential({ accessToken, refreshToken });
      // Keep the tokens out of the address bar / history once captured.
      window.history.replaceState(null, "", window.location.pathname);
    } else {
      // Also covers Supabase's "#error=access_denied&error_code=otp_expired…".
      setCredential(null);
      setLinkInvalid(true);
    }
  }, [tokenHash]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    if (!credential) return;

    setLoading(true);
    setError(null);

    try {
      if ("tokenHash" in credential) {
        const res = await fetch("/api/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenHash: credential.tokenHash, password }),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          if (data.code === "invalid_link") setLinkInvalid(true);
          else setError(data.error || "We couldn't update your password. Please try again.");
          return;
        }
      } else {
        // Supabase's own reset email: the recovery session in the link lets the
        // browser call Supabase's standard updateUser().
        const supabase = createClient();
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: credential.accessToken,
          refresh_token: credential.refreshToken,
        });
        if (sessionError) {
          console.error("[reset-password] recovery session rejected:", sessionError.message);
          setLinkInvalid(true);
          return;
        }

        const { error: updateError } = await supabase.auth.updateUser({ password });
        if (updateError) {
          console.error("[reset-password] updateUser failed:", updateError.message);
          setError(friendlyAuthError(updateError.message));
          return;
        }

        // Don't leave them signed in on the temporary recovery session: they
        // log in with the new password, and other devices are signed out too.
        await supabase.auth.signOut({ scope: "global" }).catch(() => undefined);
      }
      setDone(true);
    } catch {
      setError("Network problem — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
        <div className="text-center">
          <h1 className="font-head text-2xl font-extrabold">Password updated</h1>
        </div>
        <Card>
          <div className="flex flex-col gap-4">
            <p className="rounded-xl bg-success-tint px-4 py-3 text-sm font-medium text-[var(--success-text)]">
              Password updated successfully. You can now log in with your new password.
            </p>
            <LinkButton href="/login" className="w-full">
              Back to login
            </LinkButton>
          </div>
        </Card>
      </main>
    );
  }

  // Still reading the link (first paint) — avoid flashing the wrong screen.
  if (credential === undefined) return null;

  if (linkInvalid) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
        <div className="text-center">
          <h1 className="font-head text-2xl font-extrabold">Reset link problem</h1>
        </div>
        <Card>
          <div className="flex flex-col gap-4">
            <ErrorBanner message="This reset link is invalid or has expired. Reset links can only be used once." />
            <LinkButton href="/forgot-password" className="w-full">
              Request a new link
            </LinkButton>
          </div>
        </Card>
        <p className="text-center text-sm text-ink-soft">
          <Link href="/login" className="font-semibold text-brand-cyan-deep">
            Back to login
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="text-center">
        <h1 className="font-head text-2xl font-extrabold">Create New Password</h1>
        <p className="mt-1 text-sm text-ink-soft">Choose a new password for your account.</p>
      </div>

      <Card>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field label="New Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              autoFocus
            />
          </Field>
          <Field label="Confirm New Password">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          {error && <ErrorBanner message={error} />}

          <Button type="submit" loading={loading} className="w-full">
            Update Password
          </Button>
        </form>
      </Card>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}

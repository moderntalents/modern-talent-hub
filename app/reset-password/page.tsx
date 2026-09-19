"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card, Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";

function ResetPasswordForm() {
  const params = useSearchParams();
  const tokenHash = params.get("token_hash");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInvalid, setLinkInvalid] = useState(!tokenHash);
  const [done, setDone] = useState(false);

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

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenHash, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.code === "invalid_link") setLinkInvalid(true);
        else setError(data.error || "We couldn't update your password. Please try again.");
        return;
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

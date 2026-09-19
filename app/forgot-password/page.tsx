"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card, Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(address)) {
      setError("Enter a valid email address.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || "We couldn't send the reset email. Please try again.");
        return;
      }
      setSentTo(address);
    } catch {
      setError("Network problem — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="text-center">
        <h1 className="font-head text-2xl font-extrabold">Reset your password</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Enter the email you registered with and we&apos;ll send you a link to choose a new password.
        </p>
      </div>

      <Card>
        {sentTo ? (
          <div className="flex flex-col gap-4">
            <p className="rounded-xl bg-success-tint px-4 py-3 text-sm font-medium text-[var(--success-text)]">
              If an account exists for <span className="font-semibold">{sentTo}</span>, we&apos;ve sent a password
              reset link. Check your inbox — and your spam folder.
            </p>
            <Button type="button" variant="outline" onClick={() => setSentTo(null)} className="w-full">
              Send to a different email
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                autoFocus
              />
            </Field>

            {error && <ErrorBanner message={error} />}

            <Button type="submit" loading={loading} className="w-full">
              Send Reset Link
            </Button>
          </form>
        )}
      </Card>

      <p className="text-center text-sm text-ink-soft">
        Remembered it?{" "}
        <Link href="/login" className="font-semibold text-brand-cyan-deep">
          Back to login
        </Link>
      </p>
    </main>
  );
}

"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card, Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { changeGuardianEmail, resendConsentEmail } from "./actions";

const RESEND_COOLDOWN_SECONDS = 60;

export function ConsentPendingPanel({
  declined,
  emailActive,
  maskedGuardianEmail,
  childName,
}: {
  declined: boolean;
  emailActive: boolean; // an email is really out and can still be used
  maskedGuardianEmail: string;
  childName: string;
}) {
  const router = useRouter();
  const masked = maskedGuardianEmail; // refreshed from the server after every action
  const [editing, setEditing] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  function resend() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const r = await resendConsentEmail();
      router.refresh(); // re-reads whether an email is really out
      if (!r.ok) return setError(r.message);
      setInfo(r.message);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    });
  }

  function saveNewEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const r = await changeGuardianEmail(newEmail);
      router.refresh(); // shows the new address and whether an email is really out
      if (!r.ok) return setError(r.message);
      setInfo(r.message);
      setEditing(false);
      setNewEmail("");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    });
  }

  const footer = (
    <div className="flex flex-col items-center gap-2 text-sm">
      <Link href="/account" className="font-semibold text-brand-red-deep">
        Delete my account
      </Link>
      <button type="button" onClick={signOut} className="font-semibold text-ink-soft hover:text-ink">
        Sign out
      </button>
      <Link href="/privacy" className="text-xs font-semibold text-brand-cyan-deep">
        Privacy Policy
      </Link>
    </div>
  );

  if (declined) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
        <div className="text-center">
          <h1 className="font-head text-2xl font-extrabold">Your parent or guardian said no</h1>
          <p className="mt-1 text-sm text-ink-soft">
            This account can&apos;t be used, so nothing here is available. If you think this is a mistake, please talk to
            them. You can delete this account below.
          </p>
        </div>
        {footer}
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="text-center">
        <h1 className="font-head text-2xl font-extrabold">Waiting for your parent or guardian</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Hi {childName.split(" ")[0] || "there"}! Because you&apos;re under 18, a parent or guardian needs to say yes before
          you can start.{" "}
          {emailActive ? (
            <>
              We&apos;ve emailed <span className="font-semibold text-ink">{masked}</span>. Ask them to open the email and
              choose <strong>Approve</strong>.
            </>
          ) : (
            <>
              We haven&apos;t been able to reach <span className="font-semibold text-ink">{masked}</span> yet: the email
              couldn&apos;t be sent, or the last one has expired. Press <strong>Send the email again</strong> below, or change
              the address if it&apos;s wrong.
            </>
          )}
        </p>
      </div>

      <Card>
        <div className="flex flex-col gap-3">
          {info && (
            <p className="rounded-xl bg-success-tint px-4 py-3 text-sm font-medium text-[var(--success-text)]">{info}</p>
          )}
          {error && <ErrorBanner message={error} />}

          <Button type="button" onClick={() => router.refresh()} className="w-full">
            They approved — check again
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={resend}
            loading={pending}
            disabled={cooldown > 0}
            className="w-full"
          >
            {cooldown > 0 ? `Send the email again (${cooldown}s)` : "Send the email again"}
          </Button>

          {!editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-center text-sm font-semibold text-ink-soft hover:text-ink"
            >
              Wrong email? Change it
            </button>
          ) : (
            <form onSubmit={saveNewEmail} className="flex flex-col gap-3">
              <Field label="Parent or guardian's email" hint="Their own address, not yours.">
                <Input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="parent@example.com"
                  autoFocus
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" loading={pending} className="flex-1">
                  Save and send
                </Button>
                <Button type="button" variant="outline" onClick={() => setEditing(false)} className="flex-1">
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      </Card>

      {footer}
    </main>
  );
}

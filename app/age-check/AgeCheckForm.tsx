"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card, Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { DateOfBirthField, EMPTY_DOB, dobToAge, dobToIso, type DobParts } from "@/components/auth/DateOfBirthField";
import { ADULT_AGE, guardianEmailProblem } from "@/lib/age";
import { submitAge } from "./actions";

export function AgeCheckForm({ role, accountEmail }: { role: "student" | "teacher"; accountEmail: string }) {
  const router = useRouter();
  const [dob, setDob] = useState<DobParts>(EMPTY_DOB);
  const [guardianEmail, setGuardianEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [pending, startTransition] = useTransition();

  const age = dobToAge(dob);
  const isMinor = age !== null && age < ADULT_AGE;

  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const iso = dobToIso(dob);
    if (!iso) return setError("Choose your date of birth.");
    if (role === "teacher" && isMinor) return setError("Teacher accounts are for people aged 18 or over.");
    if (isMinor) {
      const problem = guardianEmailProblem(guardianEmail, accountEmail);
      if (problem) return setError(problem);
    }
    setError(null);

    startTransition(async () => {
      const result = await submitAge(iso, isMinor ? guardianEmail : "");
      if (!result.ok) return setError(result.message);

      if (result.next === "google_under13") {
        // The account was removed on the server; clear the leftover browser session.
        await createClient().auth.signOut();
        setRemoved(true);
        return;
      }
      router.replace(result.next === "consent" ? "/consent-pending" : `/${role}`);
      router.refresh();
    });
  }

  if (removed) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6 text-center">
        <h1 className="font-head text-2xl font-extrabold">Please sign up with an email address</h1>
        <p className="text-sm text-ink-soft">
          For your age, sign-up needs an email address and a parent or guardian. We haven&apos;t kept anything from your
          Google account. Ask a parent or guardian to help you, and choose sign up with email.
        </p>
        <Link href="/signup" className="font-semibold text-brand-cyan-deep">
          Go to sign up
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="text-center">
        <h1 className="font-head text-2xl font-extrabold">One quick question</h1>
        <p className="mt-1 text-sm text-ink-soft">Before you continue, we need your date of birth.</p>
      </div>

      <Card>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DateOfBirthField value={dob} onChange={setDob} disabled={pending} />

          {isMinor && role === "student" && (
            <Field
              label="Parent or guardian's email"
              hint="We'll email them to ask for their permission before you can start. Please use their own email address."
            >
              <Input
                type="email"
                value={guardianEmail}
                onChange={(e) => setGuardianEmail(e.target.value)}
                placeholder="parent@example.com"
                disabled={pending}
              />
            </Field>
          )}
          {isMinor && role === "teacher" && (
            <p className="rounded-xl bg-warning-tint px-4 py-3 text-sm font-medium text-[var(--warning-text)]">
              Teacher accounts are for people aged 18 or over.
            </p>
          )}

          {error && <ErrorBanner message={error} />}

          <Button type="submit" loading={pending} className="w-full">
            Continue
          </Button>
        </form>
      </Card>

      <button type="button" onClick={signOut} className="text-center text-sm font-semibold text-ink-soft hover:text-ink">
        Sign out
      </button>
      <p className="text-center text-xs text-ink-faint">
        <Link href="/privacy" className="font-semibold text-brand-cyan-deep">
          Privacy Policy
        </Link>
      </p>
    </main>
  );
}

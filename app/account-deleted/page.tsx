import type { Metadata } from "next";
import Link from "next/link";
import { LinkButton } from "@/components/ui/Button";
import { CONTACT_EMAIL } from "@/lib/legal";

export const metadata: Metadata = { title: "Account deleted — Modern Talent Hub" };

// Where people land after deleting their account. Public: they are no longer signed in.
export default function AccountDeletedPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-head text-2xl font-extrabold">Your account has been deleted</h1>
      <p className="text-sm text-ink-soft">
        Your personal information has been removed. Thank you for being part of Modern Talent Hub — you are always welcome
        to join again.
      </p>
      <LinkButton href="/" className="w-full">
        Back to the start
      </LinkButton>
      <p className="text-xs text-ink-faint">
        Questions? <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-brand-cyan-deep">{CONTACT_EMAIL}</a> ·{" "}
        <Link href="/privacy" className="font-semibold text-brand-cyan-deep">
          Privacy Policy
        </Link>
      </p>
    </main>
  );
}

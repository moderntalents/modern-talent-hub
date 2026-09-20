import Link from "next/link";
import { LEGAL_LAST_UPDATED } from "@/lib/legal";

// Plain reading layout for the public legal pages. No login needed, no app menu.

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-5 py-8">
      <Link href="/" className="text-sm font-semibold text-brand-cyan-deep">
        ← Modern Talent Hub
      </Link>
      <h1 className="mt-3 font-head text-2xl font-extrabold">{title}</h1>
      <p className="mt-1 text-xs text-ink-faint">Last updated: {LEGAL_LAST_UPDATED}</p>
      <div className="mt-5 flex flex-col gap-3">{children}</div>
      <p className="mt-10 border-t border-line pt-4 text-xs text-ink-faint">
        <Link href="/privacy" className="font-semibold text-brand-cyan-deep">
          Privacy Policy
        </Link>
        {" · "}
        <Link href="/delete-account" className="font-semibold text-brand-cyan-deep">
          Delete your account
        </Link>
      </p>
    </main>
  );
}

export function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-4 font-head text-lg font-extrabold">{children}</h2>;
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-ink-soft">{children}</p>;
}

export function UL({ children }: { children: React.ReactNode }) {
  return <ul className="ml-5 list-disc space-y-1.5 text-sm leading-relaxed text-ink-soft">{children}</ul>;
}

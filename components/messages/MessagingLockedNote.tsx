import Link from "next/link";

// Stands in for "Message teacher" when an under-18 doesn't have their parent or guardian's messaging
// permission yet. Links to the Messages page, where they can ask.
export function MessagingLockedNote() {
  return (
    <Link
      href="/student/messages"
      className="shrink-0 rounded-full border border-line bg-surface px-4 py-2 text-center text-xs font-semibold text-ink-soft hover:border-brand-cyan-deep"
    >
      Needs a parent&apos;s OK
    </Link>
  );
}

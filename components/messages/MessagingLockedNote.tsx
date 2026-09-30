import Link from "next/link";
import type { MessagingState } from "@/lib/messaging-permission";
import { messagingLockedLabel } from "@/lib/messaging-locked-label";

// Stands in for "Message teacher"/"Message coach" when a student can't message: their account
// setup isn't finished (not_cleared), or messaging can't be checked right now (unavailable). Always
// links to the Messages page, which explains the reason and offers the right next step.
export function MessagingLockedNote({ state }: { state: MessagingState }) {
  return (
    <Link
      href="/student/messages"
      className="shrink-0 rounded-full border border-line bg-surface px-4 py-2 text-center text-xs font-semibold text-ink-soft hover:border-brand-cyan-deep"
    >
      {messagingLockedLabel(state)}
    </Link>
  );
}

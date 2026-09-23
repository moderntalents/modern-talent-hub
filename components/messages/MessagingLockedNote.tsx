import Link from "next/link";
import type { MessagingState } from "@/lib/messaging-permission";
import { messagingLockedLabel } from "@/lib/messaging-locked-label";

// Stands in for "Message teacher"/"Message coach" when a student can't message yet — for
// either reason: their parent/guardian hasn't allowed messaging specifically (needs_guardian),
// or their own account age-check/consent isn't finished yet (not_cleared). Always links to the
// Messages page, which explains the specific reason and offers the right next step.
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

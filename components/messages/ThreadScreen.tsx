import Link from "next/link";
import { AutoRefresh } from "@/components/live/AutoRefresh";
import { Composer } from "@/components/messages/Composer";
import { MessageThread } from "@/components/messages/MessageThread";
import type { Thread } from "@/lib/messages/queries";

// One conversation page, shared by students and teachers. The list of replies refreshes on its own
// every few seconds, so a new message or a returned PDF appears without reloading.
export function ThreadScreen({ thread, role, backHref }: { thread: Thread; role: "student" | "teacher"; backHref: string }) {
  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh seconds={12} />
      <div>
        <Link href={backHref} className="text-xs font-semibold text-brand-cyan-deep">
          ← All messages
        </Link>
        <h1 className="font-head text-xl font-extrabold">{thread.otherName}</h1>
        <p className="text-xs text-ink-faint">{role === "student" ? "Your teacher" : "Your student"}</p>
      </div>

      <MessageThread messages={thread.messages} />

      {thread.readOnlyReason ? (
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-soft">{thread.readOnlyReason}</p>
      ) : (
        <Composer conversationId={thread.id} role={role} />
      )}
    </div>
  );
}

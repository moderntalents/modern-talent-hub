"use client";

import { MessageBubble } from "@/components/messages/MessageBubble";
import type { ThreadMessage } from "@/lib/messages/queries";

// The conversation. Attachments link to /api/messages/attachment/<message id>, which checks the
// person is in the conversation and then sends them to a link that lasts about a minute. Each
// message is a MessageBubble, which gives the sender a ⋮ menu (edit / delete) on their own messages.
// `canEdit` is false while the conversation can't take new messages (closed or paused).
export function MessageThread({ messages, canEdit }: { messages: ThreadMessage[]; canEdit: boolean }) {
  if (messages.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-faint">No messages yet. Say hello below.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} canEdit={canEdit} />
      ))}
    </div>
  );
}

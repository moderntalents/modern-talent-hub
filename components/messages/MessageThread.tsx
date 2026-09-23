import { Badge } from "@/components/ui/Card";
import { humanFileSize } from "@/lib/format";
import { formatMessageTime } from "@/lib/messages/time";
import type { ThreadMessage } from "@/lib/messages/queries";

// The conversation. Attachments link to /api/messages/attachment/<message id>, which checks the
// person is in the conversation and then sends them to a link that lasts about a minute.
export function MessageThread({ messages }: { messages: ThreadMessage[] }) {
  if (messages.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-faint">No messages yet. Say hello below.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {messages.map((m) => (
        <div key={m.id} className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
          <div
            className={`flex max-w-[85%] flex-col gap-1.5 rounded-2xl px-3.5 py-2.5 text-sm ${
              m.fromMe ? "bg-[var(--info-tint)] text-ink" : "border border-line bg-surface text-ink"
            }`}
          >
            {m.kind === "homework" && <Badge tone="warning">📚 Homework</Badge>}
            {m.kind === "submission" && <Badge tone="success">✅ Completed homework</Badge>}

            {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}

            {m.attachmentName && (
              <a
                href={`/api/messages/attachment/${m.id}`}
                className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 font-semibold text-brand-cyan-deep"
              >
                <span>📄</span>
                <span className="min-w-0 flex-1 truncate">{m.attachmentName}</span>
                <span className="shrink-0 text-xs font-normal text-ink-faint">{humanFileSize(m.attachmentSize)}</span>
                <span className="shrink-0 text-xs">Download</span>
              </a>
            )}

            <p className="text-[11px] text-ink-faint">{formatMessageTime(m.createdAt)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

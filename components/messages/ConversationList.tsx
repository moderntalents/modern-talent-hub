import Link from "next/link";
import { Badge, Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatMessageTime } from "@/lib/messages/time";
import type { ConversationSummary } from "@/lib/messages/queries";

export function ConversationList({
  basePath,
  conversations,
  emptyTitle,
  emptyDescription,
}: {
  basePath: string;
  conversations: ConversationSummary[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (conversations.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />;

  return (
    <div className="flex flex-col gap-2">
      {conversations.map((c) => (
        <Link key={c.id} href={`${basePath}/${c.id}`}>
          <Card className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{c.otherName}</p>
              <p className="shrink-0 text-xs text-ink-faint">{formatMessageTime(c.lastMessageAt)}</p>
            </div>
            <div className="flex items-center gap-2">
              {c.lastKind === "homework" && <Badge tone="warning">Homework</Badge>}
              {c.lastKind === "submission" && <Badge tone="success">Submission</Badge>}
              <p className="line-clamp-1 text-sm text-ink-soft">
                {c.lastFromMe && c.preview ? "You: " : ""}
                {c.preview}
              </p>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}

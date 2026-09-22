import { getSessionProfile } from "@/lib/auth";
import { listConversations } from "@/lib/messages/queries";
import { ConversationList } from "@/components/messages/ConversationList";
import { AutoRefresh } from "@/components/live/AutoRefresh";

// Per-person data: always rendered on request, never at build time.
export const dynamic = "force-dynamic";

export default async function StudentMessagesPage() {
  const session = await getSessionProfile();
  const conversations = await listConversations(session!.user.id, "student");

  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh seconds={20} />
      <div>
        <h1 className="font-head text-xl font-extrabold">Messages</h1>
        <p className="text-sm text-ink-soft">Ask your teachers questions and hand in homework as a PDF.</p>
      </div>

      <ConversationList
        basePath="/student/messages"
        conversations={conversations}
        emptyTitle="No messages yet"
        emptyDescription="Open one of your teacher's lessons, or an activity you're enrolled in, and choose “Message teacher”."
      />
    </div>
  );
}

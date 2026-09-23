import { getSessionProfile } from "@/lib/auth";
import { listConversations, listEnrolledStudents } from "@/lib/messages/queries";
import { ConversationList } from "@/components/messages/ConversationList";
import { StartConversationButton } from "@/components/messages/StartConversationButton";
import { AutoRefresh } from "@/components/live/AutoRefresh";
import { Card } from "@/components/ui/Card";

// Per-person data: always rendered on request, never at build time.
export const dynamic = "force-dynamic";

export default async function TeacherMessagesPage() {
  const session = await getSessionProfile();
  const [conversations, enrolled] = await Promise.all([
    listConversations(session!.user.id, "teacher"),
    listEnrolledStudents(session!.user.id),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <AutoRefresh seconds={20} />
      <div>
        <h1 className="font-head text-xl font-extrabold">Messages</h1>
        <p className="text-sm text-ink-soft">Reply to students, send homework, and open the PDFs they hand in.</p>
      </div>

      <ConversationList
        basePath="/teacher/messages"
        conversations={conversations}
        emptyTitle="No messages yet"
        emptyDescription="Students can message you from your lessons. You can also start a conversation with a student enrolled in one of your activities."
      />

      {enrolled.length > 0 && (
        <div>
          <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
            Start a conversation with an enrolled student
          </h2>
          <div className="flex flex-col gap-2">
            {enrolled.map((s) => (
              <Card key={s.studentId} className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{s.name}</p>
                  <p className="text-xs text-ink-faint">{s.activityTitle}</p>
                </div>
                <StartConversationButton
                  target={{ kind: "student", studentId: s.studentId }}
                  label="Message"
                  basePath="/teacher/messages"
                  variant="outline"
                />
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

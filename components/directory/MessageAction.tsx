import { LinkButton } from "@/components/ui/Button";
import { StartConversationButton } from "@/components/messages/StartConversationButton";
import { MessagingLockedNote } from "@/components/messages/MessagingLockedNote";
import type { MessagingState } from "@/lib/messaging-permission";
import type { DirectoryTeacher } from "@/lib/directory/rules";

/**
 * The "Message" button for one teacher/coach. If a conversation with them already exists it simply
 * opens it; otherwise the button asks the server to open (or create) the one conversation for the
 * pair — which the database never duplicates. If the student's account can't message yet, it says so
 * and points to the Messages page, exactly like the activity page does.
 */
export function MessageAction({
  teacher,
  messagingState,
  variant = "primary",
}: {
  teacher: Pick<DirectoryTeacher, "id" | "name" | "conversationId">;
  messagingState: MessagingState;
  variant?: "primary" | "outline";
}) {
  if (messagingState.kind !== "allowed") return <MessagingLockedNote state={messagingState} />;
  if (teacher.conversationId) {
    return (
      <LinkButton href={`/student/messages/${teacher.conversationId}`} variant={variant} ariaLabel={`Message ${teacher.name}`}>
        Message
      </LinkButton>
    );
  }
  return (
    <StartConversationButton
      target={{ kind: "teacher", teacherId: teacher.id }}
      label="Message"
      basePath="/student/messages"
      variant={variant}
      ariaLabel={`Message ${teacher.name}`}
    />
  );
}

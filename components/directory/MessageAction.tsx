import { LinkButton } from "@/components/ui/Button";
import { StartConversationButton } from "@/components/messages/StartConversationButton";
import { MessagingLockedNote } from "@/components/messages/MessagingLockedNote";
import type { MessagingState } from "@/lib/messaging-permission";
import { canOpenConversation, type DirectoryTeacher } from "@/lib/directory/rules";

/**
 * The "Message" button for one teacher/coach.
 *
 *  - A conversation with them already exists: it simply opens it.
 *  - Otherwise, if the student may message them (an active subscription — the messaging rule), the
 *    button asks the server to open (or create) the one conversation for the pair, which the database
 *    never duplicates.
 *  - If the student's account setup isn't finished, it says so and points to the Messages page.
 *  - If the student has no subscription with them, "Message" leads to the person's profile, which
 *    explains that messaging opens once they join one of their activities, and lists those activities.
 */
export function MessageAction({
  teacher,
  messagingState,
  variant = "primary",
  compact,
}: {
  teacher: Pick<DirectoryTeacher, "id" | "name" | "conversationId" | "canMessage">;
  messagingState: MessagingState;
  variant?: "primary" | "outline";
  /** Full width with narrower sides, for the small cards. */
  compact?: boolean;
}) {
  const label = `Message ${teacher.name}`;
  const width = compact ? "w-full" : "";

  if (!canOpenConversation(teacher)) {
    return (
      <LinkButton href={`/student/teachers/${teacher.id}#join`} variant={variant} compact={compact} className={width} ariaLabel={`${label} (join one of their activities first)`}>
        Message
      </LinkButton>
    );
  }
  if (messagingState.kind !== "allowed") return <MessagingLockedNote state={messagingState} fullWidth={compact} />;
  if (teacher.conversationId) {
    return (
      <LinkButton href={`/student/messages/${teacher.conversationId}`} variant={variant} compact={compact} className={width} ariaLabel={label}>
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
      ariaLabel={label}
      compact={compact}
      fullWidth={compact}
    />
  );
}

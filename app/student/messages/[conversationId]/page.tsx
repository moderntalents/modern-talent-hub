import { notFound, redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { getThread } from "@/lib/messages/queries";
import { getMessagingState } from "@/lib/messaging-gate";
import { ThreadScreen } from "@/components/messages/ThreadScreen";

// Per-person data: always rendered on request, never at build time.
export const dynamic = "force-dynamic";

export default async function StudentThreadPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const session = await getSessionProfile();

  // Without messaging permission the database hides every conversation; send them to the page that
  // explains why and lets them ask a parent or guardian.
  if ((await getMessagingState(session!.user.id)).kind === "needs_guardian") redirect("/student/messages");

  const thread = await getThread(conversationId, session!.user.id, "student");
  if (!thread) notFound();

  return <ThreadScreen thread={thread} role="student" backHref="/student/messages" />;
}

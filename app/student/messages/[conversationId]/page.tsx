import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { getThread } from "@/lib/messages/queries";
import { ThreadScreen } from "@/components/messages/ThreadScreen";

// Per-person data: always rendered on request, never at build time.
export const dynamic = "force-dynamic";

export default async function StudentThreadPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const session = await getSessionProfile();
  const thread = await getThread(conversationId, session!.user.id, "student");
  if (!thread) notFound();

  return <ThreadScreen thread={thread} role="student" backHref="/student/messages" />;
}

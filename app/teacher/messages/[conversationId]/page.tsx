import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { getThread } from "@/lib/messages/queries";
import { ThreadScreen } from "@/components/messages/ThreadScreen";

// Per-person data: always rendered on request, never at build time.
export const dynamic = "force-dynamic";

export default async function TeacherThreadPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const session = await getSessionProfile();
  const thread = await getThread(conversationId, session!.user.id, "teacher");
  if (!thread) notFound();

  return <ThreadScreen thread={thread} role="teacher" backHref="/teacher/messages" />;
}

import { getSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { listConversations } from "@/lib/messages/queries";
import { getMessagingState } from "@/lib/messaging-gate";
import { hasActiveConsentRequest, maskEmail } from "@/lib/consent";
import { ConversationList } from "@/components/messages/ConversationList";
import { AutoRefresh } from "@/components/live/AutoRefresh";
import { MessagingPermissionPanel } from "./MessagingPermissionPanel";

// Per-person data: always rendered on request, never at build time.
export const dynamic = "force-dynamic";

export default async function StudentMessagesPage() {
  const session = await getSessionProfile();
  const userId = session!.user.id;
  const admin = createAdminClient();
  const state = await getMessagingState(userId, admin);

  // Under 18 without the parent or guardian's messaging permission: explain, and offer to ask.
  // (The database hides their conversations anyway; this just says why.)
  if (state.kind === "needs_guardian") {
    const [{ data: record }, emailActive] = await Promise.all([
      admin.from("age_records").select("guardian_email").eq("profile_id", userId).maybeSingle(),
      hasActiveConsentRequest(admin, userId, "messaging"),
    ]);
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="font-head text-xl font-extrabold">Messages</h1>
          <p className="text-sm text-ink-soft">Ask your teachers questions and hand in homework as a PDF.</p>
        </div>
        <MessagingPermissionPanel
          status={state.status}
          emailActive={emailActive}
          maskedGuardianEmail={record?.guardian_email ? maskEmail(record.guardian_email) : "your parent or guardian"}
        />
      </div>
    );
  }

  const conversations = await listConversations(userId, "student");

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

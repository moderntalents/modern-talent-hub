import { getSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { listConversations } from "@/lib/messages/queries";
import { getMessagingState } from "@/lib/messaging-gate";
import { hasActiveConsentRequest, maskEmail } from "@/lib/consent";
import { ConversationList } from "@/components/messages/ConversationList";
import { AutoRefresh } from "@/components/live/AutoRefresh";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
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

  // Account-level age check / consent isn't finished yet — a different, earlier gate than
  // guardian permission for messaging specifically (0014). In the normal flow the student
  // layout's own age gate (lib/age-gate.ts, unchanged by this fix) already redirects someone
  // in this state away from /student/* pages before they'd ever see this — this branch exists
  // so that if it's ever reached anyway, messaging never silently tells them to click a
  // "Message teacher" button that isn't there for them.
  if (state.kind === "not_cleared") {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="font-head text-xl font-extrabold">Messages</h1>
          <p className="text-sm text-ink-soft">Ask your teachers questions and hand in homework as a PDF.</p>
        </div>
        <Card>
          <div className="flex flex-col gap-3">
            <div>
              <p className="font-head text-base font-bold">Finish setting up your account first</p>
              <p className="mt-1 text-sm text-ink-soft">
                Messaging isn&apos;t available until your account&apos;s age check is complete. This is separate
                from a parent or guardian&apos;s permission for messaging specifically.
              </p>
            </div>
            <LinkButton href="/age-check" className="w-fit">
              Finish account setup
            </LinkButton>
          </div>
        </Card>
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

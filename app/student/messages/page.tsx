import { getSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { listConversations } from "@/lib/messages/queries";
import { getAccountStatus, MESSAGING_UNAVAILABLE_MESSAGE } from "@/lib/messaging-gate";
import { createClient } from "@/lib/supabase/server";
import { ConversationList } from "@/components/messages/ConversationList";
import { AutoRefresh } from "@/components/live/AutoRefresh";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";

// Per-person data: always rendered on request, never at build time.
export const dynamic = "force-dynamic";

export default async function StudentMessagesPage() {
  const session = await getSessionProfile();
  const userId = session!.user.id;
  const admin = createAdminClient();
  // Same loader as Settings, so the two pages always agree about whether setup is finished.
  const account = await getAccountStatus(await createClient(), userId, admin);
  const state = account.messaging;

  // Account setup (age check, or a guardian's approval of the account) really isn't finished.
  // Only shown when lib/account-setup.ts says so; the student layout normally redirects before this
  // is reached.
  // The button goes straight to the step that's missing.
  if (state.kind === "not_cleared" && account.setupHref) {
    const setup = account.setup;
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
                {setup.kind === "needs_age"
                  ? "Messaging isn't available until you've finished the age check."
                  : setup.kind === "pending"
                    ? "Messaging isn't available until your parent or guardian approves your account."
                    : "Messaging isn't available because your parent or guardian didn't approve your account."}
              </p>
            </div>
            <LinkButton href={account.setupHref} className="w-fit">
              {setup.kind === "needs_age" ? "Finish the age check" : "Check the approval"}
            </LinkButton>
          </div>
        </Card>
      </div>
    );
  }

  // The permission couldn't be checked at all (lib/messaging-gate.ts logs why). Fail closed, but don't
  // send a fully set-up student back to account setup for a problem that isn't theirs.
  if (state.kind === "unavailable" || state.kind === "not_cleared") {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="font-head text-xl font-extrabold">Messages</h1>
          <p className="text-sm text-ink-soft">Ask your teachers questions and hand in homework as a PDF.</p>
        </div>
        <Card>
          <p className="font-head text-base font-bold">Messaging is unavailable right now</p>
          <p className="mt-1 text-sm text-ink-soft">{MESSAGING_UNAVAILABLE_MESSAGE}</p>
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
        emptyDescription="Open an activity you're enrolled in and choose “Message coach”."
      />
    </div>
  );
}

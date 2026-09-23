import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getAgeState, gateRedirect } from "@/lib/age-gate";
import { accountSetupBanner } from "@/lib/account-setup-status";
import { getMessagingState } from "@/lib/messaging-gate";
import { CONTACT_EMAIL } from "@/lib/legal";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import { DeleteAccountPanel } from "./DeleteAccountPanel";

export const metadata: Metadata = { title: "Settings — Modern Talent Hub" };

const SectionHeading = ({ children }: { children: React.ReactNode }) => (
  <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">{children}</h2>
);

// Sits OUTSIDE the /student and /teacher areas on purpose: a teacher who is still waiting for
// approval is blocked from every /teacher page, but must still be able to see and finish their
// account setup, check their privacy options, and delete their account. Reachable from every
// page via AppShell's "Settings" link, for every role — this is the one central place for
// account-level things, rather than scattering them across the student/teacher areas.
export default async function AccountPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login?next=%2Faccount");

  const { user, profile } = session;
  const role = profile.role;

  // Age/guardian and messaging status only apply to students and teachers (not admins) — same
  // gates the student/teacher layouts already enforce (lib/age-gate.ts, lib/messaging-gate.ts,
  // both unchanged by this page). Settings never grants anything by itself: it only shows
  // what's outstanding and links to the existing flow that actually resolves it.
  const ageState = role === "admin" ? null : await getAgeState(await createClient(), user.id);
  const setupBanner = ageState ? accountSetupBanner(ageState, gateRedirect(ageState)) : null;
  const messagingState = role === "student" ? await getMessagingState(user.id) : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-6">
      <div>
        <Link href={`/${role}`} className="text-sm font-semibold text-brand-cyan-deep">
          ← Back to my dashboard
        </Link>
        <h1 className="mt-2 font-head text-xl font-extrabold">Settings</h1>
      </div>

      {setupBanner && (
        <Card className="border-brand-cyan-deep">
          <SectionHeading>Complete your account</SectionHeading>
          <p className="text-sm text-ink-soft">{setupBanner.label}</p>
          <div className="mt-3">
            <LinkButton href={setupBanner.href} className="w-fit">
              Continue
            </LinkButton>
          </div>
        </Card>
      )}

      <Card className="flex flex-col gap-1">
        <SectionHeading>Profile</SectionHeading>
        <p className="font-semibold">{profile.full_name}</p>
        <p className="text-xs capitalize text-ink-faint">{role}</p>
      </Card>

      <Card className="flex flex-col gap-1">
        <SectionHeading>Account</SectionHeading>
        <p className="text-sm text-ink-soft">{user.email}</p>
        <Link href="/forgot-password" className="mt-1 text-sm font-semibold text-brand-cyan-deep">
          Change my password
        </Link>
      </Card>

      {ageState && (
        <Card className="flex flex-col gap-1">
          <SectionHeading>Age &amp; Guardian</SectionHeading>
          {ageState.kind === "ok" ? (
            <p className="text-sm text-ink-soft">Your account is fully set up — nothing outstanding here.</p>
          ) : (
            <>
              <p className="text-sm text-ink-soft">
                {ageState.kind === "needs_age" && "You haven't finished your age check yet."}
                {ageState.kind === "pending" && "Waiting for your parent or guardian to approve your account."}
                {ageState.kind === "declined" && "Your parent or guardian didn't approve your account."}
              </p>
              <Link href={setupBanner!.href} className="mt-1 text-sm font-semibold text-brand-cyan-deep">
                {ageState.kind === "needs_age" ? "Finish the age check" : "Check the status"}
              </Link>
            </>
          )}
        </Card>
      )}

      {role === "student" && messagingState && (
        <Card className="flex flex-col gap-1">
          <SectionHeading>Messaging</SectionHeading>
          <p className="text-sm text-ink-soft">
            {messagingState.kind === "allowed" &&
              "Messaging is available — you can message your teachers from a lesson or activity."}
            {messagingState.kind === "needs_guardian" && "Messaging needs your parent or guardian's permission first."}
            {messagingState.kind === "not_cleared" && "Messaging isn't available until your account setup above is finished."}
          </p>
          <Link href="/student/messages" className="mt-1 text-sm font-semibold text-brand-cyan-deep">
            {messagingState.kind === "allowed" ? "Go to Messages" : "See what's needed"}
          </Link>
        </Card>
      )}

      <Card className="flex flex-col gap-2">
        <SectionHeading>Privacy &amp; Safety</SectionHeading>
        <Link href="/privacy" className="text-sm font-semibold text-brand-cyan-deep">
          Read our Privacy Policy
        </Link>
        <Link href="/delete-account" className="text-sm font-semibold text-brand-cyan-deep">
          How account deletion works
        </Link>
      </Card>

      <Card className="flex flex-col gap-1">
        <SectionHeading>Notifications</SectionHeading>
        <p className="text-sm text-ink-soft">There are no configurable notification settings yet.</p>
      </Card>

      <Card className="flex flex-col gap-1">
        <SectionHeading>Help &amp; Support</SectionHeading>
        <p className="text-sm text-ink-soft">Questions or problems with your account?</p>
        <a href={`mailto:${CONTACT_EMAIL}`} className="text-sm font-semibold text-brand-cyan-deep">
          {CONTACT_EMAIL}
        </a>
      </Card>

      <Card className="flex flex-col gap-1">
        <SectionHeading>Terms &amp; Privacy</SectionHeading>
        <Link href="/privacy" className="text-sm font-semibold text-brand-cyan-deep">
          Privacy Policy
        </Link>
      </Card>

      {role === "admin" ? (
        <Card>
          <SectionHeading>Delete my account</SectionHeading>
          <p className="text-sm text-ink-soft">
            Administrator accounts can&apos;t be deleted from here, so the platform is never left without one. Contact the site
            owner if an administrator needs to be removed.
          </p>
        </Card>
      ) : (
        <DeleteAccountPanel role={role} />
      )}
    </main>
  );
}

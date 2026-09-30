import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { accountSetupBanner } from "@/lib/account-setup-status";
import { getAccountStatus, MESSAGING_UNAVAILABLE_MESSAGE } from "@/lib/messaging-gate";
import { CONTACT_EMAIL } from "@/lib/legal";
import { ageGroup, ageInYears } from "@/lib/age";
import { ageSummary } from "@/lib/age-summary";
import { phoneEditable } from "@/lib/profile-edit";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import { DeleteAccountPanel } from "./DeleteAccountPanel";
import { ProfilePanel } from "./ProfilePanel";

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

  // Age/guardian and messaging status only apply to students and teachers (not admins). Both come
  // from getAccountStatus() — the same loader the Messages page uses, built on the same setup rule
  // the student/teacher layouts gate on (lib/account-setup.ts) — so Settings and Messages can never
  // disagree about whether setup is finished. Settings never grants anything by itself: it only
  // shows what's outstanding and links to the existing flow that actually resolves it.
  const supabase = await createClient();
  const status = role === "admin" ? null : await getAccountStatus(supabase, user.id);
  const setupBanner = status ? accountSetupBanner(status.setup, status.setupHref) : null;
  const messagingState = status?.messaging ?? null;

  // The person's own stored details, read with THEIR session so row-level security applies
  // (age_records_read_own, student_profile_owner, teacher_profile_read_own_or_admin).
  const [{ data: ageRecord }, { data: studentDetails }, { data: teacherDetails }] = await Promise.all([
    role === "admin"
      ? Promise.resolve({ data: null })
      : supabase.from("age_records").select("date_of_birth, guardian_email, consent_status").eq("profile_id", user.id).maybeSingle(),
    role === "student"
      ? supabase.from("student_profiles").select("grade, school_name").eq("profile_id", user.id).maybeSingle()
      : Promise.resolve({ data: null }),
    role === "teacher"
      ? supabase.from("teacher_profiles").select("specialty, bio").eq("profile_id", user.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const group = ageRecord ? ageGroup(ageInYears(ageRecord.date_of_birth)) : null;
  const ageDetails = role === "admin" || !status ? null : ageSummary(status.setup, ageRecord, CONTACT_EMAIL);

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

      <ProfilePanel
        role={role}
        showPhone={phoneEditable(group)}
        phoneOptional={role === "admin" || group !== "adult"}
        initial={{
          fullName: profile.full_name,
          phone: profile.phone ?? "",
          grade: studentDetails?.grade ?? "",
          schoolName: studentDetails?.school_name ?? "",
          specialty: teacherDetails?.specialty ?? "",
          bio: teacherDetails?.bio ?? "",
        }}
      />

      <Card className="flex flex-col gap-1">
        <SectionHeading>Account</SectionHeading>
        <p className="text-sm text-ink-soft">{user.email}</p>
        <Link href="/forgot-password" className="mt-1 text-sm font-semibold text-brand-cyan-deep">
          Change my password
        </Link>
      </Card>

      {ageDetails && (
        <Card className="flex flex-col gap-1">
          <SectionHeading>Age &amp; Guardian</SectionHeading>
          <p className="text-sm text-ink-soft">{ageDetails.status}</p>
          {ageDetails.rows.length > 0 && (
            <dl className="mt-1 flex flex-col gap-0.5 text-sm">
              {ageDetails.rows.map((row) => (
                <div key={row.label} className="flex flex-wrap gap-x-1">
                  <dt className="text-ink-faint">{row.label}:</dt>
                  <dd className="text-ink-soft">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {ageDetails.correctionNote && <p className="mt-1 text-xs text-ink-faint">{ageDetails.correctionNote}</p>}
          {ageDetails.links.map((link) =>
            link.href.startsWith("mailto:") ? (
              <a key={link.href} href={link.href} className="mt-1 text-sm font-semibold text-brand-cyan-deep">
                {link.label}
              </a>
            ) : (
              <Link key={link.href} href={link.href} className="mt-1 text-sm font-semibold text-brand-cyan-deep">
                {link.label}
              </Link>
            ),
          )}
        </Card>
      )}

      {role !== "admin" && messagingState && (
        <Card className="flex flex-col gap-1">
          <SectionHeading>Messaging</SectionHeading>
          <p className="text-sm text-ink-soft">
            {messagingState.kind === "allowed" &&
              (role === "student"
                ? "Messaging is available — you can message the coach of any activity you're enrolled in."
                : "Messaging is available — reply to your students, and start conversations with adult students enrolled in your activities.")}
            {messagingState.kind === "not_cleared" && "Messaging isn't available until your account setup above is finished."}
            {messagingState.kind === "unavailable" && MESSAGING_UNAVAILABLE_MESSAGE}
          </p>
          {messagingState.kind === "not_cleared" && status?.setupHref ? (
            <Link href={status.setupHref} className="mt-1 text-sm font-semibold text-brand-cyan-deep">
              Finish account setup
            </Link>
          ) : messagingState.kind === "allowed" ? (
            <Link href={`/${role}/messages`} className="mt-1 text-sm font-semibold text-brand-cyan-deep">
              Go to Messages
            </Link>
          ) : null}
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

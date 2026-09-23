import type { Metadata } from "next";
import Link from "next/link";
import { H2, LegalPage, P, UL } from "@/components/legal/LegalPage";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken } from "@/lib/consent";
import { coversMessaging } from "@/lib/consent-versions";
import { CONTACT_EMAIL } from "@/lib/legal";
import { decideConsent } from "./actions";

export const metadata: Metadata = {
  title: "Parent or guardian permission — Modern Talent Hub",
  robots: { index: false, follow: false },
};

// The page a parent or guardian reaches from the email. Public — no login. Opening it only
// SHOWS the details; approving or declining needs a deliberate button press (see actions.ts).
export default async function GuardianConsentPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;

  const problem = (title: string, body: string) => (
    <LegalPage title={title}>
      <P>{body}</P>
    </LegalPage>
  );

  if (!token || token.length > 200) {
    return problem("This link isn't valid", "Please use the link in the email we sent you.");
  }

  const admin = createAdminClient();
  const { data: request } = await admin
    .from("guardian_consent_requests")
    .select("profile_id, guardian_email, expires_at, decided_at, purpose, consent_version")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (!request || request.purpose !== "platform") {
    return problem("This link isn't valid", "Please use the newest email we sent you.");
  }
  if (request.decided_at) return problem("Already answered", "This request has already been answered. Thank you.");
  if (new Date(request.expires_at) < new Date()) {
    return problem(
      "This link has expired",
      "Ask the young person to open Modern Talent Hub and choose “Send the email again”. Only the newest email works.",
    );
  }

  const [{ data: record }, { data: profile }] = await Promise.all([
    admin.from("age_records").select("consent_status, guardian_email").eq("profile_id", request.profile_id).maybeSingle(),
    admin.from("profiles").select("full_name").eq("id", request.profile_id).maybeSingle(),
  ]);
  if (
    !record ||
    record.consent_status !== "pending" ||
    record.guardian_email?.toLowerCase() !== request.guardian_email.toLowerCase()
  ) {
    return problem("This link isn't valid", "Please use the newest email we sent you.");
  }

  const name = profile?.full_name || "the young person";
  // Only requests sent with wording that covers messaging (guardian-v2 or later) can allow it here.
  const canChooseMessaging = coversMessaging(request.consent_version);

  return (
    <LegalPage title="Parent or guardian permission">
      <P>
        <strong>{name}</strong> has asked to join Modern Talent Hub, a learning and talent platform for students, teachers
        and coaches in Kenya. Because they are under 18, we need your permission first. Please read this, then choose
        Approve or Decline at the bottom.
      </P>

      <H2>What we collect about them</H2>
      <UL>
        <li>Their name, email address, date of birth, grade or class and, if they choose, their school.</li>
        <li>For a child under 13 we do not ask for or keep a phone number.</li>
        <li>The activities and lessons they use, the assignments and files they upload, and the live classes they join.</li>
        <li>We show no advertising, we do not sell their information, and we do not track them for marketing.</li>
      </UL>

      <H2>Live classes</H2>
      <UL>
        <li>
          Teachers run live video classes through our video provider, Daily. When they join a class they first see a screen
          to check their camera and microphone. Their microphone starts off; their camera may be on when they join. They can
          turn either off at any time.
        </li>
        <li>We do not record live classes. There is a group text chat during a live class.</li>
        <li>Teachers can see the names of the students in their classes and activities.</li>
      </UL>

      <H2>Private messages with teachers (optional)</H2>
      <UL>
        <li>
          The app has private messages between a student and their own teachers — for questions, and for sending and
          handing in homework as PDF files. Students can only message teachers of lessons they can open or activities
          they are enrolled in; they cannot message other students.
        </li>
        <li>
          Messaging is <strong>off</strong> for anyone under 18 unless you allow it. It is a separate choice: saying no
          to messaging does not affect the rest of the account.
        </li>
        <li>
          Messages are private to the two people in the conversation. Our administrators have no access to them in the
          app. They are deleted when either account is deleted.
        </li>
        <li>You can switch messaging off again at any time by emailing us. At 18, messaging switches on automatically.</li>
      </UL>

      <H2>Your choices</H2>
      <UL>
        <li>
          You can ask us at any time to show you, correct or delete your child&apos;s information, or withdraw this
          permission, by emailing{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-brand-cyan-deep">
            {CONTACT_EMAIL}
          </a>
          .
        </li>
        <li>
          If you decline, the account cannot be used and is removed. Read our full{" "}
          <Link href="/privacy" className="font-semibold text-brand-cyan-deep">
            Privacy Policy
          </Link>
          .
        </li>
      </UL>

      <form action={decideConsent} className="mt-4 flex flex-col gap-3">
        <input type="hidden" name="token" value={token} />
        {canChooseMessaging ? (
          <fieldset className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-4">
            <legend className="px-1 text-sm font-bold">Private messages with teachers</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="messaging" value="declined" defaultChecked className="mt-1" />
              <span>Don&apos;t allow messaging for now</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="messaging" value="approved" className="mt-1" />
              <span>Allow private messages with their teachers</span>
            </label>
            <p className="text-xs text-ink-faint">This choice only applies if you approve below.</p>
          </fieldset>
        ) : (
          <p className="rounded-xl border border-line bg-surface-2 p-4 text-sm">
            Private messaging stays off with this approval. If {name} wants it later, they can ask you separately and you
            will get another email.
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="submit"
            name="decision"
            value="approved"
            className="min-h-12 flex-1 rounded-xl bg-brand-cyan px-5 text-sm font-bold text-ink hover:opacity-90"
          >
            I approve
          </button>
          <button
            type="submit"
            name="decision"
            value="declined"
            className="min-h-12 flex-1 rounded-xl border border-line bg-surface px-5 text-sm font-bold text-ink hover:bg-surface-2"
          >
            I decline
          </button>
        </div>
      </form>
    </LegalPage>
  );
}

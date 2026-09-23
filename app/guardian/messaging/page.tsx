import type { Metadata } from "next";
import Link from "next/link";
import { H2, LegalPage, P, UL } from "@/components/legal/LegalPage";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken } from "@/lib/consent";
import { coversMessaging } from "@/lib/consent-versions";
import { CONTACT_EMAIL } from "@/lib/legal";
import { decideMessagingConsent } from "./actions";

export const metadata: Metadata = {
  title: "Permission for messaging — Modern Talent Hub",
  robots: { index: false, follow: false },
};

// Where a parent or guardian lands from the "allow messaging" email. Public — no login. Opening it only
// SHOWS the details; allowing or not allowing needs a deliberate button press (see actions.ts).
export default async function GuardianMessagingPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
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

  if (!request || request.purpose !== "messaging" || !coversMessaging(request.consent_version)) {
    return problem("This link isn't valid", "Please use the newest email we sent you.");
  }
  if (request.decided_at) return problem("Already answered", "This request has already been answered. Thank you.");
  if (new Date(request.expires_at) < new Date()) {
    return problem(
      "This link has expired",
      "Ask the young person to open Messages in Modern Talent Hub and ask again. Only the newest email works.",
    );
  }

  const [{ data: record }, { data: profile }] = await Promise.all([
    admin.from("age_records").select("consent_status, guardian_email").eq("profile_id", request.profile_id).maybeSingle(),
    admin.from("profiles").select("full_name").eq("id", request.profile_id).maybeSingle(),
  ]);
  if (
    !record ||
    record.consent_status !== "granted" ||
    record.guardian_email?.toLowerCase() !== request.guardian_email.toLowerCase()
  ) {
    return problem("This link isn't valid", "Please use the newest email we sent you.");
  }

  const name = profile?.full_name || "the young person";

  return (
    <LegalPage title="Permission for private messaging">
      <P>
        You previously allowed <strong>{name}</strong> to use Modern Talent Hub. They are asking for your permission to
        use private messages with their teachers. Messaging is off unless you allow it. Please read this, then choose at
        the bottom.
      </P>

      <H2>What messaging is</H2>
      <UL>
        <li>Private, one-to-one messages between a student and their own teachers or coaches.</li>
        <li>Teachers can send homework as PDF files, and students can hand in their work as PDF files.</li>
        <li>
          Students can only message the teachers of lessons they can open or activities they are enrolled in. They cannot
          message other students.
        </li>
      </UL>

      <H2>Privacy</H2>
      <UL>
        <li>
          Messages and files are private to the two people in the conversation. Our administrators have no access to them
          in the app.
        </li>
        <li>They are deleted when either account is deleted.</li>
        <li>We show no advertising and do not use messages for marketing.</li>
      </UL>

      <H2>Your choices</H2>
      <UL>
        <li>
          Saying no only keeps messaging off. It does not change anything else about the account, and the account is not
          removed.
        </li>
        <li>
          You can switch messaging off again at any time by emailing{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-brand-cyan-deep">
            {CONTACT_EMAIL}
          </a>
          . Both sides then lose access to the conversations straight away.
        </li>
        <li>
          When {name} turns 18, messaging switches on automatically. Read our full{" "}
          <Link href="/privacy" className="font-semibold text-brand-cyan-deep">
            Privacy Policy
          </Link>
          .
        </li>
      </UL>

      <form action={decideMessagingConsent} className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          name="decision"
          value="approved"
          className="min-h-12 flex-1 rounded-xl bg-brand-cyan px-5 text-sm font-bold text-ink hover:opacity-90"
        >
          Allow messaging
        </button>
        <button
          type="submit"
          name="decision"
          value="declined"
          className="min-h-12 flex-1 rounded-xl border border-line bg-surface px-5 text-sm font-bold text-ink hover:bg-surface-2"
        >
          Don&apos;t allow
        </button>
      </form>
    </LegalPage>
  );
}

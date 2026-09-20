"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { guardianEmailProblem } from "@/lib/age";
import { issueConsentRequest, maskEmail } from "@/lib/consent";

// Actions for a young person waiting for a parent or guardian to approve. The person is
// always taken from the login session, and only an account that is still PENDING can use
// them. Failures come back as { ok: false, message }.

export type WaitingResult = { ok: true; message: string; maskedEmail?: string } | { ok: false; message: string };

const fail = (message: string): WaitingResult => ({ ok: false, message });

async function loadPending() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in again first." } as const;

  const admin = createAdminClient();
  const [{ data: record }, { data: profile }] = await Promise.all([
    admin.from("age_records").select("consent_status, guardian_email").eq("profile_id", user.id).maybeSingle(),
    admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
  ]);
  if (!record || record.consent_status !== "pending" || !record.guardian_email) {
    return { ok: false, error: "There is nothing waiting for a parent or guardian on this account." } as const;
  }

  // At most 5 emails per hour per person, so this can't be used to spam an inbox.
  const { data: allowed } = await admin.rpc("hit_rate_limit", {
    p_key: `consent:${user.id}`,
    p_max: 5,
    p_window_seconds: 3600,
  });
  if (!allowed) return { ok: false, error: "Too many emails sent. Please try again in a while." } as const;

  return { ok: true, admin, user, guardianEmail: record.guardian_email, childName: profile?.full_name ?? "" } as const;
}

/** Sends the approval email to the guardian again (older links stop working). */
export async function resendConsentEmail(): Promise<WaitingResult> {
  try {
    const ctx = await loadPending();
    if (!ctx.ok) return fail(ctx.error);

    const sent = await issueConsentRequest(ctx.admin, {
      profileId: ctx.user.id,
      childName: ctx.childName,
      guardianEmail: ctx.guardianEmail,
    });
    if (!sent.ok) return fail(sent.message);
    return { ok: true, message: `We've sent the email again to ${maskEmail(ctx.guardianEmail)}.` };
  } catch (err) {
    console.error("[consent-pending] resend failed:", err);
    return fail("Something went wrong. Please try again.");
  }
}

/** Changes the guardian's address (while still waiting) and emails the new one. */
export async function changeGuardianEmail(newEmail: string): Promise<WaitingResult> {
  try {
    const ctx = await loadPending();
    if (!ctx.ok) return fail(ctx.error);

    const email = newEmail.trim().toLowerCase();
    const problem = guardianEmailProblem(email, ctx.user.email);
    if (problem) return fail(problem);

    const { error } = await ctx.admin
      .from("age_records")
      .update({ guardian_email: email })
      .eq("profile_id", ctx.user.id)
      .eq("consent_status", "pending");
    if (error) {
      console.error("[consent-pending] could not change guardian email:", error.message);
      return fail("Something went wrong. Please try again.");
    }

    const sent = await issueConsentRequest(ctx.admin, {
      profileId: ctx.user.id,
      childName: ctx.childName,
      guardianEmail: email,
    });
    if (!sent.ok) return fail(`${sent.message} The new address was saved — use "Send the email again" to retry.`);
    return { ok: true, message: `We've emailed ${maskEmail(email)}.`, maskedEmail: maskEmail(email) };
  } catch (err) {
    console.error("[consent-pending] change email failed:", err);
    return fail("Something went wrong. Please try again.");
  }
}

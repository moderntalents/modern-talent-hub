"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { issueMessagingConsentRequest, maskEmail } from "@/lib/consent";
import { getMessagingState } from "@/lib/messaging-gate";

// "Ask my parent to allow messaging". The student is always taken from the login session, and the
// email only ever goes to the parent/guardian ON RECORD — the student cannot type a new address here,
// so they cannot approve themselves. Failures come back as { ok: false, message }.

export type AskResult = { ok: true; message: string } | { ok: false; message: string };

const fail = (message: string): AskResult => ({ ok: false, message });

export async function requestMessagingPermission(): Promise<AskResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return fail("Please sign in again first.");

    const admin = createAdminClient();
    const [{ data: profile }, { data: record }] = await Promise.all([
      admin.from("profiles").select("role, full_name").eq("id", user.id).maybeSingle(),
      admin.from("age_records").select("consent_status, guardian_email").eq("profile_id", user.id).maybeSingle(),
    ]);
    if (profile?.role !== "student") return fail("Only student accounts need this.");

    const state = await getMessagingState(user.id, admin);
    if (state.kind === "allowed") return fail("Messaging is already switched on for your account.");
    if (state.kind === "not_cleared" || record?.consent_status !== "granted" || !record.guardian_email) {
      return fail("Your parent or guardian needs to approve your account first.");
    }

    // At most 3 emails a day, so this can't be used to fill a parent's inbox.
    const { data: allowed, error: limitError } = await admin.rpc("hit_rate_limit", {
      p_key: `messaging-consent:${user.id}`,
      p_max: 3,
      p_window_seconds: 24 * 3600,
    });
    if (limitError) {
      console.error("[messaging-consent] rate limiter unavailable:", limitError.message);
      return fail("Something went wrong. Please try again.");
    }
    if (!allowed) return fail("You've already asked a few times today. Please try again tomorrow.");

    const sent = await issueMessagingConsentRequest(admin, {
      profileId: user.id,
      childName: profile.full_name ?? "",
      guardianEmail: record.guardian_email,
    });
    if (!sent.ok) return fail(sent.message);

    revalidatePath("/student/messages");
    return { ok: true, message: `We've emailed ${maskEmail(record.guardian_email)} to ask.` };
  } catch (err) {
    console.error("[messaging-consent] request failed:", err);
    return fail("Something went wrong. Please try again.");
  }
}

"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken, purgeUnusedStudent } from "@/lib/consent";
import { coversMessaging } from "@/lib/consent-versions";

// The guardian's decision. Public (the guardian isn't signed in): the secret in the email
// link is what proves it is them. It is a POST from a button on purpose — opening the
// link alone (which email scanners and link previews do) never approves anything.
//
// The page also carries an OPTIONAL messaging choice (0014). It only counts if the platform is
// approved and the request was sent with wording that covers messaging (guardian-v2 or later); for an
// older v1 request it is ignored and messaging stays off. Declining messaging never deletes anything.

export async function decideConsent(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const decision = formData.get("decision") === "approved" ? "approved" : formData.get("decision") === "declined" ? "declined" : null;
  // Anything other than an explicit "allow" means messaging stays off.
  const messaging = formData.get("messaging") === "approved" ? "approved" : "declined";

  let result: string;
  try {
    if (!token || token.length > 200 || !decision) {
      result = "invalid";
    } else {
      const admin = createAdminClient();
      const hash = hashToken(token);

      // Who is this about, and which wording was sent? (For tidying up after a "decline", and for the
      // thank-you page.)
      const { data: request } = await admin
        .from("guardian_consent_requests")
        .select("profile_id, consent_version")
        .eq("token_hash", hash)
        .maybeSingle();

      // Atomic in the database: checks the link is real, current, unused and unexpired,
      // records the decision (and, where the wording allows it, the messaging choice) and
      // updates the child's status in one step.
      const { data: verdict, error } = await admin.rpc("decide_guardian_consent_with_messaging", {
        p_token_hash: hash,
        p_decision: decision,
        p_messaging: messaging,
      });
      if (error) {
        console.error("[guardian-consent] decision failed:", error.message);
        result = "error";
      } else if (verdict === "declined") {
        // Remove the account if it was never used; otherwise it stays locked.
        const removed = request ? await purgeUnusedStudent(admin, request.profile_id) : false;
        result = removed ? "declined-removed" : "declined-locked";
      } else if (verdict === "approved") {
        result = coversMessaging(request?.consent_version) && messaging === "approved" ? "approved-messaging" : "approved";
      } else {
        result = verdict ?? "invalid";
      }
    }
  } catch (err) {
    console.error("[guardian-consent] failed:", err);
    result = "error";
  }

  // redirect() works by throwing, so it stays outside the try/catch above.
  redirect(`/guardian/done?r=${encodeURIComponent(result)}`);
}

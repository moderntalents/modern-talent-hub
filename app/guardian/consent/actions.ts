"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken, purgeUnusedStudent } from "@/lib/consent";

// The guardian's decision. Public (the guardian isn't signed in): the secret in the email
// link is what proves it is them. It is a POST from a button on purpose — opening the
// link alone (which email scanners and link previews do) never approves anything.

export async function decideConsent(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const decision = formData.get("decision") === "approved" ? "approved" : formData.get("decision") === "declined" ? "declined" : null;

  let result: string;
  try {
    if (!token || token.length > 200 || !decision) {
      result = "invalid";
    } else {
      const admin = createAdminClient();
      const hash = hashToken(token);

      // Who is this about? (Needed only to tidy up after a "decline".)
      const { data: request } = await admin
        .from("guardian_consent_requests")
        .select("profile_id")
        .eq("token_hash", hash)
        .maybeSingle();

      // Atomic in the database: checks the link is real, current, unused and unexpired,
      // records the decision and updates the child's status in one step.
      const { data: verdict, error } = await admin.rpc("decide_guardian_consent", {
        p_token_hash: hash,
        p_decision: decision,
      });
      if (error) {
        console.error("[guardian-consent] decision failed:", error.message);
        result = "error";
      } else if (verdict === "declined") {
        // Remove the account if it was never used; otherwise it stays locked.
        const removed = request ? await purgeUnusedStudent(admin, request.profile_id) : false;
        result = removed ? "declined-removed" : "declined-locked";
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

"use server";

import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken } from "@/lib/consent";

// The guardian's answer to a MESSAGING request (0014). Public (the guardian isn't signed in): the
// secret in the email link is what proves it is them. A POST from a button on purpose, so opening the
// link alone (email scanners, link previews) never decides anything.
//
// This only switches private messaging on or off. It never changes the platform approval and never
// deletes the account — whatever the answer.

export async function decideMessagingConsent(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const raw = formData.get("decision");
  const decision = raw === "approved" ? "approved" : raw === "declined" ? "declined" : null;

  let result: string;
  try {
    if (!token || token.length > 200 || !decision) {
      result = "invalid";
    } else {
      // Atomic in the database: checks the link is a current, unused, unexpired messaging request for an
      // approved account and the guardian on record, then records the answer.
      const { data: verdict, error } = await createAdminClient().rpc("decide_guardian_messaging_consent", {
        p_token_hash: hashToken(token),
        p_decision: decision,
      });
      if (error) {
        console.error("[guardian-messaging] decision failed:", error.message);
        result = "error";
      } else if (verdict === "approved" || verdict === "declined") {
        result = `messaging-${verdict}`;
      } else {
        result = verdict ?? "invalid";
      }
    }
  } catch (err) {
    console.error("[guardian-messaging] failed:", err);
    result = "error";
  }

  // redirect() works by throwing, so it stays outside the try/catch above.
  redirect(`/guardian/done?r=${encodeURIComponent(result)}`);
}

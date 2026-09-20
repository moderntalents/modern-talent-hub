import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAgeState, requireSessionForGatePage } from "@/lib/age-gate";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasActiveConsentRequest, maskEmail } from "@/lib/consent";
import { ConsentPendingPanel } from "./ConsentPendingPanel";

export const metadata: Metadata = { title: "Waiting for a parent — Modern Talent Hub", robots: { index: false } };

// Where an under-18 waits until a parent or guardian approves. Outside the student/teacher
// layouts on purpose (they redirect here), and it never shows anything but the waiting state.
export default async function ConsentPendingPage() {
  const { user, profile } = await requireSessionForGatePage();
  if (profile.role === "admin") redirect("/admin");

  const state = await getAgeState(await createClient(), user.id);
  if (state.kind === "needs_age") redirect("/age-check");
  if (state.kind === "ok") redirect(`/${profile.role}`);

  // Only claim "we've emailed …" if an email really went out and can still be used.
  const emailActive = state.kind === "pending" && (await hasActiveConsentRequest(createAdminClient(), user.id));

  return (
    <ConsentPendingPanel
      declined={state.kind === "declined"}
      emailActive={emailActive}
      maskedGuardianEmail={state.kind === "pending" ? maskEmail(state.guardianEmail) : ""}
      childName={profile.full_name}
    />
  );
}

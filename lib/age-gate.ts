import "server-only";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionProfile } from "@/lib/auth";
import { consentComplete, gateRedirect, getAgeState, type AgeState } from "@/lib/account-setup";

// The age gate: nobody uses the student or teacher area until we know their age and, for
// under-18s, a parent or guardian has approved. Enforced in two places that both call
// this file — the page layouts (what people see) and the server actions / API routes
// (what a person could call directly), so hiding a page is never the only protection.

// Whether setup is complete is decided in ONE place, lib/account-setup.ts, which Settings, the
// Messages page and the messaging gate use too, so no two pages can disagree about it.
export type { AgeState };
export { gateRedirect, getAgeState };

/**
 * Called by the student and teacher layouts. Administrators are exempt.
 * Redirects (does not return) if the person isn't cleared yet.
 */
export async function requireAgeCleared(
  supabase: SupabaseClient<Database>,
  user: { id: string },
  role: "student" | "teacher" | "admin",
): Promise<void> {
  if (role === "admin") return;
  const target = gateRedirect(await getAgeState(supabase, user.id));
  if (target) redirect(target);
}

/**
 * For server actions and API routes, which can be called without ever loading a page.
 * True if this person may use the app right now. Administrators always may.
 */
export async function isAgeCleared(userId: string, role?: string): Promise<boolean> {
  if (role === "admin") return true;
  const admin = createAdminClient();
  const { data } = await admin.from("age_records").select("consent_status").eq("profile_id", userId).maybeSingle();
  return consentComplete(data?.consent_status);
}

export const AGE_GATE_MESSAGE =
  "Your account isn't ready to use yet. Please finish the age check (and, if you're under 18, ask your parent or guardian to approve).";

/** Convenience for the /age-check and /consent-pending pages. */
export async function requireSessionForGatePage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  return session;
}

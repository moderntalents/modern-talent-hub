import "server-only";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionProfile } from "@/lib/auth";

// The age gate: nobody uses the student or teacher area until we know their age and, for
// under-18s, a parent or guardian has approved. Enforced in two places that both call
// this file — the page layouts (what people see) and the server actions / API routes
// (what a person could call directly), so hiding a page is never the only protection.

export type AgeState =
  | { kind: "needs_age" } // no date of birth on record yet (new Google user, or an existing account)
  | { kind: "pending"; guardianEmail: string }
  | { kind: "declined" }
  | { kind: "ok" };

export async function getAgeState(supabase: SupabaseClient<Database>, userId: string): Promise<AgeState> {
  // RLS lets a person read only their own record.
  const { data } = await supabase
    .from("age_records")
    .select("consent_status, guardian_email")
    .eq("profile_id", userId)
    .maybeSingle();

  if (!data) return { kind: "needs_age" };
  if (data.consent_status === "pending") return { kind: "pending", guardianEmail: data.guardian_email ?? "" };
  if (data.consent_status === "declined") return { kind: "declined" };
  return { kind: "ok" };
}

/** Where someone who is not cleared should be sent, or null if they may continue. */
export function gateRedirect(state: AgeState): string | null {
  switch (state.kind) {
    case "needs_age":
      return "/age-check";
    case "pending":
    case "declined":
      return "/consent-pending";
    default:
      return null;
  }
}

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
  return data?.consent_status === "not_required" || data?.consent_status === "granted";
}

export const AGE_GATE_MESSAGE =
  "Your account isn't ready to use yet. Please finish the age check (and, if you're under 18, ask your parent or guardian to approve).";

/** Convenience for the /age-check and /consent-pending pages. */
export async function requireSessionForGatePage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  return session;
}

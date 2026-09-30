// The ONE rule for "is this person's account set up?". Pure, with no server-only or Next.js imports,
// so the age gate (lib/age-gate.ts), the messaging gate (lib/messaging-permission.ts), Settings, the
// Messages page and the tests all use exactly the same decision. The database applies the same rule
// in age_cleared() (0011), which messaging also uses.
//
// Account setup means the age check, plus a parent or guardian's approval of the ACCOUNT for anyone
// under 18. There is no separate permission for messaging: an approved account can message.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

export type ConsentStatus = "not_required" | "pending" | "granted" | "declined";

export type AgeState =
  | { kind: "needs_age" } // no date of birth on record yet (new Google user, or an existing account)
  | { kind: "pending"; guardianEmail: string }
  | { kind: "declined" }
  | { kind: "ok" };

/** Platform consent is in place: an adult, or an under-18 whose parent or guardian approved the account. */
export function consentComplete(status: ConsentStatus | string | null | undefined): boolean {
  return status === "not_required" || status === "granted";
}

/** The setup state for a stored age record (null = no record yet). */
export function ageStateFromRecord(
  record: { consent_status: ConsentStatus | string; guardian_email: string | null } | null,
): AgeState {
  if (!record) return { kind: "needs_age" };
  if (consentComplete(record.consent_status)) return { kind: "ok" };
  if (record.consent_status === "pending") return { kind: "pending", guardianEmail: record.guardian_email ?? "" };
  return { kind: "declined" };
}

/** Where to go to finish the missing setup step, or null when setup is complete. */
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
 * This person's account-setup state, read with THEIR session (RLS: own record only). Takes the
 * client as a parameter, so this file stays free of server/Next.js imports and is unit testable.
 */
export async function getAgeState(supabase: SupabaseClient<Database>, userId: string): Promise<AgeState> {
  const { data, error } = await supabase
    .from("age_records")
    .select("consent_status, guardian_email")
    .eq("profile_id", userId)
    .maybeSingle();
  if (error) console.error("[account-setup] could not read the age record:", error.message);
  return ageStateFromRecord(data ?? null);
}

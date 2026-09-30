import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { messagingForAccount, messagingState, type MessagingState } from "@/lib/messaging-permission";
import { getAgeState, gateRedirect, type AgeState } from "@/lib/account-setup";

// The messaging gate, on top of the Stage 2 age gate. The database decides access to conversations
// (messaging_cleared(), 0014); these helpers let pages and server actions refuse early with a clear
// message and show the right screen. Administrators have no messaging at all (0011).

type Admin = ReturnType<typeof createAdminClient>;

/** What the messaging pages should show this person. Teachers are adults, so they are always allowed. */
export async function getMessagingState(userId: string, admin: Admin = createAdminClient()): Promise<MessagingState> {
  const { data, error } = await admin
    .from("age_records")
    .select(
      "consent_status, date_of_birth, guardian_messaging_allowed, guardian_messaging_status, guardian_messaging_version",
    )
    .eq("profile_id", userId)
    .maybeSingle();
  // A failed query is NOT the same as "no age record": treating it that way told fully set-up
  // students that their account setup wasn't finished (for example when the database is missing the
  // 0014 messaging-permission columns). Fail closed, but say what actually happened.
  if (error) {
    console.error("[messaging-gate] could not read messaging permission:", error.message);
    return { kind: "unavailable" };
  }
  return messagingState(data ?? null);
}

export interface AccountStatus {
  /** Account setup (age check + guardian approval of the account) — the same state the layouts gate on. */
  setup: AgeState;
  /** Where to finish the missing setup step, or null when setup is complete. */
  setupHref: string | null;
  /** Messaging, reconciled with `setup` so it can never claim setup is unfinished when it isn't. */
  messaging: MessagingState;
}

/**
 * The one loader Settings, Messages and the lesson/activity pages use to decide what to show about
 * account setup and messaging. Setup comes from getAgeState() — the exact check the student and
 * teacher layouts enforce — and messaging is derived from it (lib/messaging-permission.ts).
 */
export async function getAccountStatus(
  supabase: SupabaseClient<Database>,
  userId: string,
  admin: Admin = createAdminClient(),
): Promise<AccountStatus> {
  const [setup, messaging] = await Promise.all([getAgeState(supabase, userId), getMessagingState(userId, admin)]);
  const reconciled = messagingForAccount(setup, messaging);
  if (reconciled.kind === "unavailable" && messaging.kind === "not_cleared") {
    console.error("[messaging-gate] setup is complete but the messaging record said otherwise; showing unavailable");
  }
  return { setup, setupHref: gateRedirect(setup), messaging: reconciled };
}

export const MESSAGING_UNAVAILABLE_MESSAGE =
  "Messaging can't be checked right now. Please try again in a little while — your account itself is fine.";

/**
 * For server actions: may this person use messaging right now? Asks the database itself, so the
 * answer is exactly the rule that protects the conversations. Fails closed.
 */
export async function isMessagingCleared(userId: string, admin: Admin = createAdminClient()): Promise<boolean> {
  const { data, error } = await admin.rpc("messaging_cleared", { p_profile: userId });
  if (error) {
    console.error("[messaging-gate] check failed:", error.message);
    return false;
  }
  return data === true;
}

export const MESSAGING_PERMISSION_MESSAGE =
  "Messaging needs your parent or guardian's permission first. Open Messages and choose “Ask my parent to allow messaging”.";

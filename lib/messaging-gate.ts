import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { messagingForAccount, type MessagingState } from "@/lib/messaging-permission";
import { getAgeState, gateRedirect, type AgeState } from "@/lib/account-setup";

// What the pages show about messaging. The database decides access to conversations (0011: both
// people must have an approved account, via age_cleared(), plus the student–teacher relationship
// rules); these helpers only pick the right screen. Administrators have no messaging at all (0011).

type Admin = ReturnType<typeof createAdminClient>;

/**
 * May this person use messaging, according to the database's own rule (0011's age_cleared())?
 * Asking the database also proves messaging is installed: if the call fails (for example 0011 isn't
 * applied yet) the answer is "unavailable" — never "your account setup isn't finished".
 */
export async function getMessagingState(userId: string, admin: Admin = createAdminClient()): Promise<MessagingState> {
  const { data, error } = await admin.rpc("age_cleared", { p_profile: userId });
  if (error) {
    console.error("[messaging-gate] could not check messaging:", error.message);
    return { kind: "unavailable" };
  }
  return data === true ? { kind: "allowed" } : { kind: "not_cleared" };
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
 * teacher layouts enforce — and messaging is reconciled with it (lib/messaging-permission.ts).
 */
export async function getAccountStatus(
  supabase: SupabaseClient<Database>,
  userId: string,
  admin: Admin = createAdminClient(),
): Promise<AccountStatus> {
  const [setup, messaging] = await Promise.all([getAgeState(supabase, userId), getMessagingState(userId, admin)]);
  const reconciled = messagingForAccount(setup, messaging);
  if (reconciled.kind === "unavailable" && messaging.kind === "not_cleared") {
    console.error("[messaging-gate] setup is complete but the messaging check said otherwise; showing unavailable");
  }
  return { setup, setupHref: gateRedirect(setup), messaging: reconciled };
}

export const MESSAGING_UNAVAILABLE_MESSAGE =
  "Messaging isn't available right now. Please try again in a little while — your account itself is fine.";

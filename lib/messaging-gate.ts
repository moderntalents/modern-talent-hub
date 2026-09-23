import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { messagingState, type MessagingState } from "@/lib/messaging-permission";

// The messaging gate, on top of the Stage 2 age gate. The database decides access to conversations
// (messaging_cleared(), 0014); these helpers let pages and server actions refuse early with a clear
// message and show the right screen. Administrators have no messaging at all (0011).

type Admin = ReturnType<typeof createAdminClient>;

/** What the messaging pages should show this person. Teachers are adults, so they are always allowed. */
export async function getMessagingState(userId: string, admin: Admin = createAdminClient()): Promise<MessagingState> {
  const { data } = await admin
    .from("age_records")
    .select(
      "consent_status, date_of_birth, guardian_messaging_allowed, guardian_messaging_status, guardian_messaging_version",
    )
    .eq("profile_id", userId)
    .maybeSingle();
  return messagingState(data ?? null);
}

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

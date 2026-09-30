// Who may use private messaging, as the pages show it. Pure, with no server-only imports, so the pages
// and the tests use the same rule.
//
// The rule (0011): messaging is open to every APPROVED account — an adult, or an under-18 whose parent
// or guardian approved the account. There is no separate messaging permission. Who may talk to whom
// (a student and their own teachers) is decided by the database, in 0011's functions, which also
// re-check that both people are approved (age_cleared()) on every call.

import type { AgeState } from "@/lib/account-setup";

export type MessagingState =
  | { kind: "allowed" }
  | { kind: "not_cleared" } // account setup (age check / guardian approval of the account) isn't complete
  // Messaging couldn't be checked (for example, the database refused the query, or the messaging
  // tables aren't there yet). Treated as NOT allowed, but never as "your account setup isn't finished".
  | { kind: "unavailable" };

/**
 * The messaging state a page should show, given the account-setup state from lib/account-setup.ts
 * (the one source of truth Settings uses too). "not_cleared" ("finish setting up your account") is
 * only ever the answer when account setup really is incomplete. If setup is complete but the
 * messaging check still came back "not_cleared" (the two reads disagreed), that is a problem on our
 * side, not the person's: fail closed as "unavailable".
 */
export function messagingForAccount(setup: AgeState, messaging: MessagingState): MessagingState {
  if (setup.kind !== "ok") return { kind: "not_cleared" };
  if (messaging.kind === "not_cleared") return { kind: "unavailable" };
  return messaging;
}

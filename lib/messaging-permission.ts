// Who may use private messaging. Pure functions with no server-only imports, so the pages, the
// server and the tests all use the same rule. The database applies the identical rule in
// messaging_cleared() (supabase/migrations/0014_messaging_guardian_consent.sql) and that is what
// actually protects conversations; this copy decides what to SHOW (for example, whether to offer
// "Ask my parent to allow messaging").
//
// The rule:
//   * platform consent must be in place (adult, or under-18 with guardian approval), and
//   * the person is 18 or over TODAY (Kenya date — worked out on every check, no birthday job), or
//     a guardian allowed messaging on wording that covers it.
// Once someone turns 18, an earlier guardian decline or withdrawal of messaging no longer applies.

import { ADULT_AGE, ageInYears } from "@/lib/age";
import { coversMessaging } from "@/lib/consent-versions";
import { consentComplete, type AgeState } from "@/lib/account-setup";

export type GuardianMessagingStatus = "not_requested" | "granted" | "declined" | "withdrawn";

export interface MessagingRecord {
  consent_status: "not_required" | "pending" | "granted" | "declined";
  date_of_birth: string;
  guardian_messaging_allowed: boolean;
  guardian_messaging_status: GuardianMessagingStatus;
  guardian_messaging_version: string | null;
}

export type MessagingState =
  | { kind: "allowed" }
  | { kind: "not_cleared" } // platform age check / guardian approval isn't complete
  | { kind: "needs_guardian"; status: GuardianMessagingStatus } // under 18, no messaging permission
  // The permission couldn't be checked (for example, the database refused the query). Never produced
  // by messagingState() below — only by the server-side loader (lib/messaging-gate.ts) — so a failed
  // check is never mistaken for "your account setup isn't finished". Treated as NOT allowed.
  | { kind: "unavailable" };

export function messagingState(record: MessagingRecord | null, now: Date = new Date()): MessagingState {
  if (!record) return { kind: "not_cleared" };
  if (!consentComplete(record.consent_status)) return { kind: "not_cleared" };
  if (ageInYears(record.date_of_birth, now) >= ADULT_AGE) return { kind: "allowed" };
  if (record.guardian_messaging_allowed && coversMessaging(record.guardian_messaging_version)) return { kind: "allowed" };
  return { kind: "needs_guardian", status: record.guardian_messaging_status };
}

export function messagingAllowed(record: MessagingRecord | null, now: Date = new Date()): boolean {
  return messagingState(record, now).kind === "allowed";
}

/**
 * The messaging state a page should show, given the account-setup state from lib/account-setup.ts
 * (the one source of truth Settings uses too). "not_cleared" ("finish setting up your account") is
 * only ever the answer when account setup really is incomplete. If setup is complete but the
 * messaging read still came back "not_cleared" (the two reads disagreed, e.g. the permission row
 * couldn't be read), that is a problem on our side, not the student's: fail closed as "unavailable".
 */
export function messagingForAccount(setup: AgeState, messaging: MessagingState): MessagingState {
  if (setup.kind !== "ok") return { kind: "not_cleared" };
  if (messaging.kind === "not_cleared") return { kind: "unavailable" };
  return messaging;
}

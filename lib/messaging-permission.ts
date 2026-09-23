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
  | { kind: "needs_guardian"; status: GuardianMessagingStatus }; // under 18, no messaging permission

export function messagingState(record: MessagingRecord | null, now: Date = new Date()): MessagingState {
  if (!record) return { kind: "not_cleared" };
  if (record.consent_status !== "not_required" && record.consent_status !== "granted") return { kind: "not_cleared" };
  if (ageInYears(record.date_of_birth, now) >= ADULT_AGE) return { kind: "allowed" };
  if (record.guardian_messaging_allowed && coversMessaging(record.guardian_messaging_version)) return { kind: "allowed" };
  return { kind: "needs_guardian", status: record.guardian_messaging_status };
}

export function messagingAllowed(record: MessagingRecord | null, now: Date = new Date()): boolean {
  return messagingState(record, now).kind === "allowed";
}

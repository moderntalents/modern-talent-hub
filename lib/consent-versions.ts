// Guardian consent wording versions. Pure constants and functions with no server-only imports, so
// pages, server code and tests share them. The database keeps the same list in
// guardian_consent_versions (supabase/migrations/0014_messaging_guardian_consent.sql) and refuses
// messaging permission on any version that does not cover messaging.

export type ConsentVersion = "guardian-v1" | "guardian-v2";
export type ConsentPurpose = "platform" | "messaging";

/** Stage 2 wording. Said "there are no private messages between users", so it never covers messaging. */
export const GUARDIAN_V1: ConsentVersion = "guardian-v1";
/** Platform permission plus a separate, optional choice to allow private messaging with teachers. */
export const GUARDIAN_V2: ConsentVersion = "guardian-v2";

/** The wording every NEW request is sent with. */
export const CURRENT_CONSENT_VERSION: ConsentVersion = GUARDIAN_V2;

const COVERS_MESSAGING: Record<ConsentVersion, boolean> = {
  "guardian-v1": false,
  "guardian-v2": true,
};

/** True only for wording that told the guardian about private messaging and let them choose. */
export function coversMessaging(version: string | null | undefined): boolean {
  return !!version && (COVERS_MESSAGING as Record<string, boolean>)[version] === true;
}

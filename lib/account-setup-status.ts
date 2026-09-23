import type { AgeState } from "@/lib/age-gate";

export interface AccountSetupBanner {
  href: string;
  label: string;
}

/**
 * What the Settings page's "Account Setup" banner should say, for a given (already-known) age
 * state and the route gateRedirect() (lib/age-gate.ts, unchanged — the caller computes this,
 * this function never imports or re-derives it) already decided for it. Returns null when
 * nothing is required — the caller passes null exactly when gateRedirect() itself returned
 * null, so this can never fabricate a banner or a link. Deliberately scoped to the REQUIRED
 * age/guardian gate only: messaging permission is optional (a student can use the rest of the
 * app without it), so it never appears here — see the Settings page's separate Messaging
 * section for that status instead.
 *
 * Takes `href` as a parameter (rather than importing gateRedirect itself) so this stays a pure,
 * framework-free module — lib/age-gate.ts pulls in next/navigation, which this file must not,
 * so it can be unit tested without a rendering/Next.js runtime.
 */
export function accountSetupBanner(state: AgeState, href: string | null): AccountSetupBanner | null {
  if (!href) return null;
  const label =
    state.kind === "needs_age"
      ? "Finish your age check to unlock your account."
      : state.kind === "pending"
        ? "Waiting for your parent or guardian to approve your account."
        : "Your parent or guardian didn't approve — you can talk to them and try again.";
  return { href, label };
}

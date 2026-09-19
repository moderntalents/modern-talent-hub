import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVATION_FEE_LIMITS, COACH_ACTIVATION_FEE_KEY, PAYMENTS_ENABLED_KEY } from "@/lib/constants";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Whether the app is charging money at all. Only an explicit `true` in
 * platform_settings turns payments on; a missing row means free mode.
 * A read error throws (rather than guessing) so a database blip can never
 * silently grant — or block — access once payments are live.
 */
export async function arePaymentsEnabled(admin: AdminClient = createAdminClient()): Promise<boolean> {
  const { data, error } = await admin
    .from("platform_settings")
    .select("value")
    .eq("key", PAYMENTS_ENABLED_KEY)
    .maybeSingle();

  if (error) throw new Error(`Could not read the payments setting: ${error.message}`);
  return data?.value === true;
}

/** A stored value is only usable as a fee if it's a whole number within the allowed range. */
export function isValidActivationFee(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= ACTIVATION_FEE_LIMITS.min &&
    value <= ACTIVATION_FEE_LIMITS.max
  );
}

/**
 * Reads the CURRENT coach activation fee (KES) from platform_settings.
 *
 * Read fresh on every call — deliberately not cached — so an admin's change
 * applies to the very next payment. Returns null when the fee has never been
 * set (or holds an invalid value) and callers must refuse to charge; there is
 * intentionally no hardcoded fallback price.
 *
 * Uses the service role because coaches have no RLS access to this table.
 */
export async function getCoachActivationFee(admin: AdminClient = createAdminClient()): Promise<number | null> {
  const { data, error } = await admin
    .from("platform_settings")
    .select("value")
    .eq("key", COACH_ACTIVATION_FEE_KEY)
    .maybeSingle();

  if (error) throw new Error(`Could not read the activation fee: ${error.message}`);
  const value = data?.value;
  return isValidActivationFee(value) ? value : null;
}

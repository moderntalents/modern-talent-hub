import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { PAYMENTS_ENABLED_KEY } from "@/lib/constants";

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

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { arePaymentsEnabled } from "@/lib/settings";

/**
 * Free-mode activation. Activates the coach ONLY while payments are switched
 * off — the check lives here, not in callers, so this can never be used to
 * skip the fee once payments are enabled. Idempotent. Returns true when the
 * coach is activated by this call.
 */
export async function activateCoachForFree(teacherId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    if (await arePaymentsEnabled(admin)) return false;

    const { data, error } = await admin
      .from("teacher_profiles")
      .update({ activated: true, activated_at: new Date().toISOString() })
      .eq("profile_id", teacherId)
      .eq("activated", false)
      .select("profile_id");

    if (error) throw new Error(error.message);
    return (data?.length ?? 0) > 0;
  } catch (err) {
    console.error("[activation] free activation failed:", err);
    return false;
  }
}

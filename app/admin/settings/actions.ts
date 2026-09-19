"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  ACTIVATION_FEE_LIMITS,
  COACH_ACTIVATION_FEE_KEY,
  PAYMENTS_ENABLED_KEY,
  formatKes,
} from "@/lib/constants";

export type SettingsActionState = { ok: boolean; message: string } | null;

export async function setPaymentsEnabled(enabled: boolean): Promise<SettingsActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Sign in required." };

  const { data: caller } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (caller?.role !== "admin") return { ok: false, message: "Admin access required." };

  const { error } = await supabase
    .from("platform_settings")
    .upsert({ key: PAYMENTS_ENABLED_KEY, value: enabled }, { onConflict: "key" });
  if (error) return { ok: false, message: error.message };

  // Student marketplace/subscription pages and the coach dashboard all branch on this.
  revalidatePath("/admin/settings");
  revalidatePath("/student", "layout");
  revalidatePath("/teacher", "layout");
  return {
    ok: true,
    message: enabled ? "Payments are ON." : "Payments are OFF — everything is free.",
  };
}

export async function updateActivationFee(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Sign in required." };

  const { data: caller } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (caller?.role !== "admin") return { ok: false, message: "Admin access required." };

  const raw = String(formData.get("fee") ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return { ok: false, message: "Enter a whole number of shillings, e.g. 1500." };
  }
  const fee = Number(raw);
  if (fee < ACTIVATION_FEE_LIMITS.min || fee > ACTIVATION_FEE_LIMITS.max) {
    return {
      ok: false,
      message: `The fee must be between ${formatKes(ACTIVATION_FEE_LIMITS.min)} and ${formatKes(ACTIVATION_FEE_LIMITS.max)}.`,
    };
  }

  // Runs as the signed-in admin, so RLS (platform_settings_admin_all) is the
  // real gate; the role check above is for a friendly message. The database
  // triggers stamp updated_by and append to platform_settings_history.
  const { error } = await supabase
    .from("platform_settings")
    .upsert({ key: COACH_ACTIVATION_FEE_KEY, value: fee }, { onConflict: "key" });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin/settings");
  return {
    ok: true,
    message: `Activation fee is now ${formatKes(fee)}. Every new activation payment uses this amount.`,
  };
}

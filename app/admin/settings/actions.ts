"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { PAYMENTS_ENABLED_KEY } from "@/lib/constants";

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

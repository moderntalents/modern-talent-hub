"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function setTeacherApproval(profileId: string, approved: boolean) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in required.");

  const { data: caller } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (caller?.role !== "admin") throw new Error("Admin access required.");

  const { error } = await supabase.from("teacher_profiles").update({ approved }).eq("profile_id", profileId);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/teachers");
}

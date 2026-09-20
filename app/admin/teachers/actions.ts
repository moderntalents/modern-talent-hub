"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ApprovalResult = { ok: true } | { ok: false; message: string };

// Returns the failure reason instead of throwing: in production a thrown server
// action error is replaced by a generic "This page couldn't load" screen that
// hides the cause from the admin (and crashes the whole page).
export async function setTeacherApproval(profileId: string, approved: boolean): Promise<ApprovalResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, message: "Sign in required." };

    const { data: caller } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (caller?.role !== "admin") return { ok: false, message: "Admin access required." };

    // .select() returns the updated rows, so "the database silently matched
    // nothing" (e.g. a row-level-security block) is caught instead of looking
    // like success.
    const { data, error } = await supabase
      .from("teacher_profiles")
      .update({ approved })
      .eq("profile_id", profileId)
      .select("profile_id");

    if (error) {
      console.error("[setTeacherApproval] update failed:", error.code, error.message);
      return { ok: false, message: error.message };
    }
    if (!data || data.length === 0) {
      console.error("[setTeacherApproval] update matched 0 rows for", profileId);
      return { ok: false, message: "Nothing was updated — the teacher record wasn't found or you don't have permission." };
    }

    revalidatePath("/admin/teachers");
    return { ok: true };
  } catch (err) {
    console.error("[setTeacherApproval] unexpected error:", err);
    return { ok: false, message: err instanceof Error ? err.message : "Something went wrong." };
  }
}

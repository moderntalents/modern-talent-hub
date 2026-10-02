"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ageGroup, ageInYears } from "@/lib/age";
import { validateProfile, type ProfileInput } from "@/lib/profile-edit";

// "Edit profile" on Settings. The person is taken from the login session, never from the request,
// and every write goes through THEIR OWN Supabase session (not the server's key), so row-level
// security decides what they may write: profiles_update_own, student_profile_owner and
// teacher_profile_update_own_or_admin (0012, whose trigger still blocks wallet/approval changes).
// Only existing rows are updated — nothing here creates a second profile. Failures come back as
// { ok: false, ... } because production hides thrown server-action errors.

export type SaveProfileResult =
  | { ok: true }
  | { ok: false; message: string; errors?: Partial<Record<keyof ProfileInput, string>> };

const SAVE_FAILED = "Your changes couldn't be saved. Please try again.";

export async function saveMyProfile(input: Partial<ProfileInput>): Promise<SaveProfileResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, message: "Please sign in again first." };

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (!profile) return { ok: false, message: "Your profile couldn't be found." };

    // The age group comes from the date of birth on record (RLS: own row only) — never from the form.
    const { data: age } = await supabase.from("age_records").select("date_of_birth").eq("profile_id", user.id).maybeSingle();
    const group = age?.date_of_birth ? ageGroup(ageInYears(age.date_of_birth)) : null;

    const checked = validateProfile(profile.role, group, input);
    if (!checked.ok) return { ok: false, message: "Please fix the highlighted fields.", errors: checked.errors };
    const { changes } = checked;

    const saved = await supabase.from("profiles").update(changes.profiles).eq("id", user.id).select("id");
    if (saved.error || !saved.data?.length) {
      console.error("[profile] update profiles failed:", saved.error?.message ?? "no row updated");
      return { ok: false, message: SAVE_FAILED };
    }

    if (changes.student) {
      // The sign-up trigger creates this row; upsert on the primary key only fills it in for an
      // older account that lacks one, and can never create a duplicate.
      const res = await supabase
        .from("student_profiles")
        .upsert({ profile_id: user.id, ...changes.student }, { onConflict: "profile_id" })
        .select("profile_id");
      if (res.error || !res.data?.length) {
        console.error("[profile] update student_profiles failed:", res.error?.message ?? "no row updated");
        return { ok: false, message: SAVE_FAILED };
      }
    }

    if (changes.teacher) {
      const res = await supabase.from("teacher_profiles").update(changes.teacher).eq("profile_id", user.id).select("profile_id");
      if (res.error || !res.data?.length) {
        console.error("[profile] update teacher_profiles failed:", res.error?.message ?? "no row updated");
        return { ok: false, message: SAVE_FAILED };
      }
    }

    // The name appears in the dashboard header too.
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    console.error("[profile] save failed:", err);
    return { ok: false, message: SAVE_FAILED };
  }
}

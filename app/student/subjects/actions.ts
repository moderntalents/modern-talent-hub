"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { GRADE_OPTIONS, isGradeCode } from "@/lib/education";

export type GradeActionState = { ok: boolean; message: string } | null;

/**
 * A student picks their grade (PP1 … Grade 12). Saved as the same free-text `grade` used by sign-up and
 * Account settings ("Grade 7"); the database works out grade_code -> level from it (migration 0024).
 * Students can only change their own row (student_profile_owner policy).
 */
export async function setMyGrade(code: string): Promise<GradeActionState> {
  if (!isGradeCode(code)) return { ok: false, message: "Choose your grade." };
  const label = GRADE_OPTIONS.find((g) => g.code === code)!.label;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Sign in required." };

  const { data, error } = await supabase
    .from("student_profiles")
    .update({ grade: label })
    .eq("profile_id", user.id)
    .select("profile_id");
  if (error) return { ok: false, message: "We couldn't save your grade. Please try again." };
  if (!data || data.length === 0) return { ok: false, message: "Only student accounts have a grade." };

  revalidatePath("/student/subjects");
  revalidatePath("/account");
  return { ok: true, message: `Saved: ${label}.` };
}

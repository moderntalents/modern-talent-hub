"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/messages/rules";
import { parseSubjectInput, subjectDbErrorMessage, type SubjectErrors } from "@/lib/subjects-admin";

export type SubjectActionState = { ok: boolean; message: string; errors?: SubjectErrors } | null;

/** Admin check, the same way Platform Settings does it. The database (is_admin() policies) checks again. */
async function adminClient() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, error: "Sign in required." };
  const { data: caller } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (caller?.role !== "admin") return { supabase, error: "Admin access required." };
  return { supabase, error: null };
}

function refresh() {
  revalidatePath("/admin/subjects");
  revalidatePath("/student/subjects", "layout");
  revalidatePath("/teacher/lessons/new");
}

const fields = (formData: FormData) => ({
  name: formData.get("name"),
  level: formData.get("level"),
  pathway: formData.get("pathway"),
  description: formData.get("description"),
  color: formData.get("color"),
  order: formData.get("order"),
});

export async function addSubject(_prev: SubjectActionState, formData: FormData): Promise<SubjectActionState> {
  const { supabase, error } = await adminClient();
  if (error) return { ok: false, message: error };

  const parsed = parseSubjectInput(fields(formData));
  if (!parsed.ok) return { ok: false, message: "Please fix the highlighted fields.", errors: parsed.errors };

  const { error: dbError } = await supabase.from("subjects").insert({ ...parsed.value, active: true });
  if (dbError) return { ok: false, message: subjectDbErrorMessage(dbError) };

  refresh();
  return { ok: true, message: `Added ${parsed.value.name}.` };
}

export async function updateSubject(_prev: SubjectActionState, formData: FormData): Promise<SubjectActionState> {
  const { supabase, error } = await adminClient();
  if (error) return { ok: false, message: error };

  const id = formData.get("id");
  if (!isUuid(id)) return { ok: false, message: "Subject not found." };
  const parsed = parseSubjectInput(fields(formData));
  if (!parsed.ok) return { ok: false, message: "Please fix the highlighted fields.", errors: parsed.errors };

  const { data, error: dbError } = await supabase.from("subjects").update(parsed.value).eq("id", id).select("id");
  if (dbError) return { ok: false, message: subjectDbErrorMessage(dbError) };
  if (!data || data.length === 0) return { ok: false, message: "Subject not found." };

  refresh();
  return { ok: true, message: `Saved ${parsed.value.name}.` };
}

/** Hide (active = false) or show a subject. Hidden subjects keep all their lessons. */
export async function setSubjectActive(id: string, active: boolean): Promise<SubjectActionState> {
  const { supabase, error } = await adminClient();
  if (error) return { ok: false, message: error };
  if (!isUuid(id)) return { ok: false, message: "Subject not found." };

  const { data, error: dbError } = await supabase.from("subjects").update({ active }).eq("id", id).select("id");
  if (dbError) return { ok: false, message: subjectDbErrorMessage(dbError) };
  if (!data || data.length === 0) return { ok: false, message: "Subject not found." };

  refresh();
  return { ok: true, message: active ? "Subject is visible." : "Subject is hidden." };
}

/** Delete — only possible while a subject has no lessons (the database refuses otherwise). */
export async function deleteSubject(id: string): Promise<SubjectActionState> {
  const { supabase, error } = await adminClient();
  if (error) return { ok: false, message: error };
  if (!isUuid(id)) return { ok: false, message: "Subject not found." };

  const { count } = await supabase.from("lessons").select("id", { count: "exact", head: true }).eq("subject_id", id);
  if ((count ?? 0) > 0) return { ok: false, message: "This subject has lessons, so it can't be deleted. Hide it instead." };

  const { data, error: dbError } = await supabase.from("subjects").delete().eq("id", id).select("id");
  if (dbError) return { ok: false, message: subjectDbErrorMessage(dbError) };
  if (!data || data.length === 0) return { ok: false, message: "Subject not found." };

  refresh();
  return { ok: true, message: "Subject deleted." };
}

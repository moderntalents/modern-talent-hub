"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

async function requireOwner(lessonId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in required.");

  const { data: lesson } = await supabase.from("lessons").select("teacher_id").eq("id", lessonId).single();
  if (!lesson || lesson.teacher_id !== user.id) throw new Error("Not found.");

  return { supabase, userId: user.id };
}

export async function attachMaterial(params: {
  lessonId: string;
  storagePath: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}) {
  const { supabase } = await requireOwner(params.lessonId);
  const { error } = await supabase.from("lesson_materials").insert({
    lesson_id: params.lessonId,
    file_name: params.fileName,
    storage_path: params.storagePath,
    file_type: params.fileType,
    file_size: params.fileSize,
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/teacher/lessons/${params.lessonId}`);
}

export async function removeMaterial(lessonId: string, materialId: string) {
  const { supabase } = await requireOwner(lessonId);
  const { data: material } = await supabase
    .from("lesson_materials")
    .select("storage_path")
    .eq("id", materialId)
    .single();
  if (material) {
    await supabase.storage.from("lesson-materials").remove([material.storage_path]);
  }
  await supabase.from("lesson_materials").delete().eq("id", materialId);
  revalidatePath(`/teacher/lessons/${lessonId}`);
}

export async function setLessonStatus(lessonId: string, status: "draft" | "published") {
  const { supabase } = await requireOwner(lessonId);
  const { error } = await supabase.from("lessons").update({ status }).eq("id", lessonId);
  if (error) throw new Error(error.message);
  revalidatePath(`/teacher/lessons/${lessonId}`);
  revalidatePath("/teacher/lessons");
}

export async function createAssignment(params: {
  lessonId: string;
  title: string;
  instructions: string;
  dueDate: string;
}) {
  const { supabase } = await requireOwner(params.lessonId);
  if (!params.title.trim()) throw new Error("Enter an assignment title.");

  const { error } = await supabase.from("assignments").insert({
    lesson_id: params.lessonId,
    title: params.title.trim(),
    instructions: params.instructions.trim() || null,
    due_date: params.dueDate || null,
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/teacher/lessons/${params.lessonId}`);
}

export async function gradeSubmission(params: {
  lessonId: string;
  submissionId: string;
  grade: number;
  feedback: string;
}) {
  const { supabase } = await requireOwner(params.lessonId);
  const { error } = await supabase
    .from("assignment_submissions")
    .update({ grade: params.grade, feedback: params.feedback || null, graded_at: new Date().toISOString() })
    .eq("id", params.submissionId);
  if (error) throw new Error(error.message);
  revalidatePath(`/teacher/lessons/${params.lessonId}`);
}

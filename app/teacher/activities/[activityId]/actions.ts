"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

async function requireOwner(activityId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in required.");

  const { data: activity } = await supabase
    .from("activities")
    .select("teacher_id")
    .eq("id", activityId)
    .single();
  if (!activity || activity.teacher_id !== user.id) throw new Error("Not found.");

  return { supabase, userId: user.id };
}

export async function attachActivityMaterial(params: {
  activityId: string;
  storagePath: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}) {
  const { supabase } = await requireOwner(params.activityId);
  const { error } = await supabase.from("activity_materials").insert({
    activity_id: params.activityId,
    file_name: params.fileName,
    storage_path: params.storagePath,
    file_type: params.fileType,
    file_size: params.fileSize,
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/teacher/activities/${params.activityId}`);
}

export async function removeActivityMaterial(activityId: string, materialId: string) {
  const { supabase } = await requireOwner(activityId);
  const { data: material } = await supabase
    .from("activity_materials")
    .select("storage_path")
    .eq("id", materialId)
    .single();
  if (material) {
    await supabase.storage.from("activity-materials").remove([material.storage_path]);
  }
  await supabase.from("activity_materials").delete().eq("id", materialId);
  revalidatePath(`/teacher/activities/${activityId}`);
}

export async function setActivityStatus(activityId: string, status: "draft" | "published") {
  const { supabase } = await requireOwner(activityId);
  const { error } = await supabase.from("activities").update({ status }).eq("id", activityId);
  if (error) throw new Error(error.message);
  revalidatePath(`/teacher/activities/${activityId}`);
  revalidatePath("/teacher/activities");
}

"use server";

import { createClient } from "@/lib/supabase/server";
import { createLiveSession } from "@/lib/live/sessions";
import { parseSchedule } from "@/lib/live/status";

export interface FormState {
  error?: string;
  lessonId?: string;
}

// Creates the draft lesson and returns its id. The form then uploads any
// selected files straight from the browser into storage (under this lesson's
// folder, which is what the storage policy requires) and attaches them, then
// opens the lesson page. The page redirect happens in the form, not here,
// because the files can only be uploaded once the lesson id exists.
//
// lessonType "live" also schedules a live class for the lesson (date, time and
// duration); "recorded" (the default) behaves exactly as before.
export async function createLesson(formData: FormData): Promise<FormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in required." };

  const { data: teacherProfile } = await supabase
    .from("teacher_profiles")
    .select("approved")
    .eq("profile_id", user.id)
    .single();
  if (!teacherProfile?.approved) {
    return { error: "Your teacher account must be approved before publishing lessons." };
  }

  const subjectId = formData.get("subjectId") as string;
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const isLive = formData.get("lessonType") === "live";
  const videoUrl = isLive ? "" : (formData.get("videoUrl") as string)?.trim();

  if (!subjectId) return { error: "Choose a subject." };
  if (!title) return { error: "Enter a lesson title." };
  if (videoUrl && !/^https?:\/\//i.test(videoUrl)) {
    return { error: "The video link must start with http:// or https://" };
  }

  // Validate the schedule BEFORE creating anything.
  let schedule: { scheduledAt: string; durationMinutes: number } | null = null;
  if (isLive) {
    const parsed = parseSchedule(formData);
    if ("error" in parsed) return { error: parsed.error };
    schedule = parsed;
  }

  const { data: lesson, error } = await supabase
    .from("lessons")
    .insert({
      subject_id: subjectId,
      teacher_id: user.id,
      title,
      description: description || null,
      video_url: videoUrl || null,
      status: "draft",
    })
    .select()
    .single();

  if (error) return { error: error.message };

  if (schedule) {
    const created = await createLiveSession({
      kind: "lesson",
      parentId: lesson.id,
      teacherId: user.id,
      scheduledAt: schedule.scheduledAt,
      durationMinutes: schedule.durationMinutes,
    });
    if (created.error) {
      // Don't leave a live lesson with no live session behind.
      await supabase.from("lessons").delete().eq("id", lesson.id);
      return { error: `Could not schedule the live class: ${created.error}` };
    }
  }

  return { lessonId: lesson.id };
}

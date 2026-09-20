"use server";

import { createClient } from "@/lib/supabase/server";

export interface FormState {
  error?: string;
  lessonId?: string;
}

// Creates the draft lesson and returns its id. The form then uploads any
// selected files straight from the browser into storage (under this lesson's
// folder, which is what the storage policy requires) and attaches them, then
// opens the lesson page. The page redirect happens in the form, not here,
// because the files can only be uploaded once the lesson id exists.
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
  const videoUrl = (formData.get("videoUrl") as string)?.trim();

  if (!subjectId) return { error: "Choose a subject." };
  if (!title) return { error: "Enter a lesson title." };
  if (videoUrl && !/^https?:\/\//i.test(videoUrl)) {
    return { error: "The video link must start with http:// or https://" };
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

  return { lessonId: lesson.id };
}

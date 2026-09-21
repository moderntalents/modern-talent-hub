"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { AGE_GATE_MESSAGE, isAgeCleared } from "@/lib/age-gate";

export async function submitAssignment(params: {
  assignmentId: string;
  lessonId: string;
  storagePath: string;
  fileName: string;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in required.");
  if (!(await isAgeCleared(user.id))) throw new Error(AGE_GATE_MESSAGE);

  const { error } = await supabase.from("assignment_submissions").upsert(
    {
      assignment_id: params.assignmentId,
      student_id: user.id,
      storage_path: params.storagePath,
      file_name: params.fileName,
      submitted_at: new Date().toISOString(),
      grade: null,
      graded_at: null,
    },
    { onConflict: "assignment_id,student_id" },
  );

  if (error) throw new Error(error.message);

  revalidatePath(`/student/lessons/${params.lessonId}`);
}

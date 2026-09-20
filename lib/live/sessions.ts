import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Attaches a live session to a lesson or an activity that was JUST created by
// its (already approval-checked) teacher. Written with the service role because
// browsers have no write access to live_sessions (see migration 0008).
export async function createLiveSession(params: {
  kind: "lesson" | "activity";
  parentId: string;
  teacherId: string;
  scheduledAt: string;
  durationMinutes: number;
}): Promise<{ error?: string }> {
  const admin = createAdminClient();
  const { error } = await admin.from("live_sessions").insert({
    kind: params.kind,
    lesson_id: params.kind === "lesson" ? params.parentId : null,
    activity_id: params.kind === "activity" ? params.parentId : null,
    teacher_id: params.teacherId,
    scheduled_at: params.scheduledAt,
    duration_minutes: params.durationMinutes,
  });
  return error ? { error: error.message } : {};
}

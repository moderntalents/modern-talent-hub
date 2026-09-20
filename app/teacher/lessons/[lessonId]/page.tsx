import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { getSignedUrl } from "@/lib/storage";
import { Badge } from "@/components/ui/Card";
import { TeacherLivePanel } from "@/components/live/TeacherLivePanel";
import { effectiveLiveStatus, formatSchedule } from "@/lib/live/status";
import { getParticipantRows } from "@/lib/live/queries";
import { MaterialsManager } from "./MaterialsManager";
import { PublishToggle } from "./PublishToggle";
import { CreateAssignmentForm, SubmissionsList, type SubmissionRow } from "./AssignmentPanel";

export default async function TeacherLessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  const session = await getSessionProfile();
  const supabase = await createClient();

  const { data: lesson } = await supabase
    .from("lessons")
    .select("*, subjects(name)")
    .eq("id", lessonId)
    .eq("teacher_id", session!.user.id)
    .single();

  if (!lesson) notFound();

  // A lesson is "live" when it has a live session (created from the New lesson form).
  const { data: live } = await supabase.from("live_sessions").select("*").eq("lesson_id", lessonId).maybeSingle();
  const participants = live ? await getParticipantRows(live.id) : [];

  const [{ data: materials }, { data: assignment }] = await Promise.all([
    supabase.from("lesson_materials").select("*").eq("lesson_id", lessonId),
    supabase.from("assignments").select("*").eq("lesson_id", lessonId).maybeSingle(),
  ]);

  let submissions: SubmissionRow[] = [];
  if (assignment) {
    const { data: rows } = await supabase
      .from("assignment_submissions")
      .select("*, profiles(full_name)")
      .eq("assignment_id", assignment.id);

    submissions = await Promise.all(
      (rows ?? []).map(async (r) => ({
        id: r.id,
        studentName: (r as unknown as { profiles: { full_name: string } | null }).profiles?.full_name ?? "Student",
        fileName: r.file_name,
        url: await getSignedUrl("assignment-submissions", r.storage_path),
        grade: r.grade,
        feedback: r.feedback,
      })),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {(lesson as unknown as { subjects: { name: string } | null }).subjects?.name}
          </p>
          <h1 className="font-head text-xl font-extrabold">{lesson.title}</h1>
          <Badge tone={lesson.status === "published" ? "success" : "warning"}>{lesson.status}</Badge>
        </div>
        <PublishToggle lessonId={lesson.id} status={lesson.status} />
      </div>

      {live && (
        <TeacherLivePanel
          sessionId={live.id}
          status={effectiveLiveStatus(live)}
          scheduledLabel={formatSchedule(live.scheduled_at)}
          durationMinutes={live.duration_minutes}
          participants={participants}
          noun="lesson"
        />
      )}

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">Materials</h2>
        <MaterialsManager
          lessonId={lesson.id}
          materials={(materials ?? []).map((m) => ({ id: m.id, file_name: m.file_name, file_size: m.file_size }))}
        />
      </div>

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">Assignment</h2>
        {assignment ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold">{assignment.title}</p>
            <SubmissionsList lessonId={lesson.id} submissions={submissions} />
          </div>
        ) : (
          <CreateAssignmentForm lessonId={lesson.id} />
        )}
      </div>
    </div>
  );
}

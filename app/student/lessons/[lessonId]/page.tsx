import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { getSignedUrl } from "@/lib/storage";
import { humanFileSize } from "@/lib/format";
import { getVideoSource } from "@/lib/video";
import { StudentLiveCard } from "@/components/live/StudentLiveCard";
import { effectiveLiveStatus, formatSchedule } from "@/lib/live/status";
import { isVideoFile } from "@/lib/uploads";
import { Card } from "@/components/ui/Card";
import { StartConversationButton } from "@/components/messages/StartConversationButton";
import { MessagingLockedNote } from "@/components/messages/MessagingLockedNote";
import { getMessagingState } from "@/lib/messaging-gate";
import { AssignmentSubmitForm } from "./AssignmentSubmitForm";

export default async function LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  const session = await getSessionProfile();
  const supabase = await createClient();
  const messagingState = await getMessagingState(session!.user.id);
  const canMessage = messagingState.kind === "allowed";

  const [{ data: lesson }, { data: materials }, { data: assignment }] = await Promise.all([
    supabase.from("lessons").select("*, subjects(name)").eq("id", lessonId).single(),
    supabase.from("lesson_materials").select("*").eq("lesson_id", lessonId),
    supabase.from("assignments").select("*").eq("lesson_id", lessonId).maybeSingle(),
  ]);

  if (!lesson) notFound();

  let submission = null;
  if (assignment) {
    const { data } = await supabase
      .from("assignment_submissions")
      .select("*")
      .eq("assignment_id", assignment.id)
      .eq("student_id", session!.user.id)
      .maybeSingle();
    submission = data;
  }

  const materialLinks = await Promise.all(
    (materials ?? []).map(async (m) => ({
      ...m,
      url: await getSignedUrl("lesson-materials", m.storage_path),
    })),
  );

  // A pasted YouTube/Vimeo link becomes an embedded player; a direct file link
  // plays in a <video>. Uploaded video files play inline; everything else is a
  // download.
  const lessonVideo = getVideoSource(lesson.video_url);

  // Live class attached to this lesson, if the teacher scheduled one. A
  // tolerant query: if it fails the lesson simply shows as a normal lesson.
  const { data: live } = await supabase.from("live_sessions").select("*").eq("lesson_id", lessonId).maybeSingle();
  const videoMaterials = materialLinks.filter((m) => isVideoFile(m.file_type, m.file_name));
  const otherMaterials = materialLinks.filter((m) => !isVideoFile(m.file_type, m.file_name));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {(lesson as unknown as { subjects: { name: string } | null }).subjects?.name}
        </p>
        <h1 className="font-head text-xl font-extrabold">{lesson.title}</h1>
        {lesson.description && <p className="mt-1 text-sm text-ink-soft">{lesson.description}</p>}
      </div>

      {lesson.teacher_id && (
        <Card className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Questions or homework?</p>
            <p className="text-xs text-ink-faint">Message the teacher and attach your work as a PDF.</p>
          </div>
          {canMessage ? (
            <StartConversationButton
              target={{ kind: "lesson", lessonId: lesson.id }}
              label="Message teacher"
              basePath="/student/messages"
              variant="outline"
            />
          ) : (
            <MessagingLockedNote state={messagingState} />
          )}
        </Card>
      )}

      {live && (
        <StudentLiveCard
          sessionId={live.id}
          status={effectiveLiveStatus(live)}
          scheduledLabel={formatSchedule(live.scheduled_at)}
          durationMinutes={live.duration_minutes}
          noun="lesson"
        />
      )}

      {lessonVideo && (
        <div className="overflow-hidden rounded-[var(--radius-brand)] border border-line bg-black">
          {lessonVideo.kind === "embed" ? (
            <iframe
              src={lessonVideo.src}
              title={lesson.title}
              className="aspect-video w-full"
              allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          ) : (
            <video src={lessonVideo.src} controls className="aspect-video w-full" />
          )}
        </div>
      )}

      {videoMaterials.map(
        (m) =>
          m.url && (
            <div key={m.id} className="flex flex-col gap-1.5">
              <p className="text-sm font-semibold">{m.file_name}</p>
              <div className="overflow-hidden rounded-[var(--radius-brand)] border border-line bg-black">
                <video src={m.url} controls preload="metadata" className="aspect-video w-full" />
              </div>
            </div>
          ),
      )}

      {otherMaterials.length > 0 && (
        <div>
          <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
            Materials
          </h2>
          <div className="flex flex-col gap-2">
            {otherMaterials.map((m) => (
              <Card key={m.id} className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{m.file_name}</p>
                  <p className="text-xs text-ink-faint">{humanFileSize(m.file_size)}</p>
                </div>
                {m.url ? (
                  <a href={m.url} download className="text-sm font-semibold text-brand-cyan-deep">
                    Download
                  </a>
                ) : (
                  <span className="text-xs text-ink-faint">Unavailable</span>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {assignment && (
        <div>
          <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
            Assignment: {assignment.title}
          </h2>
          {assignment.instructions && (
            <p className="mb-2 text-sm text-ink-soft">{assignment.instructions}</p>
          )}
          <AssignmentSubmitForm
            assignmentId={assignment.id}
            lessonId={lesson.id}
            studentId={session!.user.id}
            existingFileName={submission?.file_name ?? null}
            grade={submission?.grade ?? null}
            feedback={submission?.feedback ?? null}
          />
        </div>
      )}
    </div>
  );
}

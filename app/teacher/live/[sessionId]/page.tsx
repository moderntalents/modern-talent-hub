import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { effectiveLiveStatus, formatSchedule } from "@/lib/live/status";
import { getParticipantRows } from "@/lib/live/queries";
import { LiveRoom } from "@/components/live/LiveRoom";
import { TeacherLivePanel } from "@/components/live/TeacherLivePanel";
import { LiveBadge } from "@/components/live/LiveBadge";
import { EmptyState } from "@/components/ui/EmptyState";

// The teacher's (host's) live room. The /teacher layout already keeps
// unapproved teachers out; the query below only returns THEIR OWN session.
export default async function TeacherLiveRoomPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const session = await getSessionProfile();
  const supabase = await createClient();

  const { data: live } = await supabase
    .from("live_sessions")
    .select("*, lessons(title), activities(title)")
    .eq("id", sessionId)
    .eq("teacher_id", session!.user.id)
    .maybeSingle();
  if (!live) notFound();

  const parents = live as unknown as { lessons: { title: string } | null; activities: { title: string } | null };
  const title = parents.lessons?.title ?? parents.activities?.title ?? "Live class";
  const noun = live.kind === "lesson" ? "lesson" : "activity";
  const backHref = live.kind === "lesson" ? `/teacher/lessons/${live.lesson_id}` : `/teacher/activities/${live.activity_id}`;
  const status = effectiveLiveStatus(live);
  const participants = await getParticipantRows(live.id);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={backHref} className="text-sm font-semibold text-brand-cyan-deep">
          ← Back to {noun}
        </Link>
        <div className="mt-1 flex items-center justify-between gap-3">
          <h1 className="font-head text-xl font-extrabold">{title}</h1>
          <LiveBadge status={status} />
        </div>
      </div>

      {status === "live" ? (
        <LiveRoom sessionId={live.id} />
      ) : (
        <EmptyState
          title={status === "ended" ? `This live ${noun} has ended` : `This live ${noun} hasn't started`}
          description={status === "ended" ? undefined : "Go back and press Start to open the room."}
        />
      )}

      <TeacherLivePanel
        sessionId={live.id}
        status={status}
        scheduledLabel={formatSchedule(live.scheduled_at)}
        durationMinutes={live.duration_minutes}
        participants={participants}
        noun={noun}
        hideRoomLink
      />
    </div>
  );
}

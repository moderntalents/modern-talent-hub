import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { effectiveLiveStatus } from "@/lib/live/status";
import { LiveRoom } from "@/components/live/LiveRoom";
import { LiveBadge } from "@/components/live/LiveBadge";
import { AutoRefresh } from "@/components/live/AutoRefresh";
import { EmptyState } from "@/components/ui/EmptyState";

// The student's view of a live class. Row-level security only returns sessions
// whose lesson/activity is published; whether THIS student may enter (e.g. is
// enrolled in a live activity) is checked again on the server when they join.
export default async function StudentLiveRoomPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const supabase = await createClient();

  const { data: live } = await supabase
    .from("live_sessions")
    .select("*, lessons(title), activities(title)")
    .eq("id", sessionId)
    .maybeSingle();
  if (!live) notFound();

  const parents = live as unknown as { lessons: { title: string } | null; activities: { title: string } | null };
  const title = parents.lessons?.title ?? parents.activities?.title ?? "Live class";
  const noun = live.kind === "lesson" ? "lesson" : "activity";
  const backHref = live.kind === "lesson" ? `/student/lessons/${live.lesson_id}` : `/student/marketplace/${live.activity_id}`;
  const status = effectiveLiveStatus(live);

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
        <>
          <AutoRefresh seconds={15} enabled={status === "upcoming"} />
          <EmptyState
            title={status === "ended" ? `This live ${noun} has ended` : `This live ${noun} hasn't started yet`}
            description={status === "ended" ? undefined : "Stay on this page — it will open by itself when the teacher starts."}
          />
        </>
      )}
    </div>
  );
}

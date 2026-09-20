import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveBadge } from "@/components/live/LiveBadge";
import { AutoRefresh } from "@/components/live/AutoRefresh";
import { effectiveLiveStatus, formatSchedule } from "@/lib/live/status";
import { AdminLiveActions } from "./AdminLiveActions";

// Every live lesson/activity on the platform, newest first, with controls to
// end or remove one. (The /admin layout already restricts this to admins.)
export default async function AdminLivePage() {
  const supabase = await createClient();
  const { data: sessions } = await supabase
    .from("live_sessions")
    .select("*, lessons(title), activities(title), profiles(full_name)")
    .order("scheduled_at", { ascending: false })
    .limit(100);

  const rows = (sessions ?? []).map((s) => {
    const embedded = s as unknown as {
      lessons: { title: string } | null;
      activities: { title: string } | null;
      profiles: { full_name: string } | null;
    };
    return {
      session: s,
      title: embedded.lessons?.title ?? embedded.activities?.title ?? "(deleted)",
      teacher: embedded.profiles?.full_name ?? "Teacher",
      status: effectiveLiveStatus(s),
    };
  });

  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh seconds={15} enabled={rows.some((r) => r.status === "live")} />
      <h1 className="font-head text-xl font-extrabold">Live Classes</h1>

      {rows.length > 0 ? (
        <div className="flex flex-col gap-2">
          {rows.map(({ session, title, teacher, status }) => (
            <Card key={session.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold">{title}</p>
                <p className="text-xs text-ink-faint">
                  {session.kind === "lesson" ? "Lesson" : "Activity"} · {teacher} · {formatSchedule(session.scheduled_at)} ·{" "}
                  {session.duration_minutes} min
                </p>
                <div className="mt-1">
                  <LiveBadge status={status} />
                </div>
              </div>
              <AdminLiveActions sessionId={session.id} isLive={status === "live"} />
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState title="No live classes yet" description="Live lessons and activities created by teachers appear here." />
      )}
    </div>
  );
}

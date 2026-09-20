import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatKes, BILLING_LABELS } from "@/lib/constants";
import { Card, Badge } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveBadge } from "@/components/live/LiveBadge";
import { getLiveSummaries } from "@/lib/live/queries";
import { effectiveLiveStatus, formatSchedule } from "@/lib/live/status";

export default async function TeacherActivitiesPage() {
  const session = await getSessionProfile();
  const supabase = await createClient();
  const { data: activities } = await supabase
    .from("activities")
    .select("*")
    .eq("teacher_id", session!.user.id)
    .order("created_at", { ascending: false });

  const liveByActivity = await getLiveSummaries("activity", (activities ?? []).map((a) => a.id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="font-head text-xl font-extrabold">My Activities</h1>
        <LinkButton href="/teacher/activities/new">+ New activity</LinkButton>
      </div>

      {activities && activities.length > 0 ? (
        <div className="flex flex-col gap-2">
          {activities.map((a) => {
            const live = liveByActivity.get(a.id);
            return (
              <Link key={a.id} href={`/teacher/activities/${a.id}`}>
                <Card className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{a.title}</p>
                    <p className="text-xs text-ink-faint">
                      {a.price > 0 ? formatKes(a.price) : "Free"}
                      {BILLING_LABELS[a.billing]}
                      {live ? ` · Live · ${formatSchedule(live.scheduled_at)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {live && <LiveBadge status={effectiveLiveStatus(live)} />}
                    <Badge tone={a.status === "published" ? "success" : "warning"}>{a.status}</Badge>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No activities yet" description="Offer a sport, martial art, performing art, music or creative/tech activity for students to subscribe to." />
      )}
    </div>
  );
}

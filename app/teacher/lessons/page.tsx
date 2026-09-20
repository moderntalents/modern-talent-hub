import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card, Badge } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveBadge } from "@/components/live/LiveBadge";
import { getLiveSummaries } from "@/lib/live/queries";
import { effectiveLiveStatus, formatSchedule } from "@/lib/live/status";

export default async function TeacherLessonsPage() {
  const session = await getSessionProfile();
  const supabase = await createClient();
  const { data: lessons } = await supabase
    .from("lessons")
    .select("*, subjects(name)")
    .eq("teacher_id", session!.user.id)
    .order("created_at", { ascending: false });

  const liveByLesson = await getLiveSummaries("lesson", (lessons ?? []).map((l) => l.id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="font-head text-xl font-extrabold">My Lessons</h1>
        <LinkButton href="/teacher/lessons/new">+ New lesson</LinkButton>
      </div>

      {lessons && lessons.length > 0 ? (
        <div className="flex flex-col gap-2">
          {lessons.map((lesson) => {
            const live = liveByLesson.get(lesson.id);
            return (
              <Link key={lesson.id} href={`/teacher/lessons/${lesson.id}`}>
                <Card className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{lesson.title}</p>
                    <p className="text-xs text-ink-faint">
                      {(lesson as unknown as { subjects: { name: string } | null }).subjects?.name}
                      {live ? ` · Live · ${formatSchedule(live.scheduled_at)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {live && <LiveBadge status={effectiveLiveStatus(live)} />}
                    <Badge tone={lesson.status === "published" ? "success" : "warning"}>{lesson.status}</Badge>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No lessons yet" description="Create your first lesson to get started." />
      )}
    </div>
  );
}

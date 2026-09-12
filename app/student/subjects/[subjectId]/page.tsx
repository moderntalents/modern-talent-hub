import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, Badge } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export default async function SubjectDetailPage({
  params,
}: {
  params: Promise<{ subjectId: string }>;
}) {
  const { subjectId } = await params;
  const supabase = await createClient();

  const [{ data: subject }, { data: lessons }] = await Promise.all([
    supabase.from("subjects").select("*").eq("id", subjectId).single(),
    supabase
      .from("lessons")
      .select("*")
      .eq("subject_id", subjectId)
      .eq("status", "published")
      .order("order_index"),
  ]);

  if (!subject) notFound();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-head text-xl font-extrabold">{subject.name}</h1>
        <p className="text-sm text-ink-soft">{lessons?.length ?? 0} lessons available</p>
      </div>

      {lessons && lessons.length > 0 ? (
        <div className="flex flex-col gap-2">
          {lessons.map((lesson) => (
            <Link key={lesson.id} href={`/student/lessons/${lesson.id}`}>
              <Card className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">{lesson.title}</p>
                  {lesson.description && (
                    <p className="line-clamp-1 text-xs text-ink-faint">{lesson.description}</p>
                  )}
                </div>
                {lesson.video_url && <Badge tone="info">Video</Badge>}
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No lessons published yet"
          description="Check back soon — teachers add new lessons regularly."
        />
      )}
    </div>
  );
}

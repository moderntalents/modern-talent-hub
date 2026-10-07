import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { normalizeSearch } from "@/lib/directory/rules";
import { CoachBrowser } from "@/components/directory/CoachBrowser";

export const dynamic = "force-dynamic";

export default async function StudentHome({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const sp = await searchParams;
  const query = normalizeSearch(Array.isArray(sp.q) ? sp.q[0] : sp.q);
  const session = await getSessionProfile();
  const supabase = await createClient();

  const [{ count: subjectCount }, { data: activeSubs }] = await Promise.all([
    supabase.from("subjects").select("*", { count: "exact", head: true }),
    supabase
      .from("subscriptions")
      .select("id, activities(title)")
      .eq("student_id", session!.user.id)
      .eq("status", "active")
      .returns<{ id: string; activities: { title: string } | null }[]>(),
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <h1 className="font-head text-xl font-extrabold">
          Vizuri sana, {session!.profile.full_name.split(" ")[0]}! 👋
        </h1>
        <p className="text-sm text-ink-soft">Your learning &amp; activities in one place.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Link href="/student/subjects">
          <Card className="flex flex-col gap-1">
            <span className="text-2xl">📘</span>
            <p className="font-semibold">{subjectCount ?? 0} CBC Subjects</p>
            <p className="text-xs text-ink-faint">Lessons &amp; materials</p>
          </Card>
        </Link>
        <Link href="/student/marketplace">
          <Card className="flex flex-col gap-1">
            <span className="text-2xl">🎯</span>
            <p className="font-semibold">Activities</p>
            <p className="text-xs text-ink-faint">Sports, arts, music &amp; more</p>
          </Card>
        </Link>
      </div>

      <section aria-labelledby="find-coach-heading" className="flex min-w-0 flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 id="find-coach-heading" className="font-head text-lg font-extrabold">
              Find Your Teacher or Coach
            </h2>
            <p className="text-sm text-ink-soft">Meet the people who teach on Modern Talent Hub.</p>
          </div>
          <Link href="/student/teachers" className="shrink-0 text-sm font-semibold text-brand-cyan-deep">
            See all
          </Link>
        </div>
        <CoachBrowser studentId={session!.user.id} query={query} pageSize={6} basePath="/student" />
      </section>

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
          Active enrolments
        </h2>
        {activeSubs && activeSubs.length > 0 ? (
          <div className="flex flex-col gap-2">
            {activeSubs.map((s) => (
              <Card key={s.id}>{s.activities?.title ?? "Activity"}</Card>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No active enrolments yet"
            description="Browse Activities to subscribe to a teacher's sports, arts or music activity."
          />
        )}
      </div>
    </div>
  );
}

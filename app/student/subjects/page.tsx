import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { isUuid } from "@/lib/messages/rules";
import { normalizeSearch } from "@/lib/directory/rules";
import { CoachBrowser } from "@/components/directory/CoachBrowser";
import { EmptyState } from "@/components/ui/EmptyState";

export const dynamic = "force-dynamic";

const pill = (active: boolean) =>
  `shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold ${active ? "border-ink bg-ink text-white" : "border-line bg-surface"}`;

/**
 * Subjects = a teacher directory. By default every teacher who has published lessons; pick a subject to
 * see only the teachers who teach it. Who is listed comes from the database (published lessons ->
 * subject), so a teacher with lessons in several subjects appears under each of them. A teacher's
 * lessons are one tap away on their profile.
 */
export default async function SubjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string | string[]; q?: string | string[] }>;
}) {
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const query = normalizeSearch(first(sp.q));
  const subjectParam = first(sp.subject);

  const session = await getSessionProfile();
  const supabase = await createClient();
  const { data: subjects } = await supabase.from("subjects").select("*").order("order_index");

  const selected = isUuid(subjectParam) ? (subjects ?? []).find((s) => s.id === subjectParam.toLowerCase()) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h1 className="font-head text-xl font-extrabold">Subjects</h1>
        <p className="text-sm text-ink-soft">Choose a teacher and learn from their lessons.</p>
      </div>

      {subjects && subjects.length > 0 ? (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0" role="navigation" aria-label="Subjects">
          <Link href="/student/subjects" aria-current={!selected ? "page" : undefined} className={pill(!selected)}>
            All Teachers
          </Link>
          {subjects.map((subject) => (
            <Link
              key={subject.id}
              href={`/student/subjects?subject=${subject.id}`}
              aria-current={selected?.id === subject.id ? "page" : undefined}
              className={pill(selected?.id === subject.id)}
            >
              {subject.name}
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState title="No subjects yet" description="An admin needs to add CBC subjects." />
      )}

      <section aria-labelledby="subject-teachers-heading" className="flex min-w-0 flex-col gap-3">
        <h2 id="subject-teachers-heading" className="font-head text-lg font-extrabold">
          {selected ? `Teachers offering ${selected.name}` : "All Teachers"}
        </h2>
        <CoachBrowser
          studentId={session!.user.id}
          query={query}
          pageSize={12}
          basePath={selected ? `/student/subjects?subject=${selected.id}` : "/student/subjects"}
          scope={{ offer: "subjects", subjectId: selected?.id }}
          emptyTitle={selected ? `No teachers offering ${selected.name} yet.` : "No teachers available yet."}
          emptyDescription={
            selected
              ? "Teachers will appear here as soon as they publish a lesson in this subject."
              : "Approved teachers will appear here as soon as they publish a lesson."
          }
        />
      </section>
    </div>
  );
}

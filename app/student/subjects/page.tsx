import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { isUuid } from "@/lib/messages/rules";
import { normalizeSearch } from "@/lib/directory/rules";
import { CoachBrowser } from "@/components/directory/CoachBrowser";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card } from "@/components/ui/Card";
import { EDUCATION_LEVELS, gradeLabel, isLevelCode, levelForGrade, levelName } from "@/lib/education";
import { GradePicker } from "./GradePicker";

export const dynamic = "force-dynamic";

const pill = (active: boolean) =>
  `shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold ${active ? "border-ink bg-ink text-white" : "border-line bg-surface"}`;

/**
 * Subjects by school level (migration 0024): a student sees their own level first (from their grade) and
 * can switch to any other level for revision. Students we can't place yet are asked for their grade.
 *
 * Subjects = a teacher directory. By default every teacher who has published lessons; pick a subject to
 * see only the teachers who teach it. Who is listed comes from the database (published lessons ->
 * subject), so a teacher with lessons in several subjects appears under each of them. A teacher's
 * lessons are one tap away on their profile.
 */
export default async function SubjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string | string[]; q?: string | string[]; level?: string | string[] }>;
}) {
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const query = normalizeSearch(first(sp.q));
  const subjectParam = first(sp.subject);
  const levelParam = first(sp.level);

  const session = await getSessionProfile();
  const supabase = await createClient();
  const [{ data: allSubjects }, { data: me }] = await Promise.all([
    supabase.from("subjects").select("*").eq("active", true).order("order_index"),
    supabase.from("student_profiles").select("grade_code").eq("profile_id", session!.user.id).maybeSingle(),
  ]);

  const myLevel = levelForGrade(me?.grade_code);
  const linkedSubject = isUuid(subjectParam)
    ? (allSubjects ?? []).find((s) => s.id === subjectParam.toLowerCase())
    : undefined;
  // Which level is showing: the one picked, else the linked subject's, else the student's own. No level at
  // all (grade not set yet, nothing picked) shows every subject, as before.
  const level = isLevelCode(levelParam) ? levelParam : (linkedSubject?.level ?? myLevel ?? null);
  const subjects = level ? (allSubjects ?? []).filter((s) => s.level === level) : (allSubjects ?? []);
  const selected = linkedSubject && subjects.some((s) => s.id === linkedSubject.id) ? linkedSubject : undefined;
  const levelQuery = level ? `level=${level}` : "";
  const subjectsHref = (subjectId?: string) => {
    const qs = [levelQuery, subjectId ? `subject=${subjectId}` : ""].filter(Boolean).join("&");
    return qs ? `/student/subjects?${qs}` : "/student/subjects";
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h1 className="font-head text-xl font-extrabold">Subjects</h1>
        <p className="text-sm text-ink-soft">Choose a teacher and learn from their lessons.</p>
      </div>

      {!myLevel && (
        <Card className="flex flex-col gap-2">
          <p className="text-sm font-semibold">Choose your grade to see your subjects</p>
          <p className="text-xs text-ink-faint">
            We&apos;ll show the subjects for your level first. You can still look at other levels any time.
          </p>
          <GradePicker />
        </Card>
      )}

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0" role="navigation" aria-label="School levels">
        {EDUCATION_LEVELS.map((l) => (
          <Link
            key={l.code}
            href={`/student/subjects?level=${l.code}`}
            aria-current={level === l.code ? "page" : undefined}
            className={pill(level === l.code)}
          >
            {l.name}
            {myLevel === l.code ? " · My level" : ""}
          </Link>
        ))}
      </div>

      {level && (
        <p className="text-xs text-ink-faint">
          {myLevel === level
            ? `Showing ${levelName(level)} subjects for ${gradeLabel(me?.grade_code)}. `
            : `Showing ${levelName(level)} subjects. `}
          <Link href="/account" className="font-semibold text-brand-cyan-deep">
            Change my grade
          </Link>
        </p>
      )}

      {subjects && subjects.length > 0 ? (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0" role="navigation" aria-label="Subjects">
          <Link href={subjectsHref()} aria-current={!selected ? "page" : undefined} className={pill(!selected)}>
            All Teachers
          </Link>
          {subjects.map((subject) => (
            <Link
              key={subject.id}
              href={subjectsHref(subject.id)}
              aria-current={selected?.id === subject.id ? "page" : undefined}
              className={pill(selected?.id === subject.id)}
            >
              {subject.name}
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          title={level ? `No ${levelName(level)} subjects yet` : "No subjects yet"}
          description="Subjects for this level will appear here as soon as they are added."
        />
      )}

      <section aria-labelledby="subject-teachers-heading" className="flex min-w-0 flex-col gap-3">
        <h2 id="subject-teachers-heading" className="font-head text-lg font-extrabold">
          {selected ? `Teachers offering ${selected.name}` : "All Teachers"}
        </h2>
        <CoachBrowser
          studentId={session!.user.id}
          query={query}
          pageSize={12}
          basePath={subjectsHref(selected?.id)}
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

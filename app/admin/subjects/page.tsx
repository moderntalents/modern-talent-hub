import { createClient } from "@/lib/supabase/server";
import { Card, Badge } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { EDUCATION_LEVELS, pathwayName } from "@/lib/education";
import { SubjectForm } from "./SubjectForm";
import { SubjectRowActions } from "./SubjectRowActions";

export const dynamic = "force-dynamic";

/**
 * Admin -> Subjects: every subject by school level (migration 0024). Admins add and edit subjects, hide or
 * show them, and delete only subjects that have no lessons. Hidden subjects keep all their lessons.
 */
export default async function AdminSubjectsPage() {
  const supabase = await createClient();
  const [{ data: subjects }, { data: lessons }] = await Promise.all([
    supabase.from("subjects").select("*").order("order_index").order("name"),
    supabase.from("lessons").select("subject_id"),
  ]);

  const lessonCount = new Map<string, number>();
  for (const l of lessons ?? []) lessonCount.set(l.subject_id, (lessonCount.get(l.subject_id) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-head text-xl font-extrabold">Subjects</h1>
        <p className="text-sm text-ink-soft">
          Subjects by school level. Students see their own level first and can browse the others.
        </p>
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="font-head text-base font-bold">Add a subject</h2>
        <SubjectForm />
      </Card>

      {EDUCATION_LEVELS.map((level) => {
        const inLevel = (subjects ?? []).filter((s) => s.level === level.code);
        return (
          <section key={level.code} aria-labelledby={`level-${level.code}`} className="flex flex-col gap-2">
            <h2 id={`level-${level.code}`} className="font-head text-lg font-extrabold">
              {level.name} <span className="text-sm font-semibold text-ink-faint">{level.grades}</span>
            </h2>
            {inLevel.length === 0 ? (
              <EmptyState title={`No ${level.name} subjects yet`} description="Add one with the form above." />
            ) : (
              inLevel.map((s) => {
                const count = lessonCount.get(s.id) ?? 0;
                return (
                  <Card key={s.id} className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold">{s.name}</p>
                        <p className="text-xs text-ink-faint">
                          {count} lesson{count === 1 ? "" : "s"} · order {s.order_index}
                          {s.pathway ? ` · ${pathwayName(s.pathway)}` : ""}
                        </p>
                        <div className="mt-1 flex gap-1.5">
                          <Badge tone={s.active ? "success" : "warning"}>{s.active ? "Visible" : "Hidden"}</Badge>
                        </div>
                      </div>
                      <SubjectRowActions id={s.id} name={s.name} active={s.active} lessonCount={count} />
                    </div>
                    <details>
                      <summary className="cursor-pointer text-sm font-semibold text-brand-cyan-deep">Edit</summary>
                      <div className="mt-3">
                        <SubjectForm initial={s} />
                      </div>
                    </details>
                  </Card>
                );
              })
            )}
          </section>
        );
      })}
    </div>
  );
}

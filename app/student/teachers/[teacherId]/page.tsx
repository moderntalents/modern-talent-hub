import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getAccountStatus } from "@/lib/messaging-gate";
import { getDirectoryTeacher } from "@/lib/directory/service";
import { arePaymentsEnabled } from "@/lib/settings";
import { BILLING_LABELS, formatKes } from "@/lib/constants";
import { canOpenConversation, subtitleOf } from "@/lib/directory/rules";
import { Avatar } from "@/components/ui/Avatar";
import { Card, Badge } from "@/components/ui/Card";
import { MessageAction } from "@/components/directory/MessageAction";

// Per-person data: always rendered on request, never at build time.
export const dynamic = "force-dynamic";

// Lessons shown on a profile; a teacher with more still has them all under their subjects.
const PROFILE_LESSON_LIMIT = 60;

export default async function StudentTeacherProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ teacherId: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { teacherId } = await params;
  const from = (await searchParams).from;
  const origin = from === "subjects" || from === "activities" ? from : null;
  const back =
    origin === "subjects"
      ? { href: "/student/subjects", label: "Subjects" }
      : origin === "activities"
        ? { href: "/student/marketplace", label: "Activities" }
        : { href: "/student/teachers", label: "Teachers & Coaches" };
  const session = await getSessionProfile();
  const userId = session!.user.id;
  const admin = createAdminClient();

  // Same rule as the list: only an approved teacher/coach with something published is visible. Anyone
  // else — no matter why — is "not found", so this address can't be used to look people up.
  const teacher = await getDirectoryTeacher(admin, userId, teacherId, {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  if (!teacher) notFound();

  // Their courses and lessons: only what is already published and visible to students. The directory
  // check above is what decides that this person may be shown at all.
  const supabase = await createClient();
  const [account, paymentsOn, { data: lessons }, { data: activities }] = await Promise.all([
    getAccountStatus(supabase, userId, admin),
    arePaymentsEnabled(),
    supabase
      .from("lessons")
      .select("id, title, description, video_url, subject_id, subjects(name, order_index)")
      .eq("teacher_id", teacherId)
      .eq("status", "published")
      .order("order_index")
      .limit(PROFILE_LESSON_LIMIT)
      .returns<
        {
          id: string;
          title: string;
          description: string | null;
          video_url: string | null;
          subject_id: string;
          subjects: { name: string; order_index: number } | null;
        }[]
      >(),
    supabase
      .from("activities")
      .select("id, title, activity_type, price, billing")
      .eq("teacher_id", teacherId)
      .eq("status", "published")
      .order("title"),
  ]);

  // Lessons grouped under their subject, subjects in the platform's usual order.
  const bySubject = new Map<string, { name: string; order: number; lessons: NonNullable<typeof lessons> }>();
  for (const l of lessons ?? []) {
    const group = bySubject.get(l.subject_id) ?? { name: l.subjects?.name ?? "Lessons", order: l.subjects?.order_index ?? 0, lessons: [] };
    group.lessons.push(l);
    bySubject.set(l.subject_id, group);
  }
  const subjectGroups = [...bySubject.entries()].sort((a, b) => a[1].order - b[1].order || a[1].name.localeCompare(b[1].name));

  const first = teacher.name.split(/\s+/)[0];

  return (
    <div className="flex flex-col gap-4">
      <Link href={back.href} className="text-sm font-semibold text-brand-cyan-deep">
        ← {back.label}
      </Link>

      <Card className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-center sm:gap-6 sm:text-left">
        <Avatar name={teacher.name} src={teacher.avatarSrc} size="xl" />
        <div className="flex min-w-0 flex-1 flex-col items-center gap-2 sm:items-start">
          <div>
            <h1 className="font-head text-xl font-extrabold break-words">{teacher.name}</h1>
            <p className="mt-1 text-sm font-medium text-ink-soft break-words">{subtitleOf(teacher)}</p>
          </div>
          <MessageAction teacher={teacher} messagingState={account.messaging} />
        </div>
      </Card>

      {!canOpenConversation(teacher) && (
        <p id="join" className="rounded-2xl bg-[var(--info-tint)] px-4 py-3 text-sm text-[var(--info-text)]">
          {teacher.activities.length > 0
            ? `You can message ${first} once you join one of their activities below.`
            : `${first} doesn't have an activity you can join yet.`}
        </p>
      )}

      {teacher.bio && (
        <section aria-labelledby="about-heading">
          <h2 id="about-heading" className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
            About
          </h2>
          <Card>
            <p className="whitespace-pre-line break-words text-sm text-ink">{teacher.bio}</p>
          </Card>
        </section>
      )}

      {(activities?.length ?? 0) > 0 && (
        <section aria-labelledby="enrolled-heading">
          <h2 id="enrolled-heading" className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
            Activities by {first}
          </h2>
          <ul className="flex flex-col gap-2">
            {activities!.map((a) => (
              <li key={a.id}>
                <Link href={`/student/marketplace/${a.id}`}>
                  <Card className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold break-words">{a.title}</p>
                      <p className="text-xs text-ink-faint break-words">
                        {a.activity_type} · {paymentsOn && a.price > 0 ? `${formatKes(a.price)}${BILLING_LABELS[a.billing] ?? ""}` : "Free"}
                      </p>
                    </div>
                    <span aria-hidden="true" className="text-ink-faint">
                      →
                    </span>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {subjectGroups.length > 0 && (
        <section aria-labelledby="lessons-heading" className="flex flex-col gap-3">
          <h2 id="lessons-heading" className="font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
            Subjects &amp; lessons by {first}
          </h2>
          {subjectGroups.map(([subjectId, group]) => (
            <div key={subjectId} className="flex flex-col gap-2">
              <h3 className="font-head text-base font-bold break-words">{group.name}</h3>
              <ul className="flex flex-col gap-2">
                {group.lessons.map((lesson) => (
                  <li key={lesson.id}>
                    <Link href={`/student/lessons/${lesson.id}`}>
                      <Card className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold break-words">{lesson.title}</p>
                          {lesson.description && (
                            <p className="line-clamp-1 text-xs text-ink-faint break-words">{lesson.description}</p>
                          )}
                        </div>
                        {lesson.video_url && <Badge tone="info">Video</Badge>}
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

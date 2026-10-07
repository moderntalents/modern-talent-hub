import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getAccountStatus } from "@/lib/messaging-gate";
import { getDirectoryTeacher } from "@/lib/directory/service";
import { subtitleOf } from "@/lib/directory/rules";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { MessageAction } from "@/components/directory/MessageAction";

// Per-person data: always rendered on request, never at build time.
export const dynamic = "force-dynamic";

export default async function StudentTeacherProfilePage({ params }: { params: Promise<{ teacherId: string }> }) {
  const { teacherId } = await params;
  const session = await getSessionProfile();
  const userId = session!.user.id;
  const admin = createAdminClient();

  // Same rule as the list: only a teacher/coach this student has an active subscription with. Anyone
  // else — no matter why — is "not found", so this address can't be used to look people up.
  const teacher = await getDirectoryTeacher(admin, userId, teacherId, {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  if (!teacher) notFound();

  const account = await getAccountStatus(await createClient(), userId, admin);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/student/teachers" className="text-sm font-semibold text-brand-cyan-deep">
        ← Teachers &amp; Coaches
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

      {teacher.activities.length > 0 && (
        <section aria-labelledby="enrolled-heading">
          <h2 id="enrolled-heading" className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
            Your activities with {teacher.name.split(/\s+/)[0]}
          </h2>
          <ul className="flex flex-col gap-2">
            {teacher.activities.map((a) => (
              <li key={a.id}>
                <Link href={`/student/marketplace/${a.id}`}>
                  <Card className="flex items-center justify-between gap-2">
                    <p className="font-semibold break-words">{a.title}</p>
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
    </div>
  );
}

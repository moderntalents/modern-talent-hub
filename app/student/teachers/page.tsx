import { getSessionProfile } from "@/lib/auth";
import { normalizeSearch } from "@/lib/directory/rules";
import { CoachBrowser } from "@/components/directory/CoachBrowser";

// Per-person data: always rendered on request, never at build time.
export const dynamic = "force-dynamic";

export default async function StudentTeachersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const sp = await searchParams;
  const query = normalizeSearch(Array.isArray(sp.q) ? sp.q[0] : sp.q);
  const session = await getSessionProfile();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h1 className="font-head text-xl font-extrabold">Find your teacher or coach</h1>
        <p className="text-sm text-ink-soft">Browse every teacher and coach on Modern Talent Hub.</p>
      </div>
      <CoachBrowser studentId={session!.user.id} query={query} pageSize={12} basePath="/student/teachers" />
    </div>
  );
}

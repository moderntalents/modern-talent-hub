import { getSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getAccountStatus } from "@/lib/messaging-gate";
import { listDirectory } from "@/lib/directory/service";
import { normalizeSearch } from "@/lib/directory/rules";
import { DirectorySearch } from "@/components/directory/DirectorySearch";
import { DirectoryList } from "@/components/directory/DirectoryList";
import { EmptyState, ErrorBanner } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";

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
  const userId = session!.user.id;
  const admin = createAdminClient();

  // The list is searched, ordered and cut into pages by the database, and only teachers/coaches this
  // student has an active subscription with are ever returned (migration 0019).
  const [directory, account] = await Promise.all([
    listDirectory(admin, userId, { query, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL }),
    getAccountStatus(await createClient(), userId, admin),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-head text-xl font-extrabold">Find your teacher or coach</h1>
        <p className="text-sm text-ink-soft">The teachers and coaches of the activities you&apos;re enrolled in.</p>
      </div>

      <DirectorySearch initialQuery={query} />

      <section aria-labelledby="directory-heading" className="flex flex-col gap-3">
        <h2 id="directory-heading" className="font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
          Teachers &amp; Coaches
        </h2>

        {!directory.ok ? (
          <ErrorBanner message={directory.message} />
        ) : directory.teachers.length === 0 ? (
          query ? (
            <EmptyState
              title="No teachers or coaches found."
              description="Check the spelling, or try just a first or last name."
              action={
                <LinkButton href="/student/teachers" variant="outline">
                  Clear search
                </LinkButton>
              }
            />
          ) : (
            <EmptyState
              title="You don't have any teachers or coaches available yet."
              description="When you enrol in an activity, its coach will appear here."
              action={<LinkButton href="/student/marketplace">Browse activities</LinkButton>}
            />
          )
        ) : (
          <DirectoryList
            key={query}
            query={query}
            initial={directory.teachers}
            initialCursor={directory.nextCursor}
            messagingState={account.messaging}
          />
        )}
      </section>
    </div>
  );
}

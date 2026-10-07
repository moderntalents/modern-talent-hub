import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getAccountStatus } from "@/lib/messaging-gate";
import { listDirectory } from "@/lib/directory/service";
import { DirectorySearch } from "@/components/directory/DirectorySearch";
import { DirectoryList } from "@/components/directory/DirectoryList";
import { EmptyState, ErrorBanner } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";

/**
 * Search box + the pages of teacher/coach cards, shared by the student dashboard and the full
 * /student/teachers page. The database searches, orders and pages the list (migration 0021); only
 * approved teachers/coaches with something published are ever returned, and never anything private.
 * `basePath` is where "Clear search" returns to; `pageSize` is how many cards load at a time.
 */
export async function CoachBrowser({
  studentId,
  query,
  pageSize,
  basePath,
}: {
  studentId: string;
  query: string;
  pageSize: number;
  basePath: string;
}) {
  const admin = createAdminClient();
  const [directory, account] = await Promise.all([
    listDirectory(admin, studentId, { query, pageSize, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL }),
    getAccountStatus(await createClient(), studentId, admin),
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <DirectorySearch initialQuery={query} />
      {!directory.ok ? (
        <ErrorBanner message={directory.message} />
      ) : directory.teachers.length === 0 ? (
        query ? (
          <EmptyState
            title="No teachers or coaches found."
            description="Check the spelling, or try just a first or last name."
            action={
              <LinkButton href={basePath} variant="outline">
                Clear search
              </LinkButton>
            }
          />
        ) : (
          <EmptyState
            title="No teachers or coaches available yet."
            description="Approved teachers and coaches will appear here as soon as they publish an activity."
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
          pageSize={pageSize}
        />
      )}
    </div>
  );
}

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getAccountStatus } from "@/lib/messaging-gate";
import { listDirectory } from "@/lib/directory/service";
import type { DirectoryScope } from "@/lib/directory/rules";
import { DirectorySearch } from "@/components/directory/DirectorySearch";
import { DirectoryList } from "@/components/directory/DirectoryList";
import { EmptyState, ErrorBanner } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";

/**
 * Search box + the pages of teacher/coach cards, shared by the student dashboard and the full
 * /student/teachers page. The database searches, orders and pages the list (migration 0021); only
 * approved teachers/coaches with something published are ever returned, and never anything private.
 * `basePath` is where "Clear search" returns to; `pageSize` is how many cards load at a time.
 * `searchOnly` (student dashboard) shows just the search box until something is typed: no cards
 * are listed before a search. Every other page leaves it off and lists teachers/coaches as before.
 */
export async function CoachBrowser({
  studentId,
  query,
  pageSize,
  basePath,
  scope,
  placeholder,
  emptyTitle,
  emptyDescription,
  searchOnly = false,
}: {
  studentId: string;
  query: string;
  pageSize: number;
  basePath: string;
  /** Narrow the list to who offers what (all teachers, all coaches, one subject, one activity). */
  scope?: DirectoryScope;
  placeholder?: string;
  /** What to say when nobody matches the scope (and there is no search text). */
  emptyTitle?: string;
  emptyDescription?: string;
  /** Show only the search box until the student searches (no profiles listed before a search). */
  searchOnly?: boolean;
}) {
  if (searchOnly && !query) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <DirectorySearch initialQuery={query} placeholder={placeholder} />
      </div>
    );
  }

  const admin = createAdminClient();
  const [directory, account] = await Promise.all([
    listDirectory(admin, studentId, { query, pageSize, scope, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL }),
    getAccountStatus(await createClient(), studentId, admin),
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <DirectorySearch initialQuery={query} placeholder={placeholder} />
      {!directory.ok ? (
        <ErrorBanner message={directory.message} />
      ) : directory.teachers.length === 0 ? (
        query ? (
          <EmptyState
            title="No teachers or coaches found."
            description="Check the spelling, or try a name, subject or activity."
            action={
              <LinkButton href={basePath} variant="outline">
                Clear search
              </LinkButton>
            }
          />
        ) : (
          <EmptyState
            title={emptyTitle ?? "No teachers or coaches available yet."}
            description={
              emptyDescription ?? "Approved teachers and coaches will appear here as soon as they publish an activity."
            }
            action={scope ? undefined : <LinkButton href="/student/marketplace">Browse activities</LinkButton>}
          />
        )
      ) : (
        <DirectoryList
          key={`${query}|${scope?.offer ?? ""}|${scope?.subjectId ?? ""}|${scope?.activityId ?? ""}|${scope?.categoryId ?? ""}`}
          query={query}
          scope={scope}
          initial={directory.teachers}
          initialCursor={directory.nextCursor}
          messagingState={account.messaging}
          pageSize={pageSize}
        />
      )}
    </div>
  );
}

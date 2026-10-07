import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { findActivity, findCategory, listActivityChoices, normalizeSearch } from "@/lib/directory/rules";
import { CoachBrowser } from "@/components/directory/CoachBrowser";

export const dynamic = "force-dynamic";

const pill = (active: boolean) =>
  `shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold ${active ? "border-ink bg-ink text-white" : "border-line bg-surface"}`;

/**
 * Activities = a coach directory. By default every coach who has published an activity; pick an activity
 * (Karate, Chess...) to see only the coaches who offer it. Who is listed comes from the database
 * (published activities -> activity type), so a coach offering Karate and Taekwondo appears under both.
 * Each coach's own courses/lessons are on their profile; the individual activity pages
 * (/student/marketplace/<id>) are unchanged and reached from there.
 *
 * Old links keep working: /student/marketplace?category=martial (a whole category) lists the coaches who
 * offer any activity in it, and ?category=karate (an activity) is redirected to ?activity=karate.
 */
export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ activity?: string | string[]; category?: string | string[]; q?: string | string[] }>;
}) {
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const query = normalizeSearch(first(sp.q));
  const activityParam = first(sp.activity);
  const categoryParam = first(sp.category);

  const selected = findActivity(activityParam);
  let category = null as ReturnType<typeof findCategory>;
  if (!selected && categoryParam !== undefined) {
    const asActivity = findActivity(categoryParam);
    if (asActivity) {
      // An old link that named an activity: send it to the activity's own filter.
      redirect(`/student/marketplace?activity=${asActivity.id}${query ? `&q=${encodeURIComponent(query)}` : ""}`);
    }
    category = findCategory(categoryParam);
    // A made-up category is dropped rather than silently kept in the address.
    if (!category) redirect(query ? `/student/marketplace?q=${encodeURIComponent(query)}` : "/student/marketplace");
  }
  const session = await getSessionProfile();
  const noFilter = !selected && !category;
  const label = selected?.name ?? category?.name ?? null;
  const basePath = selected
    ? `/student/marketplace?activity=${selected.id}`
    : category
      ? `/student/marketplace?category=${category.id}`
      : "/student/marketplace";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h1 className="font-head text-xl font-extrabold">Activities</h1>
        <p className="text-sm text-ink-soft">Sports, Martial Arts, Performing Arts &amp; Music, Creative Tech &amp; Mind Games.</p>
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0" role="navigation" aria-label="Activities">
        <Link href="/student/marketplace" aria-current={noFilter ? "page" : undefined} className={pill(noFilter)}>
          All Coaches
        </Link>
        {listActivityChoices().map((a) => (
          <Link
            key={a.id}
            href={`/student/marketplace?activity=${a.id}`}
            aria-current={selected?.id === a.id ? "page" : undefined}
            className={pill(selected?.id === a.id)}
          >
            {a.name}
          </Link>
        ))}
      </div>

      <section aria-labelledby="activity-coaches-heading" className="flex min-w-0 flex-col gap-3">
        <h2 id="activity-coaches-heading" className="font-head text-lg font-extrabold">
          {label ? `Coaches offering ${label}` : "All Coaches"}
        </h2>
        <CoachBrowser
          studentId={session!.user.id}
          query={query}
          pageSize={12}
          basePath={basePath}
          scope={{ offer: "activities", activityId: selected?.id, categoryId: category?.id }}
          emptyTitle={label ? `No coaches offering ${label} yet.` : "No coaches available yet."}
          emptyDescription={
            label
              ? "Coaches will appear here as soon as they publish this activity."
              : "Approved coaches will appear here as soon as they publish an activity."
          }
        />
      </section>
    </div>
  );
}

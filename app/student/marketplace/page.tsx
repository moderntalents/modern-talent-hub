import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { arePaymentsEnabled } from "@/lib/settings";
import { ACTIVITY_CATEGORIES, BILLING_LABELS, formatKes, type ActivityCategoryId } from "@/lib/constants";
import { Card, Badge } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category: categoryParam } = await searchParams;
  const category = ACTIVITY_CATEGORIES.some((c) => c.id === categoryParam)
    ? (categoryParam as ActivityCategoryId)
    : undefined;
  const supabase = await createClient();

  let query = supabase
    .from("activities")
    .select("*, profiles(full_name)")
    .eq("status", "published");
  if (category) query = query.eq("category", category);

  const [{ data: activities }, paymentsOn] = await Promise.all([
    query.order("created_at", { ascending: false }),
    arePaymentsEnabled(),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-head text-xl font-extrabold">Marketplace</h1>
        <p className="text-sm text-ink-soft">Sports, Martial Arts, Performing Arts &amp; Music, Creative Tech &amp; Mind Games.</p>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <Link
          href="/student/marketplace"
          className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold ${!category ? "border-ink bg-ink text-white" : "border-line bg-surface"}`}
        >
          All
        </Link>
        {ACTIVITY_CATEGORIES.map((cat) => (
          <Link
            key={cat.id}
            href={`/student/marketplace?category=${cat.id}`}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold ${category === cat.id ? "border-ink bg-ink text-white" : "border-line bg-surface"}`}
          >
            {cat.name}
          </Link>
        ))}
      </div>

      {activities && activities.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {activities.map((activity) => (
            <Link key={activity.id} href={`/student/marketplace/${activity.id}`}>
              <Card className="flex flex-col gap-2">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-semibold">{activity.title}</p>
                    <p className="text-xs text-ink-faint">
                      by {(activity as unknown as { profiles: { full_name: string } | null }).profiles?.full_name ?? "Teacher"}
                    </p>
                  </div>
                  <Badge tone="info">{activity.category}</Badge>
                </div>
                {activity.description && (
                  <p className="line-clamp-2 text-sm text-ink-soft">{activity.description}</p>
                )}
                <p className="font-head text-sm font-bold">
                  {paymentsOn && activity.price > 0 ? formatKes(activity.price) : "Free"}
                  {paymentsOn && activity.price > 0 && (
                    <span className="text-xs font-normal text-ink-faint">{BILLING_LABELS[activity.billing]}</span>
                  )}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No activities published yet"
          description="Teachers haven't listed any activities in this category yet."
        />
      )}
    </div>
  );
}

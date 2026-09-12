import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { getSignedUrl } from "@/lib/storage";
import { BILLING_LABELS, formatKes } from "@/lib/constants";
import { Card, Badge } from "@/components/ui/Card";
import { SubscribeForm } from "./SubscribeForm";

export default async function ActivityDetailPage({
  params,
}: {
  params: Promise<{ activityId: string }>;
}) {
  const { activityId } = await params;
  const session = await getSessionProfile();
  const supabase = await createClient();

  const [{ data: activity }, { data: materials }, { data: subscription }] = await Promise.all([
    supabase.from("activities").select("*, profiles(full_name)").eq("id", activityId).single(),
    supabase.from("activity_materials").select("*").eq("activity_id", activityId),
    supabase
      .from("subscriptions")
      .select("status")
      .eq("activity_id", activityId)
      .eq("student_id", session!.user.id)
      .maybeSingle(),
  ]);

  if (!activity) notFound();

  const materialLinks = await Promise.all(
    (materials ?? []).map(async (m) => ({ ...m, url: await getSignedUrl("activity-materials", m.storage_path) })),
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Badge tone="info">{activity.category}</Badge>
        <h1 className="mt-2 font-head text-xl font-extrabold">{activity.title}</h1>
        <p className="text-sm text-ink-soft">
          by {(activity as unknown as { profiles: { full_name: string } | null }).profiles?.full_name ?? "Teacher"}
          {activity.location ? ` · ${activity.location}` : ""}
        </p>
      </div>

      {activity.description && <p className="text-sm text-ink-soft">{activity.description}</p>}

      <div className="flex flex-wrap gap-2 text-xs text-ink-faint">
        {activity.level && <Badge tone="info">Level: {activity.level}</Badge>}
        {activity.age_range && <Badge tone="info">Ages {activity.age_range}</Badge>}
      </div>

      <Card>
        <p className="font-head text-lg font-extrabold">
          {activity.price > 0 ? formatKes(activity.price) : "Free"}
          <span className="text-sm font-normal text-ink-faint">{BILLING_LABELS[activity.billing]}</span>
        </p>
        <div className="mt-3">
          <SubscribeForm
            activityId={activity.id}
            price={activity.price}
            alreadySubscribed={subscription?.status === "active"}
          />
        </div>
      </Card>

      {materialLinks.length > 0 && (
        <div>
          <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
            Materials
          </h2>
          <div className="flex flex-col gap-2">
            {materialLinks.map((m) => (
              <Card key={m.id} className="flex items-center justify-between">
                <p className="text-sm font-semibold">{m.file_name}</p>
                {m.url && subscription?.status === "active" ? (
                  <a href={m.url} download className="text-sm font-semibold text-brand-cyan-deep">
                    Download
                  </a>
                ) : (
                  <span className="text-xs text-ink-faint">Enrol to access</span>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

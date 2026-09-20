import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { getSignedUrl } from "@/lib/storage";
import { arePaymentsEnabled } from "@/lib/settings";
import { isVideoFile } from "@/lib/uploads";
import { StudentLiveCard } from "@/components/live/StudentLiveCard";
import { effectiveLiveStatus, formatSchedule } from "@/lib/live/status";
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

  // Payments off => everything is free, whatever price the teacher listed.
  const paymentsOn = await arePaymentsEnabled();
  const effectivePrice = paymentsOn ? activity.price : 0;

  const materialLinks = await Promise.all(
    (materials ?? []).map(async (m) => ({ ...m, url: await getSignedUrl("activity-materials", m.storage_path) })),
  );

  // Live class attached to this activity, if the teacher scheduled one. A
  // tolerant query: if it fails the activity simply shows as a regular activity.
  const { data: live } = await supabase.from("live_sessions").select("*").eq("activity_id", activityId).maybeSingle();
  const enrolled = subscription?.status === "active";

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
          {effectivePrice > 0 ? formatKes(effectivePrice) : "Free"}
          {effectivePrice > 0 && (
            <span className="text-sm font-normal text-ink-faint">{BILLING_LABELS[activity.billing]}</span>
          )}
        </p>
        <div className="mt-3">
          <SubscribeForm
            activityId={activity.id}
            price={effectivePrice}
            alreadySubscribed={subscription?.status === "active"}
          />
        </div>
      </Card>

      {live && (
        <StudentLiveCard
          sessionId={live.id}
          status={effectiveLiveStatus(live)}
          scheduledLabel={formatSchedule(live.scheduled_at)}
          durationMinutes={live.duration_minutes}
          noun="activity"
          joinBlockedReason={enrolled ? undefined : "Enrol in this activity above to join its live class."}
        />
      )}

      {materialLinks.length > 0 && (
        <div>
          <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
            Materials
          </h2>
          <div className="flex flex-col gap-2">
            {materialLinks.map((m) =>
              // Enrolled students can watch an uploaded video right here;
              // everyone else (and every other file type) gets the usual row.
              m.url && subscription?.status === "active" && isVideoFile(m.file_type, m.file_name) ? (
                <div key={m.id} className="flex flex-col gap-1.5">
                  <p className="text-sm font-semibold">{m.file_name}</p>
                  <div className="overflow-hidden rounded-[var(--radius-brand)] border border-line bg-black">
                    <video src={m.url} controls preload="metadata" className="aspect-video w-full" />
                  </div>
                </div>
              ) : (
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
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

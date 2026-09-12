import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatKes, BILLING_LABELS } from "@/lib/constants";
import { Badge } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ActivityMaterialsManager } from "./ActivityMaterialsManager";
import { ActivityPublishToggle } from "./ActivityPublishToggle";

export default async function TeacherActivityPage({
  params,
}: {
  params: Promise<{ activityId: string }>;
}) {
  const { activityId } = await params;
  const session = await getSessionProfile();
  const supabase = await createClient();

  const { data: activity } = await supabase
    .from("activities")
    .select("*")
    .eq("id", activityId)
    .eq("teacher_id", session!.user.id)
    .single();

  if (!activity) notFound();

  const [{ data: materials }, { data: students }] = await Promise.all([
    supabase.from("activity_materials").select("*").eq("activity_id", activityId),
    supabase
      .from("subscriptions")
      .select("*, profiles(full_name)")
      .eq("activity_id", activityId)
      .eq("status", "active"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Badge tone="info">{activity.category}</Badge>
          <h1 className="mt-2 font-head text-xl font-extrabold">{activity.title}</h1>
          <p className="text-sm text-ink-soft">
            {activity.price > 0 ? formatKes(activity.price) : "Free"}
            {BILLING_LABELS[activity.billing]}
          </p>
          <Badge tone={activity.status === "published" ? "success" : "warning"}>{activity.status}</Badge>
        </div>
        <ActivityPublishToggle activityId={activity.id} status={activity.status} />
      </div>

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">Materials</h2>
        <ActivityMaterialsManager
          activityId={activity.id}
          materials={(materials ?? []).map((m) => ({ id: m.id, file_name: m.file_name, file_size: m.file_size }))}
        />
      </div>

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
          Enrolled students ({students?.length ?? 0})
        </h2>
        {students && students.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {students.map((s) => (
              <li key={s.id} className="text-sm">
                {(s as unknown as { profiles: { full_name: string } | null }).profiles?.full_name}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No students enrolled yet" />
        )}
      </div>
    </div>
  );
}

import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatKes } from "@/lib/constants";
import { arePaymentsEnabled } from "@/lib/settings";
import { Card, Badge } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

const STATUS_TONE = {
  active: "success",
  pending_payment: "warning",
  cancelled: "danger",
  expired: "danger",
} as const;

export default async function SubscriptionsPage() {
  const session = await getSessionProfile();
  const supabase = await createClient();

  const paymentsOn = await arePaymentsEnabled();

  const [{ data: subscriptions }, { data: transactions }] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("*, activities(title, price, billing)")
      .eq("student_id", session!.user.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("payment_transactions")
      .select("*")
      .eq("student_id", session!.user.id)
      .order("created_at", { ascending: false }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-head text-xl font-extrabold">My Subscriptions</h1>
        <p className="text-sm text-ink-soft">Enrolments and payment history.</p>
      </div>

      {subscriptions && subscriptions.length > 0 ? (
        <div className="flex flex-col gap-2">
          {subscriptions.map((s) => {
            const activity = (s as unknown as { activities: { title: string; price: number; billing: string } | null }).activities;
            return (
              <Card key={s.id} className="flex items-center justify-between">
                <div>
                  <p className="font-semibold">{activity?.title ?? "Activity"}</p>
                  <p className="text-xs text-ink-faint">
                    {activity ? (paymentsOn && activity.price > 0 ? formatKes(activity.price) : "Free") : ""}
                  </p>
                </div>
                <Badge tone={STATUS_TONE[s.status]}>{s.status.replace("_", " ")}</Badge>
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No subscriptions yet" description="Enrol in a marketplace activity to see it here." />
      )}

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
          Payment history
        </h2>
        {transactions && transactions.length > 0 ? (
          <div className="flex flex-col gap-2">
            {transactions.map((t) => (
              <Card key={t.id} className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm font-semibold">{formatKes(t.amount)}</p>
                  <p className="text-xs text-ink-faint">
                    {new Date(t.created_at).toLocaleString("en-KE")}
                    {t.provider_reference ? ` · ${t.provider_reference}` : ""}
                  </p>
                </div>
                <Badge tone={t.status === "completed" ? "success" : t.status === "failed" ? "danger" : "warning"}>
                  {t.status}
                </Badge>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState title="No payments yet" />
        )}
      </div>
    </div>
  );
}

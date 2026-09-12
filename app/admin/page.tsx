import { createClient } from "@/lib/supabase/server";
import { formatKes } from "@/lib/constants";
import { Card } from "@/components/ui/Card";

export default async function AdminHome() {
  const supabase = await createClient();

  const [{ count: pendingTeachers }, { count: pendingWithdrawals }, { data: volume }] = await Promise.all([
    supabase.from("teacher_profiles").select("*", { count: "exact", head: true }).eq("approved", false),
    supabase.from("withdrawal_requests").select("*", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("payment_transactions").select("amount, platform_share").eq("status", "completed"),
  ]);

  const totalVolume = (volume ?? []).reduce((sum, t) => sum + Number(t.amount), 0);
  const platformRevenue = (volume ?? []).reduce((sum, t) => sum + Number(t.platform_share), 0);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-head text-xl font-extrabold">Admin Overview</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <p className="text-2xl font-extrabold">{pendingTeachers ?? 0}</p>
          <p className="text-xs text-ink-faint">Pending teacher approvals</p>
        </Card>
        <Card>
          <p className="text-2xl font-extrabold">{pendingWithdrawals ?? 0}</p>
          <p className="text-xs text-ink-faint">Pending withdrawals</p>
        </Card>
        <Card>
          <p className="text-2xl font-extrabold">{formatKes(totalVolume)}</p>
          <p className="text-xs text-ink-faint">Total payment volume</p>
        </Card>
        <Card>
          <p className="text-2xl font-extrabold text-[var(--success-text)]">{formatKes(platformRevenue)}</p>
          <p className="text-xs text-ink-faint">Platform revenue (30%)</p>
        </Card>
      </div>
    </div>
  );
}

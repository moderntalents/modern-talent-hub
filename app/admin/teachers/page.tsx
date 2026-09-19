import { createClient } from "@/lib/supabase/server";
import { formatKes } from "@/lib/constants";
import { Card, Badge } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApproveButton } from "./ApproveButton";

export default async function AdminTeachersPage() {
  const supabase = await createClient();
  const { data: teachers } = await supabase
    .from("teacher_profiles")
    .select("*, profiles(full_name, phone, created_at)")
    .order("profile_id");

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-head text-xl font-extrabold">Teacher Accounts</h1>
      {teachers && teachers.length > 0 ? (
        <div className="flex flex-col gap-2">
          {teachers.map((t) => {
            const p = (t as unknown as { profiles: { full_name: string; phone: string | null } | null }).profiles;
            return (
              <Card key={t.profile_id} className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">{p?.full_name}</p>
                  <p className="text-xs text-ink-faint">{t.specialty ?? "—"} · {p?.phone}</p>
                  <p className="text-xs font-semibold text-[var(--success-text)]">
                    Wallet: {formatKes(t.wallet_balance)}
                  </p>
                  <div className="mt-1 flex gap-1.5">
                    <Badge tone={t.approved ? "success" : "warning"}>{t.approved ? "Approved" : "Pending"}</Badge>
                    <Badge tone={t.activated ? "success" : "warning"}>{t.activated ? "Activated" : "Not activated"}</Badge>
                  </div>
                </div>
                <ApproveButton profileId={t.profile_id} approved={t.approved} />
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No teacher accounts yet" />
      )}
    </div>
  );
}

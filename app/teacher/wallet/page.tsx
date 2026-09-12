import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { formatKes, REVENUE_SPLIT } from "@/lib/constants";
import { Card, Badge } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { WithdrawForm } from "./WithdrawForm";

const WITHDRAWAL_TONE = {
  pending: "warning",
  processing: "warning",
  successful: "success",
  failed: "danger",
  reversed: "danger",
} as const;

export default async function TeacherWalletPage() {
  const session = await getSessionProfile();
  const supabase = await createClient();

  const [{ data: teacherProfile }, { data: transactions }, { data: pendingTx }, { data: withdrawals }] =
    await Promise.all([
      supabase.from("teacher_profiles").select("*").eq("profile_id", session!.user.id).single(),
      supabase
        .from("payment_transactions")
        .select("*")
        .eq("teacher_id", session!.user.id)
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(20),
      supabase
        .from("payment_transactions")
        .select("amount")
        .eq("teacher_id", session!.user.id)
        .eq("status", "pending"),
      supabase
        .from("withdrawal_requests")
        .select("*")
        .eq("teacher_id", session!.user.id)
        .order("requested_at", { ascending: false }),
    ]);

  const walletBalance = teacherProfile?.wallet_balance ?? 0;
  const pendingBalance = (pendingTx ?? []).reduce(
    (sum, t) => sum + Number(t.amount) * (REVENUE_SPLIT.teacherPct / 100),
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-head text-xl font-extrabold">Wallet</h1>
        <p className="text-sm text-ink-soft">
          You keep {REVENUE_SPLIT.teacherPct}% of every payment; {REVENUE_SPLIT.platformPct}% goes to the platform.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card className="text-center">
          <p className="text-xs text-ink-faint">Available balance</p>
          <p className="font-head text-2xl font-extrabold text-[var(--success-text)]">{formatKes(walletBalance)}</p>
        </Card>
        <Card className="text-center">
          <p className="text-xs text-ink-faint">Pending (awaiting M-Pesa confirmation)</p>
          <p className="font-head text-2xl font-extrabold text-[var(--warning-text)]">{formatKes(pendingBalance)}</p>
        </Card>
      </div>

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">Withdraw funds</h2>
        <Card>
          <WithdrawForm walletBalance={walletBalance} defaultPhone={teacherProfile?.mpesa_number ?? ""} />
        </Card>
      </div>

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
          Withdrawal history
        </h2>
        {withdrawals && withdrawals.length > 0 ? (
          <div className="flex flex-col gap-2">
            {withdrawals.map((w) => (
              <Card key={w.id} className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm font-semibold">{formatKes(w.amount)}</p>
                  <p className="text-xs text-ink-faint">
                    {new Date(w.requested_at).toLocaleString("en-KE")} · {w.method} · {w.destination}
                  </p>
                </div>
                <Badge tone={WITHDRAWAL_TONE[w.status]}>{w.status}</Badge>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState title="No withdrawals yet" />
        )}
      </div>

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
          Earnings ledger
        </h2>
        {transactions && transactions.length > 0 ? (
          <div className="flex flex-col gap-2">
            {transactions.map((t) => (
              <Card key={t.id} className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-ink-faint">{new Date(t.completed_at!).toLocaleDateString("en-KE")}</p>
                  {t.provider_reference && <p className="font-mono text-xs text-ink-faint">{t.provider_reference}</p>}
                </div>
                <p className="font-mono text-sm font-semibold text-[var(--success-text)]">+{formatKes(t.teacher_share)}</p>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState title="No completed payments yet" />
        )}
      </div>
    </div>
  );
}

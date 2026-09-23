import { createClient } from "@/lib/supabase/server";
import { formatKes } from "@/lib/constants";
import { Card, Badge } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { WithdrawalActions } from "./WithdrawalActions";

const TONE = {
  pending: "warning",
  processing: "warning",
  review: "danger",
  successful: "success",
  failed: "danger",
  reversed: "danger",
} as const;

export default async function AdminWithdrawalsPage() {
  const supabase = await createClient();
  const { data: withdrawals } = await supabase
    .from("withdrawal_requests")
    .select("*, profiles(full_name)")
    .order("requested_at", { ascending: false });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-head text-xl font-extrabold">Withdrawal Requests</h1>
        <p className="text-sm text-ink-soft">
          Marking a request &ldquo;successful&rdquo; only updates this ledger — send the actual M-Pesa/bank
          payment yourself first, then record the reference here. If a payout is later clawed back
          by the provider, mark it &ldquo;reversed&rdquo; to credit the teacher&apos;s wallet back.
        </p>
      </div>

      {withdrawals && withdrawals.length > 0 ? (
        <div className="flex flex-col gap-2">
          {withdrawals.map((w) => (
            <Card key={w.id}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold">
                    {(w as unknown as { profiles: { full_name: string } | null }).profiles?.full_name}
                  </p>
                  <p className="font-mono text-sm">{formatKes(w.amount)}</p>
                  <p className="text-xs text-ink-faint">
                    {w.method} · {w.destination} · {new Date(w.requested_at).toLocaleString("en-KE")}
                  </p>
                  {w.provider_reference && <p className="text-xs text-ink-faint">Ref: {w.provider_reference}</p>}
                </div>
                <Badge tone={TONE[w.status]}>{w.status}</Badge>
              </div>
              <WithdrawalActions id={w.id} status={w.status} />
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState title="No withdrawal requests yet" />
      )}
    </div>
  );
}

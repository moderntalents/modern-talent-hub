import { createClient } from "@/lib/supabase/server";
import { formatKes } from "@/lib/constants";
import { Card, Badge } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PAYMENT_VISIBLE_COLUMNS } from "@/lib/payment-columns";

export default async function AdminTransactionsPage() {
  const supabase = await createClient();
  const { data: transactions } = await supabase
    .from("payment_transactions")
    .select(
      `${PAYMENT_VISIBLE_COLUMNS}, student:profiles!payment_transactions_student_id_fkey(full_name), teacher:profiles!payment_transactions_teacher_id_fkey(full_name)` as const,
    )
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-head text-xl font-extrabold">Transaction Log</h1>
      {transactions && transactions.length > 0 ? (
        <div className="flex flex-col gap-2">
          {transactions.map((t) => {
            const student = (t as unknown as { student: { full_name: string } | null }).student;
            const teacher = (t as unknown as { teacher: { full_name: string } | null }).teacher;
            return (
              <Card key={t.id} className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">
                    {student?.full_name} → {teacher?.full_name}
                  </p>
                  <p className="text-xs text-ink-faint">
                    {new Date(t.created_at).toLocaleString("en-KE")}
                    {t.provider_reference ? ` · ${t.provider_reference}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm font-semibold">{formatKes(t.amount)}</p>
                  <Badge tone={t.status === "completed" ? "success" : t.status === "failed" ? "danger" : "warning"}>
                    {t.status}
                  </Badge>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No transactions yet" />
      )}
    </div>
  );
}

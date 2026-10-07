import { createClient } from "@/lib/supabase/server";
import { Card, Badge } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PAYMENT_VISIBLE_COLUMNS } from "@/lib/payment-columns";
import { PaymentBreakdown } from "@/components/payments/PaymentBreakdown";

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
              <Card key={t.id} className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold">
                      {student?.full_name} → {teacher?.full_name}
                    </p>
                    <p className="break-words text-xs text-ink-faint">
                      {new Date(t.created_at).toLocaleString("en-KE")}
                      {t.provider_reference ? ` · Ref ${t.provider_reference}` : " · No reference yet"}
                    </p>
                  </div>
                  <Badge tone={t.status === "completed" ? "success" : t.status === "failed" ? "danger" : "warning"}>
                    {t.status}
                  </Badge>
                </div>
                <PaymentBreakdown
                  gross={Number(t.expected_amount ?? t.amount)}
                  teacherShare={Number(t.teacher_share)}
                  platformShare={Number(t.platform_share)}
                  teacherPct={t.teacher_pct}
                  platformPct={t.platform_pct}
                  completed={t.status === "completed"}
                />
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

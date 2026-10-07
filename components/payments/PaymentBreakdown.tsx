import { formatKes } from "@/lib/constants";

// One payment, laid out the same everywhere it is shown (admin log, coach earnings): the gross amount the
// student/parent paid and how it was shared. The shares come from the payment row itself (set by the database
// when the payment completes: 70% coach, remainder MTH), never recalculated here.
export interface PaymentBreakdownProps {
  gross: number;
  teacherShare: number;
  platformShare: number;
  teacherPct: number | null;
  platformPct: number | null;
  completed: boolean;
}

export function PaymentBreakdown({ gross, teacherShare, platformShare, teacherPct, platformPct, completed }: PaymentBreakdownProps) {
  const cell = (label: string, value: string, tone?: string) => (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className={`font-mono text-sm font-semibold ${tone ?? ""}`}>{value}</dd>
    </div>
  );
  return (
    <dl className="grid grid-cols-3 gap-2">
      {cell("Paid", formatKes(gross))}
      {cell(`Coach ${teacherPct ?? 70}%`, completed ? formatKes(teacherShare) : "—", completed ? "text-[var(--success-text)]" : "")}
      {cell(`MTH ${platformPct ?? 30}%`, completed ? formatKes(platformShare) : "—")}
    </dl>
  );
}

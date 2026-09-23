import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { activateCoachForFree } from "@/lib/activation";
import { getSessionProfile } from "@/lib/auth";
import { formatKes } from "@/lib/constants";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PAYMENT_VISIBLE_COLUMNS } from "@/lib/payment-columns";

export default async function TeacherHome() {
  const session = await getSessionProfile();
  const supabase = await createClient();

  const [{ data: teacherProfile }, { count: lessonCount }, { count: activeStudents }, { data: recentTx }] =
    await Promise.all([
      supabase.from("teacher_profiles").select("*").eq("profile_id", session!.user.id).single(),
      supabase.from("lessons").select("*", { count: "exact", head: true }).eq("teacher_id", session!.user.id),
      supabase
        .from("subscriptions")
        .select("*", { count: "exact", head: true })
        .eq("teacher_id", session!.user.id)
        .eq("status", "active"),
      supabase
        .from("payment_transactions")
        .select(PAYMENT_VISIBLE_COLUMNS)
        .eq("teacher_id", session!.user.id)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

  if (!teacherProfile?.activated) {
    // Free mode (payments off): activate on the spot. No-op once payments are on.
    if (teacherProfile && (await activateCoachForFree(session!.user.id))) redirect("/teacher");

    return (
      <EmptyState
        title="Activate your coach account"
        description="Pay the one-time activation fee via M-Pesa to unlock your coach dashboard."
        action={<LinkButton href="/teacher/activate">Activate account</LinkButton>}
      />
    );
  }

  if (!teacherProfile?.approved) {
    return (
      <EmptyState
        title="Your teacher account is pending approval"
        description="An admin needs to review and approve your account before you can publish lessons or activities. You can still prepare drafts in the meantime."
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-head text-xl font-extrabold">Karibu, {session!.profile.full_name.split(" ")[0]}</h1>
        <p className="text-sm text-ink-soft">Your teaching &amp; earnings overview.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card>
          <p className="text-2xl font-extrabold text-[var(--success-text)]">{formatKes(teacherProfile.wallet_balance)}</p>
          <p className="text-xs text-ink-faint">Wallet balance</p>
        </Card>
        <Card>
          <p className="text-2xl font-extrabold">{lessonCount ?? 0}</p>
          <p className="text-xs text-ink-faint">Lessons</p>
        </Card>
        <Card>
          <p className="text-2xl font-extrabold">{activeStudents ?? 0}</p>
          <p className="text-xs text-ink-faint">Active students</p>
        </Card>
      </div>

      <div className="flex gap-3">
        <Link href="/teacher/lessons/new" className="text-sm font-semibold text-brand-cyan-deep">
          + New lesson
        </Link>
        <Link href="/teacher/activities/new" className="text-sm font-semibold text-brand-cyan-deep">
          + New activity
        </Link>
      </div>

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">
          Recent payments
        </h2>
        {recentTx && recentTx.length > 0 ? (
          <div className="flex flex-col gap-2">
            {recentTx.map((t) => (
              <Card key={t.id} className="flex items-center justify-between">
                <p className="text-sm">{new Date(t.created_at).toLocaleDateString("en-KE")}</p>
                <p className="font-mono text-sm font-semibold">
                  {t.status === "completed" ? `+${formatKes(t.teacher_share)}` : t.status}
                </p>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState title="No payments yet" description="Once a student subscribes and pays, you'll see it here." />
        )}
      </div>
    </div>
  );
}

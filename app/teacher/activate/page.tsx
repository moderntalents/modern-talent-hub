import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { getCoachActivationFee } from "@/lib/settings";
import { activateCoachForFree } from "@/lib/activation";
import { formatKes } from "@/lib/constants";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ActivateForm } from "./ActivateForm";

export default async function ActivatePage() {
  const session = await getSessionProfile();
  const supabase = await createClient();

  const { data: coach } = await supabase
    .from("teacher_profiles")
    .select("activated")
    .eq("profile_id", session!.user.id)
    .single();

  if (coach?.activated) redirect("/teacher");

  // Free mode (payments off): no fee to pay — activate and continue.
  if (await activateCoachForFree(session!.user.id)) redirect("/teacher");

  let fee: number | null = null;
  try {
    fee = await getCoachActivationFee();
  } catch (err) {
    console.error("[teacher/activate] fee lookup failed:", err);
  }

  if (fee === null) {
    return (
      <EmptyState
        title="Activation isn't open yet"
        description="The activation fee hasn't been set up. Please check back soon or contact support."
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <div>
        <h1 className="font-head text-xl font-extrabold">Activate your coach account</h1>
        <p className="text-sm text-ink-soft">A one-time payment unlocks your coach dashboard.</p>
      </div>
      <Card className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm text-ink-soft">Activation fee</p>
          <p className="font-mono text-2xl font-extrabold">{formatKes(fee)}</p>
        </div>
        <ActivateForm feeLabel={formatKes(fee)} />
      </Card>
    </div>
  );
}

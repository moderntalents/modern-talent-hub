import { createClient } from "@/lib/supabase/server";
import { PAYMENTS_ENABLED_KEY, REVENUE_SPLIT } from "@/lib/constants";
import { Card, Badge } from "@/components/ui/Card";
import { PaymentsToggle } from "./PaymentsToggle";

export default async function AdminSettingsPage() {
  const supabase = await createClient();
  const { data: paymentsSetting } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", PAYMENTS_ENABLED_KEY)
    .maybeSingle();

  const paymentsOn = paymentsSetting?.value === true;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-head text-xl font-extrabold">Platform Settings</h1>

      <Card className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-head text-base font-bold">Payments</h2>
            <p className="text-xs text-ink-faint">
              {paymentsOn
                ? "Students pay for priced activities. Coaches never pay to join or to post."
                : "Everything is free: students join any activity without paying."}
            </p>
          </div>
          <Badge tone={paymentsOn ? "success" : "warning"}>{paymentsOn ? "ON" : "OFF — free mode"}</Badge>
        </div>
        <PaymentsToggle enabled={paymentsOn} />
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="font-head text-base font-bold">Revenue share</h2>
        <p className="text-sm text-ink-soft">
          Every student payment is split {REVENUE_SPLIT.teacherPct}% to the coach or teacher and{" "}
          {REVENUE_SPLIT.platformPct}% to Modern Talent Hub. Posting lessons and activities is free.
        </p>
      </Card>
    </div>
  );
}

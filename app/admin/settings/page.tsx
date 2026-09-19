import { createClient } from "@/lib/supabase/server";
import { COACH_ACTIVATION_FEE_KEY, PAYMENTS_ENABLED_KEY, formatKes } from "@/lib/constants";
import { isValidActivationFee } from "@/lib/settings";
import { Card, Badge } from "@/components/ui/Card";
import { ActivationFeeForm } from "./ActivationFeeForm";
import { PaymentsToggle } from "./PaymentsToggle";

const asFee = (v: unknown) => (isValidActivationFee(v) ? formatKes(v) : "—");

export default async function AdminSettingsPage() {
  const supabase = await createClient();

  const [{ data: paymentsSetting }, { data: setting }, { data: history }] = await Promise.all([
    supabase.from("platform_settings").select("value").eq("key", PAYMENTS_ENABLED_KEY).maybeSingle(),
    supabase.from("platform_settings").select("value, updated_at").eq("key", COACH_ACTIVATION_FEE_KEY).maybeSingle(),
    supabase
      .from("platform_settings_history")
      .select("id, old_value, new_value, changed_at, profiles(full_name)")
      .eq("key", COACH_ACTIVATION_FEE_KEY)
      .order("changed_at", { ascending: false })
      .limit(10),
  ]);

  const paymentsOn = paymentsSetting?.value === true;
  const stored = setting?.value;
  const currentFee = isValidActivationFee(stored) ? stored : null;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-head text-xl font-extrabold">Platform Settings</h1>

      <Card className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-head text-base font-bold">Payments</h2>
            <p className="text-xs text-ink-faint">
              {paymentsOn
                ? "Coaches pay the activation fee and students pay for priced activities."
                : "Everything is free: coaches activate instantly and students join any activity without paying."}
            </p>
          </div>
          <Badge tone={paymentsOn ? "success" : "warning"}>{paymentsOn ? "ON" : "OFF — free mode"}</Badge>
        </div>
        <PaymentsToggle enabled={paymentsOn} />
      </Card>

      <Card className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-head text-base font-bold">Coach activation fee</h2>
            <p className="text-xs text-ink-faint">
              One-time M-Pesa payment a coach makes to activate their account.
            </p>
          </div>
          {currentFee === null ? (
            <Badge tone="warning">Not set</Badge>
          ) : (
            <span className="font-mono text-lg font-bold">{formatKes(currentFee)}</span>
          )}
        </div>

        {currentFee === null && (
          <p className="text-sm text-ink-soft">
            No fee is set, so coaches can&apos;t pay to activate yet. Set one below.
          </p>
        )}

        <ActivationFeeForm currentFee={currentFee} />
      </Card>

      <div>
        <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">Change history</h2>
        {history && history.length > 0 ? (
          <div className="flex flex-col gap-2">
            {history.map((h) => {
              const who = (h as unknown as { profiles: { full_name: string } | null }).profiles?.full_name;
              return (
                <Card key={h.id} className="flex items-center justify-between gap-3">
                  <p className="text-sm">
                    <span className="text-ink-faint">{asFee(h.old_value)}</span> → <strong>{asFee(h.new_value)}</strong>
                  </p>
                  <p className="text-right text-xs text-ink-faint">
                    {who ?? "System"} · {new Date(h.changed_at).toLocaleString("en-KE")}
                  </p>
                </Card>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-ink-faint">No changes recorded yet.</p>
        )}
      </div>
    </div>
  );
}

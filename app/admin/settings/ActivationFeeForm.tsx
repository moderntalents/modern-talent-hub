"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { ACTIVATION_FEE_LIMITS } from "@/lib/constants";
import { updateActivationFee, type SettingsActionState } from "./actions";

export function ActivationFeeForm({ currentFee }: { currentFee: number | null }) {
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(updateActivationFee, null);

  return (
    <form action={action} className="flex flex-col gap-3">
      <Field
        label="Coach activation fee (KSh)"
        htmlFor="fee"
        hint="Whole shillings. Charged via M-Pesa STK Push the next time a coach activates."
      >
        <Input
          id="fee"
          name="fee"
          type="number"
          inputMode="numeric"
          step={1}
          min={ACTIVATION_FEE_LIMITS.min}
          max={ACTIVATION_FEE_LIMITS.max}
          defaultValue={currentFee ?? ""}
          placeholder="e.g. 1500"
          required
        />
      </Field>
      <div>
        <Button type="submit" loading={pending}>
          Save fee
        </Button>
      </div>
      {state?.ok && <p className="text-sm font-medium text-[var(--success-text)]">{state.message}</p>}
      {state && !state.ok && <ErrorBanner message={state.message} />}
    </form>
  );
}

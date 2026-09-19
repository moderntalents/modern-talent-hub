"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { setPaymentsEnabled } from "./actions";

export function PaymentsToggle({ enabled }: { enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    if (
      !enabled &&
      !window.confirm(
        "Turn payments ON? Coaches will have to pay the activation fee and students will be charged for priced activities.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await setPaymentsEnabled(!enabled);
      if (result && !result.ok) setError(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant={enabled ? "outline" : "primary"} loading={pending} onClick={toggle}>
          {enabled ? "Turn payments OFF (make everything free)" : "Turn payments ON"}
        </Button>
      </div>
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

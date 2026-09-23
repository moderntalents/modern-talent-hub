"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import type { GuardianMessagingStatus } from "@/lib/messaging-permission";
import { requestMessagingPermission } from "./actions";

// Shown on the Messages page to an under-18 whose parent or guardian hasn't allowed private messaging.
// Everything else in their account works as normal.
export function MessagingPermissionPanel({
  status,
  emailActive,
  maskedGuardianEmail,
}: {
  status: GuardianMessagingStatus;
  emailActive: boolean; // a messaging request is out and can still be answered
  maskedGuardianEmail: string;
}) {
  const router = useRouter();
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function ask() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const r = await requestMessagingPermission();
      router.refresh();
      if (r.ok) setInfo(r.message);
      else setError(r.message);
    });
  }

  const explanation = emailActive
    ? `We've emailed ${maskedGuardianEmail}. Messaging switches on as soon as they choose Allow.`
    : status === "declined"
      ? "Your parent or guardian chose not to allow messaging. You can talk to them and ask again."
      : status === "withdrawn"
        ? "Your parent or guardian has switched messaging off. You can talk to them and ask again."
        : "Because you're under 18, your parent or guardian needs to allow private messages with your teachers.";

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div>
          <p className="font-head text-base font-bold">Messaging needs your parent or guardian&apos;s permission</p>
          <p className="mt-1 text-sm text-ink-soft">{explanation}</p>
          <p className="mt-1 text-xs text-ink-faint">
            The rest of your account works as normal. When you turn 18, messaging switches on automatically.
          </p>
        </div>
        {info && (
          <p className="rounded-xl bg-success-tint px-4 py-3 text-sm font-medium text-[var(--success-text)]">{info}</p>
        )}
        {error && <ErrorBanner message={error} />}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" onClick={ask} loading={pending} className="sm:flex-1">
            {emailActive ? "Send the email again" : "Ask my parent to allow messaging"}
          </Button>
          {emailActive && (
            <Button type="button" variant="outline" onClick={() => router.refresh()} className="sm:flex-1">
              They allowed it — check again
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

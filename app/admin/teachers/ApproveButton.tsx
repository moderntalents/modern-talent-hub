"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { setTeacherApproval } from "./actions";

export function ApproveButton({ profileId, approved }: { profileId: string; approved: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant={approved ? "outline" : "primary"}
        loading={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await setTeacherApproval(profileId, !approved);
            if (!result.ok) setError(result.message);
          });
        }}
      >
        {approved ? "Revoke approval" : "Approve"}
      </Button>
      {error && <p className="max-w-56 text-right text-xs font-medium text-[var(--danger-text)]">{error}</p>}
    </div>
  );
}

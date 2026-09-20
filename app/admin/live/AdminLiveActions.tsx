"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { endLiveSession, removeLiveSession, type LiveActionResult } from "@/lib/live/actions";

// Admin controls for one live session: end a running class, or remove the record.
export function AdminLiveActions({ sessionId, isLive }: { sessionId: string; isLive: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<LiveActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.message);
      else router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {isLive && (
          <Button
            variant="outline"
            loading={pending}
            onClick={() => {
              if (window.confirm("End this live class for everyone?")) run(() => endLiveSession(sessionId));
            }}
          >
            End
          </Button>
        )}
        <Button
          variant="danger"
          loading={pending}
          onClick={() => {
            if (window.confirm("Remove this live session? The lesson/activity itself stays.")) {
              run(() => removeLiveSession(sessionId));
            }
          }}
        >
          Remove
        </Button>
      </div>
      {error && <p className="max-w-56 text-right text-xs font-medium text-[var(--danger-text)]">{error}</p>}
    </div>
  );
}

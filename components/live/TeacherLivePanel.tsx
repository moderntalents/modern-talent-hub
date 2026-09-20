"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { endLiveSession, removeLiveSession, startLiveSession, type LiveActionResult } from "@/lib/live/actions";
import type { LiveStatus } from "@/lib/live/status";
import { AutoRefresh } from "./AutoRefresh";
import { LiveBadge } from "./LiveBadge";

export interface ParticipantRow {
  id: string;
  name: string;
  joinedLabel: string;
}

// The teacher's controls for a live class: start it, open the room, end it,
// and see which students have joined.
export function TeacherLivePanel({
  sessionId,
  status,
  scheduledLabel,
  durationMinutes,
  participants,
  noun,
  hideRoomLink = false,
}: {
  sessionId: string;
  status: LiveStatus;
  scheduledLabel: string;
  durationMinutes: number;
  participants: ParticipantRow[];
  noun: "lesson" | "activity";
  hideRoomLink?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<LiveActionResult>, onSuccess: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onSuccess();
    });
  }

  return (
    <Card className="flex flex-col gap-4">
      <AutoRefresh seconds={10} enabled={status === "live"} />

      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-head text-base font-bold">Live {noun}</h2>
          <p className="text-sm text-ink-soft">
            {scheduledLabel} · {durationMinutes} min
          </p>
        </div>
        <LiveBadge status={status} />
      </div>

      <div className="flex flex-wrap gap-2">
        {status === "upcoming" && (
          <Button
            loading={pending}
            onClick={() => run(() => startLiveSession(sessionId), () => router.push(`/teacher/live/${sessionId}`))}
          >
            Start live {noun}
          </Button>
        )}

        {status === "live" && (
          <>
            {!hideRoomLink && <LinkButton href={`/teacher/live/${sessionId}`}>Open live room</LinkButton>}
            <Button
              variant="danger"
              loading={pending}
              onClick={() => {
                if (!window.confirm(`End this live ${noun} for everyone?`)) return;
                run(() => endLiveSession(sessionId), () => router.refresh());
              }}
            >
              End live {noun}
            </Button>
          </>
        )}

        {status !== "live" && (
          <Button
            variant="outline"
            loading={pending}
            onClick={() => {
              if (!window.confirm(`Remove this live session? The ${noun} itself stays.`)) return;
              run(() => removeLiveSession(sessionId), () => router.refresh());
            }}
          >
            Remove live session
          </Button>
        )}
      </div>

      {status === "upcoming" && (
        <p className="text-xs text-ink-faint">
          Students see this as UPCOMING until you press Start, then they can join. You can start at any time.
        </p>
      )}
      {status === "ended" && <p className="text-xs text-ink-faint">This live {noun} has ended.</p>}

      {error && <ErrorBanner message={error} />}

      <div>
        <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-faint">
          Students who joined ({participants.length})
        </h3>
        {participants.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {participants.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                <span>{p.name}</span>
                <span className="text-xs text-ink-faint">{p.joinedLabel}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-faint">No students have joined yet.</p>
        )}
      </div>
    </Card>
  );
}

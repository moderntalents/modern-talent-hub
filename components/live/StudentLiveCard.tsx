import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { LiveStatus } from "@/lib/live/status";
import { AutoRefresh } from "./AutoRefresh";
import { LiveBadge } from "./LiveBadge";

// What a student sees on a live lesson / activity: the status, when it is, and
// a Join button once it's LIVE.
export function StudentLiveCard({
  sessionId,
  status,
  scheduledLabel,
  durationMinutes,
  noun,
  joinBlockedReason,
}: {
  sessionId: string;
  status: LiveStatus;
  scheduledLabel: string;
  durationMinutes: number;
  noun: "lesson" | "activity";
  /** Set when the student can't join yet (e.g. not enrolled) — shown instead of the button. */
  joinBlockedReason?: string;
}) {
  return (
    <Card className="flex flex-col gap-3">
      {/* Flips UPCOMING -> LIVE (and LIVE -> ENDED) without a reload. */}
      <AutoRefresh seconds={20} enabled={status !== "ended"} />

      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-head text-base font-bold">Live {noun}</h2>
          <p className="text-sm text-ink-soft">
            {scheduledLabel} · {durationMinutes} min
          </p>
        </div>
        <LiveBadge status={status} />
      </div>

      {status === "live" &&
        (joinBlockedReason ? (
          <p className="text-sm font-medium text-ink-soft">{joinBlockedReason}</p>
        ) : (
          <div>
            <LinkButton href={`/student/live/${sessionId}`}>Join Live Class</LinkButton>
          </div>
        ))}
      {status === "upcoming" && (
        <p className="text-sm text-ink-soft">
          Not started yet. This page updates by itself — the Join button appears when the teacher starts the class.
        </p>
      )}
      {status === "ended" && <p className="text-sm text-ink-soft">This live class has ended.</p>}
    </Card>
  );
}

import { LIVE_STATUS_LABEL, type LiveStatus } from "@/lib/live/status";

const TONES: Record<LiveStatus, string> = {
  upcoming: "bg-[var(--info-tint)] text-[var(--info-text)]",
  live: "bg-[var(--danger-tint)] text-[var(--danger-text)]",
  ended: "bg-surface-2 text-ink-faint",
};

// UPCOMING / LIVE / ENDED — same pill shape as the app's other badges.
export function LiveBadge({ status }: { status: LiveStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${TONES[status]}`}>
      {status === "live" && <span className="h-2 w-2 animate-pulse rounded-full bg-current" />}
      {LIVE_STATUS_LABEL[status]}
    </span>
  );
}

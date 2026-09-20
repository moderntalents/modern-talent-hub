// Pure helpers (safe on server and client) for how a live session is described.

export type LiveStatus = "upcoming" | "live" | "ended";

export interface LiveSessionLike {
  status: "scheduled" | "live" | "ended";
  scheduled_at: string;
  duration_minutes: number;
  started_at: string | null;
}

export const LIVE_STATUS_LABEL: Record<LiveStatus, string> = {
  upcoming: "UPCOMING",
  live: "LIVE",
  ended: "ENDED",
};

const MINUTE = 60_000;
// A class that runs over its planned length still counts as live for a while
// (the video room itself is created to last duration + this grace).
export const LIVE_GRACE_MINUTES = 30;
// A class the teacher never started is shown as ended once it's well past its slot.
const MISSED_AFTER_MINUTES = 60;

/**
 * What students should be shown. The stored status is what the teacher last did
 * (scheduled / live / ended); this also covers sessions nobody remembered to end
 * and classes that were never started, so nothing shows "LIVE" forever.
 */
export function effectiveLiveStatus(session: LiveSessionLike, now: number = Date.now()): LiveStatus {
  if (session.status === "ended") return "ended";

  const duration = session.duration_minutes * MINUTE;

  if (session.status === "live") {
    const start = Date.parse(session.started_at ?? session.scheduled_at);
    return now > start + duration + LIVE_GRACE_MINUTES * MINUTE ? "ended" : "live";
  }

  return now > Date.parse(session.scheduled_at) + duration + MISSED_AFTER_MINUTES * MINUTE ? "ended" : "upcoming";
}

/** e.g. "Sat, 20 Sep, 3:00 pm" — always East Africa Time, the app's home timezone. */
export function formatSchedule(iso: string): string {
  return new Date(iso)
    .toLocaleString("en-KE", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Africa/Nairobi",
    })
    .replace(/\s+/g, " ");
}

export const DURATION_OPTIONS = [30, 45, 60, 90, 120] as const;

/** Reads the schedule fields from a create-lesson / create-activity form. */
export function parseSchedule(
  formData: FormData,
): { scheduledAt: string; durationMinutes: number } | { error: string } {
  const raw = String(formData.get("scheduledAt") ?? "");
  const time = Date.parse(raw);
  if (!raw || Number.isNaN(time)) return { error: "Choose the date and time for the live class." };
  if (time < Date.now() - 5 * MINUTE) return { error: "The live class time must be in the future." };
  if (time > Date.now() + 366 * 24 * 60 * MINUTE) return { error: "The live class can be at most a year away." };

  const duration = Number(formData.get("durationMinutes"));
  if (!Number.isInteger(duration) || duration < 5 || duration > 240) {
    return { error: "Choose how long the live class will last." };
  }

  return { scheduledAt: new Date(time).toISOString(), durationMinutes: duration };
}

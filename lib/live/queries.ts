import "server-only";
import { createClient } from "@/lib/supabase/server";
import { formatSchedule } from "@/lib/live/status";
import type { ParticipantRow } from "@/components/live/TeacherLivePanel";

export interface LiveSummary {
  id: string;
  status: "scheduled" | "live" | "ended";
  scheduled_at: string;
  duration_minutes: number;
  started_at: string | null;
}

/**
 * Live session (if any) for each of the given lessons or activities, keyed by
 * the lesson/activity id. Deliberately a separate, error-tolerant query rather
 * than an embed in the list queries: if the live tables aren't there, the
 * result is simply "nothing is live" and the existing lists render as before.
 */
export async function getLiveSummaries(
  kind: "lesson" | "activity",
  parentIds: string[],
): Promise<Map<string, LiveSummary>> {
  const byParent = new Map<string, LiveSummary>();
  if (parentIds.length === 0) return byParent;

  const supabase = await createClient();
  const { data } = await supabase
    .from("live_sessions")
    .select("id, lesson_id, activity_id, status, scheduled_at, duration_minutes, started_at")
    .in(kind === "lesson" ? "lesson_id" : "activity_id", parentIds);

  for (const row of data ?? []) {
    const parent = kind === "lesson" ? row.lesson_id : row.activity_id;
    if (parent) byParent.set(parent, row);
  }
  return byParent;
}

/** The students who have joined a session, oldest first. RLS limits this to the session's teacher and admins. */
export async function getParticipantRows(sessionId: string): Promise<ParticipantRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("live_session_participants")
    .select("id, joined_at, profiles(full_name)")
    .eq("session_id", sessionId)
    .order("joined_at");

  return (data ?? []).map((p) => ({
    id: p.id,
    name: (p as unknown as { profiles: { full_name: string } | null }).profiles?.full_name ?? "Student",
    joinedLabel: formatSchedule(p.joined_at),
  }));
}

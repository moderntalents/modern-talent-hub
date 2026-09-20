"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMeetingToken, createRoom, deleteRoom, isLiveConfigured, roomUrl } from "@/lib/live/daily";
import { effectiveLiveStatus, LIVE_GRACE_MINUTES } from "@/lib/live/status";

// Every live-class action lives here. Each one works out WHO is asking (teacher /
// student / admin) from their login, checks the rule for that action, and only
// then writes with the service role. Failures come back as { ok: false, message }
// rather than thrown errors, so the page can show the reason (production hides
// thrown server-action errors behind a generic screen).

export type LiveActionResult = { ok: true; url?: string } | { ok: false; message: string };

const fail = (message: string): LiveActionResult => ({ ok: false, message });

async function loadContext(sessionId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in required." } as const;

  const { data: profile } = await supabase.from("profiles").select("role, full_name").eq("id", user.id).single();
  if (!profile) return { error: "Your profile couldn't be found." } as const;

  const admin = createAdminClient();
  const { data: session } = await admin.from("live_sessions").select("*").eq("id", sessionId).maybeSingle();
  if (!session) return { error: "This live class no longer exists." } as const;

  return { admin, user, profile, session } as const;
}

async function isApprovedTeacher(admin: ReturnType<typeof createAdminClient>, userId: string) {
  const { data } = await admin.from("teacher_profiles").select("approved").eq("profile_id", userId).maybeSingle();
  return data?.approved === true;
}

// A student may join a live LESSON if the lesson is published, and a live
// ACTIVITY if it is published and they're enrolled (active subscription).
async function studentJoinProblem(
  admin: ReturnType<typeof createAdminClient>,
  session: { kind: "lesson" | "activity"; lesson_id: string | null; activity_id: string | null },
  studentId: string,
): Promise<string | null> {
  if (session.kind === "lesson") {
    const { data } = await admin.from("lessons").select("status").eq("id", session.lesson_id!).maybeSingle();
    return data?.status === "published" ? null : "This lesson isn't available.";
  }

  const { data: activity } = await admin.from("activities").select("status").eq("id", session.activity_id!).maybeSingle();
  if (activity?.status !== "published") return "This activity isn't available.";

  const { data: subscription } = await admin
    .from("subscriptions")
    .select("status")
    .eq("activity_id", session.activity_id!)
    .eq("student_id", studentId)
    .maybeSingle();
  return subscription?.status === "active" ? null : "Enrol in this activity to join its live class.";
}

function refresh() {
  revalidatePath("/teacher", "layout");
  revalidatePath("/student", "layout");
  revalidatePath("/admin/live");
}

/** Teacher: opens the video room and marks the class LIVE. */
export async function startLiveSession(sessionId: string): Promise<LiveActionResult> {
  try {
    const ctx = await loadContext(sessionId);
    if ("error" in ctx) return fail(ctx.error);
    const { admin, user, profile, session } = ctx;

    if (profile.role !== "teacher" || session.teacher_id !== user.id) {
      return fail("Only the teacher who created this live class can start it.");
    }
    if (!(await isApprovedTeacher(admin, user.id))) {
      return fail("Your teacher account must be approved before you can host live classes.");
    }
    if (session.status === "ended") return fail("This live class has already ended.");
    if (session.status === "live") return { ok: true };
    if (!isLiveConfigured()) return fail("Live video isn't set up on this site yet. Please contact the administrator.");

    const roomName = `mth-${session.id.replace(/-/g, "")}`;
    const now = Date.now();
    await createRoom(roomName, now + (session.duration_minutes + LIVE_GRACE_MINUTES) * 60_000);

    const { error } = await admin
      .from("live_sessions")
      .update({ status: "live", room_name: roomName, started_at: new Date(now).toISOString() })
      .eq("id", session.id)
      .eq("status", "scheduled");
    if (error) return fail(error.message);

    refresh();
    return { ok: true };
  } catch (err) {
    console.error("[live] start failed:", err);
    return fail(err instanceof Error ? err.message : "Could not start the live class.");
  }
}

/** Teacher (own class) or admin: closes the room, removes everyone, marks it ENDED. */
export async function endLiveSession(sessionId: string): Promise<LiveActionResult> {
  try {
    const ctx = await loadContext(sessionId);
    if ("error" in ctx) return fail(ctx.error);
    const { admin, user, profile, session } = ctx;

    const isOwner = profile.role === "teacher" && session.teacher_id === user.id;
    if (!isOwner && profile.role !== "admin") return fail("You can't end this live class.");
    if (session.status === "ended") return { ok: true };

    const { error } = await admin
      .from("live_sessions")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", session.id);
    if (error) return fail(error.message);

    if (session.room_name) {
      try {
        await deleteRoom(session.room_name); // ejects anyone still in the room
      } catch (err) {
        console.error("[live] room delete failed (the room will expire on its own):", err);
      }
    }

    refresh();
    return { ok: true };
  } catch (err) {
    console.error("[live] end failed:", err);
    return fail(err instanceof Error ? err.message : "Could not end the live class.");
  }
}

/** Teacher (host) or student (participant): returns the private, single-use-for-you room link. */
export async function joinLiveSession(sessionId: string): Promise<LiveActionResult> {
  try {
    const ctx = await loadContext(sessionId);
    if ("error" in ctx) return fail(ctx.error);
    const { admin, user, profile, session } = ctx;

    const state = effectiveLiveStatus(session);
    if (state === "ended") return fail("This live class has ended.");
    if (state !== "live" || !session.room_name) return fail("This live class hasn't started yet.");
    if (!isLiveConfigured()) return fail("Live video isn't set up on this site yet. Please contact the administrator.");

    let isHost = false;
    if (profile.role === "teacher") {
      if (session.teacher_id !== user.id) return fail("You can only host your own live classes.");
      if (!(await isApprovedTeacher(admin, user.id))) return fail("Your teacher account must be approved first.");
      isHost = true;
    } else if (profile.role === "student") {
      const problem = await studentJoinProblem(admin, session, user.id);
      if (problem) return fail(problem);
    } else {
      return fail("Admins manage live classes from Admin → Live. Use a teacher or student account to join a room.");
    }

    const start = Date.parse(session.started_at ?? session.scheduled_at);
    const token = await createMeetingToken({
      roomName: session.room_name,
      userName: profile.full_name,
      userId: user.id,
      isHost,
      expiresAtMs: start + (session.duration_minutes + LIVE_GRACE_MINUTES) * 60_000,
    });

    if (!isHost) {
      await admin
        .from("live_session_participants")
        .upsert(
          { session_id: session.id, profile_id: user.id, last_joined_at: new Date().toISOString() },
          { onConflict: "session_id,profile_id" },
        );
    }

    return { ok: true, url: roomUrl(session.room_name, token) };
  } catch (err) {
    console.error("[live] join failed:", err);
    return fail(err instanceof Error ? err.message : "Could not join the live class.");
  }
}

/** Admin (any) or the owning teacher (when it isn't live): deletes the live session record. */
export async function removeLiveSession(sessionId: string): Promise<LiveActionResult> {
  try {
    const ctx = await loadContext(sessionId);
    if ("error" in ctx) return fail(ctx.error);
    const { admin, user, profile, session } = ctx;

    const isOwner = profile.role === "teacher" && session.teacher_id === user.id;
    if (!isOwner && profile.role !== "admin") return fail("You can't remove this live class.");
    if (isOwner && session.status === "live") return fail("End the live class first, then you can remove it.");

    if (session.room_name && session.status === "live") {
      try {
        await deleteRoom(session.room_name);
      } catch (err) {
        console.error("[live] room delete failed (the room will expire on its own):", err);
      }
    }

    const { error } = await admin.from("live_sessions").delete().eq("id", session.id);
    if (error) return fail(error.message);

    refresh();
    return { ok: true };
  } catch (err) {
    console.error("[live] remove failed:", err);
    return fail(err instanceof Error ? err.message : "Could not remove the live class.");
  }
}

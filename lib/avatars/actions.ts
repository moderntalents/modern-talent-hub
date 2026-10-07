"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import * as service from "@/lib/avatars/service";

// Every profile-picture action a browser can call. Each one works out WHO is asking from their login
// (never from anything the browser sends) and only lets coaches (teacher accounts) in; the rules about
// what may be stored are enforced again by the service and the database. Failures come back as
// { ok: false, message } rather than thrown errors, because production hides thrown server-action
// errors behind a generic screen.

type Failure = { ok: false; message: string };
const fail = (message: string): Failure => ({ ok: false, message });
const UNEXPECTED = "Something went wrong. Please try again.";

async function loadCoach() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Please sign in again.");

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile) return fail("Your profile couldn't be found.");
  if (profile.role !== "teacher") return fail("Only coaches can have a profile picture.");

  return { ok: true as const, userId: user.id, admin: createAdminClient() };
}

/** Everywhere the picture shows has to look again: settings, the student directory, profiles and messages. */
function refresh() {
  revalidatePath("/account");
  revalidatePath("/student/teachers", "layout");
  revalidatePath("/student/messages", "layout");
  revalidatePath("/teacher/messages", "layout");
}

/** Step 1: get a one-time upload link for a server-chosen path. */
export async function prepareAvatarUpload(input: { contentType: string; size: number }): Promise<service.Result<{ path: string; token: string }>> {
  try {
    const coach = await loadCoach();
    if (!coach.ok) return coach;
    return await service.prepareAvatarUpload(coach.admin, coach.userId, { contentType: input?.contentType, size: input?.size });
  } catch (err) {
    console.error("[avatars] prepare failed:", err);
    return fail(UNEXPECTED);
  }
}

/** Step 3: after the browser has uploaded to that link, check the file and make it the profile picture. */
export async function saveAvatar(input: { path: string }): Promise<service.Result<{ path: string }>> {
  try {
    const coach = await loadCoach();
    if (!coach.ok) return coach;
    const result = await service.saveAvatar(coach.admin, coach.userId, { path: input?.path });
    if (result.ok) refresh();
    return result;
  } catch (err) {
    console.error("[avatars] save failed:", err);
    return fail(UNEXPECTED);
  }
}

/** Remove the profile picture. */
export async function removeAvatar(): Promise<service.Result> {
  try {
    const coach = await loadCoach();
    if (!coach.ok) return coach;
    const result = await service.removeAvatar(coach.admin, coach.userId);
    if (result.ok) refresh();
    return result;
  } catch (err) {
    console.error("[avatars] remove failed:", err);
    return fail(UNEXPECTED);
  }
}

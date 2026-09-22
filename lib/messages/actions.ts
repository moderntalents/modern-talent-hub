"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AGE_GATE_MESSAGE, isAgeCleared } from "@/lib/age-gate";
import { isMessagingCleared, MESSAGING_PERMISSION_MESSAGE } from "@/lib/messaging-gate";
import type { MessageKind } from "@/lib/messages/rules";
import * as service from "@/lib/messages/service";

// Every messaging action a browser can call. Each one works out WHO is asking from their login
// (never from anything the browser sends), applies the Stage 2 age gate and the messaging permission
// gate (0014: under-18s need their guardian's separate messaging permission; 18+ are allowed
// automatically), checks their role, and only then calls the service with the server's key. The rules about who may talk to whom are enforced
// again inside the database. Failures come back as { ok: false, message } rather than thrown errors,
// because production hides thrown server-action errors behind a generic screen.

type Failure = { ok: false; message: string };
const fail = (message: string): Failure => ({ ok: false, message });

async function loadCaller(allowed: readonly ("student" | "teacher")[]) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Please sign in again.");

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!profile) return fail("Your profile couldn't be found.");
  if (profile.role !== "student" && profile.role !== "teacher") return fail("Messaging is for students and teachers.");
  if (!allowed.includes(profile.role)) return fail("You can't do that with this account.");
  if (!(await isAgeCleared(user.id, profile.role))) return fail(AGE_GATE_MESSAGE);

  const admin = createAdminClient();
  if (!(await isMessagingCleared(user.id, admin))) return fail(MESSAGING_PERMISSION_MESSAGE);

  return { ok: true as const, userId: user.id, role: profile.role, admin };
}

function refresh() {
  revalidatePath("/student/messages", "layout");
  revalidatePath("/teacher/messages", "layout");
}

const UNEXPECTED = "Something went wrong. Please try again.";

/** Student, from a published lesson's page. */
export async function startConversationFromLesson(lessonId: string): Promise<service.Result<{ conversationId: string }>> {
  try {
    const caller = await loadCaller(["student"]);
    if (!caller.ok) return caller;
    const result = await service.startFromLesson(caller.admin, caller.userId, lessonId);
    if (result.ok) refresh();
    return result;
  } catch (err) {
    console.error("[messages] start from lesson failed:", err);
    return fail(UNEXPECTED);
  }
}

/** Student, from an activity they are actively subscribed to. */
export async function startConversationFromActivity(activityId: string): Promise<service.Result<{ conversationId: string }>> {
  try {
    const caller = await loadCaller(["student"]);
    if (!caller.ok) return caller;
    const result = await service.startFromActivity(caller.admin, caller.userId, activityId);
    if (result.ok) refresh();
    return result;
  } catch (err) {
    console.error("[messages] start from activity failed:", err);
    return fail(UNEXPECTED);
  }
}

/** Teacher, with one of their own active subscribers. */
export async function startConversationAsTeacher(studentId: string): Promise<service.Result<{ conversationId: string }>> {
  try {
    const caller = await loadCaller(["teacher"]);
    if (!caller.ok) return caller;
    const result = await service.startAsTeacher(caller.admin, caller.userId, studentId);
    if (result.ok) refresh();
    return result;
  } catch (err) {
    console.error("[messages] start as teacher failed:", err);
    return fail(UNEXPECTED);
  }
}

/** Step 1 of attaching a PDF: get a one-time upload link for a server-chosen path. */
export async function prepareAttachmentUpload(input: {
  conversationId: string;
  fileName: string;
  fileSize: number;
}): Promise<service.Result<{ path: string; token: string }>> {
  try {
    const caller = await loadCaller(["student", "teacher"]);
    if (!caller.ok) return caller;
    return await service.prepareAttachmentUpload(caller.admin, caller.userId, input);
  } catch (err) {
    console.error("[messages] prepare upload failed:", err);
    return fail(UNEXPECTED);
  }
}

/** Sends a message, optionally with the PDF uploaded in step 1. */
export async function sendMessage(input: {
  conversationId: string;
  body: string;
  kind: MessageKind;
  attachment?: { path: string; name: string } | null;
}): Promise<service.Result<{ messageId: string }>> {
  try {
    const caller = await loadCaller(["student", "teacher"]);
    if (!caller.ok) return caller;
    const result = await service.sendMessage(caller.admin, caller.userId, input);
    if (result.ok) revalidatePath(`/${caller.role}/messages`, "layout");
    return result;
  } catch (err) {
    console.error("[messages] send failed:", err);
    return fail(UNEXPECTED);
  }
}

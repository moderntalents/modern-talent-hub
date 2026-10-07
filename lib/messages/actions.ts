"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AGE_GATE_MESSAGE, isAgeCleared } from "@/lib/age-gate";
import type { MessageKind } from "@/lib/messages/rules";
import * as service from "@/lib/messages/service";

// Every messaging action a browser can call. Each one works out WHO is asking from their login
// (never from anything the browser sends), applies the Stage 2 age gate, checks their role, and only
// then calls the service with the server's key. The rules about who may talk to whom are enforced
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

  return { ok: true as const, userId: user.id, role: profile.role, admin: createAdminClient() };
}

function refresh() {
  revalidatePath("/student/messages", "layout");
  revalidatePath("/teacher/messages", "layout");
}

const UNEXPECTED = "Something went wrong. Please try again.";

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

/** Student, from the teacher/coach directory: a teacher they have an active subscription with. */
export async function startConversationAsStudent(teacherId: string): Promise<service.Result<{ conversationId: string }>> {
  try {
    const caller = await loadCaller(["student"]);
    if (!caller.ok) return caller;
    const result = await service.startAsStudent(caller.admin, caller.userId, teacherId);
    if (result.ok) refresh();
    return result;
  } catch (err) {
    console.error("[messages] start as student failed:", err);
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

/** Changes the text of a message the signed-in person sent. Anyone else's message is refused by the database. */
export async function editMessage(input: { messageId: string; body: string }): Promise<service.Result<{ edited: boolean }>> {
  try {
    const caller = await loadCaller(["student", "teacher"]);
    if (!caller.ok) return caller;
    const result = await service.editMessage(caller.admin, caller.userId, input);
    if (result.ok) revalidatePath(`/${caller.role}/messages`, "layout");
    return result;
  } catch (err) {
    console.error("[messages] edit failed:", err);
    return fail(UNEXPECTED);
  }
}

/** Deletes a message the signed-in person sent: its text and PDF are erased and both people see "This message was deleted". */
export async function deleteMessage(messageId: string): Promise<service.Result> {
  try {
    const caller = await loadCaller(["student", "teacher"]);
    if (!caller.ok) return caller;
    const result = await service.deleteMessage(caller.admin, caller.userId, messageId);
    if (result.ok) refresh();
    return result;
  } catch (err) {
    console.error("[messages] delete failed:", err);
    return fail(UNEXPECTED);
  }
}

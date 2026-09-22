// The messaging flows. Every function here assumes the CALLER has already been identified from
// their login (see lib/messages/actions.ts) — `userId` is never taken from the browser — and that
// they are age-cleared and have messaging permission (0014). The rules about WHO may talk to WHOM
// live in the database (supabase/migrations/0011_messaging.sql, gated by 0014) and are re-checked
// there on every call; this file adds what a database cannot: rate limits, and inspecting the
// uploaded file's real bytes.
//
// It takes the service-role client as a parameter (rather than creating one) so the tests can run
// the same code against a real Postgres.

import type { createAdminClient } from "@/lib/supabase/admin";
import {
  MAX_ATTACHMENT_BYTES,
  MESSAGE_BUCKET,
  MESSAGE_KINDS,
  type MessageKind,
  attachmentPath,
  cleanFileName,
  friendlyMessagingError,
  hasPdfHeader,
  isUuid,
  isValidAttachmentPath,
  validateBody,
  validateDeclaredFile,
} from "@/lib/messages/rules";

export type Admin = ReturnType<typeof createAdminClient>;
export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string };

const fail = (message: string) => ({ ok: false, message }) as const;

/** How fast one person may act. Fixed windows, counted in the database (hit_rate_limit from 0005). */
export const LIMITS = {
  start: { max: 30, seconds: 3600 },
  upload: { max: 20, seconds: 3600 },
  send: { max: 30, seconds: 600 },
} as const;

const TOO_FAST = "You're going a bit fast. Please wait a few minutes and try again.";

async function withinLimit(admin: Admin, kind: keyof typeof LIMITS, userId: string): Promise<boolean> {
  const limit = LIMITS[kind];
  const { data, error } = await admin.rpc("hit_rate_limit", {
    p_key: `msg-${kind}:${userId}`,
    p_max: limit.max,
    p_window_seconds: limit.seconds,
  });
  if (error) {
    console.error("[messages] rate limiter unavailable:", error.message);
    return false; // fail closed, like the sign-up and consent endpoints
  }
  return data === true;
}

/** null if this person may send into this conversation right now, otherwise the reason in plain words. */
async function sendBlocker(admin: Admin, userId: string, conversationId: string): Promise<string | null> {
  const { data, error } = await admin.rpc("messaging_can_send", { p_user: userId, p_conversation: conversationId });
  if (error) return friendlyMessagingError(error.message);
  return data === "ok" ? null : friendlyMessagingError(`messaging:${data}`);
}

// ---------------------------------------------------------------------------------------------
// Starting a conversation — three ways, and only three. The database decides each one.
// ---------------------------------------------------------------------------------------------

async function start(
  admin: Admin,
  userId: string,
  run: () => PromiseLike<{ data: string | null; error: { message: string } | null }>,
): Promise<Result<{ conversationId: string }>> {
  if (!(await withinLimit(admin, "start", userId))) return fail(TOO_FAST);
  const { data, error } = await run();
  if (error || !data) return fail(friendlyMessagingError(error?.message));
  return { ok: true, conversationId: data };
}

/** Student → the teacher of a published lesson. */
export function startFromLesson(admin: Admin, studentId: string, lessonId: string) {
  if (!isUuid(lessonId)) return Promise.resolve(fail("This lesson isn't available."));
  return start(admin, studentId, () =>
    admin.rpc("start_conversation_from_lesson", { p_student: studentId, p_lesson: lessonId }),
  );
}

/** Student → the teacher of an activity they have an active subscription to. */
export function startFromActivity(admin: Admin, studentId: string, activityId: string) {
  if (!isUuid(activityId)) return Promise.resolve(fail("This activity isn't available."));
  return start(admin, studentId, () =>
    admin.rpc("start_conversation_from_activity", { p_student: studentId, p_activity: activityId }),
  );
}

/** Teacher → one of their own active subscribers. */
export function startAsTeacher(admin: Admin, teacherId: string, studentId: string) {
  if (!isUuid(studentId)) return Promise.resolve(fail("That student couldn't be found."));
  return start(admin, teacherId, () =>
    admin.rpc("start_conversation_as_teacher", { p_teacher: teacherId, p_student: studentId }),
  );
}

// ---------------------------------------------------------------------------------------------
// Attachments: the server chooses the path, the browser uploads to it once, the server inspects it.
// ---------------------------------------------------------------------------------------------

/**
 * Step 1 of attaching a PDF. Checks the person may send here, then hands back a ONE-TIME upload
 * link for a path the server picked (<conversation>/<random>.pdf). The browser never chooses a path,
 * and the bucket itself refuses anything over 10 MB or not sent as a PDF.
 */
export async function prepareAttachmentUpload(
  admin: Admin,
  userId: string,
  input: { conversationId: string; fileName: string; fileSize: number },
): Promise<Result<{ path: string; token: string }>> {
  if (!isUuid(input.conversationId)) return fail("That conversation couldn't be found.");
  const problem = validateDeclaredFile({ name: String(input.fileName), size: Number(input.fileSize) });
  if (problem) return fail(problem);

  const blocked = await sendBlocker(admin, userId, input.conversationId);
  if (blocked) return fail(blocked);
  if (!(await withinLimit(admin, "upload", userId))) return fail(TOO_FAST);

  const path = attachmentPath(input.conversationId.toLowerCase(), crypto.randomUUID());
  const { data, error } = await admin.storage.from(MESSAGE_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    console.error("[messages] could not create an upload link:", error?.message);
    return fail("We couldn't start the upload. Please try again.");
  }
  return { ok: true, path, token: data.token };
}

/** Removes an uploaded file that ended up not being sent — but never one that a message is using. */
async function discardUnusedUpload(admin: Admin, path: string) {
  const { data: inUse } = await admin.rpc("attachment_in_use", { p_path: path });
  if (inUse === false) {
    const { error } = await admin.storage.from(MESSAGE_BUCKET).remove([path]);
    if (error) console.error("[messages] could not remove an unsent upload:", error.message);
  }
}

/**
 * Step 2: look at what was ACTUALLY uploaded, not what the browser claimed. Must exist, be between
 * 1 byte and 10 MB, and start with the PDF signature. Anything else is deleted on the spot.
 */
async function inspectUpload(admin: Admin, path: string): Promise<Result<{ size: number }>> {
  const { data: blob, error } = await admin.storage.from(MESSAGE_BUCKET).download(path);
  if (error || !blob) return fail("We couldn't find your uploaded file. Please attach it again.");

  if (blob.size <= 0 || blob.size > MAX_ATTACHMENT_BYTES) {
    await discardUnusedUpload(admin, path);
    return fail(blob.size <= 0 ? "That file is empty." : "That PDF is over 10 MB. Please send a smaller file.");
  }
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (!hasPdfHeader(head)) {
    await discardUnusedUpload(admin, path);
    return fail("That file isn't a valid PDF.");
  }
  return { ok: true, size: blob.size };
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

export interface SendInput {
  conversationId: string;
  body: string;
  kind: MessageKind;
  attachment?: { path: string; name: string } | null;
}

export async function sendMessage(admin: Admin, userId: string, input: SendInput): Promise<Result<{ messageId: string }>> {
  if (!isUuid(input.conversationId)) return fail("That conversation couldn't be found.");
  if (typeof input.body !== "string") return fail("Write a message or attach a PDF.");
  if (!MESSAGE_KINDS.includes(input.kind)) return fail("That message couldn't be sent.");
  const bodyProblem = validateBody(input.body);
  if (bodyProblem) return fail(bodyProblem);

  const attachment = input.attachment ?? null;
  if (attachment && !isValidAttachmentPath(input.conversationId, attachment.path)) {
    return fail("That file couldn't be attached. Please choose the PDF again.");
  }
  if (!attachment && input.body.trim() === "") return fail("Write a message or attach a PDF.");

  const blocked = await sendBlocker(admin, userId, input.conversationId);
  if (blocked) return fail(blocked);
  if (!(await withinLimit(admin, "send", userId))) return fail(TOO_FAST);

  let size: number | null = null;
  if (attachment) {
    // A file already used by a message can never be attached to another one.
    const { data: inUse } = await admin.rpc("attachment_in_use", { p_path: attachment.path });
    if (inUse !== false) return fail("That file couldn't be attached. Please choose the PDF again.");

    const inspected = await inspectUpload(admin, attachment.path);
    if (!inspected.ok) return inspected;
    size = inspected.size;
  }

  const { data, error } = await admin.rpc("send_message", {
    p_sender: userId,
    p_conversation: input.conversationId,
    p_body: input.body,
    p_kind: input.kind,
    p_attachment_path: attachment?.path ?? null,
    p_attachment_name: attachment ? cleanFileName(attachment.name) : null,
    p_attachment_size: size,
  });

  if (error || !data) {
    if (attachment) await discardUnusedUpload(admin, attachment.path);
    return fail(friendlyMessagingError(error?.message));
  }
  return { ok: true, messageId: data };
}

// ---------------------------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------------------------

export type AttachmentLookup = (messageId: string) => PromiseLike<{ attachment_path: string | null; attachment_name: string | null } | null>;

/** How long a download link lives. Long enough for the browser to start the download, no longer. */
export const DOWNLOAD_LINK_SECONDS = 60;

/**
 * A short-lived link to one attachment, or null. `lookup` MUST read the message as the signed-in
 * person (through row-level security), so a message that isn't theirs simply isn't found; the link
 * itself is then created with the server's key. There is no way to get a link from a file path.
 */
export async function attachmentDownloadUrl(admin: Admin, lookup: AttachmentLookup, messageId: string): Promise<string | null> {
  if (!isUuid(messageId)) return null;
  const row = await lookup(messageId);
  if (!row?.attachment_path) return null;

  const { data, error } = await admin.storage
    .from(MESSAGE_BUCKET)
    .createSignedUrl(row.attachment_path, DOWNLOAD_LINK_SECONDS, { download: row.attachment_name ?? "attachment.pdf" });
  if (error || !data) {
    console.error("[messages] could not create a download link:", error?.message);
    return null;
  }
  return data.signedUrl;
}

// ---------------------------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------------------------

// Postgres / PostgREST codes for "this function doesn't exist" (migration 0011 not run yet).
const MISSING_FUNCTION = new Set(["PGRST202", "42883"]);

/**
 * Removes everything a person has in messaging: every file in each of their conversations'
 * folders (including any uploaded but never sent), then the conversations and messages themselves,
 * for BOTH people in each conversation. Used by both account-deletion paths.
 *
 * Throws if a step fails, so the caller stops before anything else is deleted and the person can
 * simply try again. If migration 0011 hasn't been run there is nothing to remove, so it does nothing.
 */
export async function removeUserMessaging(admin: Admin, userId: string): Promise<void> {
  const { data: ids, error } = await admin.rpc("messaging_conversation_ids", { p_user: userId });
  if (error) {
    if (error.code && MISSING_FUNCTION.has(error.code)) return;
    throw new Error(`list conversations: ${error.message}`);
  }

  const bucket = admin.storage.from(MESSAGE_BUCKET);
  for (const conversationId of ids ?? []) {
    // Files are removed in batches until the folder is empty.
    for (;;) {
      const { data: files, error: listError } = await bucket.list(conversationId, { limit: 100 });
      if (listError) throw new Error(`list message files: ${listError.message}`);
      if (!files || files.length === 0) break;
      const { error: removeError } = await bucket.remove(files.map((f) => `${conversationId}/${f.name}`));
      if (removeError) throw new Error(`remove message files: ${removeError.message}`);
    }
  }

  const { error: deleteError } = await admin.rpc("delete_user_messages", { p_user: userId });
  if (deleteError) throw new Error(`delete messages: ${deleteError.message}`);
}

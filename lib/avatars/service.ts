// Coach profile pictures: upload, change and remove.
//
// Every function assumes the CALLER has already been identified from their login (see
// lib/avatars/actions.ts) — `userId` is never taken from the browser. Who may have a picture (coaches
// only) and what a stored path may look like are enforced again inside the database
// (supabase/migrations/0020_profile_pictures.sql); this file adds what a database cannot: rate limits,
// and inspecting the uploaded file's real bytes. It takes the service-role client as a parameter so the
// tests can run the same code against a real Postgres.
//
// The flow mirrors message attachments:
//   1. prepareAvatarUpload — checks the request and returns a one-time upload link for a path the SERVER
//      chose (<user id>/<random id>.jpg|png|webp).
//   2. the browser uploads the (already shrunk) photo to that link, once.
//   3. saveAvatar — downloads what was really uploaded, checks it is a normal JPEG/PNG/WebP picture of a
//      sensible size, records it on the profile, and deletes the picture it replaced.
// A new random path for every picture also means the old picture is never served from a cache.

import type { createAdminClient } from "@/lib/supabase/admin";
import {
  AVATAR_BUCKET,
  MAX_AVATAR_BYTES,
  avatarPath,
  friendlyAvatarError,
  isAvatarType,
  isValidAvatarPath,
  validateAvatarBytes,
  type AvatarType,
} from "@/lib/avatars/rules";
import { isUuid } from "@/lib/messages/rules";

export type Admin = ReturnType<typeof createAdminClient>;
export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string };

const fail = (message: string) => ({ ok: false, message }) as const;

/** How fast one person may change their picture. A fixed window, counted in the database (hit_rate_limit from 0005). */
export const AVATAR_LIMIT = { max: 20, seconds: 3600 } as const;
const TOO_FAST = "You're going a bit fast. Please wait a few minutes and try again.";

async function withinLimit(admin: Admin, userId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("hit_rate_limit", {
    p_key: `avatar:${userId}`,
    p_max: AVATAR_LIMIT.max,
    p_window_seconds: AVATAR_LIMIT.seconds,
  });
  if (error) {
    console.error("[avatars] rate limiter unavailable:", error.message);
    return false; // fail closed, like the messaging and sign-up endpoints
  }
  return data === true;
}

/** Deletes files from the avatars bucket. Failures are logged: a leftover file is never worth failing for. */
async function removeFiles(admin: Admin, paths: string[]) {
  const clean = paths.filter(Boolean);
  if (clean.length === 0) return;
  const { error } = await admin.storage.from(AVATAR_BUCKET).remove(clean);
  if (error) console.error("[avatars] could not remove old picture files:", error.message);
}

/** Every file in this person's folder except `keep` (a bare file name), as full paths. */
async function folderFiles(admin: Admin, userId: string, keep?: string): Promise<string[] | null> {
  const folder = userId.toLowerCase();
  const { data, error } = await admin.storage.from(AVATAR_BUCKET).list(folder, { limit: 100 });
  if (error) {
    console.error("[avatars] could not list a picture folder:", error.message);
    return null;
  }
  return (data ?? []).map((f) => f.name).filter((name) => name && name !== keep).map((name) => `${folder}/${name}`);
}

/**
 * Step 1. Checks the request, then hands back a ONE-TIME upload link for a path the server picked. The
 * browser never chooses a path, and the bucket itself refuses anything over 1 MB or not sent as a
 * JPEG, PNG or WebP.
 */
export async function prepareAvatarUpload(
  admin: Admin,
  userId: string,
  input: { contentType: string; size: number },
): Promise<Result<{ path: string; token: string }>> {
  if (!isUuid(userId)) return fail("Please sign in again.");
  if (!isAvatarType(input?.contentType)) return fail("Please choose a JPG, PNG or WebP photo.");
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) return fail("That file is empty.");
  if (size > MAX_AVATAR_BYTES) return fail("That photo is too large. Please choose a smaller one.");

  if (!(await withinLimit(admin, userId))) return fail(TOO_FAST);

  const path = avatarPath(userId, crypto.randomUUID(), input.contentType as AvatarType);
  const { data, error } = await admin.storage.from(AVATAR_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    console.error("[avatars] could not create an upload link:", error?.message);
    return fail("We couldn't start the upload. Please try again.");
  }
  return { ok: true, path, token: data.token };
}

/**
 * Step 3. Looks at what was ACTUALLY uploaded to `path`, not what the browser claimed. It must be in
 * this person's own folder, be a real JPEG/PNG/WebP between 100 and 4096 pixels, and no bigger than
 * 1 MB. Anything else is deleted on the spot. On success the profile points at it, the previous
 * picture is deleted, and so is anything else left in the folder (for example an abandoned upload).
 */
export async function saveAvatar(admin: Admin, userId: string, input: { path: string }): Promise<Result<{ path: string }>> {
  const path = input?.path;
  if (!isValidAvatarPath(userId, path)) return fail(friendlyAvatarError("avatar:bad_path"));

  const { data: blob, error: downloadError } = await admin.storage.from(AVATAR_BUCKET).download(path);
  if (downloadError || !blob) return fail("We couldn't find your uploaded photo. Please try again.");

  const check = validateAvatarBytes(new Uint8Array(await blob.arrayBuffer()));
  if (!check.ok) {
    await removeFiles(admin, [path]);
    return fail(check.message);
  }
  // The file's own contents decide the extension a browser will treat it as; they must agree.
  const extension = path.slice(path.lastIndexOf(".") + 1);
  const expected = check.type === "image/jpeg" ? "jpg" : check.type === "image/png" ? "png" : "webp";
  if (extension !== expected) {
    await removeFiles(admin, [path]);
    return fail("That file isn't what it says it is. Please choose a different photo.");
  }

  const { data: previous, error } = await admin.rpc("set_profile_avatar", { p_user: userId, p_path: path });
  if (error) {
    await removeFiles(admin, [path]);
    return fail(friendlyAvatarError(error.message));
  }

  // The new picture is live. Tidy up: the one it replaced, and any stray uploads in the folder.
  const stale = new Set<string>();
  if (typeof previous === "string" && isValidAvatarPath(userId, previous) && previous !== path) stale.add(previous);
  for (const file of (await folderFiles(admin, userId, path.slice(path.lastIndexOf("/") + 1))) ?? []) stale.add(file);
  await removeFiles(admin, [...stale]);

  return { ok: true, path };
}

/** Removes the person's picture: the profile goes back to showing initials, and every stored file is deleted. */
export async function removeAvatar(admin: Admin, userId: string): Promise<Result> {
  if (!isUuid(userId)) return fail("Please sign in again.");
  if (!(await withinLimit(admin, userId))) return fail(TOO_FAST);

  const { data: previous, error } = await admin.rpc("clear_profile_avatar", { p_user: userId });
  if (error) return fail(friendlyAvatarError(error.message));

  const files = new Set<string>();
  if (typeof previous === "string" && isValidAvatarPath(userId, previous)) files.add(previous);
  for (const file of (await folderFiles(admin, userId)) ?? []) files.add(file);
  await removeFiles(admin, [...files]);
  return { ok: true };
}

/**
 * For account deletion: removes every picture file in the person's folder. Pictures are public, so —
 * unlike the best-effort cleanup above — a failure here is thrown, and the deletion can be retried.
 */
export async function removeUserAvatars(admin: Admin, userId: string): Promise<void> {
  if (!isUuid(userId)) return;
  const bucket = admin.storage.from(AVATAR_BUCKET);
  for (let round = 0; round < 20; round++) {
    const { data: files, error } = await bucket.list(userId.toLowerCase(), { limit: 100 });
    if (error) throw new Error(`list profile pictures: ${error.message}`);
    if (!files || files.length === 0) return;
    const { error: removeError } = await bucket.remove(files.map((f) => `${userId.toLowerCase()}/${f.name}`));
    if (removeError) throw new Error(`remove profile pictures: ${removeError.message}`);
  }
}

// Rules for coach profile pictures.
//
// Pure functions and constants with NO imports, so the same code runs in the browser (to give quick
// feedback and to size the photo), on the server (which is what actually enforces them, by looking at
// the real bytes of what was uploaded) and in the tests. The database and the storage bucket enforce
// the same limits again — see supabase/migrations/0020_profile_pictures.sql.

export const AVATAR_BUCKET = "avatars";

/** What the browser sends: a square this many pixels wide, saved as a JPEG. */
export const AVATAR_OUTPUT_SIZE = 512;
/** The most the bucket accepts (also set on the bucket itself). A 512 px photo is a small fraction of this. */
export const MAX_AVATAR_BYTES = 1024 * 1024;
/** The biggest photo the browser will try to read before shrinking it. */
export const MAX_PICKED_BYTES = 25 * 1024 * 1024;
/** Server-side sanity range for the stored image. */
export const MIN_AVATAR_PIXELS = 100;
export const MAX_AVATAR_PIXELS = 4096;

export type AvatarType = "image/jpeg" | "image/png" | "image/webp";
export const AVATAR_TYPES: readonly AvatarType[] = ["image/jpeg", "image/png", "image/webp"];
export const AVATAR_EXTENSION: Record<AvatarType, "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function isAvatarType(value: unknown): value is AvatarType {
  return typeof value === "string" && (AVATAR_TYPES as readonly string[]).includes(value);
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The only shape of storage path the server ever creates: <coach id>/<random id>.<jpg|png|webp> */
export function avatarPath(userId: string, fileId: string, type: AvatarType): string {
  return `${userId.toLowerCase()}/${fileId.toLowerCase()}.${AVATAR_EXTENSION[type]}`;
}

export function isValidAvatarPath(userId: string, path: unknown): path is string {
  return (
    typeof userId === "string" &&
    new RegExp(`^${UUID}$`).test(userId.toLowerCase()) &&
    typeof path === "string" &&
    new RegExp(`^${userId.toLowerCase()}/${UUID}\\.(jpg|png|webp)$`).test(path)
  );
}

/**
 * Quick check of the photo a coach picked, before the browser tries to read it. Only an image (or a
 * file that doesn't say what it is — some phones don't) is attempted. The picture that is uploaded is
 * always re-drawn by the browser as a fresh JPEG, so what is picked can be any photo format the
 * browser can read (including iPhone photos); the server checks what it actually receives.
 */
export function validatePickedPhoto(file: { type: string; size: number }): string | null {
  if (file.type && !file.type.startsWith("image/")) return "Please choose a photo (JPG, PNG or WebP).";
  if (!Number.isFinite(file.size) || file.size <= 0) return "That file is empty.";
  if (file.size > MAX_PICKED_BYTES) return "That photo is too large. Please choose one under 25 MB.";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Looking inside the file. A file's name and the type the browser reports are just claims, so the
// server reads the first bytes to learn what it really is, and how big the picture is.
// ---------------------------------------------------------------------------------------------

export interface DetectedImage {
  type: AvatarType;
  width: number;
  height: number;
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b: Uint8Array, i: number, s: string) => s.length + i <= b.length && [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));

function pngSize(b: Uint8Array): DetectedImage | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !signature.every((v, i) => b[i] === v) || !ascii(b, 12, "IHDR")) return null;
  return { type: "image/png", width: be32(b, 16), height: be32(b, 20) };
}

function jpegSize(b: Uint8Array): DetectedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i++;
      marker = b[i + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers that carry no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of data, and no size was found
    const length = be16(b, i + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 > b.length) return null;
      return { type: "image/jpeg", height: be16(b, i + 5), width: be16(b, i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): DetectedImage | null {
  if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) {
    // lossy: frame tag (3 bytes), start code 9D 01 2A, then 14-bit width and height
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { type: "image/webp", width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const width = (b[21] | ((b[22] & 0x3f) << 8)) + 1;
    const height = ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) + 1;
    return { type: "image/webp", width, height };
  }
  if (ascii(b, 12, "VP8X")) {
    if (b[20] & 0x02) return null; // animated
    return { type: "image/webp", width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  }
  return null;
}

/** What this file really is — a JPEG, PNG or WebP picture — and its size in pixels, or null for anything else. */
export function detectImage(bytes: Uint8Array): DetectedImage | null {
  return pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
}

export type AvatarCheck = ({ ok: true } & DetectedImage) | { ok: false; message: string };

const NOT_A_PHOTO = "That file isn't a JPG, PNG or WebP photo. Please choose a different one.";

/** The full check the server runs on the bytes that were actually uploaded. */
export function validateAvatarBytes(bytes: Uint8Array): AvatarCheck {
  if (bytes.length === 0) return { ok: false, message: "That file is empty." };
  if (bytes.length > MAX_AVATAR_BYTES) return { ok: false, message: "That photo is too large. Please choose a smaller one." };
  const found = detectImage(bytes);
  if (!found) return { ok: false, message: NOT_A_PHOTO };
  if (found.width < MIN_AVATAR_PIXELS || found.height < MIN_AVATAR_PIXELS) {
    return { ok: false, message: `That photo is too small. It should be at least ${MIN_AVATAR_PIXELS} × ${MIN_AVATAR_PIXELS} pixels.` };
  }
  if (found.width > MAX_AVATAR_PIXELS || found.height > MAX_AVATAR_PIXELS) {
    return { ok: false, message: "That photo's dimensions are too large. Please choose a smaller one." };
  }
  return { ok: true, ...found };
}

// The database reports rule failures as "avatar:<reason>". These are the words people see.
const FRIENDLY: Record<string, string> = {
  not_allowed: "Only coaches can have a profile picture.",
  bad_path: "That upload couldn't be used. Please choose the photo again.",
};

export function friendlyAvatarError(raw: string | null | undefined): string {
  const reason = /avatar:([a-z_]+)/.exec(raw ?? "")?.[1];
  return (reason && FRIENDLY[reason]) || "Something went wrong. Please try again.";
}

/** The square to cut from the middle of a picture: [left, top, side]. */
export function centerSquare(width: number, height: number): [number, number, number] {
  const side = Math.min(width, height);
  return [Math.floor((width - side) / 2), Math.floor((height - side) / 2), side];
}

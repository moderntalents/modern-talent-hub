// Rules for files teachers attach to lessons. Pure functions, safe to import
// from both client and server components.

// Supabase's Free plan caps a single upload at 50 MB. Longer videos should be
// shared as a YouTube/Vimeo link instead.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Anything can be attached (PDF, Word, PowerPoint, Excel, images, audio, video,
// zip…) except things that run code or render as web pages, which students
// shouldn't be handed. This is a client-side guard; the files also only ever
// reach storage through the teacher-only storage policy.
const BLOCKED_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "vbs", "vbe", "js", "jse", "wsf",
  "ps1", "sh", "jar", "apk", "dll", "dmg", "iso", "lnk", "reg", "hta",
  "html", "htm", "xhtml", "svg",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Returns a human-readable problem, or null if the file is fine to upload. */
export function validateUpload(file: { name: string; size: number }): string | null {
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_UPLOAD_BYTES) {
    return `"${file.name}" is over 50 MB. For long videos, paste a YouTube or Vimeo link instead.`;
  }
  if (BLOCKED_EXTENSIONS.has(fileExtension(file.name))) {
    return `"${file.name}": this type of file can't be uploaded.`;
  }
  return null;
}

/** True for video files, by MIME type or (when the browser gives none) extension. */
export function isVideoFile(fileType: string | null | undefined, fileName: string): boolean {
  return Boolean(fileType?.startsWith("video/")) || VIDEO_EXTENSIONS.has(fileExtension(fileName));
}

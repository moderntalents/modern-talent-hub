// Rules for the student "Find your teacher or coach" directory.
//
// Pure functions and constants (the only import is another pure module), so the same code runs in the
// browser (to tidy what someone types), on the server (which is what actually enforces things) and in
// the tests.
// WHO a student may find is decided by the database (supabase/migrations/0021_discoverable_coaches.sql,
// which replaced the 0019 rule; messaging still follows the 0011 relationship rule) — nothing in this
// file grants access.

import { isUuid } from "@/lib/messages/rules";

/** How many teachers one page shows. The server asks for one more, to know if there is a next page. */
export const DIRECTORY_PAGE_SIZE = 12;

/** Longest search text we look at, and the most words and longest word the database is given. */
export const MAX_SEARCH_CHARS = 80;
export const MAX_SEARCH_TERMS = 5;
export const MAX_TERM_CHARS = 40;

/**
 * What someone typed → the words to look for. Trims, collapses spaces, drops control characters,
 * and caps the size, so " David   PAGNI " becomes ["David", "PAGNI"]. Capitalisation is left alone
 * because the database matches without regard to it. An empty list means "no search".
 */
export function parseSearch(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const cleaned = raw
    .replace(/[\\u0000-\\u001f\\u007f\\u200b\\u00a0]+/g, " ")
    .slice(0, MAX_SEARCH_CHARS)
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TERMS)
    .map((word) => [...word].slice(0, MAX_TERM_CHARS).join(""));
}

/** The search text as it should sit in the address bar / search box: tidy, or "" for none. */
export function normalizeSearch(raw: unknown): string {
  return parseSearch(raw).join(" ");
}

// ---------------------------------------------------------------------------------------------
// Paging. The cursor says where the last page ended: the lower-cased name the database sorts by,
// and the teacher's id to break ties. It carries nothing secret, and the server still re-applies
// the permission rule to every page, so a made-up cursor can only change WHERE the list starts.
// ---------------------------------------------------------------------------------------------

export interface DirectoryCursor {
  name: string;
  id: string;
}

export function encodeCursor(cursor: DirectoryCursor): string {
  return Buffer.from(JSON.stringify([cursor.name, cursor.id]), "utf8").toString("base64url");
}

export function decodeCursor(raw: unknown): DirectoryCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 600) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [name, id] = parsed;
    if (typeof name !== "string" || name.length > 300 || !isUuid(id)) return null;
    return { name, id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// What a card shows
// ---------------------------------------------------------------------------------------------

/**
 * "Coach" or "Teacher". Someone with a published activity (sports, martial arts, music, creative) is a
 * coach — the app calls those teachers "coaches" everywhere ("Message coach"). Someone who only has
 * published lessons is a teacher. The database says which (student_directory().kind); anything it
 * doesn't recognise is shown as "Coach", the app's usual word. Kept in one place so the screens never decide.
 */
export function roleLabel(kind?: string | null): "Coach" | "Teacher" {
  return kind === "Teacher" ? "Teacher" : "Coach";
}

/** "David Pagni" → "DP"; "Madonna" → "M"; blank → "?". Letters only, so emoji and symbols are skipped. */
export function initialsOf(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => [...w].find((ch) => /\p{L}|\p{N}/u.test(ch)) ?? "")
    .filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : "";
  return (first + last).toUpperCase();
}

/**
 * The address of a teacher's picture, or null (→ show initials).
 *
 * profiles.avatar_url is something a teacher can write from their own signed-in session, so it is
 * NOT trusted as a web address: showing it would let a teacher make every student's browser fetch
 * any URL they like. Only a file in this project's public "avatars" bucket, inside that teacher's OWN
 * folder (the bucket's write policy is folder = user id), is shown. Accepts either the storage path
 * ("<teacher id>/photo.jpg") or the full public address of that same file.
 */
export function avatarSrc(avatarUrl: string | null | undefined, teacherId: string, supabaseUrl: string | undefined): string | null {
  if (!avatarUrl || !supabaseUrl || !isUuid(teacherId)) return null;
  const base = supabaseUrl.replace(/\/+$/, "");
  const publicPrefix = `${base}/storage/v1/object/public/avatars/`;
  const raw = avatarUrl.trim();
  const path = raw.startsWith(publicPrefix) ? raw.slice(publicPrefix.length) : raw;
  const [folder, file, ...rest] = path.split(/[?#]/)[0].split("/");
  if (rest.length > 0 || !folder || !file) return null;
  if (folder.toLowerCase() !== teacherId.toLowerCase()) return null;
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(file) || file.startsWith(".")) return null;
  // Keep a cache-busting query the app may have added when a picture is replaced.
  const query = /\?v=[A-Za-z0-9_-]{1,40}$/.exec(raw)?.[0] ?? "";
  return `${publicPrefix}${folder}/${file}${query}`;
}

export interface DirectoryActivity {
  id: string;
  title: string;
}

/** How many of a teacher's activities a card names before saying "+ n more". */
export const CARD_ACTIVITY_LIMIT = 2;

export interface DirectoryTeacher {
  id: string;
  name: string;
  /** Position in the sort order, used as the paging cursor. */
  sortName: string;
  avatarSrc: string | null;
  role: "Coach" | "Teacher";
  specialty: string | null;
  bio: string | null;
  /** Some of their published activities (the database returns at most 6, by title). */
  activities: DirectoryActivity[];
  /** Set when a conversation already exists, so "Message" can open it directly. */
  conversationId: string | null;
  /**
   * Whether this student may start messaging them today (an active subscription — the messaging rule).
   * A hint for the buttons only: starting a conversation is checked again by the database.
   */
  canMessage: boolean;
}

/** Can the Message button do anything? Yes if a conversation exists to open, or one may be started. */
export function canOpenConversation(t: Pick<DirectoryTeacher, "conversationId" | "canMessage">): boolean {
  return t.conversationId !== null || t.canMessage;
}

/** The one line under a name: "Coach • Karate" — their role and specialty, or just the role. */
export function subtitleOf(t: Pick<DirectoryTeacher, "role" | "specialty">): string {
  const specialty = t.specialty?.trim().replace(/\s+/g, " ");
  if (!specialty) return t.role;
  // "Head football coach" already says it.
  return /\b(coach|teacher)\b/i.test(specialty) ? specialty : `${t.role} • ${specialty}`;
}

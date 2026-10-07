// Rules for the student "Find your teacher or coach" directory.
//
// Pure functions and constants (the only import is another pure module), so the same code runs in the
// browser (to tidy what someone types), on the server (which is what actually enforces things) and in
// the tests.
// WHO a student may find is decided by the database (supabase/migrations/0021_discoverable_coaches.sql,
// which replaced the 0019 rule; messaging still follows the 0011 relationship rule) — nothing in this
// file grants access.

import { isUuid } from "@/lib/messages/rules";
import { ACTIVITY_CATEGORIES } from "@/lib/constants";

/** How many teachers one page shows. The server asks for one more, to know if there is a next page. */
export const DIRECTORY_PAGE_SIZE = 12;

/** Longest search text we look at, and the most words and longest word the database is given. */
export const MAX_SEARCH_CHARS = 80;
export const MAX_SEARCH_TERMS = 5;
export const MAX_TERM_CHARS = 40;

/**
 * What someone typed → the words to look for. Trims, collapses spaces, drops control characters,
 * and caps the size, so " David   PAGNI " becomes ["David", "PAGNI"]. Capitalisation is left alone
 * because the database matches without regard to it. An empty list means "no search". The database
 * (migration 0023) requires EVERY word to match something the student can already see about the person:
 * name, specialty, a subject they teach or an activity they offer — partial words are fine.
 */
export function parseSearch(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const cleaned = raw
    .replace(/[\\u0000-\\u001f\\u007f\\u200b\\u00a0]+/g, " ")
    .slice(0, MAX_SEARCH_CHARS)
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TERMS)
    .map((word) => [...word].slice(0, MAX_TERM_CHARS).join(""));
}

/** The search text as it should sit in the address bar / search box: tidy, or "" for none. */
export function normalizeSearch(raw: unknown): string {
  return parseSearch(raw).join(" ");
}

// ---------------------------------------------------------------------------------------------
// Narrowing the list by what people offer (Subjects / Activities pages; migration 0023)
// ---------------------------------------------------------------------------------------------

/** "subjects" = the All Teachers list (people with published lessons); "activities" = All Coaches. */
export type DirectoryOffer = "subjects" | "activities";

/** What the list is narrowed to. All parts are optional; none = the whole directory. */
export interface DirectoryScope {
  offer?: DirectoryOffer;
  /** A subjects.id: only people with a published lesson in it. */
  subjectId?: string;
  /** An activity id or name from the catalog (e.g. "karate" / "Karate"): only people with that activity published. */
  activityId?: string;
  /**
   * A catalog category id ("martial", "sports"...): people with a published activity in ANY of its activities.
   * Old Activities links looked like /student/marketplace?category=martial; they land here. Ignored when an
   * activityId is also given.
   */
  categoryId?: string;
}

/** The catalog activity (Karate, Chess...) for an id or name in any capitalisation, or null. */
export function findActivity(raw: unknown): { id: string; name: string } | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  for (const category of ACTIVITY_CATEGORIES) {
    for (const a of category.activities) {
      if (a.id.toLowerCase() === key || a.name.toLowerCase() === key) return { id: a.id, name: a.name };
    }
  }
  return null;
}

/** The catalog category (Martial Arts...) for an id or name in any capitalisation, or null. */
export function findCategory(raw: unknown): { id: string; name: string } | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  const c = ACTIVITY_CATEGORIES.find((x) => x.id.toLowerCase() === key || x.name.toLowerCase() === key);
  return c ? { id: c.id, name: c.name } : null;
}

/** Every catalog activity, in catalog order — what the Activities pills are made from. */
export function listActivityChoices(): { id: string; name: string }[] {
  return ACTIVITY_CATEGORIES.flatMap((c) => c.activities.map((a) => ({ id: a.id, name: a.name })));
}

/**
 * Anything the browser sent → a scope we trust the SHAPE of (the database still decides who is
 * visible). Unknown values are dropped, so a made-up filter can only narrow or empty the list.
 */
export function parseScope(raw: unknown): DirectoryScope {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const scope: DirectoryScope = {};
  if (r.offer === "subjects" || r.offer === "activities") scope.offer = r.offer;
  if (typeof r.subjectId === "string" && isUuid(r.subjectId)) scope.subjectId = r.subjectId.toLowerCase();
  if (typeof r.activityId === "string" && r.activityId.trim()) scope.activityId = r.activityId.trim().slice(0, 60);
  if (typeof r.categoryId === "string" && r.categoryId.trim()) scope.categoryId = r.categoryId.trim().slice(0, 60);
  return scope;
}

/**
 * The scope → the database arguments. An activity that isn't in the catalog can't match anyone, so
 * it is an explicit "nobody" rather than quietly turning into "everybody".
 */
export function scopeToArgs(
  scope: DirectoryScope,
): { nobody: true } | { nobody: false; offer: DirectoryOffer | null; subject: string | null; activities: string[] | null } {
  let activities: string[] | null = null;
  if (scope.activityId) {
    const activity = findActivity(scope.activityId);
    if (!activity) return { nobody: true };
    // activities.activity_type holds the display name ("Karate"); older rows may hold the id.
    activities = [activity.name, activity.id];
  } else if (scope.categoryId) {
    const category = ACTIVITY_CATEGORIES.find((c) => c.id === findCategory(scope.categoryId)?.id);
    if (!category) return { nobody: true };
    activities = category.activities.flatMap((a) => [a.name, a.id]);
  }
  return { nobody: false, offer: scope.offer ?? null, subject: scope.subjectId ?? null, activities };
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
    .split(/\\s+/)
    .map((w) => [...w].find((ch) => /\\p{L}|\\p{N}/u.test(ch)) ?? "")
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
  const base = supabaseUrl.replace(/\\/+$/, "");
  const publicPrefix = `${base}/storage/v1/object/public/avatars/`;
  const raw = avatarUrl.trim();
  const path = raw.startsWith(publicPrefix) ? raw.slice(publicPrefix.length) : raw;
  const [folder, file, ...rest] = path.split(/[?#]/)[0].split("/");
  if (rest.length > 0 || !folder || !file) return null;
  if (folder.toLowerCase() !== teacherId.toLowerCase()) return null;
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(file) || file.startsWith(".")) return null;
  // Keep a cache-busting query the app may have added when a picture is replaced.
  const query = /\\?v=[A-Za-z0-9_-]{1,40}$/.exec(raw)?.[0] ?? "";
  return `${publicPrefix}${folder}/${file}${query}`;
}

export interface DirectoryActivity {
  id: string;
  title: string;
}

/** How many of a teacher's activities a card names before saying "+ n more". */
export const CARD_ACTIVITY_LIMIT = 2;

export interface DirectorySubject {
  id: string;
  name: string;
}

/** How many subjects a card names before saying "+ n more". */
export const CARD_SUBJECT_LIMIT = 2;

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
  /** Some of the subjects they have published lessons in (the database returns at most 6, by name). */
  subjects: DirectorySubject[];
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
  const specialty = t.specialty?.trim().replace(/\\s+/g, " ");
  if (!specialty) return t.role;
  // "Head football coach" already says it.
  return /\\b(coach|teacher)\\b/i.test(specialty) ? specialty : `${t.role} • ${specialty}`;
}

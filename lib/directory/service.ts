// The student's teacher/coach directory: list, search, page and look up one person.
//
// `studentId` must come from the signed-in session on the server (see lib/directory/actions.ts and
// the pages), never from the browser. WHO is listed is decided entirely by the database function
// student_directory() (migration 0019), which applies the messaging relationship rule — an active
// subscription — on every call; this file only tidies the input and shapes the rows. Like the
// messaging service it takes the service-role client as a parameter so the tests can run the same
// code against a real Postgres.

import type { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/messages/rules";
import {
  DIRECTORY_PAGE_SIZE,
  avatarSrc,
  decodeCursor,
  encodeCursor,
  parseSearch,
  roleLabel,
  type DirectoryTeacher,
} from "@/lib/directory/rules";

type Admin = ReturnType<typeof createAdminClient>;

type Row = {
  teacher_id: string;
  sort_name: string;
  full_name: string;
  avatar_url: string | null;
  specialty: string | null;
  bio: string | null;
  activities: { id: string; title: string }[] | null;
  conversation_id: string | null;
};

function toTeacher(row: Row, supabaseUrl: string | undefined): DirectoryTeacher {
  return {
    id: row.teacher_id,
    name: row.full_name,
    sortName: row.sort_name,
    avatarSrc: avatarSrc(row.avatar_url, row.teacher_id, supabaseUrl),
    role: roleLabel(),
    specialty: row.specialty?.trim() || null,
    bio: row.bio?.trim() || null,
    activities: Array.isArray(row.activities) ? row.activities : [],
    conversationId: row.conversation_id,
  };
}

export type DirectoryPage =
  | { ok: true; teachers: DirectoryTeacher[]; nextCursor: string | null }
  | { ok: false; message: string };

export const DIRECTORY_UNAVAILABLE = "We couldn't load your teachers and coaches right now. Please try again.";

/**
 * One page of the teachers/coaches this student may find, optionally narrowed by a name search,
 * in name order. `cursor` is the `nextCursor` of the previous page. Never returns more than
 * `pageSize` people, so the browser is never handed the whole list.
 */
export async function listDirectory(
  admin: Admin,
  studentId: string,
  options: { query?: unknown; cursor?: unknown; pageSize?: number; supabaseUrl?: string } = {},
): Promise<DirectoryPage> {
  if (!isUuid(studentId)) return { ok: true, teachers: [], nextCursor: null };
  const pageSize = Math.min(Math.max(Math.floor(options.pageSize ?? DIRECTORY_PAGE_SIZE), 1), 50);
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  // A cursor that isn't one of ours restarts from the top rather than failing.

  const { data, error } = await admin.rpc("student_directory", {
    p_student: studentId,
    p_terms: parseSearch(options.query),
    p_limit: pageSize + 1,
    p_after_name: after?.name ?? null,
    p_after_id: after?.id ?? null,
    p_teacher: null,
  });
  if (error) {
    console.error("[directory] student_directory failed:", error.message);
    return { ok: false, message: DIRECTORY_UNAVAILABLE };
  }

  const rows = (data ?? []) as Row[];
  const page = rows.slice(0, pageSize).map((r) => toTeacher(r, options.supabaseUrl));
  const last = page[page.length - 1];
  return {
    ok: true,
    teachers: page,
    nextCursor: rows.length > pageSize && last ? encodeCursor({ name: last.sortName, id: last.id }) : null,
  };
}

/**
 * One teacher/coach, only if THIS student may find them (same rule as the list). Anyone else —
 * a teacher the student has no active subscription with, an unapproved teacher, a student, an id
 * that doesn't exist — gives the same answer: null. So a profile address can't be used to find out
 * who exists on the platform.
 */
export async function getDirectoryTeacher(
  admin: Admin,
  studentId: string,
  teacherId: string,
  options: { supabaseUrl?: string } = {},
): Promise<DirectoryTeacher | null> {
  if (!isUuid(studentId) || !isUuid(teacherId)) return null;
  const { data, error } = await admin.rpc("student_directory", {
    p_student: studentId,
    p_terms: [],
    p_limit: 1,
    p_after_name: null,
    p_after_id: null,
    p_teacher: teacherId,
  });
  if (error) {
    console.error("[directory] could not load a teacher profile:", error.message);
    return null;
  }
  const row = ((data ?? []) as Row[])[0];
  return row ? toTeacher(row, options.supabaseUrl) : null;
}

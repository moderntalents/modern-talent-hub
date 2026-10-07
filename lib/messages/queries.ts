import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DELETED_MESSAGE_TEXT, isUuid, threadReadOnlyReason, type MessageKind } from "@/lib/messages/rules";
import { avatarSrc } from "@/lib/directory/rules";

// What the messaging pages read. Conversations and messages are read AS THE SIGNED-IN PERSON, so
// row-level security applies: someone only ever gets back conversations they are one of the two
// people in (and only while both are age-cleared). Nothing here can widen that.

/**
 * Display names for people the caller already has a conversation with. Teachers cannot read student
 * profiles under the site's security rules, so this uses the server's key — but it only ever returns
 * a NAME, and callers pass only ids taken from conversations they were allowed to read.
 */
export async function getDisplayNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(ids)].filter(isUuid);
  if (unique.length === 0) return names;
  const { data } = await createAdminClient().from("profiles").select("id, full_name").in("id", unique);
  for (const p of data ?? []) names.set(p.id, p.full_name);
  return names;
}

/**
 * Name and picture for people the caller already has a conversation with. Only a COACH has a picture
 * to show (a student's is always their initials), and the address is vetted by avatarSrc() — a file in
 * that person's own folder of the public avatars bucket, or nothing. Like getDisplayNames, it only ever
 * returns what is shown on screen, for ids taken from conversations the caller was allowed to read.
 */
async function getDisplayPeople(ids: string[]): Promise<Map<string, { name: string; avatarSrc: string | null }>> {
  const people = new Map<string, { name: string; avatarSrc: string | null }>();
  const unique = [...new Set(ids)].filter(isUuid);
  if (unique.length === 0) return people;
  const { data } = await createAdminClient().from("profiles").select("id, full_name, role, avatar_url").in("id", unique);
  for (const p of data ?? []) {
    people.set(p.id, {
      name: p.full_name,
      avatarSrc: p.role === "teacher" ? avatarSrc(p.avatar_url, p.id, process.env.NEXT_PUBLIC_SUPABASE_URL) : null,
    });
  }
  return people;
}

export interface ConversationSummary {
  id: string;
  otherName: string;
  /** The other person's picture, or null (show their initials). */
  otherAvatarSrc: string | null;
  lastMessageAt: string;
  preview: string;
  lastKind: MessageKind | null;
  lastFromMe: boolean;
}

function previewOf(body: string, attachmentName: string | null, deleted = false): string {
  if (deleted) return DELETED_MESSAGE_TEXT;
  const text = body.trim().replace(/\s+/g, " ");
  if (text) return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  return attachmentName ? `📎 ${attachmentName}` : "";
}

/** The caller's conversations, most recently active first. */
export async function listConversations(myId: string, role: "student" | "teacher"): Promise<ConversationSummary[]> {
  const supabase = await createClient();
  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, student_id, teacher_id, created_at, last_message_at")
    .order("last_message_at", { ascending: false })
    .limit(100);
  if (!conversations || conversations.length === 0) return [];

  const { data: recent } = await supabase
    .from("messages")
    .select("conversation_id, sender_id, kind, body, attachment_name, created_at, deleted_at")
    .in("conversation_id", conversations.map((c) => c.id))
    .order("created_at", { ascending: false })
    .limit(400);

  const latest = new Map<string, NonNullable<typeof recent>[number]>();
  for (const m of recent ?? []) if (!latest.has(m.conversation_id)) latest.set(m.conversation_id, m);

  const otherId = (c: { student_id: string; teacher_id: string }) => (role === "student" ? c.teacher_id : c.student_id);
  const people = await getDisplayPeople(conversations.map(otherId));

  // A teacher doesn't see a thread until something has been written in it: a thread a student opened
  // without writing stays out of the teacher's list (with an under-18 student the teacher couldn't
  // write in it anyway). last_message_at only moves when a message is sent.
  const shown =
    role === "teacher" ? conversations.filter((c) => latest.has(c.id) || c.last_message_at !== c.created_at) : conversations;

  return shown.map((c) => {
    const last = latest.get(c.id);
    return {
      id: c.id,
      otherName: people.get(otherId(c))?.name ?? (role === "student" ? "Teacher" : "Student"),
      otherAvatarSrc: people.get(otherId(c))?.avatarSrc ?? null,
      lastMessageAt: c.last_message_at,
      preview: last ? previewOf(last.body, last.attachment_name, last.deleted_at !== null) : "No messages yet",
      // A deleted message is shown as plain text, without its Homework / Submission label.
      lastKind: last && last.deleted_at === null ? last.kind : null,
      lastFromMe: last?.sender_id === myId,
    };
  });
}

export interface ThreadMessage {
  id: string;
  fromMe: boolean;
  kind: MessageKind;
  body: string;
  attachmentName: string | null;
  attachmentSize: number | null;
  createdAt: string;
  /** When the sender last changed the text, or null if never. */
  editedAt: string | null;
  /** True once the sender deleted it: the body and file are gone and only a placeholder is shown. */
  deleted: boolean;
}

export interface Thread {
  id: string;
  otherName: string;
  /** The other person's picture, or null (show their initials). */
  otherAvatarSrc: string | null;
  messages: ThreadMessage[];
  /** null when the person can write; otherwise why the thread is read-only. */
  readOnlyReason: string | null;
}

/** One conversation and its most recent messages, or null if the caller isn't allowed to see it. */
export async function getThread(conversationId: string, myId: string, role: "student" | "teacher"): Promise<Thread | null> {
  if (!isUuid(conversationId)) return null;
  const supabase = await createClient();

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, student_id, teacher_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conversation) return null;

  const { data: rows } = await supabase
    .from("messages")
    .select("id, sender_id, kind, body, attachment_name, attachment_size, created_at, edited_at, deleted_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(200);

  const otherId = role === "student" ? conversation.teacher_id : conversation.student_id;
  const people = await getDisplayPeople([otherId]);

  // The same check the send path runs (lib/messages/service.ts), so the message box is shown exactly
  // when sending would be accepted. A failed check used to fall through to "closed", hiding the box
  // with the wrong explanation; it is now logged and reported as what it is.
  const { data: status, error: statusError } = await createAdminClient().rpc("messaging_can_send", {
    p_user: myId,
    p_conversation: conversationId,
  });
  if (statusError) console.error("[messages] messaging_can_send failed:", statusError.message);

  return {
    id: conversation.id,
    otherName: people.get(otherId)?.name ?? (role === "student" ? "Teacher" : "Student"),
    otherAvatarSrc: people.get(otherId)?.avatarSrc ?? null,
    readOnlyReason: threadReadOnlyReason(status, !!statusError),
    messages: (rows ?? [])
      .reverse()
      .map((m) => ({
        id: m.id,
        fromMe: m.sender_id === myId,
        kind: m.kind,
        body: m.body,
        attachmentName: m.attachment_name,
        attachmentSize: m.attachment_size,
        createdAt: m.created_at,
        editedAt: m.edited_at,
        deleted: m.deleted_at !== null,
      })),
  };
}

export interface EnrolledStudent {
  studentId: string;
  name: string;
  activityTitle: string;
}

/**
 * The students a teacher may START a conversation with: adults with an active subscription to one of
 * the teacher's activities. Who qualifies is decided by the database (messaging_teacher_startable_students,
 * the same rule start_conversation_as_teacher() enforces), so under-18 students are simply not listed —
 * no age is read or shown here. `teacherId` must be the signed-in teacher's own id.
 */
export async function listEnrolledStudents(teacherId: string): Promise<EnrolledStudent[]> {
  const { data: startable, error } = await createAdminClient().rpc("messaging_teacher_startable_students", { p_teacher: teacherId });
  if (error) {
    console.error("[messages] could not list students a teacher may message:", error.message);
    return [];
  }
  const allowed = new Set(startable ?? []);
  if (allowed.size === 0) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from("subscriptions")
    .select("student_id, current_period_end, activities(title)")
    .eq("teacher_id", teacherId)
    .eq("status", "active")
    .returns<{ student_id: string; current_period_end: string | null; activities: { title: string } | null }[]>();

  // Show the title of a subscription that is still current (not one past its end date).
  const now = Date.now();
  const rows = (data ?? []).filter(
    (r) => allowed.has(r.student_id) && (r.current_period_end === null || Date.parse(r.current_period_end) > now),
  );
  const names = await getDisplayNames(rows.map((r) => r.student_id));
  const seen = new Set<string>();
  const students: EnrolledStudent[] = [];
  for (const r of rows) {
    if (seen.has(r.student_id)) continue;
    seen.add(r.student_id);
    students.push({ studentId: r.student_id, name: names.get(r.student_id) ?? "Student", activityTitle: r.activities?.title ?? "Activity" });
  }
  return students.sort((a, b) => a.name.localeCompare(b.name));
}

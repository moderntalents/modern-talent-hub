import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid, type MessageKind } from "@/lib/messages/rules";

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

export interface ConversationSummary {
  id: string;
  otherName: string;
  lastMessageAt: string;
  preview: string;
  lastKind: MessageKind | null;
  lastFromMe: boolean;
}

function previewOf(body: string, attachmentName: string | null): string {
  const text = body.trim().replace(/\s+/g, " ");
  if (text) return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  return attachmentName ? `📎 ${attachmentName}` : "";
}

/** The caller's conversations, most recently active first. */
export async function listConversations(myId: string, role: "student" | "teacher"): Promise<ConversationSummary[]> {
  const supabase = await createClient();
  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, student_id, teacher_id, last_message_at")
    .order("last_message_at", { ascending: false })
    .limit(100);
  if (!conversations || conversations.length === 0) return [];

  const { data: recent } = await supabase
    .from("messages")
    .select("conversation_id, sender_id, kind, body, attachment_name, created_at")
    .in("conversation_id", conversations.map((c) => c.id))
    .order("created_at", { ascending: false })
    .limit(400);

  const latest = new Map<string, NonNullable<typeof recent>[number]>();
  for (const m of recent ?? []) if (!latest.has(m.conversation_id)) latest.set(m.conversation_id, m);

  const otherId = (c: { student_id: string; teacher_id: string }) => (role === "student" ? c.teacher_id : c.student_id);
  const names = await getDisplayNames(conversations.map(otherId));

  return conversations.map((c) => {
    const last = latest.get(c.id);
    return {
      id: c.id,
      otherName: names.get(otherId(c)) ?? (role === "student" ? "Teacher" : "Student"),
      lastMessageAt: c.last_message_at,
      preview: last ? previewOf(last.body, last.attachment_name) : "No messages yet",
      lastKind: last?.kind ?? null,
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
}

export interface Thread {
  id: string;
  otherName: string;
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
    .select("id, sender_id, kind, body, attachment_name, attachment_size, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(200);

  const otherId = role === "student" ? conversation.teacher_id : conversation.student_id;
  const names = await getDisplayNames([otherId]);

  const { data: status } = await createAdminClient().rpc("messaging_can_send", {
    p_user: myId,
    p_conversation: conversationId,
  });

  return {
    id: conversation.id,
    otherName: names.get(otherId) ?? (role === "student" ? "Teacher" : "Student"),
    readOnlyReason:
      status === "ok"
        ? null
        : status === "not_cleared"
          ? "Messaging is paused until the age check or guardian approval is complete."
          : "This conversation is closed for new messages. You can still read it.",
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
      })),
  };
}

export interface EnrolledStudent {
  studentId: string;
  name: string;
  activityTitle: string;
}

/** A teacher's own active subscribers — the only students a teacher may start a conversation with. */
export async function listEnrolledStudents(teacherId: string): Promise<EnrolledStudent[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("subscriptions")
    .select("student_id, activities(title)")
    .eq("teacher_id", teacherId)
    .eq("status", "active")
    .returns<{ student_id: string; activities: { title: string } | null }[]>();

  const rows = data ?? [];
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

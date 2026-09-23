// Database-level tests for migration 0011 (messaging), run against a real Postgres that has
// the repository's actual migrations applied. These prove the RULES hold in the database
// itself — independent of any application code.

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, type Actor } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";

let db: PGlite;

const uuid = () => crypto.randomUUID();
const pdfPath = (conversationId: string) => `${conversationId}/${uuid()}.pdf`;
const MB10 = 10 * 1024 * 1024;

async function call(actor: Actor, name: string, args: Record<string, unknown>) {
  const keys = Object.keys(args);
  const sql = `select ${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  return as(db, actor, async () => (await db.query<{ r: unknown }>(sql, keys.map((k) => args[k]))).rows.map((x) => x.r));
}
const one = async (actor: Actor, name: string, args: Record<string, unknown>) => (await call(actor, name, args))[0];

const SERVICE: Actor = "service";
const fromLesson = (student: string, lesson: string) => one(SERVICE, "start_conversation_from_lesson", { p_student: student, p_lesson: lesson }) as Promise<string>;
const fromActivity = (student: string, activity: string) => one(SERVICE, "start_conversation_from_activity", { p_student: student, p_activity: activity }) as Promise<string>;
const asTeacher = (teacher: string, student: string) => one(SERVICE, "start_conversation_as_teacher", { p_teacher: teacher, p_student: student }) as Promise<string>;

function send(sender: string, conversation: string, o: Partial<{ body: string | null; kind: string; path: string | null; name: string | null; size: number | null }> = {}) {
  return one(SERVICE, "send_message", {
    p_sender: sender,
    p_conversation: conversation,
    p_body: "body" in o ? o.body : "hello",
    p_kind: o.kind ?? "message",
    p_attachment_path: o.path ?? null,
    p_attachment_name: o.name ?? null,
    p_attachment_size: o.size ?? null,
  }) as Promise<string>;
}

const NOT_ALLOWED = /messaging:not_allowed/;
const NOT_CLEARED = /messaging:not_cleared/;

async function count(actor: Actor, sql: string, params: unknown[] = []): Promise<number> {
  return as(db, actor, async () => (await db.query(sql, params)).rows.length);
}
async function denied(actor: Actor, sql: string, params: unknown[] = []): Promise<void> {
  await assert.rejects(as(db, actor, () => db.query(sql, params)), /permission denied|row-level security|violates/i);
}

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
});

beforeEach(async () => {
  await db.exec("delete from conversations");
});

describe("storage bucket", () => {
  test("message-attachments is private, PDF-only and capped at 10 MB", async () => {
    const { rows } = await db.query<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
      "select public, file_size_limit::text, allowed_mime_types from storage.buckets where id = 'message-attachments'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].public, false);
    assert.equal(Number(rows[0].file_size_limit), MB10);
    assert.deepEqual(rows[0].allowed_mime_types, ["application/pdf"]);
  });

  test("no storage policy grants anyone access to the bucket: browsers can't read, list, upload or delete", async () => {
    const policies = await db.query<{ policyname: string; qual: string | null; with_check: string | null }>(
      "select policyname, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects'",
    );
    for (const p of policies.rows) {
      const text = `${p.qual ?? ""} ${p.with_check ?? ""}`;
      assert.doesNotMatch(text, /message-attachments/, `policy ${p.policyname} mentions the bucket`);
      // Every existing policy must be scoped to some OTHER bucket; an unscoped one would leak this bucket too.
      assert.match(text, /bucket_id/, `policy ${p.policyname} is not scoped to a bucket`);
    }

    const conv = await fromLesson(ID.S1, ID.L1);
    await db.query("insert into storage.objects (bucket_id, name) values ('message-attachments', $1)", [pdfPath(conv)]);
    for (const actor of [{ id: ID.S1 }, { id: ID.T1 }, { id: ID.ADMIN }, "anon"] as Actor[]) {
      assert.equal(await count(actor, "select 1 from storage.objects where bucket_id = 'message-attachments'"), 0);
      await denied(actor, "insert into storage.objects (bucket_id, name) values ('message-attachments', $1)", [pdfPath(conv)]);
    }
    const del = await as(db, { id: ID.S1 }, () => db.query("delete from storage.objects where bucket_id = 'message-attachments'"));
    assert.equal(del.affectedRows, 0, "a participant must not be able to delete files directly");
  });
});

describe("who may START a conversation", () => {
  test("a student can message the teacher of a published lesson", async () => {
    const id = await fromLesson(ID.S1, ID.L1);
    const { rows } = await db.query<{ student_id: string; teacher_id: string }>("select student_id, teacher_id from conversations where id = $1", [id]);
    assert.deepEqual(rows[0], { student_id: ID.S1, teacher_id: ID.T1 });
  });

  test("starting again returns the same conversation (one thread per student–teacher pair)", async () => {
    const a = await fromLesson(ID.S1, ID.L1);
    const b = await fromLesson(ID.S1, ID.L1);
    assert.equal(a, b);
    assert.equal((await db.query("select 1 from conversations")).rows.length, 1);
  });

  test("a student cannot message the teacher of a DRAFT lesson, an unapproved teacher, or a lesson that does not exist", async () => {
    await assert.rejects(fromLesson(ID.S1, ID.L2), NOT_ALLOWED); // draft
    await assert.rejects(fromLesson(ID.S1, ID.L4), NOT_ALLOWED); // draft
    await assert.rejects(fromLesson(ID.S1, ID.L3), NOT_ALLOWED); // published, but the teacher is not approved
    await assert.rejects(fromLesson(ID.S1, uuid()), NOT_ALLOWED);
  });

  test("a student can message the teacher of an activity they have an ACTIVE subscription to", async () => {
    const id = await fromActivity(ID.S1, ID.A1);
    const { rows } = await db.query<{ teacher_id: string }>("select teacher_id from conversations where id = $1", [id]);
    assert.equal(rows[0].teacher_id, ID.T2);
  });

  test("…but not without one: pending payment, no subscription, a draft activity, or another activity", async () => {
    await assert.rejects(fromActivity(ID.S5, ID.A1), NOT_ALLOWED); // pending_payment
    await assert.rejects(fromActivity(ID.S7, ID.A1), NOT_ALLOWED); // never subscribed
    await assert.rejects(fromActivity(ID.S1, ID.A2), NOT_ALLOWED); // subscribed to A1, not A2
    await db.query("insert into subscriptions (student_id, activity_id, teacher_id, status) values ($1, $2, $3, 'active')", [ID.S1, ID.A3, ID.T2]);
    await assert.rejects(fromActivity(ID.S1, ID.A3), NOT_ALLOWED); // active, but the activity is a draft
    await db.query("delete from subscriptions where activity_id = $1", [ID.A3]);
  });

  test("a teacher can start a conversation only with their own ACTIVE subscriber", async () => {
    const id = await asTeacher(ID.T2, ID.S1);
    const { rows } = await db.query<{ student_id: string }>("select student_id from conversations where id = $1", [id]);
    assert.equal(rows[0].student_id, ID.S1);

    await assert.rejects(asTeacher(ID.T2, ID.S5), NOT_ALLOWED); // pending payment
    await assert.rejects(asTeacher(ID.T2, ID.S7), NOT_ALLOWED); // unrelated student
    await assert.rejects(asTeacher(ID.T1, ID.S1), NOT_ALLOWED); // T1 has a published lesson, but that alone lets STUDENTS write in, not teachers write out
    await assert.rejects(asTeacher(ID.T4, ID.S1), NOT_ALLOWED); // S1 is subscribed to T2's activity, not T4's
  });

  test("an unapproved teacher cannot start or receive a conversation", async () => {
    await db.query("update teacher_profiles set approved = false where profile_id = $1", [ID.T2]);
    try {
      await assert.rejects(asTeacher(ID.T2, ID.S1), NOT_ALLOWED);
      await assert.rejects(fromActivity(ID.S1, ID.A1), NOT_ALLOWED);
    } finally {
      await db.query("update teacher_profiles set approved = true where profile_id = $1", [ID.T2]);
    }
  });

  test("both people must be age-cleared (Stage 2): pending, declined and missing records are all refused", async () => {
    assert.ok(await fromLesson(ID.S2, ID.L1), "under-18 with guardian approval (account + messaging) is allowed");
    await assert.rejects(fromLesson(ID.S8, ID.L1), /messaging:not_permitted/); // account approved, messaging not (0014)
    await assert.rejects(fromLesson(ID.S3, ID.L1), NOT_CLEARED); // guardian approval pending
    await assert.rejects(fromLesson(ID.S6, ID.L1), NOT_CLEARED); // guardian declined
    await assert.rejects(fromLesson(ID.S4, ID.L1), NOT_CLEARED); // no age record yet

    const saved = await db.query("select * from age_records where profile_id = $1", [ID.T1]);
    await db.query("delete from age_records where profile_id = $1", [ID.T1]);
    try {
      await assert.rejects(fromLesson(ID.S1, ID.L1), NOT_CLEARED); // teacher has no age record
    } finally {
      const r = saved.rows[0] as { profile_id: string; date_of_birth: string; consent_status: string };
      await db.query("insert into age_records (profile_id, date_of_birth, consent_status) values ($1, $2, $3)", [r.profile_id, r.date_of_birth, r.consent_status]);
    }
  });

  test("students and teachers can only be paired student→teacher; there is no student-to-student or teacher-to-teacher path", async () => {
    await assert.rejects(fromLesson(ID.T1, ID.L1), NOT_ALLOWED); // a teacher acting as the 'student'
    await assert.rejects(asTeacher(ID.S1, ID.S7), NOT_ALLOWED); // a student acting as the 'teacher'
    await assert.rejects(asTeacher(ID.S1, ID.T2), NOT_ALLOWED);
  });

  test("the internal helper that opens conversations cannot be called by anyone, not even the server role", async () => {
    for (const actor of [SERVICE, { id: ID.S1 }, "anon"] as Actor[]) {
      await assert.rejects(one(actor, "_open_conversation", { p_student: ID.S1, p_teacher: ID.T1 }), /permission denied/i);
    }
  });
});

describe("SENDING messages", () => {
  test("both people in a conversation can send; both messages are stored with the right sender", async () => {
    const c = await fromLesson(ID.S1, ID.L1);
    await send(ID.S1, c, { body: "Hello teacher" });
    await send(ID.T1, c, { body: "Hello student" });
    const { rows } = await db.query<{ sender_id: string; body: string }>("select sender_id, body from messages order by created_at, body");
    assert.deepEqual(rows.map((r) => r.sender_id).sort(), [ID.S1, ID.T1].sort());
  });

  test("someone who is not in the conversation cannot send into it", async () => {
    const c = await fromLesson(ID.S1, ID.L1);
    for (const outsider of [ID.S7, ID.T4, ID.T2, ID.ADMIN, ID.S2]) {
      await assert.rejects(send(outsider, c), /messaging:not_found/);
    }
    await assert.rejects(send(uuid(), c), /messaging:not_found/);
    await assert.rejects(send(ID.S1, uuid()), /messaging:not_found/);
    assert.equal((await db.query("select 1 from messages")).rows.length, 0);
  });

  test("homework is teacher-only and submissions are student-only", async () => {
    const c = await fromLesson(ID.S1, ID.L1);
    await send(ID.T1, c, { kind: "homework", body: "Do exercise 4" });
    await send(ID.S1, c, { kind: "submission", body: "Done" });
    await assert.rejects(send(ID.S1, c, { kind: "homework" }), /messaging:bad_request/);
    await assert.rejects(send(ID.T1, c, { kind: "submission" }), /messaging:bad_request/);
    await assert.rejects(send(ID.S1, c, { kind: "announcement" }), /messaging:bad_request/);
  });

  test("a message needs text or a file, and text is capped at 2000 characters", async () => {
    const c = await fromLesson(ID.S1, ID.L1);
    await assert.rejects(send(ID.S1, c, { body: "" }), /messaging:empty/);
    await assert.rejects(send(ID.S1, c, { body: "   \n\t " }), /messaging:empty/);
    await assert.rejects(send(ID.S1, c, { body: "\n\n\n" }), /messaging:empty/);
    await assert.rejects(send(ID.S1, c, { body: "\u00a0 \r\n" }), /messaging:empty/); // non-breaking space too
    await assert.rejects(send(ID.S1, c, { body: "\u200b\u3000\u00a0" }), /messaging:empty/); // zero-width, ideographic, nbsp
    await assert.rejects(send(ID.S1, c, { body: null }), /messaging:empty/);
    await send(ID.S1, c, { body: "x".repeat(2000) });
    await assert.rejects(send(ID.S1, c, { body: "x".repeat(2001) }), /messaging:too_long/);
  });

  test("a PDF-only message (no text) is allowed and is stored against the right conversation", async () => {
    const c = await fromLesson(ID.S1, ID.L1);
    const path = pdfPath(c);
    const id = await send(ID.S1, c, { body: "", kind: "submission", path, name: "homework.pdf", size: 12345 });
    const { rows } = await db.query<{ attachment_path: string; attachment_size: string; conversation_id: string }>("select attachment_path, attachment_size::text, conversation_id from messages where id = $1", [id]);
    assert.equal(rows[0].attachment_path, path);
    assert.equal(Number(rows[0].attachment_size), 12345);
    assert.equal(rows[0].conversation_id, c);
  });

  test("attachments are constrained: server-shaped path inside the SAME conversation, PDF, 1 byte to 10 MB, one message per file", async () => {
    const c = await fromLesson(ID.S1, ID.L1);
    const other = await fromLesson(ID.S2, ID.L1);
    const ok = (o: object) => send(ID.S1, c, { path: pdfPath(c), name: "a.pdf", size: 1000, ...o });

    await assert.rejects(ok({ path: pdfPath(other) }), /messaging:bad_attachment/); // another conversation's folder
    await assert.rejects(ok({ path: `${c}/${uuid()}.exe` }), /messaging:bad_attachment/);
    await assert.rejects(ok({ path: `${c}/../${other}/${uuid()}.pdf` }), /messaging:bad_attachment/);
    await assert.rejects(ok({ path: `${c}/${uuid().toUpperCase()}.pdf` }), /messaging:bad_attachment/);
    await assert.rejects(ok({ path: `${c}/not-a-uuid.pdf` }), /messaging:bad_attachment/);
    await assert.rejects(ok({ path: "somewhere/else.pdf" }), /messaging:bad_attachment/);
    await assert.rejects(ok({ size: 0 }), /messaging:bad_attachment/);
    await assert.rejects(ok({ size: MB10 + 1 }), /messaging:bad_attachment/);
    await assert.rejects(ok({ name: null }), /messaging:bad_attachment/);
    await assert.rejects(ok({ size: null }), /messaging:bad_attachment/);
    await assert.rejects(send(ID.S1, c, { name: "orphan.pdf", size: 5 }), /messaging:bad_attachment/); // name/size without a file

    await ok({ size: MB10 }); // exactly 10 MB is fine
    const reused = pdfPath(c);
    await ok({ path: reused });
    await assert.rejects(ok({ path: reused }), /messaging:bad_attachment/); // the same file cannot back a second message
  });

  test("the table itself also refuses malformed attachments and empty messages (defence in depth)", async () => {
    const c = await fromLesson(ID.S1, ID.L1);
    const insert = (sql: string, params: unknown[]) => db.query(`insert into messages (conversation_id, sender_id, body, attachment_path, attachment_name, attachment_size) values ${sql}`, params);
    await assert.rejects(insert("($1, $2, '', null, null, null)", [c, ID.S1]), /messages_has_content/);
    await assert.rejects(insert("($1, $2, E'  \\n\\t ', null, null, null)", [c, ID.S1]), /messages_has_content/);
    await assert.rejects(insert("($1, $2, 'x', $3, 'a.pdf', 10)", [c, ID.S1, `${c}/${uuid()}.html`]), /messages_attachment_path/);
    await assert.rejects(insert("($1, $2, 'x', $3, 'a.pdf', 10)", [c, ID.S1, pdfPath(uuid())]), /messages_attachment_path/);
    await assert.rejects(insert("($1, $2, 'x', $3, null, 10)", [c, ID.S1, pdfPath(c)]), /messages_attachment_all_or_none/);
    await assert.rejects(insert("($1, $2, 'x', $3, 'a.pdf', 99999999999)", [c, ID.S1, pdfPath(c)]), /messages_attachment_size/);
  });

  test("when the relationship ends the thread becomes read-only: lesson unpublished, subscription cancelled, teacher unapproved", async () => {
    // Lesson-based conversation: closes when the teacher has no published lesson left.
    const byLesson = await fromLesson(ID.S1, ID.L1);
    await send(ID.S1, byLesson);
    await db.query("update lessons set status = 'draft' where id = $1", [ID.L1]);
    try {
      await assert.rejects(send(ID.S1, byLesson), /messaging:closed/);
      await assert.rejects(send(ID.T1, byLesson), /messaging:closed/);
      assert.equal(await count({ id: ID.S1 }, "select 1 from messages where conversation_id = $1", [byLesson]), 1, "history stays readable");
    } finally {
      await db.query("update lessons set status = 'published' where id = $1", [ID.L1]);
    }
    await send(ID.S1, byLesson); // reopens with the lesson

    // Activity-based conversation: closes when the subscription is no longer active.
    const byActivity = await fromActivity(ID.S1, ID.A1);
    await send(ID.T2, byActivity);
    await db.query("update subscriptions set status = 'cancelled' where student_id = $1 and activity_id = $2", [ID.S1, ID.A1]);
    try {
      await assert.rejects(send(ID.S1, byActivity), /messaging:closed/);
      await assert.rejects(send(ID.T2, byActivity), /messaging:closed/);
    } finally {
      await db.query("update subscriptions set status = 'active' where student_id = $1 and activity_id = $2", [ID.S1, ID.A1]);
    }

    // Approval withdrawn.
    await db.query("update teacher_profiles set approved = false where profile_id = $1", [ID.T1]);
    try {
      await assert.rejects(send(ID.S1, byLesson), /messaging:closed/);
    } finally {
      await db.query("update teacher_profiles set approved = true where profile_id = $1", [ID.T1]);
    }
  });

  test("sending stops, and reading stops, if a child's guardian consent is later withdrawn", async () => {
    const c = await fromLesson(ID.S2, ID.L1);
    await send(ID.S2, c);
    await db.query("update age_records set consent_status = 'declined' where profile_id = $1", [ID.S2]);
    try {
      await assert.rejects(send(ID.S2, c), NOT_CLEARED);
      await assert.rejects(send(ID.T1, c), NOT_CLEARED);
      assert.equal(await count({ id: ID.S2 }, "select 1 from conversations"), 0);
      assert.equal(await count({ id: ID.S2 }, "select 1 from messages"), 0);
      assert.equal(await count({ id: ID.T1 }, "select 1 from messages"), 0);
    } finally {
      await db.query("update age_records set consent_status = 'granted' where profile_id = $1", [ID.S2]);
    }
    assert.equal(await count({ id: ID.S2 }, "select 1 from messages"), 1);
  });
});

describe("READING: each person sees only their own conversations", () => {
  test("students, teachers, outsiders, anonymous visitors and admins", async () => {
    const c1 = await fromLesson(ID.S1, ID.L1); // S1 ↔ T1
    const c2 = await fromLesson(ID.S2, ID.L1); // S2 ↔ T1
    const c3 = await fromActivity(ID.S1, ID.A1); // S1 ↔ T2
    await send(ID.S1, c1, { body: "secret in c1" });
    await send(ID.S2, c2, { body: "secret in c2" });
    await send(ID.S1, c3, { body: "secret in c3" });

    const ids = async (actor: Actor) => (await as(db, actor, () => db.query<{ id: string }>("select id from conversations order by id"))).rows.map((r) => r.id).sort();
    assert.deepEqual(await ids({ id: ID.S1 }), [c1, c3].sort(), "S1 sees only S1's two conversations");
    assert.deepEqual(await ids({ id: ID.S2 }), [c2]);
    assert.deepEqual(await ids({ id: ID.T1 }), [c1, c2].sort(), "T1 sees only T1's conversations");
    assert.deepEqual(await ids({ id: ID.T2 }), [c3]);

    // Outsiders and admins see nothing — including by asking for a specific id.
    for (const outsider of [{ id: ID.S7 }, { id: ID.T4 }, { id: ID.T3 }, { id: ID.ADMIN }] as Actor[]) {
      assert.equal(await count(outsider, "select 1 from conversations"), 0);
      assert.equal(await count(outsider, "select 1 from messages"), 0);
      assert.equal(await count(outsider, "select 1 from messages where conversation_id = $1", [c1]), 0);
      assert.equal(await count(outsider, "select 1 from conversations where id = $1", [c1]), 0);
    }
    await denied("anon", "select 1 from conversations");
    await denied("anon", "select 1 from messages");

    // A participant of ONE conversation cannot read another one, even by guessing its id.
    assert.equal(await count({ id: ID.S2 }, "select 1 from messages where conversation_id = $1", [c1]), 0);
    assert.equal(await count({ id: ID.T2 }, "select 1 from messages where conversation_id = $1", [c1]), 0);
    assert.equal(await count({ id: ID.S1 }, "select 1 from messages where conversation_id = $1", [c1]), 1);
  });

  test("clients cannot write at all: no insert, update or delete on conversations or messages, for anyone", async () => {
    const c = await fromLesson(ID.S1, ID.L1);
    const m = await send(ID.S1, c, { body: "original" });

    for (const actor of [{ id: ID.S1 }, { id: ID.T1 }, { id: ID.S7 }, { id: ID.ADMIN }, "anon"] as Actor[]) {
      await denied(actor, "insert into conversations (student_id, teacher_id) values ($1, $2)", [ID.S1, ID.T4]);
      await denied(actor, "insert into messages (conversation_id, sender_id, body) values ($1, $2, 'forged')", [c, ID.T1]);
      await denied(actor, "update messages set body = 'edited' where id = $1", [m]);
      await denied(actor, "update conversations set last_message_at = now() where id = $1", [c]);
      await denied(actor, "delete from messages where id = $1", [m]);
      await denied(actor, "delete from conversations where id = $1", [c]);
    }
    const { rows } = await db.query<{ body: string }>("select body from messages");
    assert.deepEqual(rows, [{ body: "original" }]);

    const policies = await db.query<{ tablename: string; cmd: string }>("select tablename, cmd from pg_policies where tablename in ('conversations','messages')");
    assert.deepEqual(policies.rows.map((p) => p.cmd), ["SELECT", "SELECT"], "only SELECT policies exist");
  });

  test("none of the server-only functions can be called from a browser session", async () => {
    const c = await fromLesson(ID.S1, ID.L1);
    const calls: [string, Record<string, unknown>][] = [
      ["start_conversation_from_lesson", { p_student: ID.S7, p_lesson: ID.L1 }],
      ["start_conversation_from_activity", { p_student: ID.S1, p_activity: ID.A1 }],
      ["start_conversation_as_teacher", { p_teacher: ID.T2, p_student: ID.S1 }],
      ["messaging_can_send", { p_user: ID.S1, p_conversation: c }],
      ["send_message", { p_sender: ID.S1, p_conversation: c, p_body: "x", p_kind: "message", p_attachment_path: null, p_attachment_name: null, p_attachment_size: null }],
      ["messaging_conversation_ids", { p_user: ID.S1 }],
      ["delete_user_messages", { p_user: ID.S1 }],
      ["messaging_relationship", { p_student: ID.S1, p_teacher: ID.T1 }],
      ["age_cleared", { p_profile: ID.S1 }],
    ];
    for (const actor of [{ id: ID.S1 }, { id: ID.T1 }, "anon"] as Actor[]) {
      for (const [name, args] of calls) {
        await assert.rejects(one(actor, name, args), /permission denied/i, `${name} must not be callable by a browser session`);
      }
    }
    assert.equal((await db.query("select 1 from messages")).rows.length, 0);
    assert.equal((await db.query("select 1 from conversations")).rows.length, 1);
  });

  test("the read-policy helper answers 'yes' only for a participant of a fully cleared conversation, and reveals nothing otherwise", async () => {
    const c = await fromLesson(ID.S1, ID.L1);
    const canRead = (actor: Actor, id: string) => one(actor, "caller_can_read_conversation", { p_conversation: id });
    assert.equal(await canRead({ id: ID.S1 }, c), true);
    assert.equal(await canRead({ id: ID.T1 }, c), true);
    assert.equal(await canRead({ id: ID.S7 }, c), false); // outsider
    assert.equal(await canRead({ id: ID.ADMIN }, c), false); // admins get no access
    assert.equal(await canRead("anon", c), false);
    assert.equal(await canRead({ id: ID.S1 }, uuid()), false); // unknown id: same answer as "not yours"
  });
});

describe("account deletion support", () => {
  test("delete_user_messages removes the conversations and messages for BOTH people; other people's threads are untouched", async () => {
    const c1 = await fromLesson(ID.S1, ID.L1);
    const c2 = await fromLesson(ID.S2, ID.L1);
    await send(ID.S1, c1);
    await send(ID.T1, c1);
    await send(ID.S2, c2);

    const listed = (await call(SERVICE, "messaging_conversation_ids", { p_user: ID.S1 })) as string[];
    assert.deepEqual(listed, [c1]);

    assert.equal(await one(SERVICE, "delete_user_messages", { p_user: ID.S1 }), 1);
    assert.equal((await db.query("select 1 from conversations where id = $1", [c1])).rows.length, 0);
    assert.equal((await db.query("select 1 from messages where conversation_id = $1", [c1])).rows.length, 0);
    assert.equal(await count({ id: ID.T1 }, "select 1 from conversations"), 1, "T1 keeps the conversation with S2");
    assert.equal((await db.query("select 1 from messages where conversation_id = $1", [c2])).rows.length, 1);
  });

  test("the normal hard-delete path (removing the login) cascades to conversations and messages", async () => {
    const c = await fromLesson(ID.S7, ID.L1);
    await send(ID.S7, c);
    await db.query("delete from auth.users where id = $1", [ID.S7]);
    assert.equal((await db.query("select 1 from conversations where id = $1", [c])).rows.length, 0);
    assert.equal((await db.query("select 1 from messages where conversation_id = $1", [c])).rows.length, 0);
  });
});

// Database-level tests for migration 0011 (messaging), run against a real Postgres that has
// the repository's actual migrations applied. These prove the RULES hold in the database
// itself — independent of any application code.
//
// The rules under test:
//   * The only student–teacher relationship is an ACTIVE activity subscription whose student,
//     activity and teacher all match (a published lesson alone is not a relationship).
//   * Both people must have an approved account (age_cleared(): adult, or guardian-approved under-18).
//   * Adults: either side may start. Under-18s: only the student may start, and the teacher can
//     write only after the student has sent the first message.
//   * An ended subscription starts nothing new; existing threads become read-only, never deleted.

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, type Actor } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";

let db: PGlite;

const uuid = () => crypto.randomUUID();
const pdfPath = (conversationId: string) => `${conversationId}/${uuid()}.pdf`;
const MB10 = 10 * 1024 * 1024;

// Extra people for this file only (the shared seed is used by the payment tests too).
const SX = "bbbbbbbb-0000-4000-8000-0000000000a1"; // adult, active subscriber of A1 (deleted by the last test)

async function call(actor: Actor, name: string, args: Record<string, unknown>) {
  const keys = Object.keys(args);
  const sql = `select ${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  return as(db, actor, async () => (await db.query<{ r: unknown }>(sql, keys.map((k) => args[k]))).rows.map((x) => x.r));
}
const one = async (actor: Actor, name: string, args: Record<string, unknown>) => (await call(actor, name, args))[0];

const SERVICE: Actor = "service";
const fromActivity = (student: string, activity: string) => one(SERVICE, "start_conversation_from_activity", { p_student: student, p_activity: activity }) as Promise<string>;
const asTeacher = (teacher: string, student: string) => one(SERVICE, "start_conversation_as_teacher", { p_teacher: teacher, p_student: student }) as Promise<string>;
const canSend = (user: string, conversation: string) => one(SERVICE, "messaging_can_send", { p_user: user, p_conversation: conversation }) as Promise<string>;
const isMinor = (profile: string, at: string) => one(SERVICE, "messaging_is_minor", { p_profile: profile, p_at: at }) as Promise<boolean>;
const startable = async (teacher: string) => ((await call(SERVICE, "messaging_teacher_startable_students", { p_teacher: teacher })) as string[]).sort();

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
const MINOR = /messaging:minor_student/;
const AWAITING = /messaging:awaiting_student/;

async function count(actor: Actor, sql: string, params: unknown[] = []): Promise<number> {
  return as(db, actor, async () => (await db.query(sql, params)).rows.length);
}
async function denied(actor: Actor, sql: string, params: unknown[] = []): Promise<void> {
  await assert.rejects(as(db, actor, () => db.query(sql, params)), /permission denied|row-level security|violates/i);
}

/** Runs `fn` with an extra subscription row in place, then removes it. */
async function withSubscription(row: { student: string; activity: string; teacher: string; status?: string; periodEnd?: string | null }, fn: () => Promise<void>) {
  await db.query("insert into subscriptions (student_id, activity_id, teacher_id, status, current_period_end) values ($1, $2, $3, $4, $5)", [
    row.student,
    row.activity,
    row.teacher,
    row.status ?? "active",
    row.periodEnd ?? null,
  ]);
  try {
    await fn();
  } finally {
    await db.query("delete from subscriptions where student_id = $1 and activity_id = $2", [row.student, row.activity]);
  }
}

/** Runs `fn` with S2's date of birth changed, then puts it back. */
async function withBirthDate(profile: string, sqlDate: string, fn: () => Promise<void>) {
  const { rows } = await db.query<{ d: string }>("select date_of_birth::text as d from age_records where profile_id = $1", [profile]);
  await db.query(`update age_records set date_of_birth = ${sqlDate} where profile_id = $1`, [profile]);
  try {
    await fn();
  } finally {
    await db.query("update age_records set date_of_birth = $2 where profile_id = $1", [profile, rows[0].d]);
  }
}

// The Kenyan calendar date exactly 18 years ago: someone born then turns 18 today.
const EIGHTEEN_TODAY = "((now() at time zone 'Africa/Nairobi')::date - interval '18 years')::date";

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data)
      values ('${SX}', '${SX}@test.invalid', '{"role":"student","full_name":"Student X"}');
    insert into age_records (profile_id, date_of_birth, consent_status) values ('${SX}', '1995-05-05', 'not_required');
    -- S2 is under 18 with a guardian-approved account; give S2 the same activity as S1.
    insert into subscriptions (student_id, activity_id, teacher_id, status) values
      ('${ID.S2}', '${ID.A1}', '${ID.T2}', 'active'),
      ('${SX}', '${ID.A1}', '${ID.T2}', 'active');
  `);
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

    const conv = await fromActivity(ID.S1, ID.A1);
    await db.query("insert into storage.objects (bucket_id, name) values ('message-attachments', $1)", [pdfPath(conv)]);
    for (const actor of [{ id: ID.S1 }, { id: ID.T2 }, { id: ID.ADMIN }, "anon"] as Actor[]) {
      assert.equal(await count(actor, "select 1 from storage.objects where bucket_id = 'message-attachments'"), 0);
      await denied(actor, "insert into storage.objects (bucket_id, name) values ('message-attachments', $1)", [pdfPath(conv)]);
    }
    const del = await as(db, { id: ID.S1 }, () => db.query("delete from storage.objects where bucket_id = 'message-attachments'"));
    assert.equal(del.affectedRows, 0, "a participant must not be able to delete files directly");
  });
});

describe("who may START a conversation: an active activity subscription is the only relationship", () => {
  test("a published lesson alone is not a relationship: the lesson start is gone, and T1 (lessons only) is unreachable", async () => {
    const { rows } = await db.query<{ fn: string | null }>("select to_regproc('public.start_conversation_from_lesson')::text as fn");
    assert.equal(rows[0].fn, null, "start_conversation_from_lesson must not exist");
    await assert.rejects(asTeacher(ID.T1, ID.S1), NOT_ALLOWED);
    assert.equal(await one(SERVICE, "messaging_relationship", { p_student: ID.S1, p_teacher: ID.T1 }), false);
  });

  test("a student with an ACTIVE subscription can start with that activity's teacher", async () => {
    const id = await fromActivity(ID.S1, ID.A1);
    const { rows } = await db.query<{ student_id: string; teacher_id: string }>("select student_id, teacher_id from conversations where id = $1", [id]);
    assert.deepEqual(rows[0], { student_id: ID.S1, teacher_id: ID.T2 });
  });

  test("an approved under-18 student can start too", async () => {
    const id = await fromActivity(ID.S2, ID.A1);
    assert.ok(id);
  });

  test("starting again returns the same conversation (one thread per student–teacher pair)", async () => {
    const a = await fromActivity(ID.S1, ID.A1);
    const b = await fromActivity(ID.S1, ID.A1);
    const c = await asTeacher(ID.T2, ID.S1);
    assert.equal(a, b);
    assert.equal(a, c);
    assert.equal((await db.query("select 1 from conversations")).rows.length, 1);
  });

  test("…but not without one: pending payment, no subscription, another activity, a draft activity, an unknown activity", async () => {
    await assert.rejects(fromActivity(ID.S5, ID.A1), NOT_ALLOWED); // pending_payment
    await assert.rejects(fromActivity(ID.S7, ID.A1), NOT_ALLOWED); // never subscribed
    await assert.rejects(fromActivity(ID.S1, ID.A2), NOT_ALLOWED); // subscribed to A1, not A2
    await assert.rejects(fromActivity(ID.S1, uuid()), NOT_ALLOWED);
    await withSubscription({ student: ID.S1, activity: ID.A3, teacher: ID.T2 }, async () => {
      await assert.rejects(fromActivity(ID.S1, ID.A3), NOT_ALLOWED); // active, but the activity is a draft
    });
  });

  test("the subscription must match the exact student, activity and teacher — a mismatched teacher opens nothing", async () => {
    // S7 'subscribed' to T2's activity A1, but the row names T4 as the teacher.
    await withSubscription({ student: ID.S7, activity: ID.A1, teacher: ID.T4 }, async () => {
      await assert.rejects(fromActivity(ID.S7, ID.A1), NOT_ALLOWED);
      await assert.rejects(asTeacher(ID.T4, ID.S7), NOT_ALLOWED);
      await assert.rejects(asTeacher(ID.T2, ID.S7), NOT_ALLOWED);
      assert.equal(await one(SERVICE, "messaging_relationship", { p_student: ID.S7, p_teacher: ID.T4 }), false);
      assert.equal(await one(SERVICE, "messaging_relationship", { p_student: ID.S7, p_teacher: ID.T2 }), false);
    });
    // S7 'subscribed' to T4's activity A2, but the row names T2.
    await withSubscription({ student: ID.S7, activity: ID.A2, teacher: ID.T2 }, async () => {
      await assert.rejects(fromActivity(ID.S7, ID.A2), NOT_ALLOWED);
      await assert.rejects(asTeacher(ID.T2, ID.S7), NOT_ALLOWED);
      await assert.rejects(asTeacher(ID.T4, ID.S7), NOT_ALLOWED);
    });
    assert.equal((await db.query("select 1 from conversations")).rows.length, 0);
  });

  test("an ended subscription starts nothing: cancelled, expired, or past its period end; a future or empty end date is active", async () => {
    for (const ended of [{ status: "cancelled" }, { status: "expired" }, { status: "active", periodEnd: "2000-01-01T00:00:00Z" }]) {
      await withSubscription({ student: ID.S7, activity: ID.A1, teacher: ID.T2, ...ended }, async () => {
        await assert.rejects(fromActivity(ID.S7, ID.A1), NOT_ALLOWED, JSON.stringify(ended));
        await assert.rejects(asTeacher(ID.T2, ID.S7), NOT_ALLOWED, JSON.stringify(ended));
      });
    }
    await withSubscription({ student: ID.S7, activity: ID.A1, teacher: ID.T2, periodEnd: "2999-01-01T00:00:00Z" }, async () => {
      assert.ok(await fromActivity(ID.S7, ID.A1));
    });
    await db.exec("delete from conversations");
    // S1's seeded subscription has no end date (free, one-time or per-lesson billing): still active.
    assert.ok(await fromActivity(ID.S1, ID.A1));
  });

  test("a teacher can start with an eligible ADULT subscriber, and with nobody else", async () => {
    const id = await asTeacher(ID.T2, ID.S1);
    const { rows } = await db.query<{ student_id: string }>("select student_id from conversations where id = $1", [id]);
    assert.equal(rows[0].student_id, ID.S1);

    await assert.rejects(asTeacher(ID.T2, ID.S5), NOT_ALLOWED); // pending payment
    await assert.rejects(asTeacher(ID.T2, ID.S7), NOT_ALLOWED); // unrelated student
    await assert.rejects(asTeacher(ID.T1, ID.S1), NOT_ALLOWED); // T1 has only a published lesson
    await assert.rejects(asTeacher(ID.T4, ID.S1), NOT_ALLOWED); // S1 is subscribed to T2's activity, not T4's
  });

  test("a teacher can NEVER start with an under-18 subscriber — not even when the minor has already opened a thread", async () => {
    await assert.rejects(asTeacher(ID.T2, ID.S2), MINOR);
    assert.equal((await db.query("select 1 from conversations")).rows.length, 0, "the refused attempt created nothing");

    const opened = await fromActivity(ID.S2, ID.A1);
    await assert.rejects(asTeacher(ID.T2, ID.S2), MINOR);
    await send(ID.S2, opened);
    await assert.rejects(asTeacher(ID.T2, ID.S2), MINOR, "the teacher replies in the thread; they never 'start' one");
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

  test("both accounts must be approved (0010): pending, declined and missing records are all refused", async () => {
    for (const student of [ID.S3, ID.S6, ID.S4]) {
      await withSubscription({ student, activity: ID.A1, teacher: ID.T2 }, async () => {
        await assert.rejects(fromActivity(student, ID.A1), NOT_CLEARED, student);
      });
    }

    const saved = await db.query<{ profile_id: string; date_of_birth: string; consent_status: string }>(
      "select profile_id, date_of_birth::text as date_of_birth, consent_status from age_records where profile_id = $1",
      [ID.T2],
    );
    await db.query("delete from age_records where profile_id = $1", [ID.T2]);
    try {
      await assert.rejects(fromActivity(ID.S1, ID.A1), NOT_CLEARED); // the teacher has no age record
      await assert.rejects(asTeacher(ID.T2, ID.S1), NOT_CLEARED);
    } finally {
      const r = saved.rows[0];
      await db.query("insert into age_records (profile_id, date_of_birth, consent_status) values ($1, $2, $3)", [r.profile_id, r.date_of_birth, r.consent_status]);
    }
  });

  test("students and teachers can only be paired student→teacher; there is no student-to-student or teacher-to-teacher path", async () => {
    // Even a (forged) active subscription with a teacher in the student's seat opens nothing.
    await withSubscription({ student: ID.T1, activity: ID.A1, teacher: ID.T2 }, async () => {
      await assert.rejects(fromActivity(ID.T1, ID.A1), NOT_ALLOWED);
      await assert.rejects(asTeacher(ID.T2, ID.T1), NOT_ALLOWED);
    });
    await assert.rejects(asTeacher(ID.S1, ID.S7), NOT_ALLOWED); // a student acting as the 'teacher'
    await assert.rejects(asTeacher(ID.S1, ID.T2), NOT_ALLOWED);
    assert.equal((await db.query("select 1 from conversations")).rows.length, 0);
  });

  test("the internal helper that opens conversations cannot be called by anyone, not even the server role", async () => {
    for (const actor of [SERVICE, { id: ID.S1 }, "anon"] as Actor[]) {
      await assert.rejects(one(actor, "_open_conversation", { p_student: ID.S1, p_teacher: ID.T2 }), /permission denied/i);
    }
  });
});

describe("under-18 students: the student writes first", () => {
  test("a minor opens a thread: the teacher must wait — even for homework or a file — until the minor has written", async () => {
    const c = await fromActivity(ID.S2, ID.A1);
    assert.equal(await canSend(ID.T2, c), "awaiting_student");
    assert.equal(await canSend(ID.S2, c), "ok");
    await assert.rejects(send(ID.T2, c), AWAITING);
    await assert.rejects(send(ID.T2, c, { kind: "homework", body: "Do exercise 4" }), AWAITING);
    await assert.rejects(send(ID.T2, c, { body: "", path: pdfPath(c), name: "a.pdf", size: 10 }), AWAITING);
    assert.equal((await db.query("select 1 from messages")).rows.length, 0);

    await send(ID.S2, c, { body: "Hello coach" });
    assert.equal(await canSend(ID.T2, c), "ok");
    await send(ID.T2, c, { body: "Hello!" });
    await send(ID.T2, c, { kind: "homework", body: "Practise the drill" });
    await send(ID.S2, c, { kind: "submission", body: "Done" });
    assert.equal((await db.query("select 1 from messages where conversation_id = $1", [c])).rows.length, 4);
  });

  test("a PDF-only first message from the minor counts", async () => {
    const c = await fromActivity(ID.S2, ID.A1);
    await send(ID.S2, c, { body: "", kind: "submission", path: pdfPath(c), name: "work.pdf", size: 100 });
    assert.ok(await send(ID.T2, c, { body: "Thanks" }));
  });

  test("adults: the teacher may write first, whoever opened the thread", async () => {
    const studentOpened = await fromActivity(ID.S1, ID.A1);
    assert.equal(await canSend(ID.T2, studentOpened), "ok");
    assert.ok(await send(ID.T2, studentOpened, { body: "Welcome" }));

    await db.exec("delete from conversations");
    const teacherOpened = await asTeacher(ID.T2, ID.S1);
    assert.ok(await send(ID.T2, teacherOpened, { body: "Welcome" }));
  });

  test("age is worked out on the Kenyan date at the moment of the check, with the 29 February rule", async () => {
    await withBirthDate(ID.S2, "'2008-10-02'", async () => {
      assert.equal(await isMinor(ID.S2, "2026-10-01T20:59:59Z"), true, "23:59:59 in Nairobi on 1 October: still 17");
      assert.equal(await isMinor(ID.S2, "2026-10-01T21:00:00Z"), false, "00:00 in Nairobi on 2 October: 18");
    });
    await withBirthDate(ID.S2, "'2008-02-29'", async () => {
      assert.equal(await isMinor(ID.S2, "2026-02-28T12:00:00Z"), true, "not 18 yet on 28 February");
      assert.equal(await isMinor(ID.S2, "2026-03-01T12:00:00Z"), false, "18 on 1 March in a non-leap year");
    });
    assert.equal(await isMinor(ID.S4, "2026-10-01T12:00:00Z"), true, "no age record: treated as a minor (fails closed)");
    assert.equal(await isMinor(uuid(), "2026-10-01T12:00:00Z"), true);
  });

  test("on their 18th birthday the student is an adult for messaging: the teacher may start and may write first", async () => {
    await withBirthDate(ID.S2, `${EIGHTEEN_TODAY} + 1`, async () => {
      await assert.rejects(asTeacher(ID.T2, ID.S2), MINOR, "the day before the 18th birthday");
    });
    await withBirthDate(ID.S2, EIGHTEEN_TODAY, async () => {
      const c = await asTeacher(ID.T2, ID.S2);
      assert.ok(await send(ID.T2, c, { body: "Happy birthday" }));
    });
  });
});

describe("the teacher's start list (messaging_teacher_startable_students)", () => {
  test("lists only adult, approved students with an active matching subscription — never minors, never ages", async () => {
    assert.deepEqual(await startable(ID.T2), [ID.S1, SX].sort()); // S2 (minor) and S5 (pending payment) excluded
    assert.deepEqual(await startable(ID.T1), []); // lessons only
    assert.deepEqual(await startable(ID.T4), []); // no subscribers

    await withSubscription({ student: ID.S3, activity: ID.A2, teacher: ID.T4 }, async () => {
      assert.deepEqual(await startable(ID.T4), [], "an account still waiting for its guardian is not listed");
    });
    await withSubscription({ student: ID.S7, activity: ID.A2, teacher: ID.T4, periodEnd: "2000-01-01T00:00:00Z" }, async () => {
      assert.deepEqual(await startable(ID.T4), [], "an expired subscription is not listed");
    });
    await withSubscription({ student: ID.S7, activity: ID.A1, teacher: ID.T4 }, async () => {
      assert.deepEqual(await startable(ID.T4), [], "a mismatched teacher is not listed");
    });

    await db.query("update teacher_profiles set approved = false where profile_id = $1", [ID.T2]);
    try {
      assert.deepEqual(await startable(ID.T2), [], "an unapproved teacher can start with nobody");
    } finally {
      await db.query("update teacher_profiles set approved = true where profile_id = $1", [ID.T2]);
    }
  });
});

describe("SENDING messages", () => {
  test("both people in a conversation can send; both messages are stored with the right sender", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    await send(ID.S1, c, { body: "Hello teacher" });
    await send(ID.T2, c, { body: "Hello student" });
    const { rows } = await db.query<{ sender_id: string; body: string }>("select sender_id, body from messages order by created_at, body");
    assert.deepEqual(rows.map((r) => r.sender_id).sort(), [ID.S1, ID.T2].sort());
  });

  test("someone who is not in the conversation cannot send into it", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    for (const outsider of [ID.S7, ID.T4, ID.T1, ID.ADMIN, ID.S2]) {
      await assert.rejects(send(outsider, c), /messaging:not_found/);
    }
    await assert.rejects(send(uuid(), c), /messaging:not_found/);
    await assert.rejects(send(ID.S1, uuid()), /messaging:not_found/);
    assert.equal((await db.query("select 1 from messages")).rows.length, 0);
  });

  test("homework is teacher-only and submissions are student-only", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    await send(ID.T2, c, { kind: "homework", body: "Do exercise 4" });
    await send(ID.S1, c, { kind: "submission", body: "Done" });
    await assert.rejects(send(ID.S1, c, { kind: "homework" }), /messaging:bad_request/);
    await assert.rejects(send(ID.T2, c, { kind: "submission" }), /messaging:bad_request/);
    await assert.rejects(send(ID.S1, c, { kind: "announcement" }), /messaging:bad_request/);
  });

  test("a message needs text or a file, and text is capped at 2000 characters", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    await assert.rejects(send(ID.S1, c, { body: "" }), /messaging:empty/);
    await assert.rejects(send(ID.S1, c, { body: "   \n\t " }), /messaging:empty/);
    await assert.rejects(send(ID.S1, c, { body: "\n\n\n" }), /messaging:empty/);
    await assert.rejects(send(ID.S1, c, { body: "  \r\n" }), /messaging:empty/); // non-breaking space too
    await assert.rejects(send(ID.S1, c, { body: "​　 " }), /messaging:empty/); // zero-width, ideographic, nbsp
    await assert.rejects(send(ID.S1, c, { body: null }), /messaging:empty/);
    await send(ID.S1, c, { body: "x".repeat(2000) });
    await assert.rejects(send(ID.S1, c, { body: "x".repeat(2001) }), /messaging:too_long/);
  });

  test("a PDF-only message (no text) is allowed and is stored against the right conversation", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    const path = pdfPath(c);
    const id = await send(ID.S1, c, { body: "", kind: "submission", path, name: "homework.pdf", size: 12345 });
    const { rows } = await db.query<{ attachment_path: string; attachment_size: string; conversation_id: string }>("select attachment_path, attachment_size::text, conversation_id from messages where id = $1", [id]);
    assert.equal(rows[0].attachment_path, path);
    assert.equal(Number(rows[0].attachment_size), 12345);
    assert.equal(rows[0].conversation_id, c);
  });

  test("attachments are constrained: server-shaped path inside the SAME conversation, PDF, 1 byte to 10 MB, one message per file", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    const other = await fromActivity(ID.S2, ID.A1);
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
    const c = await fromActivity(ID.S1, ID.A1);
    const insert = (sql: string, params: unknown[]) => db.query(`insert into messages (conversation_id, sender_id, body, attachment_path, attachment_name, attachment_size) values ${sql}`, params);
    await assert.rejects(insert("($1, $2, '', null, null, null)", [c, ID.S1]), /messages_has_content/);
    await assert.rejects(insert("($1, $2, E'  \\n\\t ', null, null, null)", [c, ID.S1]), /messages_has_content/);
    await assert.rejects(insert("($1, $2, 'x', $3, 'a.pdf', 10)", [c, ID.S1, `${c}/${uuid()}.html`]), /messages_attachment_path/);
    await assert.rejects(insert("($1, $2, 'x', $3, 'a.pdf', 10)", [c, ID.S1, pdfPath(uuid())]), /messages_attachment_path/);
    await assert.rejects(insert("($1, $2, 'x', $3, null, 10)", [c, ID.S1, pdfPath(c)]), /messages_attachment_all_or_none/);
    await assert.rejects(insert("($1, $2, 'x', $3, 'a.pdf', 99999999999)", [c, ID.S1, pdfPath(c)]), /messages_attachment_size/);
  });

  test("when the subscription ends the thread becomes READ-ONLY for both people — nothing is deleted", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    await send(ID.S1, c, { body: "before" });
    await send(ID.T2, c, { body: "reply" });

    const ends = [
      "update subscriptions set status = 'cancelled' where student_id = $1 and activity_id = $2",
      "update subscriptions set status = 'expired' where student_id = $1 and activity_id = $2",
      "update subscriptions set current_period_end = '2000-01-01T00:00:00Z' where student_id = $1 and activity_id = $2",
    ];
    for (const end of ends) {
      await db.query(end, [ID.S1, ID.A1]);
      try {
        await assert.rejects(send(ID.S1, c), /messaging:closed/, end);
        await assert.rejects(send(ID.T2, c), /messaging:closed/, end);
        assert.equal(await canSend(ID.S1, c), "closed");
        assert.equal(await count({ id: ID.S1 }, "select 1 from messages where conversation_id = $1", [c]), 2, "history stays readable");
        assert.equal(await count({ id: ID.T2 }, "select 1 from messages where conversation_id = $1", [c]), 2, "for both people");
      } finally {
        await db.query("update subscriptions set status = 'active', current_period_end = null where student_id = $1 and activity_id = $2", [ID.S1, ID.A1]);
      }
    }
    assert.equal((await db.query("select 1 from conversations where id = $1", [c])).rows.length, 1, "never deleted");
    await send(ID.S1, c); // reopens when the subscription is active again
  });

  test("a published lesson does NOT keep a thread open once the subscription has ended", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    await db.query("insert into lessons (id, subject_id, teacher_id, title, status) values ($1, $2, $3, 'T2 lesson', 'published')", [uuid(), ID.SUBJECT, ID.T2]);
    await db.query("update subscriptions set status = 'cancelled' where student_id = $1 and activity_id = $2", [ID.S1, ID.A1]);
    try {
      await assert.rejects(send(ID.S1, c), /messaging:closed/);
      await assert.rejects(send(ID.T2, c), /messaging:closed/);
    } finally {
      await db.query("update subscriptions set status = 'active' where student_id = $1 and activity_id = $2", [ID.S1, ID.A1]);
      await db.query("delete from lessons where teacher_id = $1", [ID.T2]);
    }
  });

  test("a teacher losing approval closes the thread (read-only)", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    await send(ID.S1, c);
    await db.query("update teacher_profiles set approved = false where profile_id = $1", [ID.T2]);
    try {
      await assert.rejects(send(ID.S1, c), /messaging:closed/);
      await assert.rejects(send(ID.T2, c), /messaging:closed/);
      assert.equal(await count({ id: ID.S1 }, "select 1 from messages where conversation_id = $1", [c]), 1);
    } finally {
      await db.query("update teacher_profiles set approved = true where profile_id = $1", [ID.T2]);
    }
  });

  test("sending stops, and reading stops, if a child's account approval is later withdrawn", async () => {
    const c = await fromActivity(ID.S2, ID.A1);
    await send(ID.S2, c);
    await db.query("update age_records set consent_status = 'declined' where profile_id = $1", [ID.S2]);
    try {
      await assert.rejects(send(ID.S2, c), NOT_CLEARED);
      await assert.rejects(send(ID.T2, c), NOT_CLEARED);
      assert.equal(await count({ id: ID.S2 }, "select 1 from conversations"), 0);
      assert.equal(await count({ id: ID.S2 }, "select 1 from messages"), 0);
      assert.equal(await count({ id: ID.T2 }, "select 1 from messages"), 0);
    } finally {
      await db.query("update age_records set consent_status = 'granted' where profile_id = $1", [ID.S2]);
    }
    assert.equal(await count({ id: ID.S2 }, "select 1 from messages"), 1);
  });
});

describe("READING: each person sees only their own conversations", () => {
  test("students, teachers, outsiders, anonymous visitors and admins", async () => {
    await withSubscription({ student: ID.S1, activity: ID.A2, teacher: ID.T4 }, async () => {
      const c1 = await fromActivity(ID.S1, ID.A1); // S1 ↔ T2
      const c2 = await fromActivity(ID.S2, ID.A1); // S2 ↔ T2
      const c3 = await fromActivity(ID.S1, ID.A2); // S1 ↔ T4
      await send(ID.S1, c1, { body: "secret in c1" });
      await send(ID.S2, c2, { body: "secret in c2" });
      await send(ID.S1, c3, { body: "secret in c3" });

      const ids = async (actor: Actor) => (await as(db, actor, () => db.query<{ id: string }>("select id from conversations order by id"))).rows.map((r) => r.id).sort();
      assert.deepEqual(await ids({ id: ID.S1 }), [c1, c3].sort(), "S1 sees only S1's two conversations");
      assert.deepEqual(await ids({ id: ID.S2 }), [c2]);
      assert.deepEqual(await ids({ id: ID.T2 }), [c1, c2].sort(), "T2 sees only T2's conversations");
      assert.deepEqual(await ids({ id: ID.T4 }), [c3]);

      // Outsiders and admins see nothing — including by asking for a specific id.
      for (const outsider of [{ id: ID.S7 }, { id: ID.T1 }, { id: ID.T3 }, { id: ID.ADMIN }] as Actor[]) {
        assert.equal(await count(outsider, "select 1 from conversations"), 0);
        assert.equal(await count(outsider, "select 1 from messages"), 0);
        assert.equal(await count(outsider, "select 1 from messages where conversation_id = $1", [c1]), 0);
        assert.equal(await count(outsider, "select 1 from conversations where id = $1", [c1]), 0);
      }
      await denied("anon", "select 1 from conversations");
      await denied("anon", "select 1 from messages");

      // A participant of ONE conversation cannot read another one, even by guessing its id.
      assert.equal(await count({ id: ID.S2 }, "select 1 from messages where conversation_id = $1", [c1]), 0);
      assert.equal(await count({ id: ID.T4 }, "select 1 from messages where conversation_id = $1", [c1]), 0);
      assert.equal(await count({ id: ID.S1 }, "select 1 from messages where conversation_id = $1", [c1]), 1);
    });
  });

  test("clients cannot write at all: no insert, update or delete on conversations or messages, for anyone", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    const m = await send(ID.S1, c, { body: "original" });

    for (const actor of [{ id: ID.S1 }, { id: ID.T2 }, { id: ID.S7 }, { id: ID.ADMIN }, "anon"] as Actor[]) {
      await denied(actor, "insert into conversations (student_id, teacher_id) values ($1, $2)", [ID.S1, ID.T4]);
      await denied(actor, "insert into messages (conversation_id, sender_id, body) values ($1, $2, 'forged')", [c, ID.T2]);
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
    const c = await fromActivity(ID.S1, ID.A1);
    const calls: [string, Record<string, unknown>][] = [
      ["start_conversation_from_activity", { p_student: ID.S1, p_activity: ID.A1 }],
      ["start_conversation_as_teacher", { p_teacher: ID.T2, p_student: ID.S1 }],
      ["messaging_can_send", { p_user: ID.S1, p_conversation: c }],
      ["send_message", { p_sender: ID.S1, p_conversation: c, p_body: "x", p_kind: "message", p_attachment_path: null, p_attachment_name: null, p_attachment_size: null }],
      ["messaging_conversation_ids", { p_user: ID.S1 }],
      ["delete_user_messages", { p_user: ID.S1 }],
      ["messaging_relationship", { p_student: ID.S1, p_teacher: ID.T2 }],
      ["messaging_active_subscription", { p_student: ID.S1, p_teacher: ID.T2 }],
      ["messaging_is_minor", { p_profile: ID.S1 }],
      ["messaging_teacher_startable_students", { p_teacher: ID.T2 }],
      ["age_cleared", { p_profile: ID.S1 }],
    ];
    for (const actor of [{ id: ID.S1 }, { id: ID.T2 }, "anon"] as Actor[]) {
      for (const [name, args] of calls) {
        await assert.rejects(one(actor, name, args), /permission denied/i, `${name} must not be callable by a browser session`);
      }
    }
    assert.equal((await db.query("select 1 from messages")).rows.length, 0);
    assert.equal((await db.query("select 1 from conversations")).rows.length, 1);
  });

  test("the read-policy helper answers 'yes' only for a participant of a fully cleared conversation, and reveals nothing otherwise", async () => {
    const c = await fromActivity(ID.S1, ID.A1);
    const canRead = (actor: Actor, id: string) => one(actor, "caller_can_read_conversation", { p_conversation: id });
    assert.equal(await canRead({ id: ID.S1 }, c), true);
    assert.equal(await canRead({ id: ID.T2 }, c), true);
    assert.equal(await canRead({ id: ID.S7 }, c), false); // outsider
    assert.equal(await canRead({ id: ID.ADMIN }, c), false); // admins get no access
    assert.equal(await canRead("anon", c), false);
    assert.equal(await canRead({ id: ID.S1 }, uuid()), false); // unknown id: same answer as "not yours"
  });
});

describe("account deletion support", () => {
  test("delete_user_messages removes the conversations and messages for BOTH people; other people's threads are untouched", async () => {
    const c1 = await fromActivity(ID.S1, ID.A1);
    const c2 = await fromActivity(ID.S2, ID.A1);
    await send(ID.S1, c1);
    await send(ID.T2, c1);
    await send(ID.S2, c2);

    const listed = (await call(SERVICE, "messaging_conversation_ids", { p_user: ID.S1 })) as string[];
    assert.deepEqual(listed, [c1]);

    assert.equal(await one(SERVICE, "delete_user_messages", { p_user: ID.S1 }), 1);
    assert.equal((await db.query("select 1 from conversations where id = $1", [c1])).rows.length, 0);
    assert.equal((await db.query("select 1 from messages where conversation_id = $1", [c1])).rows.length, 0);
    assert.equal(await count({ id: ID.T2 }, "select 1 from conversations"), 1, "T2 keeps the conversation with S2");
    assert.equal((await db.query("select 1 from messages where conversation_id = $1", [c2])).rows.length, 1);
  });

  test("the normal hard-delete path (removing the login) cascades to conversations and messages", async () => {
    const c = await fromActivity(SX, ID.A1);
    await send(SX, c);
    await db.query("delete from auth.users where id = $1", [SX]);
    assert.equal((await db.query("select 1 from conversations where id = $1", [c])).rows.length, 0);
    assert.equal((await db.query("select 1 from messages where conversation_id = $1", [c])).rows.length, 0);
  });
});

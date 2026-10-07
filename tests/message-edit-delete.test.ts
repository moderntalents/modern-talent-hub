// Editing and deleting your own messages (migration 0018 + lib/messages/service.ts), run against the
// real database rules and an in-memory bucket. The point of most of these tests is WHO may do it:
// only the sender, enforced by the database, never by anything the browser says.

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, rejects } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import { makeFakeAdmin, pdfBytes, type FakeAdmin } from "./helpers/fake-admin";
import * as service from "../lib/messages/service";
import { DELETED_MESSAGE_TEXT, friendlyMessagingError } from "../lib/messages/rules";

let db: PGlite;
let fake: FakeAdmin;

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
  // S2 (under 18, guardian-approved account) is enrolled in the same activity as S1.
  await db.query("insert into subscriptions (student_id, activity_id, teacher_id, status) values ($1, $2, $3, 'active')", [ID.S2, ID.A1, ID.T2]);
});

beforeEach(async () => {
  await db.exec("delete from conversations; delete from auth_rate_limits;");
  fake = makeFakeAdmin(db);
});

const rows = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const message = async (id: string) => (await rows("select * from messages where id = $1", [id]))[0];

/** Student S1 (adult) opens a conversation with teacher T2 from activity A1. */
async function conversation(student: string = ID.S1): Promise<string> {
  const r = await service.startFromActivity(fake.admin, student, ID.A1);
  assert.ok(r.ok, "setup: conversation should open");
  return r.conversationId;
}

async function send(user: string, conv: string, body: string, kind: "message" | "homework" | "submission" = "message"): Promise<string> {
  const r = await service.sendMessage(fake.admin, user, { conversationId: conv, body, kind });
  assert.ok(r.ok, `setup: send should work: ${JSON.stringify(r)}`);
  return r.messageId;
}

async function sendPdf(user: string, conv: string, body = ""): Promise<{ id: string; path: string }> {
  const ticket = await service.prepareAttachmentUpload(fake.admin, user, { conversationId: conv, fileName: "homework.pdf", fileSize: 2048 });
  assert.ok(ticket.ok, "setup: upload link");
  fake.browserUpload(ticket.path, pdfBytes());
  const sent = await service.sendMessage(fake.admin, user, { conversationId: conv, body, kind: "message", attachment: { path: ticket.path, name: "homework.pdf" } });
  assert.ok(sent.ok, "setup: send with PDF");
  return { id: sent.messageId, path: ticket.path };
}

const failedWith = (r: { ok: boolean }, pattern: RegExp) => {
  assert.equal(r.ok, false, "expected a failure");
  assert.match((r as unknown as { message: string }).message, pattern);
};

describe("sending, then editing", () => {
  test("the sender changes the text; it is stamped as edited, keeps its place, and the other person sees it", async () => {
    const conv = await conversation();
    const first = await send(ID.S1, conv, "Hello teacher");
    const reply = await send(ID.T2, conv, "Hi there");
    const original = (await rows("select m.created_at, c.last_message_at from messages m join conversations c on c.id = m.conversation_id where m.id = $1", [first]))[0];

    const r = await service.editMessage(fake.admin, ID.S1, { messageId: first, body: "  Hello teacher, are we training today?  " });
    assert.deepEqual(r, { ok: true, edited: true });

    const m = await message(first);
    assert.equal(m.body, "Hello teacher, are we training today?", "surrounding spaces are trimmed, like a new message");
    assert.notEqual(m.edited_at, null);
    assert.equal(m.deleted_at, null);
    assert.equal(String(m.created_at), String(original.created_at), "it keeps its original time and place in the conversation");
    assert.equal(String((await rows("select last_message_at from conversations where id = $1", [conv]))[0].last_message_at), String(original.last_message_at), "editing doesn't bump the conversation");

    // Both people read the new text and the edited stamp through the normal read policy.
    for (const who of [ID.S1, ID.T2]) {
      const seen = await as(db, { id: who }, async () => (await db.query<{ body: string; edited_at: string | null }>("select body, edited_at from messages where id = $1", [first])).rows[0]);
      assert.equal(seen.body, "Hello teacher, are we training today?");
      assert.notEqual(seen.edited_at, null);
    }
    // The other message is untouched.
    assert.equal((await message(reply)).edited_at, null);
  });

  test("saving the same text is not an edit — no 'Edited' label appears", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "Same words");
    assert.deepEqual(await service.editMessage(fake.admin, ID.S1, { messageId: id, body: "  Same words " }), { ok: true, edited: false });
    assert.equal((await message(id)).edited_at, null);
  });

  test("cancelling an edit changes nothing (the browser simply never calls the server)", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "Original");
    const stored = await message(id);
    // Nothing is sent when a person cancels; the stored message is exactly as it was.
    assert.equal(stored.body, "Original");
    assert.equal(stored.edited_at, null);
  });

  test("a teacher can edit their own message, and a homework message stays homework", async () => {
    const conv = await conversation();
    const id = await send(ID.T2, conv, "Do page 4", "homework");
    assert.ok((await service.editMessage(fake.admin, ID.T2, { messageId: id, body: "Do pages 4 and 5" })).ok);
    const m = await message(id);
    assert.equal(m.body, "Do pages 4 and 5");
    assert.equal(m.kind, "homework");
  });

  test("the new text follows the same rules as a new message", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "Hello");
    failedWith(await service.editMessage(fake.admin, ID.S1, { messageId: id, body: "   \n\t " }), /can't be empty/i);
    failedWith(await service.editMessage(fake.admin, ID.S1, { messageId: id, body: "x".repeat(2001) }), /at most 2000/i);
    failedWith(await service.editMessage(fake.admin, ID.S1, { messageId: id, body: "​ " }), /can't be empty/i);
    assert.equal((await message(id)).body, "Hello", "a refused edit changes nothing");
    assert.ok((await service.editMessage(fake.admin, ID.S1, { messageId: id, body: "x".repeat(2000) })).ok, "exactly 2000 is fine");
  });

  test("a message with a PDF may have its text removed — the file stays", async () => {
    const conv = await conversation();
    const { id, path } = await sendPdf(ID.S1, conv, "Here is my homework");
    assert.ok((await service.editMessage(fake.admin, ID.S1, { messageId: id, body: "" })).ok);
    const m = await message(id);
    assert.equal(m.body, "");
    assert.equal(m.attachment_path, path, "editing never touches the PDF");
    assert.ok(fake.files.has(path));
  });

  test("the database rejects a malformed edit even if the service were bypassed", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "Hello");
    const call = (body: string) => fake.admin.rpc("edit_message", { p_user: ID.S1, p_message: id, p_body: body });
    assert.match(String((await call("")).error?.message), /messaging:edit_empty/);
    assert.match(String((await call("x".repeat(2001))).error?.message), /messaging:too_long/);
    assert.equal((await message(id)).body, "Hello");
  });
});

describe("only the sender may change a message", () => {
  test("the OTHER person in the conversation can neither edit nor delete it", async () => {
    const conv = await conversation();
    const studentMsg = await send(ID.S1, conv, "From the student");
    const teacherMsg = await send(ID.T2, conv, "From the teacher");

    failedWith(await service.editMessage(fake.admin, ID.T2, { messageId: studentMsg, body: "Hijacked" }), /only change messages you sent/i);
    failedWith(await service.editMessage(fake.admin, ID.S1, { messageId: teacherMsg, body: "Hijacked" }), /only change messages you sent/i);
    failedWith(await service.deleteMessage(fake.admin, ID.T2, studentMsg), /only change messages you sent/i);
    failedWith(await service.deleteMessage(fake.admin, ID.S1, teacherMsg), /only change messages you sent/i);

    for (const [id, body] of [[studentMsg, "From the student"], [teacherMsg, "From the teacher"]] as const) {
      const m = await message(id);
      assert.equal(m.body, body);
      assert.equal(m.edited_at, null);
      assert.equal(m.deleted_at, null);
    }
  });

  test("outsiders — another student, another teacher, an admin — are told the message doesn't exist", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "Private");
    const unknown = crypto.randomUUID();

    for (const who of [ID.S7, ID.T4, ID.T1, ID.S2, ID.ADMIN]) {
      const edit = await service.editMessage(fake.admin, who, { messageId: id, body: "Hijacked" });
      const del = await service.deleteMessage(fake.admin, who, id);
      failedWith(edit, /couldn't be found/i);
      failedWith(del, /couldn't be found/i);
      // The answer is the same as for a message that really doesn't exist, so nothing leaks.
      assert.deepEqual(edit, await service.editMessage(fake.admin, who, { messageId: unknown, body: "Hijacked" }));
      assert.deepEqual(del, await service.deleteMessage(fake.admin, who, unknown));
    }
    const m = await message(id);
    assert.equal(m.body, "Private");
    assert.equal(m.deleted_at, null);
  });

  test("malformed ids never reach the database", async () => {
    failedWith(await service.editMessage(fake.admin, ID.S1, { messageId: "nope", body: "x" }), /couldn't be found/i);
    failedWith(await service.editMessage(fake.admin, ID.S1, { messageId: `${ID.A1}' or 1=1 --`, body: "x" }), /couldn't be found/i);
    failedWith(await service.deleteMessage(fake.admin, ID.S1, "nope"), /couldn't be found/i);
    failedWith(await service.editMessage(fake.admin, ID.S1, { messageId: crypto.randomUUID(), body: 42 as unknown as string }), /write a message/i);
  });

  test("the database itself refuses: a browser can't call the functions or write to messages", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "Mine");

    for (const who of [{ id: ID.S1 }, { id: ID.T2 }, "anon"] as const) {
      assert.ok(await rejects(db, who, "select edit_message($1, $2, 'x')", [ID.S1, id]), "edit_message is for the server only");
      assert.ok(await rejects(db, who, "select delete_message($1, $2)", [ID.S1, id]), "delete_message is for the server only");
      assert.ok(await rejects(db, who, "update messages set body = 'x' where id = $1", [id]), "no direct updates");
      assert.ok(await rejects(db, who, "update messages set deleted_at = now() where id = $1", [id]), "no direct deletes");
      assert.ok(await rejects(db, who, "delete from messages where id = $1", [id]), "no row deletes");
    }
    assert.equal((await message(id)).body, "Mine");
  });

  test("the server's own check uses the caller from the login: someone else's id can't be passed off as yours", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "Mine");
    // Even the service-role function re-checks ownership from the user it is told about.
    assert.match(String((await fake.admin.rpc("edit_message", { p_user: ID.T2, p_message: id, p_body: "x" })).error?.message), /messaging:not_yours/);
    assert.match(String((await fake.admin.rpc("edit_message", { p_user: ID.S7, p_message: id, p_body: "x" })).error?.message), /messaging:message_not_found/);
    assert.match(String((await fake.admin.rpc("edit_message", { p_user: null as unknown as string, p_message: id, p_body: "x" })).error?.message), /messaging:message_not_found/);
    assert.match(String((await fake.admin.rpc("delete_message", { p_user: null as unknown as string, p_message: id })).error?.message), /messaging:message_not_found/);
  });
});

describe("deleting", () => {
  test("the content is erased, the other person sees a placeholder, and the conversation keeps its order", async () => {
    const conv = await conversation();
    const a = await send(ID.S1, conv, "First");
    const b = await send(ID.T2, conv, "Second");
    const c = await send(ID.S1, conv, "Third");

    assert.deepEqual(await service.deleteMessage(fake.admin, ID.T2, b), { ok: true });

    const m = await message(b);
    assert.equal(m.body, "");
    assert.equal(m.attachment_path, null);
    assert.equal(m.edited_at, null);
    assert.notEqual(m.deleted_at, null);

    // Both people still get the row, in its place, but with nothing in it.
    for (const who of [ID.S1, ID.T2]) {
      const seen = await as(db, { id: who }, async () => (await db.query<{ id: string; body: string; deleted_at: string | null }>("select id, body, deleted_at from messages where conversation_id = $1 order by created_at", [conv])).rows);
      assert.deepEqual(seen.map((r) => r.id), [a, b, c]);
      assert.equal(seen[1].body, "");
      assert.notEqual(seen[1].deleted_at, null);
      assert.equal(seen[0].deleted_at, null);
    }
    assert.equal(DELETED_MESSAGE_TEXT, "This message was deleted");
  });

  test("an attached PDF is detached and removed from storage — and can no longer be downloaded", async () => {
    const conv = await conversation();
    const { id, path } = await sendPdf(ID.S1, conv, "My homework");
    assert.ok(fake.files.has(path));

    assert.deepEqual(await service.deleteMessage(fake.admin, ID.S1, id), { ok: true });
    assert.equal(fake.files.has(path), false, "the file is gone from the bucket");
    assert.deepEqual(fake.removed, [path]);

    const m = await message(id);
    assert.equal(m.attachment_path, null);
    assert.equal(m.attachment_name, null);
    assert.equal(m.attachment_size, null);

    const lookup: service.AttachmentLookup = async (messageId) =>
      ((await rows("select attachment_path, attachment_name from messages where id = $1", [messageId]))[0] ?? null) as { attachment_path: string | null; attachment_name: string | null } | null;
    assert.equal(await service.attachmentDownloadUrl(fake.admin, lookup, id), null);
  });

  test("someone else's PDF can't be removed by trying to delete the message", async () => {
    const conv = await conversation();
    const { id, path } = await sendPdf(ID.S1, conv);
    failedWith(await service.deleteMessage(fake.admin, ID.T2, id), /only change messages you sent/i);
    failedWith(await service.deleteMessage(fake.admin, ID.S7, id), /couldn't be found/i);
    assert.ok(fake.files.has(path));
    assert.deepEqual(fake.removed, []);
  });

  test("if the file can't be removed right now the message is still deleted, and the problem is logged", async () => {
    const conv = await conversation();
    const { id, path } = await sendPdf(ID.S1, conv);
    fake.failNext("remove");
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      assert.deepEqual(await service.deleteMessage(fake.admin, ID.S1, id), { ok: true });
    } finally {
      console.error = original;
    }
    assert.notEqual((await message(id)).deleted_at, null);
    assert.equal((await message(id)).attachment_path, null, "nothing points at the file any more");
    assert.ok(fake.files.has(path), "the orphan is left for the conversation's cleanup");
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /could not remove the file of a deleted message/);
  });

  test("deleting twice is harmless; an edit after a delete is refused", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "Oops");
    assert.ok((await service.deleteMessage(fake.admin, ID.S1, id)).ok);
    const stamp = (await message(id)).deleted_at;
    assert.ok((await service.deleteMessage(fake.admin, ID.S1, id)).ok);
    assert.equal(String((await message(id)).deleted_at), String(stamp), "the first deletion time is kept");
    failedWith(await service.editMessage(fake.admin, ID.S1, { messageId: id, body: "Back again" }), /already been deleted/i);
    assert.equal((await message(id)).body, "");
  });

  test("an edited message that is then deleted loses its 'edited' stamp too", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "v1");
    assert.ok((await service.editMessage(fake.admin, ID.S1, { messageId: id, body: "v2" })).ok);
    assert.ok((await service.deleteMessage(fake.admin, ID.S1, id)).ok);
    const m = await message(id);
    assert.equal(m.body, "");
    assert.equal(m.edited_at, null);
  });

  test("a deleted row must really be empty: the table itself refuses leftovers", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "Keep me");
    await assert.rejects(() => db.query("update messages set deleted_at = now() where id = $1", [id]), /messages_deleted_is_empty/);
    assert.equal((await message(id)).deleted_at, null);
  });

  test("the conversation can still be used afterwards: new messages work and ordering is intact", async () => {
    const conv = await conversation();
    const first = await send(ID.S1, conv, "One");
    assert.ok((await service.deleteMessage(fake.admin, ID.S1, first)).ok);
    const second = await send(ID.T2, conv, "Two");
    const list = await rows("select id from messages where conversation_id = $1 order by created_at", [conv]);
    assert.deepEqual(list.map((r) => r.id), [first, second]);
  });
});

describe("when the conversation can't take new messages", () => {
  test("a closed conversation (subscription ended): editing is refused, deleting your own message still works", async () => {
    const conv = await conversation();
    const keep = await send(ID.S1, conv, "I'd like this gone");
    const edit = await send(ID.S1, conv, "Stay as is");
    await db.query("update subscriptions set status = 'cancelled' where student_id = $1 and activity_id = $2", [ID.S1, ID.A1]);
    try {
      failedWith(await service.editMessage(fake.admin, ID.S1, { messageId: edit, body: "Changed" }), /closed/i);
      assert.equal((await message(edit)).body, "Stay as is");

      assert.ok((await service.deleteMessage(fake.admin, ID.S1, keep)).ok);
      assert.notEqual((await message(keep)).deleted_at, null);
      // …but still only your own.
      failedWith(await service.deleteMessage(fake.admin, ID.T2, edit), /only change messages you sent/i);
    } finally {
      await db.query("update subscriptions set status = 'active' where student_id = $1 and activity_id = $2", [ID.S1, ID.A1]);
    }
  });

  test("while an account isn't approved (guardian approval withdrawn) neither edit nor delete is possible", async () => {
    const conv = await conversation(ID.S2);
    const id = await send(ID.S2, conv, "Hi coach");
    await db.query("update age_records set consent_status = 'declined' where profile_id = $1", [ID.S2]);
    try {
      failedWith(await service.editMessage(fake.admin, ID.S2, { messageId: id, body: "Changed" }), /age check|guardian/i);
      failedWith(await service.deleteMessage(fake.admin, ID.S2, id), /age check|guardian/i);
      assert.equal((await message(id)).body, "Hi coach");
    } finally {
      await db.query("update age_records set consent_status = 'granted' where profile_id = $1", [ID.S2]);
    }
  });
});

describe("limits and wording", () => {
  test("edits and deletes are rate limited per person", async () => {
    const conv = await conversation();
    const id = await send(ID.S1, conv, "start");
    for (let i = 0; i < service.LIMITS.change.max; i++) {
      assert.ok((await service.editMessage(fake.admin, ID.S1, { messageId: id, body: `edit ${i}` })).ok);
    }
    failedWith(await service.editMessage(fake.admin, ID.S1, { messageId: id, body: "one too many" }), /going a bit fast/i);
    failedWith(await service.deleteMessage(fake.admin, ID.S1, id), /going a bit fast/i);
    assert.ok((await service.editMessage(fake.admin, ID.T2, { messageId: id, body: "x" })).ok === false, "another person's attempt is still refused for ownership, not speed");
  });

  test("the new reasons have plain-language sentences", () => {
    assert.match(friendlyMessagingError("messaging:message_not_found"), /couldn't be found/);
    assert.match(friendlyMessagingError("messaging:not_yours"), /only change messages you sent/);
    assert.match(friendlyMessagingError("messaging:message_deleted"), /already been deleted/);
    assert.match(friendlyMessagingError("messaging:edit_empty"), /can't be empty/);
  });
});

describe("account deletion still works with edited and deleted messages", () => {
  test("removing a person's messaging clears the conversation, files and all", async () => {
    const conv = await conversation();
    const { id, path } = await sendPdf(ID.S1, conv, "with file");
    const kept = await sendPdf(ID.S1, conv, "second file");
    await service.editMessage(fake.admin, ID.S1, { messageId: id, body: "edited" });
    await service.deleteMessage(fake.admin, ID.S1, id);
    await send(ID.T2, conv, "reply");
    assert.equal(fake.files.has(path), false);

    await service.removeUserMessaging(fake.admin, ID.S1);
    assert.equal((await rows("select 1 from messages where conversation_id = $1", [conv])).length, 0);
    assert.equal((await rows("select 1 from conversations where id = $1", [conv])).length, 0);
    assert.equal(fake.files.has(kept.path), false);
  });
});

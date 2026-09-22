// Tests for lib/messages/service.ts — the code the server actions call — run against the real
// database rules and an in-memory bucket. These cover what a database can't: the uploaded file's real
// bytes, rate limits, safe deletion of unsent files, download links, and account-deletion cleanup.

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, type Actor } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import { makeFakeAdmin, pdfBytes, textBytes, type FakeAdmin } from "./helpers/fake-admin";
import * as service from "../lib/messages/service";
import { MAX_ATTACHMENT_BYTES } from "../lib/messages/rules";

let db: PGlite;
let fake: FakeAdmin;

const uuid = () => crypto.randomUUID();

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
});

beforeEach(async () => {
  await db.exec("delete from conversations; delete from auth_rate_limits;");
  fake = makeFakeAdmin(db);
});

const rows = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;

async function conversation(student: string = ID.S1, lesson: string = ID.L1): Promise<string> {
  const r = await service.startFromLesson(fake.admin, student, lesson);
  assert.ok(r.ok, "setup: conversation should open");
  return r.conversationId;
}

/** The whole attach-a-PDF journey the browser performs: get a link, upload, send. */
async function sendWithPdf(user: string, conv: string, bytes: Uint8Array, over: Partial<{ name: string; body: string; kind: "message" | "homework" | "submission" }> = {}) {
  const ticket = await service.prepareAttachmentUpload(fake.admin, user, { conversationId: conv, fileName: over.name ?? "homework.pdf", fileSize: bytes.length });
  assert.ok(ticket.ok, "setup: upload link should be issued");
  fake.browserUpload(ticket.path, bytes);
  const sent = await service.sendMessage(fake.admin, user, {
    conversationId: conv,
    body: over.body ?? "",
    kind: over.kind ?? "message",
    attachment: { path: ticket.path, name: over.name ?? "homework.pdf" },
  });
  return { ticket, sent };
}

const failedWith = (r: { ok: boolean }, pattern: RegExp) => {
  assert.equal(r.ok, false, "expected a failure");
  assert.match((r as unknown as { message: string }).message, pattern);
};

describe("starting conversations", () => {
  test("a student opens a conversation from a lesson and from an activity; a teacher from an enrolled student", async () => {
    const a = await service.startFromLesson(fake.admin, ID.S1, ID.L1);
    const b = await service.startFromActivity(fake.admin, ID.S1, ID.A1);
    const c = await service.startAsTeacher(fake.admin, ID.T2, ID.S1);
    assert.ok(a.ok && b.ok && c.ok);
    assert.equal(b.conversationId, c.conversationId, "the same pair shares one thread");
    assert.notEqual(a.conversationId, b.conversationId);
  });

  test("the database's refusals come back as plain sentences", async () => {
    failedWith(await service.startFromLesson(fake.admin, ID.S1, ID.L2), /can't message/i); // draft
    failedWith(await service.startFromActivity(fake.admin, ID.S5, ID.A1), /can't message/i); // not paid
    failedWith(await service.startAsTeacher(fake.admin, ID.T1, ID.S1), /can't message/i); // no subscription
    failedWith(await service.startFromLesson(fake.admin, ID.S3, ID.L1), /age check/i); // guardian pending
    failedWith(await service.startFromLesson(fake.admin, ID.S1, "not-a-uuid"), /isn't available/i);
    failedWith(await service.startFromLesson(fake.admin, ID.S1, `${ID.L1}' or 1=1 --`), /isn't available/i);
    assert.equal((await rows("select 1 from conversations")).length, 0);
  });

  test("starting is rate limited: 30 an hour", async () => {
    for (let i = 0; i < service.LIMITS.start.max; i++) assert.ok((await service.startFromLesson(fake.admin, ID.S1, ID.L1)).ok);
    failedWith(await service.startFromLesson(fake.admin, ID.S1, ID.L1), /going a bit fast/i);
    assert.ok((await service.startFromLesson(fake.admin, ID.S2, ID.L1)).ok, "another person is not affected");
  });
});

describe("preparing an upload", () => {
  test("issues a one-time link for a path the SERVER picks, inside this conversation's folder", async () => {
    const conv = await conversation();
    const t = await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: conv, fileName: "../../evil/../../x.pdf", fileSize: 1000 });
    assert.ok(t.ok);
    assert.match(t.path, new RegExp(`^${conv}/[0-9a-f-]{36}\\.pdf$`));
    assert.doesNotMatch(t.path, /evil|\.\./, "the browser's file name never influences the path");
    const t2 = await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: conv, fileName: "x.pdf", fileSize: 1000 });
    assert.ok(t2.ok);
    assert.notEqual(t.path, t2.path, "every link gets a fresh random path");
  });

  test("not for outsiders, admins, unknown conversations, or closed ones — and no link is issued", async () => {
    const conv = await conversation();
    for (const who of [ID.S7, ID.T4, ID.ADMIN, ID.S2]) {
      failedWith(await service.prepareAttachmentUpload(fake.admin, who, { conversationId: conv, fileName: "a.pdf", fileSize: 10 }), /couldn't be found/i);
    }
    failedWith(await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: uuid(), fileName: "a.pdf", fileSize: 10 }), /couldn't be found/i);
    failedWith(await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: "nope", fileName: "a.pdf", fileSize: 10 }), /couldn't be found/i);

    await db.query("update lessons set status = 'draft' where id = $1", [ID.L1]);
    try {
      failedWith(await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: conv, fileName: "a.pdf", fileSize: 10 }), /closed/i);
    } finally {
      await db.query("update lessons set status = 'published' where id = $1", [ID.L1]);
    }
    assert.throws(() => fake.browserUpload(`${conv}/${uuid()}.pdf`, pdfBytes()), /no upload link/);
  });

  test("declared type and size are checked before any link exists", async () => {
    const conv = await conversation();
    const prep = (fileName: string, fileSize: number) => service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: conv, fileName, fileSize });
    failedWith(await prep("a.docx", 100), /PDF/);
    failedWith(await prep("a.pdf.exe", 100), /PDF/);
    failedWith(await prep("a.pdf", 0), /empty/);
    failedWith(await prep("a.pdf", MAX_ATTACHMENT_BYTES + 1), /10 MB/);
    failedWith(await prep("a.pdf", -5), /empty/);
    assert.ok((await prep("a.pdf", MAX_ATTACHMENT_BYTES)).ok);
  });

  test("rate limited: 20 links an hour", async () => {
    const conv = await conversation();
    for (let i = 0; i < service.LIMITS.upload.max; i++) {
      assert.ok((await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: conv, fileName: "a.pdf", fileSize: 10 })).ok);
    }
    failedWith(await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: conv, fileName: "a.pdf", fileSize: 10 }), /going a bit fast/i);
  });
});

describe("sending", () => {
  test("a plain text message, both directions", async () => {
    const conv = await conversation();
    assert.ok((await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "  Hello  ", kind: "message" })).ok);
    assert.ok((await service.sendMessage(fake.admin, ID.T1, { conversationId: conv, body: "Hi!", kind: "message" })).ok);
    const stored = await rows("select sender_id, body, attachment_path from messages order by created_at");
    assert.deepEqual(stored.map((r) => r.body), ["Hello", "Hi!"]);
    assert.ok(stored.every((r) => r.attachment_path === null));
  });

  test("the full homework journey: teacher sends instructions + PDF, student hands in a PDF, both can download", async () => {
    const conv = await conversation();
    const homework = await sendWithPdf(ID.T1, conv, pdfBytes(5000), { name: "Fractions worksheet.pdf", body: "Do questions 1–10", kind: "homework" });
    assert.ok(homework.sent.ok);
    const done = await sendWithPdf(ID.S1, conv, pdfBytes(7000), { name: "My answers.pdf", body: "Here is my work", kind: "submission" });
    assert.ok(done.sent.ok);

    const stored = await rows("select kind, sender_id, attachment_name, attachment_size::int as size, attachment_path from messages order by created_at");
    assert.deepEqual(
      stored.map((r) => [r.kind, r.sender_id, r.attachment_name, r.size]),
      [
        ["homework", ID.T1, "Fractions worksheet.pdf", 5000],
        ["submission", ID.S1, "My answers.pdf", 7000],
      ],
    );
    assert.ok(fake.files.has(homework.ticket.path) && fake.files.has(done.ticket.path), "both files were kept");
    assert.deepEqual(fake.removed, []);
  });

  test("the stored size is the REAL size of the uploaded file, not what the browser claimed", async () => {
    const conv = await conversation();
    const ticket = await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: conv, fileName: "a.pdf", fileSize: 10 }); // claims 10 bytes
    assert.ok(ticket.ok);
    fake.browserUpload(ticket.path, pdfBytes(3333));
    const sent = await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "", kind: "message", attachment: { path: ticket.path, name: "a.pdf" } });
    assert.ok(sent.ok);
    assert.equal((await rows("select attachment_size::int as s from messages"))[0].s, 3333);
  });

  test("a file that is not really a PDF is refused and deleted, whatever it is called", async () => {
    const conv = await conversation();
    const disguised: [string, Uint8Array][] = [
      ["a web page", textBytes("<html><script>steal()</script></html>")],
      ["a Windows program", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])],
      ["a PNG image", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ["a script", textBytes("#!/bin/sh\nrm -rf /\n")],
      ["text that mentions PDF", textBytes("This is not %PDF- at the start")],
    ];
    for (const [label, bytes] of disguised) {
      const { ticket, sent } = await sendWithPdf(ID.S1, conv, bytes);
      failedWith(sent, /valid PDF/i);
      assert.equal(fake.files.has(ticket.path), false, `${label}: the file must be deleted`);
    }
    assert.equal((await rows("select 1 from messages")).length, 0);
  });

  test("an empty file, or one that is bigger than it claimed, is refused and deleted", async () => {
    const conv = await conversation();

    // (A browser that admits a zero-byte file is refused before any link exists; these two lie.)
    const ticket = await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: conv, fileName: "a.pdf", fileSize: 100 }); // claims 100 bytes
    assert.ok(ticket.ok);
    fake.browserUpload(ticket.path, pdfBytes(MAX_ATTACHMENT_BYTES + 1)); // …but uploads 10 MB + 1
    const sent = await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "", kind: "message", attachment: { path: ticket.path, name: "a.pdf" } });
    failedWith(sent, /10 MB/);
    assert.equal(fake.files.has(ticket.path), false, "the oversized file is deleted");

    const zero = await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: conv, fileName: "a.pdf", fileSize: 100 });
    assert.ok(zero.ok);
    fake.browserUpload(zero.path, new Uint8Array(0));
    failedWith(await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "", kind: "message", attachment: { path: zero.path, name: "a.pdf" } }), /empty/i);
    assert.equal((await rows("select 1 from messages")).length, 0);
  });

  test("exactly 10 MB is accepted", async () => {
    const conv = await conversation();
    const { sent } = await sendWithPdf(ID.S1, conv, pdfBytes(MAX_ATTACHMENT_BYTES));
    assert.ok(sent.ok);
  });

  test("a file name is cleaned before it is stored", async () => {
    const conv = await conversation();
    const { sent } = await sendWithPdf(ID.S1, conv, pdfBytes(), { name: '../../etc/pass"wd<b>.pdf' });
    assert.ok(sent.ok);
    assert.equal((await rows("select attachment_name from messages"))[0].attachment_name, "pass_wd_b_.pdf");
  });

  test("the browser cannot choose the path: other folders, other conversations, traversal, or a file never uploaded", async () => {
    const conv = await conversation(ID.S1, ID.L1);
    const other = await conversation(ID.S2, ID.L1);
    const send = (path: string, user = ID.S1, c = conv) => service.sendMessage(fake.admin, user, { conversationId: c, body: "x", kind: "message", attachment: { path, name: "a.pdf" } });

    // A real, valid PDF sitting in ANOTHER conversation must not be attachable here.
    const foreign = `${other}/${uuid()}.pdf`;
    fake.files.set(foreign, pdfBytes());
    failedWith(await send(foreign), /couldn't be attached/i);
    assert.ok(fake.files.has(foreign), "and it must not be deleted either");

    for (const bad of [`${conv}/../${other}/${uuid()}.pdf`, `${conv}/${uuid()}.exe`, `secret/${uuid()}.pdf`, "../../etc/passwd", `${conv}/${uuid()}.pdf/../x.pdf`]) {
      failedWith(await send(bad), /couldn't be attached/i);
    }
    failedWith(await send(`${conv}/${uuid()}.pdf`), /couldn't find your uploaded file/i); // valid shape, nothing there
    assert.equal((await rows("select 1 from messages")).length, 0);
  });

  test("a file can back only one message, and a failed attempt to reuse it never deletes it", async () => {
    const conv = await conversation();
    const first = await sendWithPdf(ID.S1, conv, pdfBytes(), { name: "mine.pdf", body: "first" });
    assert.ok(first.sent.ok);

    // The teacher (who can see the message) tries to attach the student's file to a message of their own.
    const reuse = await service.sendMessage(fake.admin, ID.T1, { conversationId: conv, body: "mine now", kind: "message", attachment: { path: first.ticket.path, name: "stolen.pdf" } });
    failedWith(reuse, /couldn't be attached/i);
    // …and again with something that fails later in the pipeline.
    const again = await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "again", kind: "homework", attachment: { path: first.ticket.path, name: "mine.pdf" } });
    assert.equal(again.ok, false);

    assert.ok(fake.files.has(first.ticket.path), "the original file is still there");
    assert.deepEqual(fake.removed, []);
    assert.equal((await rows("select 1 from messages")).length, 1);
  });

  test("a reused file is refused up front, without even fetching its bytes from storage", async () => {
    const conv = await conversation();
    const first = await sendWithPdf(ID.S1, conv, pdfBytes(), { body: "first" });
    assert.ok(first.sent.ok);
    const fetched = fake.stats.downloads;

    const reuse = await service.sendMessage(fake.admin, ID.T1, { conversationId: conv, body: "x", kind: "message", attachment: { path: first.ticket.path, name: "a.pdf" } });
    failedWith(reuse, /couldn't be attached/i);
    assert.equal(fake.stats.downloads, fetched, "no download (up to 10 MB) should be wasted on a file that is already taken");
  });

  test("even if two sends RACE past the early check, the loser cannot delete the winner's file", async () => {
    const conv = await conversation();
    const first = await sendWithPdf(ID.S1, conv, pdfBytes(), { body: "winner" });
    assert.ok(first.sent.ok);

    // Simulate the race: the loser's first "is this file in use?" question is answered "no" (the winner
    // had not committed yet), so it proceeds to the database, which refuses the duplicate.
    let asked = 0;
    const realRpc = fake.admin.rpc.bind(fake.admin) as unknown as (name: string, args: Record<string, unknown>) => Promise<unknown>;
    const racing = {
      ...fake.admin,
      rpc: (name: string, args: Record<string, unknown>) =>
        name === "attachment_in_use" && asked++ === 0 ? Promise.resolve({ data: false, error: null }) : realRpc(name, args),
    } as unknown as service.Admin;

    const loser = await service.sendMessage(racing, ID.T1, { conversationId: conv, body: "loser", kind: "message", attachment: { path: first.ticket.path, name: "a.pdf" } });
    failedWith(loser, /couldn't be attached/i);
    assert.ok(asked >= 2, "the clean-up asked again before deleting anything");
    assert.ok(fake.files.has(first.ticket.path), "the winner's file must survive");
    assert.deepEqual(fake.removed, []);
    assert.equal((await rows("select 1 from messages")).length, 1);
  });

  test("an upload that ends up unsent is cleaned up (the conversation closed in between)", async () => {
    const conv = await conversation();
    const ticket = await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: conv, fileName: "a.pdf", fileSize: 100 });
    assert.ok(ticket.ok);
    fake.browserUpload(ticket.path, pdfBytes());

    // Between upload and send the database rejects it (a student can't send 'homework').
    const sent = await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "", kind: "homework", attachment: { path: ticket.path, name: "a.pdf" } });
    failedWith(sent, /couldn't be sent/i);
    assert.equal(fake.files.has(ticket.path), false, "the unsent upload is deleted");
  });

  test("the rules of who may send what still apply through the service", async () => {
    const conv = await conversation();
    failedWith(await service.sendMessage(fake.admin, ID.S7, { conversationId: conv, body: "hi", kind: "message" }), /couldn't be found/i); // outsider
    failedWith(await service.sendMessage(fake.admin, ID.ADMIN, { conversationId: conv, body: "hi", kind: "message" }), /couldn't be found/i);
    failedWith(await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "hi", kind: "homework" }), /couldn't be sent/i);
    failedWith(await service.sendMessage(fake.admin, ID.T1, { conversationId: conv, body: "hi", kind: "submission" }), /couldn't be sent/i);
    failedWith(await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "hi", kind: "shout" as never }), /couldn't be sent/i);
    failedWith(await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "   ", kind: "message" }), /write a message/i);
    failedWith(await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "\u200b\u3000", kind: "message" }), /write a message/i);
    failedWith(await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "x".repeat(2001), kind: "message" }), /2000/);
    failedWith(await service.sendMessage(fake.admin, ID.S1, { conversationId: "nope", body: "hi", kind: "message" }), /couldn't be found/i);
    assert.equal((await rows("select 1 from messages")).length, 0);
  });

  test("a closed conversation refuses new messages; a child whose consent was withdrawn is refused too", async () => {
    const conv = await conversation(ID.S2, ID.L1);
    assert.ok((await service.sendMessage(fake.admin, ID.S2, { conversationId: conv, body: "hi", kind: "message" })).ok);
    await db.query("update age_records set consent_status = 'declined' where profile_id = $1", [ID.S2]);
    try {
      failedWith(await service.sendMessage(fake.admin, ID.S2, { conversationId: conv, body: "hi", kind: "message" }), /age check/i);
      failedWith(await service.sendMessage(fake.admin, ID.T1, { conversationId: conv, body: "hi", kind: "message" }), /age check/i);
    } finally {
      await db.query("update age_records set consent_status = 'granted' where profile_id = $1", [ID.S2]);
    }
  });

  test("sending is rate limited: 30 messages per 10 minutes", async () => {
    const conv = await conversation();
    for (let i = 0; i < service.LIMITS.send.max; i++) {
      assert.ok((await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: `m${i}`, kind: "message" })).ok);
    }
    failedWith(await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "one too many", kind: "message" }), /going a bit fast/i);
    assert.ok((await service.sendMessage(fake.admin, ID.T1, { conversationId: conv, body: "the teacher is unaffected", kind: "message" })).ok);
  });

  test("if the rate limiter itself is unavailable, sending is refused rather than unlimited", async () => {
    const conv = await conversation();
    const broken = makeFakeAdmin(db, { rpcOverride: (name) => (name === "hit_rate_limit" ? { code: "XX000", message: "boom" } : null) });
    failedWith(await service.sendMessage(broken.admin, ID.S1, { conversationId: conv, body: "hi", kind: "message" }), /going a bit fast/i);
  });
});

describe("downloading", () => {
  /** Reads the message exactly as the download route does: as the signed-in person, through row-level security. */
  const lookupAs = (actor: Actor) => (id: string) =>
    as(db, actor, async () => {
      try {
        const { rows: r } = await db.query<{ attachment_path: string | null; attachment_name: string | null }>("select attachment_path, attachment_name from messages where id = $1", [id]);
        return r[0] ?? null;
      } catch {
        return null; // permission denied (anonymous) is "not found"
      }
    });

  test("a participant gets a link that lasts 60 seconds, for the right file, named as a download", async () => {
    const conv = await conversation();
    const { ticket, sent } = await sendWithPdf(ID.S1, conv, pdfBytes(), { name: "My answers.pdf" });
    assert.ok(sent.ok);

    for (const person of [ID.S1, ID.T1]) {
      const url = await service.attachmentDownloadUrl(fake.admin, lookupAs({ id: person }), sent.messageId);
      assert.ok(url?.includes(ticket.path));
    }
    assert.equal(service.DOWNLOAD_LINK_SECONDS, 60);
    assert.ok(fake.downloads.every((d) => d.expiresIn === 60 && d.download === "My answers.pdf"));
  });

  test("nobody else can: another student, another teacher, an admin, an anonymous visitor — or by guessing ids", async () => {
    const conv = await conversation();
    const { sent } = await sendWithPdf(ID.S1, conv, pdfBytes());
    assert.ok(sent.ok);
    const before = fake.downloads.length;

    for (const who of [{ id: ID.S7 }, { id: ID.S2 }, { id: ID.T4 }, { id: ID.T2 }, { id: ID.ADMIN }, "anon"] as Actor[]) {
      assert.equal(await service.attachmentDownloadUrl(fake.admin, lookupAs(who), sent.messageId), null, JSON.stringify(who));
    }
    assert.equal(fake.downloads.length, before, "no link was even requested from storage");

    for (const junk of [uuid(), "nope", "", `${sent.messageId}' or '1'='1`, "../../etc/passwd"]) {
      assert.equal(await service.attachmentDownloadUrl(fake.admin, lookupAs({ id: ID.S1 }), junk), null);
    }
  });

  test("a message without a file has no download", async () => {
    const conv = await conversation();
    const m = await service.sendMessage(fake.admin, ID.S1, { conversationId: conv, body: "just text", kind: "message" });
    assert.ok(m.ok);
    assert.equal(await service.attachmentDownloadUrl(fake.admin, lookupAs({ id: ID.S1 }), m.messageId), null);
  });

  test("access ends when the conversation becomes unreadable (guardian consent withdrawn)", async () => {
    const conv = await conversation(ID.S2, ID.L1);
    const { sent } = await sendWithPdf(ID.S2, conv, pdfBytes());
    assert.ok(sent.ok);
    assert.ok(await service.attachmentDownloadUrl(fake.admin, lookupAs({ id: ID.T1 }), sent.messageId));
    await db.query("update age_records set consent_status = 'declined' where profile_id = $1", [ID.S2]);
    try {
      assert.equal(await service.attachmentDownloadUrl(fake.admin, lookupAs({ id: ID.T1 }), sent.messageId), null);
      assert.equal(await service.attachmentDownloadUrl(fake.admin, lookupAs({ id: ID.S2 }), sent.messageId), null);
    } finally {
      await db.query("update age_records set consent_status = 'granted' where profile_id = $1", [ID.S2]);
    }
  });
});

describe("account deletion cleanup", () => {
  test("removes every message, every file (even uploaded-but-never-sent), and the other person's copy — and nothing else", async () => {
    const mine = await conversation(ID.S1, ID.L1);
    const others = await conversation(ID.S2, ID.L1);
    const a = await sendWithPdf(ID.S1, mine, pdfBytes(), { body: "one" });
    const b = await sendWithPdf(ID.T1, mine, pdfBytes(), { body: "two", kind: "homework" });
    const bystander = await sendWithPdf(ID.S2, others, pdfBytes(), { body: "not deleted" });
    assert.ok(a.sent.ok && b.sent.ok && bystander.sent.ok);
    const orphan = await service.prepareAttachmentUpload(fake.admin, ID.S1, { conversationId: mine, fileName: "x.pdf", fileSize: 10 });
    assert.ok(orphan.ok);
    fake.browserUpload(orphan.path, pdfBytes()); // uploaded, never sent

    await service.removeUserMessaging(fake.admin, ID.S1);

    assert.equal((await rows("select 1 from conversations where id = $1", [mine])).length, 0);
    assert.equal((await rows("select 1 from messages where conversation_id = $1", [mine])).length, 0);
    for (const p of [a.ticket.path, b.ticket.path, orphan.path]) assert.equal(fake.files.has(p), false, `${p} should be gone`);
    // The teacher's OTHER conversation is untouched.
    assert.equal((await rows("select 1 from messages where conversation_id = $1", [others])).length, 1);
    assert.ok(fake.files.has(bystander.ticket.path));
  });

  test("works for a teacher too (their side of every conversation, with files)", async () => {
    const c1 = await conversation(ID.S1, ID.L1);
    const c2 = await conversation(ID.S2, ID.L1);
    const f1 = await sendWithPdf(ID.S1, c1, pdfBytes());
    const f2 = await sendWithPdf(ID.S2, c2, pdfBytes());
    assert.ok(f1.sent.ok && f2.sent.ok);
    await service.removeUserMessaging(fake.admin, ID.T1);
    assert.equal((await rows("select 1 from conversations")).length, 0);
    assert.equal(fake.files.size, 0);
  });

  test("a person with no conversations is a harmless no-op", async () => {
    await service.removeUserMessaging(fake.admin, ID.S7);
    assert.equal(fake.removed.length, 0);
  });

  test("if a file cannot be removed it STOPS and throws, leaving the rows so the deletion can be retried", async () => {
    const conv = await conversation();
    const { sent } = await sendWithPdf(ID.S1, conv, pdfBytes());
    assert.ok(sent.ok);

    fake.failNext("remove");
    await assert.rejects(service.removeUserMessaging(fake.admin, ID.S1), /remove message files/);
    assert.equal((await rows("select 1 from conversations")).length, 1, "rows are kept so nothing is orphaned");
    assert.equal(fake.files.size, 1);

    fake.failNext("list");
    await assert.rejects(service.removeUserMessaging(fake.admin, ID.S1), /list message files/);
    assert.equal((await rows("select 1 from conversations")).length, 1);

    await service.removeUserMessaging(fake.admin, ID.S1); // retry succeeds
    assert.equal((await rows("select 1 from conversations")).length, 0);
    assert.equal(fake.files.size, 0);
  });

  test("before migration 0011 is run there is nothing to remove, and deletion is not blocked", async () => {
    const before = makeFakeAdmin(db, { rpcOverride: () => ({ code: "PGRST202", message: "Could not find the function" }) });
    await service.removeUserMessaging(before.admin, ID.S1);
    const broken = makeFakeAdmin(db, { rpcOverride: () => ({ code: "XX000", message: "database exploded" }) });
    await assert.rejects(service.removeUserMessaging(broken.admin, ID.S1), /database exploded/);
  });

  test("both deletion paths in the account action call it: the scrub path (profile kept) and the hard-delete path", async () => {
    const source = readFileSync("app/account/actions.ts", "utf8");
    const body = source.slice(source.indexOf("export async function deleteMyAccount"));

    // In source order: the existing Stage 1 steps, with the messaging cleanup after the per-role file
    // cleanup and BEFORE the branch that either scrubs the account or deletes the login.
    const inOrder = [
      "removeLoginIdentities(admin, user.id)",
      "removeStudentFiles(admin, user.id)",
      "cleanUpTeacherContent(admin, user.id)",
      "removeUserMessaging(admin, user.id)",
      "scrubAccount(admin, user.id)",
      "admin.auth.admin.deleteUser(user.id)",
    ];
    const positions = inOrder.map((step) => body.indexOf(step));
    inOrder.forEach((step, i) => assert.ok(positions[i] >= 0, `deleteMyAccount no longer contains: ${step}`));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, "deletion steps are out of order");
  });

  test("scrub path leaves the profile behind, so the rows would NOT cascade — the explicit removal is what protects privacy", async () => {
    const conv = await conversation(ID.S5, ID.L1);
    const s = await service.sendMessage(fake.admin, ID.S5, { conversationId: conv, body: "hi", kind: "message" });
    assert.ok(s.ok);
    // What the scrub path does: the profile row STAYS (payment records point at it).
    assert.equal((await rows("select 1 from conversations where student_id = $1", [ID.S5])).length, 1);
    await service.removeUserMessaging(fake.admin, ID.S5);
    assert.equal((await rows("select 1 from profiles where id = $1", [ID.S5])).length, 1, "profile row still exists");
    assert.equal((await rows("select 1 from conversations where student_id = $1", [ID.S5])).length, 0);
    assert.equal((await rows("select 1 from messages")).length, 0);
  });
});

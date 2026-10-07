// The student "Find your teacher or coach" directory (migrations 0019 + 0021, lib/directory/*), run
// against the real database rules. Most of these tests are about WHO may be found — approved,
// age-cleared teachers/coaches that have something published, whether or not the student is enrolled —
// enforced in the database, and about what is NOT leaked.

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, rejects } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import { makeFakeAdmin, type FakeAdmin } from "./helpers/fake-admin";
import * as directory from "../lib/directory/service";
import * as messaging from "../lib/messages/service";
import {
  DIRECTORY_PAGE_SIZE,
  avatarSrc,
  canOpenConversation,
  decodeCursor,
  encodeCursor,
  initialsOf,
  normalizeSearch,
  parseSearch,
  roleLabel,
  subtitleOf,
  type DirectoryTeacher,
} from "../lib/directory/rules";

const SUPABASE_URL = "https://abcdefgh.supabase.co";
const NOBODY = "99999999-0000-4000-8000-000000000999";

// Extra people, all on top of the shared seed.
const X = {
  A4: "ffffffff-0000-4000-8000-000000000004", // T1's activity (T1 has a published lesson too)
  A5: "ffffffff-0000-4000-8000-000000000005", // T3's activity (T3 is NOT approved)
  A6: "ffffffff-0000-4000-8000-000000000006", // T4's second activity
};

let db: PGlite;
let fake: FakeAdmin;

const rows = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
  await db.exec(`
    -- Names to search for, and a public profile that also holds private details.
    update profiles set full_name = 'David Pagni', avatar_url = '${ID.T2}/photo.jpg' where id = '${ID.T2}';
    update profiles set full_name = 'Sarah Williams' where id = '${ID.T1}';
    update profiles set full_name = 'Mwangi Kamau', phone = '0700 000 111' where id = '${ID.T4}';
    update teacher_profiles set specialty = 'Football', bio = 'Plays and coaches football.', mpesa_number = '0711111111',
      bank_name = 'Secret Bank', bank_account = '123456789', wallet_balance = 4321 where profile_id = '${ID.T2}';
    update teacher_profiles set specialty = 'Chess', bio = null where profile_id = '${ID.T4}';
    update teacher_profiles set approved = true where profile_id = '${ID.T1}';

    insert into activities (id, teacher_id, category, activity_type, title, status) values
      ('${X.A4}', '${ID.T1}', 'creative', 'maths', 'Maths club', 'published'),
      ('${X.A5}', '${ID.T3}', 'sports', 'tennis', 'Tennis (unapproved coach)', 'published'),
      ('${X.A6}', '${ID.T4}', 'creative', 'draughts', 'Draughts', 'published');

    insert into subscriptions (student_id, activity_id, teacher_id, status, current_period_end) values
      ('${ID.S1}', '${X.A4}', '${ID.T1}', 'active', null),
      ('${ID.S1}', '${X.A5}', '${ID.T3}', 'active', null),             -- but T3 is not approved
      ('${ID.S1}', '${ID.A2}', '${ID.T4}', 'active', now() - interval '1 day'),   -- expired
      ('${ID.S2}', '${ID.A1}', '${ID.T2}', 'active', null),             -- under 18, guardian approved
      ('${ID.S3}', '${ID.A1}', '${ID.T2}', 'active', null),             -- under 18, approval pending
      ('${ID.S6}', '${ID.A1}', '${ID.T2}', 'cancelled', null);
  `);
});

beforeEach(async () => {
  await db.exec("delete from conversations; delete from auth_rate_limits;");
  fake = makeFakeAdmin(db);
});

const list = async (student: string, query: unknown = "", extra: { cursor?: unknown; pageSize?: number } = {}) => {
  const page = await directory.listDirectory(fake.admin, student, { query, supabaseUrl: SUPABASE_URL, ...extra });
  assert.ok(page.ok, "the directory should load");
  return page;
};
const names = async (student: string, query: unknown = "") => (await list(student, query)).teachers.map((t) => t.name);

const ALL = ["David Pagni", "Mwangi Kamau", "Sarah Williams"];

describe("who is listed: approved teachers/coaches with something published (no subscription needed)", () => {
  test("every cleared student sees the same discoverable people, in name order", async () => {
    assert.deepEqual(await names(ID.S1), ALL);
    assert.deepEqual(await names(ID.S7), ALL, "an outsider with no subscriptions can still discover them");
    assert.deepEqual(await names(ID.S5), ALL, "pending payment doesn't matter for discovery");
    assert.deepEqual(await names(ID.S2), ALL, "a guardian-approved under-18");
  });

  test("an unapproved teacher never appears, even with published work and active subscribers", async () => {
    assert.ok(!(await names(ID.S1)).some((n) => n.includes("Three")));
    assert.ok(!(await names(ID.S7)).some((n) => n.includes("Three")));
  });

  test("a teacher with nothing published (only drafts, or nothing) is not discoverable", async () => {
    const id = "aaaaaaaa-2222-4000-8000-000000000001";
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${id}', '${id}@test.invalid', '{"role":"teacher","full_name":"Empty Handed"}');
      update teacher_profiles set approved = true where profile_id = '${id}';
      insert into age_records (profile_id, date_of_birth, consent_status) values ('${id}', '1980-01-01', 'not_required');
      insert into activities (teacher_id, category, activity_type, title, status) values ('${id}', 'sports', 'x', 'Draft only', 'draft');
    `);
    try {
      assert.ok(!(await names(ID.S1)).includes("Empty Handed"));
      assert.equal(await directory.getDirectoryTeacher(fake.admin, ID.S1, id), null);
      await db.query("update activities set status = 'published' where teacher_id = $1", [id]);
      assert.ok((await names(ID.S1)).includes("Empty Handed"), "publishing makes them discoverable");
      await db.query("update teacher_profiles set approved = false where profile_id = $1", [id]);
      assert.ok(!(await names(ID.S1)).includes("Empty Handed"), "withdrawing approval hides them again");
    } finally {
      await db.exec(`delete from activities where teacher_id = '${id}'; delete from auth.users where id = '${id}';`);
    }
  });

  test("a teacher with a published lesson but no activity is a Teacher; one with a published activity is a Coach", async () => {
    const id = "aaaaaaaa-2222-4000-8000-000000000002";
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${id}', '${id}@test.invalid', '{"role":"teacher","full_name":"Lesson Giver"}');
      update teacher_profiles set approved = true where profile_id = '${id}';
      insert into age_records (profile_id, date_of_birth, consent_status) values ('${id}', '1980-01-01', 'not_required');
      insert into lessons (subject_id, teacher_id, title, status) values ('${ID.SUBJECT}', '${id}', 'Algebra', 'published');
    `);
    try {
      const t = (await list(ID.S1, "lesson giver")).teachers[0];
      assert.equal(t.role, "Teacher");
      assert.deepEqual(t.activities, []);
      assert.equal(subtitleOf(t), "Teacher");
      const coach = (await list(ID.S1, "david")).teachers[0];
      assert.equal(coach.role, "Coach");
    } finally {
      await db.exec(`delete from lessons where teacher_id = '${id}'; delete from auth.users where id = '${id}';`);
    }
  });

  test("a student whose account setup isn't approved sees no one (same age gate as messaging)", async () => {
    assert.deepEqual(await names(ID.S3), [], "guardian approval pending");
    assert.deepEqual(await names(ID.S4), [], "no age record");
  });

  test("a teacher whose own age/approval record isn't cleared is not listed", async () => {
    await db.query("delete from age_records where profile_id = $1", [ID.T4]);
    try {
      assert.deepEqual(await names(ID.S1), ["David Pagni", "Sarah Williams"]);
    } finally {
      await db.query("insert into age_records (profile_id, date_of_birth, consent_status) values ($1, '1980-01-01', 'not_required')", [ID.T4]);
    }
    assert.deepEqual(await names(ID.S1), ALL);
  });

  test("a teacher's own account (or any non-student id) gets an empty directory", async () => {
    assert.deepEqual(await names(ID.T2), []);
    assert.deepEqual(await names(ID.ADMIN), []);
    assert.deepEqual(await names(NOBODY), []);
  });

  test("students and admins are never listed, however they are named", async () => {
    for (const q of ["Student", "Admin", "Seven", "One"]) {
      assert.ok(!(await names(ID.S1, q)).some((n) => /student|admin/i.test(n)), q);
    }
  });

  test("each person is listed once, with their published activities (not drafts)", async () => {
    await db.query("insert into activities (id, teacher_id, category, activity_type, title, status) values ($1, $2, 'creative', 'x', 'Zzz extra', 'published')", [X.A6 .replace("0006", "0007"), ID.T4]);
    try {
      const { teachers } = await list(ID.S1);
      assert.equal(teachers.filter((t) => t.name === "Mwangi Kamau").length, 1);
      assert.deepEqual(teachers.find((t) => t.name === "Mwangi Kamau")!.activities.map((a) => a.title), ["Chess club", "Draughts", "Zzz extra"]);
      assert.ok(!teachers.find((t) => t.name === "David Pagni")!.activities.some((a) => /draft/i.test(a.title)));
    } finally {
      await db.query("delete from activities where id = $1", [X.A6.replace("0006", "0007")]);
    }
  });

  test("a card carries at most six activities", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `ffffffff-3333-4000-8000-00000000000${i}`);
    for (const [i, id] of ids.entries()) {
      await db.query("insert into activities (id, teacher_id, category, activity_type, title, status) values ($1, $2, 'sports', 'x', $3, 'published')", [id, ID.T2, `Extra ${i}`]);
    }
    try {
      assert.equal((await list(ID.S1, "david")).teachers[0].activities.length, 6);
    } finally {
      await db.query("delete from activities where id = any($1::uuid[])", [ids]);
    }
  });
});

describe("search", () => {
  test("by first name, last name and full name", async () => {
    assert.deepEqual(await names(ID.S1, "David"), ["David Pagni"]);
    assert.deepEqual(await names(ID.S1, "Pagni"), ["David Pagni"]);
    assert.deepEqual(await names(ID.S1, "David Pagni"), ["David Pagni"]);
    assert.deepEqual(await names(ID.S1, "Sarah Williams"), ["Sarah Williams"]);
  });

  test("a coach is found by name too", async () => {
    const [t] = (await list(ID.S1, "david")).teachers;
    assert.equal(t.role, "Coach");
    assert.equal(t.name, "David Pagni");
  });

  test("capitalisation doesn't matter", async () => {
    for (const q of ["david", "DAVID", "dAvId", "pAGNI", "DAVID PAGNI"]) assert.deepEqual(await names(ID.S1, q), ["David Pagni"], q);
  });

  test("partial names", async () => {
    for (const q of ["Dav", "avi", "pag", "agni", "d p", "dav pag"]) assert.deepEqual(await names(ID.S1, q), ["David Pagni"], q);
    assert.deepEqual(await names(ID.S1, "a"), ALL, "one letter matches every name containing it");
  });

  test("words in any order, and extra spaces, tabs and new lines around or between them", async () => {
    assert.deepEqual(await names(ID.S1, "pagni david"), ["David Pagni"]);
    assert.deepEqual(await names(ID.S1, "   David   "), ["David Pagni"]);
    assert.deepEqual(await names(ID.S1, "\t David \n  Pagni " + String.fromCharCode(0xa0)), ["David Pagni"]);
  });

  test("a blank search is the whole list; no match is an empty list (not an error)", async () => {
    assert.deepEqual(await names(ID.S1, ""), ALL);
    assert.deepEqual(await names(ID.S1, "     "), ALL);
    const none = await list(ID.S1, "zzzz");
    assert.deepEqual(none.teachers, []);
    assert.equal(none.nextCursor, null);
  });

  test("it only reaches discoverable teachers/coaches — never unapproved ones, students or admins", async () => {
    assert.deepEqual(await names(ID.S1, "Mwangi"), ["Mwangi Kamau"], "an approved coach the student isn't enrolled with");
    assert.deepEqual(await names(ID.S1, "Three"), [], "an unapproved teacher");
    assert.deepEqual(await names(ID.S7, "David"), ["David Pagni"], "an outsider can find David by name");
    assert.deepEqual(await names(ID.S3, "David"), [], "but not before their own account setup is approved");
  });

  test("wildcards and odd characters are just characters, not patterns or SQL", async () => {
    for (const q of ["%", "_", "d%", "D_vid", "\\", "'; drop table profiles; --", '"', "David\\", "%%%%%"]) {
      const page = await list(ID.S1, q);
      assert.deepEqual(page.teachers, [], `${JSON.stringify(q)} should match nothing`);
    }
    assert.ok(Number((await rows("select count(*)::int as n from profiles"))[0].n) > 0, "nothing was dropped");
  });

  test("absurdly long or non-text input is cut down or ignored, never an error", async () => {
    assert.deepEqual((await list(ID.S1, "a".repeat(5000))).teachers, []);
    assert.deepEqual(await names(ID.S1, undefined), ALL);
    assert.deepEqual(await names(ID.S1, { $ne: "" } as unknown), ALL);
    assert.deepEqual(await names(ID.S1, ["David"] as unknown), ALL, "an array is not a search");
  });

  test("a search term is trimmed in the pure helper", () => {
    assert.deepEqual(parseSearch("  David   PAGNI "), ["David", "PAGNI"]);
    assert.equal(normalizeSearch("  David   PAGNI "), "David PAGNI");
    assert.deepEqual(parseSearch(""), []);
    assert.deepEqual(parseSearch(String.fromCharCode(0, 0x200b) + "  \t"), []);
    assert.equal(parseSearch("a b c d e f g h").length, 5);
    assert.equal(parseSearch("x".repeat(500))[0].length <= 40, true);
    assert.deepEqual(parseSearch(42), []);
  });
});

describe("browsing in pages", () => {
  // 30 more coaches for S1, all approved and cleared, with names that sort predictably.
  const MANY = Array.from({ length: 30 }, (_, i) => ({
    id: `aaaaaaaa-1111-4000-8000-${String(i + 1).padStart(12, "0")}`,
    act: `ffffffff-1111-4000-8000-${String(i + 1).padStart(12, "0")}`,
    name: `Coach ${String.fromCharCode(65 + Math.floor(i / 10))}${i % 10} Mwenda`,
  }));

  before(async () => {
    for (const m of MANY) {
      await db.exec(`
        insert into auth.users (id, email, raw_user_meta_data) values ('${m.id}', '${m.id}@test.invalid', '{"role":"teacher","full_name":"${m.name}"}');
        update teacher_profiles set approved = true where profile_id = '${m.id}';
        insert into age_records (profile_id, date_of_birth, consent_status) values ('${m.id}', '1980-01-01', 'not_required');
        insert into activities (id, teacher_id, category, activity_type, title, status) values ('${m.act}', '${m.id}', 'sports', 'x', 'Activity ${m.name}', 'published');
        insert into subscriptions (student_id, activity_id, teacher_id, status) values ('${ID.S1}', '${m.act}', '${m.id}', 'active');
      `);
    }
  });

  test("a page never holds more than the page size, and the next page continues exactly where it stopped", async () => {
    const seen: DirectoryTeacher[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list(ID.S1, "", { cursor });
      assert.ok(page.teachers.length <= DIRECTORY_PAGE_SIZE, "at most one page of people");
      seen.push(...page.teachers);
      cursor = page.nextCursor;
      pages++;
      assert.ok(pages < 10, "paging must end");
    } while (cursor);

    assert.equal(seen.length, 33, "30 new coaches + David Pagni, Mwangi Kamau and Sarah Williams");
    assert.equal(pages, 3, "12 + 12 + 9");
    assert.equal(new Set(seen.map((t) => t.id)).size, seen.length, "nobody twice, nobody skipped");
    const sorted = [...seen].sort((a, b) => (a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0));
    assert.deepEqual(seen.map((t) => t.id), sorted.map((t) => t.id), "name order across pages");
  });

  test("the last page has no 'next', and a full page followed by nothing doesn't invent one", async () => {
    const first = await list(ID.S1, "", { pageSize: 33 });
    assert.equal(first.teachers.length, 33);
    assert.equal(first.nextCursor, null, "exactly 33 people with a page size of 33 → no more");
    assert.notEqual((await list(ID.S1, "", { pageSize: 32 })).nextCursor, null);
  });

  test("search and paging work together (server-side, page by page)", async () => {
    const p1 = await list(ID.S1, "mwenda");
    assert.equal(p1.teachers.length, DIRECTORY_PAGE_SIZE);
    assert.ok(p1.nextCursor);
    const p2 = await list(ID.S1, "mwenda", { cursor: p1.nextCursor });
    const p3 = await list(ID.S1, "mwenda", { cursor: p2.nextCursor });
    assert.equal(p1.teachers.length + p2.teachers.length + p3.teachers.length, 30);
    assert.equal(p3.nextCursor, null);
    assert.ok([...p1.teachers, ...p2.teachers, ...p3.teachers].every((t) => /mwenda/i.test(t.name)));
    assert.deepEqual((await list(ID.S1, "mwenda b2")).teachers.map((t) => t.name), ["Coach B2 Mwenda"]);
  });

  test("the dashboard's first page of six is cut by the database, with a next page", async () => {
    const first = await list(ID.S1, "", { pageSize: 6 });
    assert.equal(first.teachers.length, 6);
    assert.ok(first.nextCursor);
    const second = await list(ID.S1, "", { pageSize: 6, cursor: first.nextCursor });
    assert.equal(second.teachers.length, 6);
    assert.ok(!second.teachers.some((t) => first.teachers.some((f) => f.id === t.id)));
  });

  test("a forged or damaged cursor can only move the starting point, never widen who is listed", async () => {
    // unreadable → starts from the top
    assert.equal((await list(ID.S1, "", { cursor: "not-a-cursor" })).teachers[0].name, "Coach A0 Mwenda");
    assert.equal((await list(ID.S1, "", { cursor: { evil: true } as unknown })).teachers[0].name, "Coach A0 Mwenda");
    // well-formed but made up: resumes after that point, still only this student's coaches
    const forged = encodeCursor({ name: "", id: ID.T4 });
    const page = await list(ID.S1, "", { cursor: forged });
    assert.ok(!page.teachers.some((t) => t.id === ID.T3), "an unapproved teacher never appears");
    // a student who isn't cleared gets nothing, whatever cursor they send
    assert.deepEqual((await list(ID.S3, "", { cursor: forged })).teachers, []);
  });

  test("the cursor round-trips and rejects anything that isn't ours", () => {
    const c = { name: "david pagni", id: ID.T2 };
    assert.deepEqual(decodeCursor(encodeCursor(c)), c);
    for (const bad of [undefined, null, "", "x", 5, {}, "e30", Buffer.from(JSON.stringify(["a", "not-a-uuid"])).toString("base64url"), Buffer.from(JSON.stringify(["a"])).toString("base64url"), "A".repeat(1000)]) {
      assert.equal(decodeCursor(bad), null, String(bad).slice(0, 20));
    }
  });

  test("page sizes are clamped", async () => {
    assert.equal((await list(ID.S1, "", { pageSize: 0 })).teachers.length, 1);
    assert.equal((await list(ID.S1, "", { pageSize: 10_000 })).teachers.length, 33);
    assert.equal((await list(ID.S1, "", { pageSize: -5 })).teachers.length, 1);
  });
});

describe("what a student can see about a coach (privacy)", () => {
  test("only name, picture, role, specialty, bio and their shared activities and subjects — nothing private", async () => {
    const [t] = (await list(ID.S1, "david")).teachers;
    assert.deepEqual(Object.keys(t).sort(), ["activities", "avatarSrc", "bio", "canMessage", "conversationId", "id", "name", "role", "sortName", "specialty", "subjects"]);
    assert.equal(t.specialty, "Football");
    assert.equal(t.bio, "Plays and coaches football.");
    assert.deepEqual(t.activities.map((a) => a.title), ["Football club"]);

    const everything = JSON.stringify([...(await list(ID.S1)).teachers, await directory.getDirectoryTeacher(fake.admin, ID.S1, ID.T2)]);
    for (const secret of ["0711111111", "Secret Bank", "123456789", "4321", "0700 000 111", "@test.invalid", "wallet", "mpesa", "phone", "email"]) {
      assert.ok(!everything.includes(secret), `must not contain ${secret}`);
    }
  });

  test("the database function itself returns no private columns", async () => {
    const r = await fake.admin.rpc("student_directory", { p_student: ID.S1, p_terms: ["david"], p_limit: 5, p_after_name: null, p_after_id: null, p_teacher: null });
    const columns = Object.keys((r.data as Record<string, unknown>[])[0]).sort();
    assert.deepEqual(columns, ["activities", "avatar_url", "bio", "can_message", "conversation_id", "full_name", "kind", "sort_name", "specialty", "subjects", "teacher_id"]);
  });
});

describe("backend authorization (the browser can't ask for more)", () => {
  test("the profile lookup returns only discoverable teachers/coaches, and only to a cleared student", async () => {
    assert.equal((await directory.getDirectoryTeacher(fake.admin, ID.S1, ID.T2))?.name, "David Pagni");
    assert.equal((await directory.getDirectoryTeacher(fake.admin, ID.S7, ID.T2))?.name, "David Pagni", "an outsider can view a profile");
    assert.equal((await directory.getDirectoryTeacher(fake.admin, ID.S1, ID.T4))?.name, "Mwangi Kamau", "no subscription needed");
    assert.equal(await directory.getDirectoryTeacher(fake.admin, ID.S1, ID.T3), null, "an unapproved teacher");
    assert.equal(await directory.getDirectoryTeacher(fake.admin, ID.S3, ID.T2), null, "approval still pending");
    assert.equal(await directory.getDirectoryTeacher(fake.admin, ID.S4, ID.T2), null, "no age record");
  });

  test("unknown people, students and malformed ids all look the same: nothing", async () => {
    for (const id of [NOBODY, ID.S1, ID.S7, ID.ADMIN, "not-a-uuid", "", "' or 1=1 --"]) {
      assert.equal(await directory.getDirectoryTeacher(fake.admin, ID.S1, id), null, id);
    }
    assert.equal(await directory.getDirectoryTeacher(fake.admin, "nope", ID.T2), null);
  });

  test("a failed lookup is reported, not turned into an empty list that looks like 'no coaches'", async () => {
    const broken = makeFakeAdmin(db, { rpcOverride: () => ({ code: "XX000", message: "boom" }) });
    const page = await directory.listDirectory(broken.admin, ID.S1, {});
    assert.equal(page.ok, false);
    assert.match((page as { message: string }).message, /couldn't load/);
    assert.equal(await directory.getDirectoryTeacher(broken.admin, ID.S1, ID.T2), null);
  });

  test("browsers (signed in or not) cannot call the directory or start functions at all", async () => {
    const list = "select * from student_directory($1, '{}'::text[], 12, null, null, null)";
    for (const actor of ["anon", { id: ID.S1 }, { id: ID.T2 }] as const) {
      assert.equal(await rejects(db, actor, list, [ID.S1]), true, `student_directory as ${JSON.stringify(actor)}`);
      assert.equal(await rejects(db, actor, "select start_conversation_as_student($1, $2)", [ID.S1, ID.T2]), true, `start as ${JSON.stringify(actor)}`);
    }
    assert.equal(await rejects(db, "service", list, [ID.S1]), false, "the server can");
  });

  test("a browser still can't read a teacher's profile row through the tables either", async () => {
    // Unchanged by this feature, but the directory's privacy depends on it: students cannot read teacher_profiles.
    assert.equal((await rows("select 1"))[0] !== undefined, true);
    const { as } = await import("./helpers/db");
    const seen = await as(db, { id: ID.S1 }, async () => (await db.query("select * from teacher_profiles")).rows);
    assert.deepEqual(seen, []);
  });
});

describe("Message button → the existing messaging system", () => {
  const count = async () => (await rows("select count(*)::int as n from conversations"))[0].n as number;

  test("no conversation yet: it creates one; pressing again returns the same one (no duplicates)", async () => {
    assert.equal(await count(), 0);
    const first = await messaging.startAsStudent(fake.admin, ID.S1, ID.T2);
    assert.ok(first.ok);
    const again = await messaging.startAsStudent(fake.admin, ID.S1, ID.T2);
    const third = await messaging.startAsStudent(fake.admin, ID.S1, ID.T2);
    assert.ok(again.ok && third.ok);
    assert.equal(again.conversationId, first.conversationId);
    assert.equal(third.conversationId, first.conversationId);
    assert.equal(await count(), 1);
    const [row] = await rows("select student_id, teacher_id from conversations");
    assert.deepEqual([row.student_id, row.teacher_id], [ID.S1, ID.T2]);
  });

  test("an existing conversation is reused, whichever way it was started — from the activity page, by the teacher, or from here", async () => {
    const fromActivity = await messaging.startFromActivity(fake.admin, ID.S1, ID.A1);
    assert.ok(fromActivity.ok);
    const fromDirectory = await messaging.startAsStudent(fake.admin, ID.S1, ID.T2);
    assert.ok(fromDirectory.ok);
    assert.equal(fromDirectory.conversationId, fromActivity.conversationId);
    assert.equal(await count(), 1);

    await db.exec("delete from conversations");
    const byTeacher = await messaging.startAsTeacher(fake.admin, ID.T2, ID.S1);
    assert.ok(byTeacher.ok);
    const fromHere = await messaging.startAsStudent(fake.admin, ID.S1, ID.T2);
    assert.ok(fromHere.ok);
    assert.equal(fromHere.conversationId, byTeacher.conversationId);
    assert.equal(await count(), 1);
  });

  test("the directory knows about an existing conversation, so 'Message' can open it directly", async () => {
    assert.equal((await list(ID.S1, "david")).teachers[0].conversationId, null);
    const started = await messaging.startAsStudent(fake.admin, ID.S1, ID.T2);
    assert.ok(started.ok);
    assert.equal((await list(ID.S1, "david")).teachers[0].conversationId, started.conversationId);
    assert.equal((await list(ID.S1, "sarah")).teachers[0].conversationId, null, "other people are unaffected");
    assert.equal((await directory.getDirectoryTeacher(fake.admin, ID.S1, ID.T2))?.conversationId, started.conversationId);
  });

  test("the directory says who the student may message: only people they have an active subscription with", async () => {
    const flags = async (student: string) => Object.fromEntries((await list(student, "", { pageSize: 50 })).teachers.filter((t) => ALL.includes(t.name)).map((t) => [t.name, t.canMessage]));
    assert.deepEqual(await flags(ID.S1), { "David Pagni": true, "Mwangi Kamau": false, "Sarah Williams": true });
    assert.deepEqual(await flags(ID.S7), { "David Pagni": false, "Mwangi Kamau": false, "Sarah Williams": false });
    // Discovering someone grants nothing: the database still refuses to start the conversation.
    assert.equal((await messaging.startAsStudent(fake.admin, ID.S7, ID.T2)).ok, false);
    assert.equal(await count(), 0);
  });

  test("it's the same conversation the student can then write in", async () => {
    const started = await messaging.startAsStudent(fake.admin, ID.S1, ID.T2);
    assert.ok(started.ok);
    const sent = await messaging.sendMessage(fake.admin, ID.S1, { conversationId: started.conversationId, body: "Hello coach", kind: "message" });
    assert.ok(sent.ok);
  });

  test("you can't message someone you aren't connected to — the database refuses, whatever the browser sends", async () => {
    for (const [student, teacher] of [
      [ID.S1, ID.T4], // approved, discoverable coach, but the subscription has expired
      [ID.S1, ID.T3], // unapproved
      [ID.S7, ID.T2], // outsider
      [ID.S5, ID.T2], // payment pending
      [ID.S6, ID.T2], // cancelled
      [ID.S1, ID.S7], // a student, not a teacher
      [ID.S1, NOBODY],
      [ID.T2, ID.T1], // a teacher can't use the student route
    ]) {
      const r = await messaging.startAsStudent(fake.admin, student, teacher);
      assert.equal(r.ok, false, `${student} → ${teacher}`);
    }
    assert.equal(await messaging.startAsStudent(fake.admin, ID.S1, "nope").then((r) => r.ok), false);
    assert.equal(await count(), 0, "nothing was created");
  });

  test("an under-18 whose guardian hasn't approved can't start one, but an approved one can", async () => {
    assert.equal((await messaging.startAsStudent(fake.admin, ID.S3, ID.T2)).ok, false);
    assert.equal((await messaging.startAsStudent(fake.admin, ID.S2, ID.T2)).ok, true);
  });

  test("starting is rate limited like the other start paths", async () => {
    let refused = 0;
    for (let i = 0; i < 40; i++) if (!(await messaging.startAsStudent(fake.admin, ID.S1, ID.T2)).ok) refused++;
    assert.ok(refused >= 10, `expected the limit of ${messaging.LIMITS.start.max} per hour to apply, got ${refused} refusals`);
  });
});

describe("profile pictures", () => {
  const folder = ID.T2;
  const pub = `${SUPABASE_URL}/storage/v1/object/public/avatars/`;

  test("a picture in the teacher's own folder is shown — as a path or as the full public address", () => {
    assert.equal(avatarSrc(`${folder}/photo.jpg`, folder, SUPABASE_URL), `${pub}${folder}/photo.jpg`);
    assert.equal(avatarSrc(`${pub}${folder}/photo.jpg`, folder, `${SUPABASE_URL}/`), `${pub}${folder}/photo.jpg`);
    assert.equal(avatarSrc(`${folder}/photo.jpg?v=123`, folder, SUPABASE_URL), `${pub}${folder}/photo.jpg?v=123`);
    assert.equal(avatarSrc(`${folder.toUpperCase()}/Photo_1.PNG`, folder, SUPABASE_URL), `${pub}${folder.toUpperCase()}/Photo_1.PNG`);
  });

  test("anything else is refused (a teacher can write this column themselves, so it is not trusted)", () => {
    for (const bad of [
      "https://evil.example/track.png",
      `http://evil.example/${folder}/photo.jpg`,
      `${pub}${ID.T1}/photo.jpg`, // someone else's folder
      `${ID.T1}/photo.jpg`,
      `${folder}/../${ID.T1}/photo.jpg`,
      `${folder}/a/b.jpg`,
      `${folder}/.hidden`,
      `${folder}/`,
      `${folder}`,
      "photo.jpg",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      `${folder}/photo.jpg" onerror="x`,
      `${folder}/pho to.jpg`,
      `${SUPABASE_URL}.evil.example/storage/v1/object/public/avatars/${folder}/photo.jpg`,
      "",
      "   ",
    ]) {
      assert.equal(avatarSrc(bad, folder, SUPABASE_URL), null, JSON.stringify(bad));
    }
    assert.equal(avatarSrc(null, folder, SUPABASE_URL), null);
    assert.equal(avatarSrc(undefined, folder, SUPABASE_URL), null);
    assert.equal(avatarSrc(`${folder}/photo.jpg`, folder, undefined), null, "no project address configured → initials");
    assert.equal(avatarSrc(`${folder}/photo.jpg`, "not-a-uuid", SUPABASE_URL), null);
  });

  test("the directory hands back a vetted address, or null so the card shows initials", async () => {
    const david = (await list(ID.S1, "david")).teachers[0];
    assert.equal(david.avatarSrc, `${pub}${ID.T2}/photo.jpg`);
    const sarah = (await list(ID.S1, "sarah")).teachers[0];
    assert.equal(sarah.avatarSrc, null, "no picture on file");
    await db.query("update profiles set avatar_url = $1 where id = $2", ["https://evil.example/track.png", ID.T1]);
    try {
      assert.equal((await list(ID.S1, "sarah")).teachers[0].avatarSrc, null, "a web address pointing elsewhere is never shown");
    } finally {
      await db.query("update profiles set avatar_url = null where id = $1", [ID.T1]);
    }
  });

  test("fallback initials are consistent", () => {
    assert.equal(initialsOf("David Pagni"), "DP");
    assert.equal(initialsOf("  sarah   williams "), "SW");
    assert.equal(initialsOf("Madonna"), "M");
    assert.equal(initialsOf("Mary Jane Watson"), "MW");
    assert.equal(initialsOf("🙂 Joy Ke"), "JK");
    assert.equal(initialsOf("Ōtextane Ñandú"), "ŌÑ");
    assert.equal(initialsOf(""), "?");
    assert.equal(initialsOf("   "), "?");
    assert.equal(initialsOf("🙂🙂"), "?");
  });
});

describe("what is shown on a card", () => {
  const base = { role: roleLabel("Coach"), specialty: null as string | null };

  test("role is Teacher only for someone with no published activity, otherwise Coach", () => {
    assert.equal(roleLabel("Teacher"), "Teacher");
    assert.equal(roleLabel("Coach"), "Coach");
    assert.equal(roleLabel(), "Coach");
    assert.equal(roleLabel(null), "Coach");
  });

  test("the subtitle is the role and specialty, or just the role when there is no specialty", () => {
    assert.equal(subtitleOf({ ...base, specialty: "Football" }), "Coach • Football");
    assert.equal(subtitleOf({ ...base, specialty: "  Chess  " }), "Coach • Chess");
    assert.equal(subtitleOf({ ...base, specialty: "Head football coach" }), "Head football coach");
    assert.equal(subtitleOf(base), "Coach");
    assert.equal(subtitleOf({ role: "Teacher", specialty: "Maths" }), "Teacher • Maths");
  });

  test("Message opens a conversation only when one exists or the student may start one", () => {
    const t = { conversationId: null, canMessage: false };
    assert.equal(canOpenConversation(t), false);
    assert.equal(canOpenConversation({ ...t, canMessage: true }), true);
    assert.equal(canOpenConversation({ ...t, conversationId: ID.S1 }), true);
  });
});

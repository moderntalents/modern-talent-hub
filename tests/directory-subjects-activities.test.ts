// Teacher-first discovery on the student "Subjects" and "Activities" pages (migration 0023,
// lib/directory/*): everyone offering a subject / activity is listed, a person under several subjects or
// activities appears under each, and nothing is hard-coded — it all comes from published lessons and
// published activities. Same visibility rules as the directory (approved, set up, something published).

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, rejects } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import { makeFakeAdmin, type FakeAdmin } from "./helpers/fake-admin";
import * as directory from "../lib/directory/service";
import { existsSync, readFileSync } from "node:fs";
import {
  findActivity,
  findCategory,
  listActivityChoices,
  parseScope,
  scopeToArgs,
  type DirectoryScope,
} from "../lib/directory/rules";

const SCIENCE = "dddddddd-0000-4000-8000-000000000002";
const HISTORY = "dddddddd-0000-4000-8000-000000000003"; // a subject nobody teaches
const GEOGRAPHY = "dddddddd-0000-4000-8000-000000000005"; // taught only by "Specialty Only"
const ASTRONOMY = "dddddddd-0000-4000-8000-000000000004"; // only ever a DRAFT lesson
const MULTI = "aaaaaaaa-3333-4000-8000-0000000000ff"; // Maths AND Science lessons, Karate AND Taekwondo
const MATHS_TEACHERS = 10; // extra teachers with a published Mathematics lesson
const tid = (n: number) => `aaaaaaaa-3333-4000-8000-${String(n).padStart(12, "0")}`;

let db: PGlite;
let fake: FakeAdmin;

const user = (id: string, name: string) =>
  `insert into auth.users (id, email, raw_user_meta_data) values ('${id}', '${id}@test.invalid', '{"role":"teacher","full_name":"${name}"}');
   update teacher_profiles set approved = true where profile_id = '${id}';
   insert into age_records (profile_id, date_of_birth, consent_status) values ('${id}', '1980-01-01', 'not_required');`;

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
  fake = makeFakeAdmin(db);
  let sql = `
    insert into subjects (id, name, order_index) values ('${SCIENCE}', 'Science', 2), ('${HISTORY}', 'History', 3);
    update subjects set order_index = 1 where id = '${ID.SUBJECT}';
    ${user(MULTI, "Multi Talented")}
    insert into lessons (subject_id, teacher_id, title, status) values
      ('${ID.SUBJECT}', '${MULTI}', 'Maths basics', 'published'),
      ('${SCIENCE}', '${MULTI}', 'Forces', 'published');
    insert into activities (teacher_id, category, activity_type, title, status) values
      ('${MULTI}', 'martial', 'Karate', 'Karate fundamentals', 'published'),
      ('${MULTI}', 'martial', 'Taekwondo', 'Taekwondo kicks', 'published');
  `;
  for (let i = 1; i <= MATHS_TEACHERS; i++) {
    sql += `${user(tid(i), `Maths Teacher ${String(i).padStart(2, "0")}`)}
      insert into lessons (subject_id, teacher_id, title, status) values ('${ID.SUBJECT}', '${tid(i)}', 'Lesson ${i}', 'published');`;
  }
  // A second karate coach (lowercase id stored, as older rows were), a draft-only karate coach, and an
  // unapproved karate coach — only the first should be listed under Karate besides MULTI.
  sql += `
    ${user(tid(50), "Karate Second")}
    insert into activities (teacher_id, category, activity_type, title, status) values ('${tid(50)}', 'martial', 'karate', 'White belt lessons', 'published');
    ${user(tid(51), "Karate Draft")}
    insert into activities (teacher_id, category, activity_type, title, status) values ('${tid(51)}', 'martial', 'Karate', 'Not yet', 'draft');
    insert into auth.users (id, email, raw_user_meta_data) values ('${tid(52)}', 'x52@test.invalid', '{"role":"teacher","full_name":"Karate Unapproved"}');
    insert into age_records (profile_id, date_of_birth, consent_status) values ('${tid(52)}', '1980-01-01', 'not_required');
    insert into activities (teacher_id, category, activity_type, title, status) values ('${tid(52)}', 'martial', 'Karate', 'Hidden', 'published');
  `;
  // Search fixtures: a specialty, a person matched ONLY through their specialty, a subject whose only lesson
  // is a draft, and private details that must never be searchable.
  sql += `
    update teacher_profiles set specialty = 'Mental arithmetic' where profile_id = '${tid(3)}';
    update teacher_profiles set bio = 'secret-bio-word', mpesa_number = '0799123456' where profile_id = '${tid(4)}';
    update profiles set phone = '0722000333' where id = '${tid(4)}';
    ${user(tid(60), "Specialty Only")}
    update teacher_profiles set specialty = 'Rugby sevens' where profile_id = '${tid(60)}';
    insert into subjects (id, name, order_index) values ('${GEOGRAPHY}', 'Geography', 8);
    insert into lessons (subject_id, teacher_id, title, status) values ('${GEOGRAPHY}', '${tid(60)}', 'Rift Valley', 'published');
    insert into subjects (id, name, order_index) values ('${ASTRONOMY}', 'Astronomy', 9);
    insert into lessons (subject_id, teacher_id, title, status) values ('${ASTRONOMY}', '${tid(2)}', 'Stars (draft)', 'draft');
  `;
  await db.exec(sql);
});

const list = async (student: string, scope: DirectoryScope, extra: { query?: unknown; cursor?: unknown; pageSize?: number } = {}) => {
  const page = await directory.listDirectory(fake.admin, student, { scope, pageSize: 50, ...extra });
  assert.ok(page.ok, "the directory should load");
  return page;
};
const names = async (student: string, scope: DirectoryScope, query?: unknown) =>
  (await list(student, scope, { query })).teachers.map((t) => t.name);

const MATHS_NAMES = Array.from({ length: MATHS_TEACHERS }, (_, i) => `Maths Teacher ${String(i + 1).padStart(2, "0")}`);

describe("Subjects: All Teachers, then one subject", () => {
  test("All Teachers lists everyone with a published lesson — and nobody who only coaches", async () => {
    const all = await names(ID.S1, { offer: "subjects" });
    for (const n of [...MATHS_NAMES, "Multi Talented", "Teacher One"]) {
      assert.ok(all.includes(n), `${n} should be listed`);
    }
    assert.ok(!all.includes("Teacher Two"), "a coach with only an activity is not in the teachers list");
    assert.ok(!all.includes("Teacher Four"), "only a DRAFT lesson");
    assert.ok(!all.some((n) => n.includes("unapproved")), "an unapproved teacher");
    assert.equal(all.length, MATHS_TEACHERS + 3);
  });

  test("selecting Mathematics lists ALL of its teachers (no cap at a handful)", async () => {
    const maths = await names(ID.S1, { offer: "subjects", subjectId: ID.SUBJECT });
    assert.deepEqual(maths, ["Multi Talented", ...MATHS_NAMES, "Teacher One"].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    assert.equal(maths.length, MATHS_TEACHERS + 2);
  });

  test("a teacher with lessons in two subjects appears under both, and only there", async () => {
    assert.ok((await names(ID.S1, { offer: "subjects", subjectId: ID.SUBJECT })).includes("Multi Talented"));
    assert.deepEqual(await names(ID.S1, { offer: "subjects", subjectId: SCIENCE }), ["Multi Talented"]);
    assert.deepEqual(await names(ID.S1, { offer: "subjects", subjectId: HISTORY }), []);
  });

  test("a new published lesson puts a teacher under that subject; a draft or unpublishing takes them out", async () => {
    const before = await names(ID.S1, { offer: "subjects", subjectId: HISTORY });
    assert.deepEqual(before, []);
    const [l] = (await db.query<{ id: string }>(
      `insert into lessons (subject_id, teacher_id, title, status) values ('${HISTORY}', '${tid(1)}', 'Kenya', 'published') returning id`,
    )).rows;
    assert.deepEqual(await names(ID.S1, { offer: "subjects", subjectId: HISTORY }), ["Maths Teacher 01"]);
    await db.query("update lessons set status = 'draft' where id = $1", [l.id]);
    assert.deepEqual(await names(ID.S1, { offer: "subjects", subjectId: HISTORY }), []);
    await db.query("delete from lessons where id = $1", [l.id]);
  });

  test("each card says which subjects the teacher teaches (from the database, by name)", async () => {
    const t = (await list(ID.S1, { offer: "subjects" }, { query: "multi" })).teachers[0];
    assert.deepEqual(t.subjects.map((s) => s.name), ["Mathematics", "Science"]);
    const plain = (await list(ID.S1, { offer: "subjects" }, { query: "maths teacher 03" })).teachers[0];
    assert.deepEqual(plain.subjects.map((s) => s.name), ["Mathematics"]);
  });

  test("paging works inside a subject: every teacher once, none repeated", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list(ID.S1, { offer: "subjects", subjectId: ID.SUBJECT }, { pageSize: 4, cursor });
      seen.push(...page.teachers.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.length, MATHS_TEACHERS + 2);
    assert.equal(new Set(seen).size, seen.length);
  });

  test("a name search narrows within the chosen subject", async () => {
    assert.deepEqual(await names(ID.S1, { offer: "subjects", subjectId: ID.SUBJECT }, "teacher 07"), ["Maths Teacher 07"]);
    assert.deepEqual(await names(ID.S1, { offer: "subjects", subjectId: SCIENCE }, "teacher 07"), []);
  });
});

describe("Activities: All Coaches, then one activity", () => {
  test("All Coaches lists everyone with a published activity — not people who only teach lessons", async () => {
    const all = await names(ID.S1, { offer: "activities" });
    for (const n of ["Teacher Two", "Teacher Four", "Multi Talented", "Karate Second"]) assert.ok(all.includes(n), `${n} should be listed`);
    assert.ok(!all.includes("Maths Teacher 01"), "lessons only");
    assert.ok(!all.includes("Karate Draft"), "draft activity only");
    assert.ok(!all.includes("Karate Unapproved"), "unapproved");
  });

  test("selecting Karate lists every coach offering it (name or id stored, any capitalisation)", async () => {
    assert.deepEqual(await names(ID.S1, { offer: "activities", activityId: "karate" }), ["Karate Second", "Multi Talented"]);
    assert.deepEqual(await names(ID.S1, { offer: "activities", activityId: "Karate" }), ["Karate Second", "Multi Talented"]);
  });

  test("a coach offering Karate and Taekwondo appears under both", async () => {
    assert.ok((await names(ID.S1, { offer: "activities", activityId: "karate" })).includes("Multi Talented"));
    assert.deepEqual(await names(ID.S1, { offer: "activities", activityId: "taekwondo" }), ["Multi Talented"]);
  });

  test("the seeded Football and Chess coaches are found under their own activity only", async () => {
    assert.deepEqual(await names(ID.S1, { offer: "activities", activityId: "football" }), ["Teacher Two"]);
    assert.deepEqual(await names(ID.S1, { offer: "activities", activityId: "chess" }), ["Teacher Four"]);
    assert.deepEqual(await names(ID.S1, { offer: "activities", activityId: "skating" }), [], "only a DRAFT skating activity exists");
  });

  test("an activity that is not in the catalog lists nobody (it never turns into 'everybody')", async () => {
    assert.deepEqual(await names(ID.S1, { offer: "activities", activityId: "underwater-basket-weaving" }), []);
    assert.deepEqual(await names(ID.S1, { offer: "activities", activityId: "%" }), []);
  });

  test("coaches still show their activities on the card", async () => {
    const t = (await list(ID.S1, { offer: "activities", activityId: "karate" }, { query: "multi" })).teachers[0];
    assert.deepEqual(t.activities.map((a) => a.title).sort(), ["Karate fundamentals", "Taekwondo kicks"]);
    assert.equal(t.role, "Coach");
  });
});

describe("the same visibility and privacy rules apply", () => {
  test("a student whose own account setup isn't complete sees nobody, with or without a filter", async () => {
    assert.deepEqual(await names(ID.S3, { offer: "subjects", subjectId: ID.SUBJECT }), []);
    assert.deepEqual(await names(ID.S4, { offer: "activities", activityId: "karate" }), []);
  });

  test("a made-up scope can only narrow the list, never widen it", async () => {
    const wide = (await list(ID.S1, {})).teachers.length;
    for (const junk of [{ offer: "everything" }, { subjectId: "not-a-uuid" }, { activityId: 42 }, "x", null, { offer: "subjects", extra: true }]) {
      const n = (await list(ID.S1, parseScope(junk))).teachers.length;
      assert.ok(n <= wide);
    }
  });

  test("an unknown offer or subject id handed straight to the database returns nobody", async () => {
    const q = (sql: string, params: unknown[]) => db.query<{ teacher_id: string }>(sql, params).then((r) => r.rows.length);
    assert.equal(await q("select * from student_directory($1, '{}', 50, null, null, null, 'bogus', null, null)", [ID.S1]), 0);
    assert.equal(await q("select * from student_directory($1, '{}', 50, null, null, null, null, $2, null)", [ID.S1, "dddddddd-0000-4000-8000-0000000000aa"]), 0);
    assert.equal(await q("select * from student_directory($1, '{}', 50, null, null, null, null, null, '{}')", [ID.S1]), 0);
  });

  test("cards carry no private details", async () => {
    const t = (await list(ID.S1, { offer: "subjects" }, { query: "multi" })).teachers[0];
    assert.deepEqual(
      Object.keys(t).sort(),
      ["activities", "avatarSrc", "bio", "canMessage", "conversationId", "id", "name", "role", "sortName", "specialty", "subjects"],
    );
  });

  test("browsers (signed in or not) still cannot call the directory function, filters or not", async () => {
    const sql = "select * from student_directory($1, '{}'::text[], 12, null, null, null, 'subjects', null, null)";
    for (const actor of ["anon", { id: ID.S1 }, { id: ID.T2 }] as const) {
      assert.equal(await rejects(db, actor, sql, [ID.S1]), true);
    }
    assert.equal(await rejects(db, "service", sql, [ID.S1]), false);
  });

  test("a teacher's profile still opens for any person the student may discover, from any list", async () => {
    const t = await directory.getDirectoryTeacher(fake.admin, ID.S1, MULTI);
    assert.equal(t?.name, "Multi Talented");
    assert.equal(t?.subjects.length, 2);
    assert.equal(t?.activities.length, 2);
    assert.equal(await directory.getDirectoryTeacher(fake.admin, ID.S1, tid(52)), null, "unapproved: not found");
  });
});

describe("search: name, subject, activity and specialty", () => {
  const find = (q: string, scope: DirectoryScope = {}) => names(ID.S1, scope, q);
  const MATHS_ALL = [...MATHS_NAMES, "Multi Talented", "Teacher One"].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  test("name: a first name, a last word, and a partial word", async () => {
    assert.deepEqual(await find("Multi"), ["Multi Talented"]);
    assert.deepEqual(await find("talen"), ["Multi Talented"]);
    assert.deepEqual(await find("karate second"), ["Karate Second"]);
  });

  test("subject: 'Math' finds everyone who teaches Mathematics, however it is typed", async () => {
    assert.deepEqual(await find("math"), MATHS_ALL);
    assert.deepEqual(await find("MATHEMATICS"), MATHS_ALL);
    assert.deepEqual(await find("ematic"), MATHS_ALL, "partial, from the middle of the word");
    assert.deepEqual(await find("science"), ["Multi Talented"]);
  });

  test("activity: 'Karate' (and 'kara') finds Karate coaches by activity type or title", async () => {
    assert.deepEqual(await find("Karate"), ["Karate Second", "Multi Talented"]);
    assert.deepEqual(await find("kara"), ["Karate Second", "Multi Talented"]);
    assert.deepEqual(await find("taekwondo"), ["Multi Talented"]);
    assert.deepEqual(await find("white belt"), ["Karate Second"], "an activity title");
    assert.deepEqual(await find("football"), ["Teacher Two"]);
  });

  test("specialty: found by it even when nothing else matches", async () => {
    assert.deepEqual(await find("rugby"), ["Specialty Only"], "only the specialty says rugby");
    assert.deepEqual(await find("arithmetic"), ["Maths Teacher 03"]);
    assert.deepEqual(await find("MENTAL ARITH"), ["Maths Teacher 03"]);
  });

  test("several words: each may match a different field, in any order", async () => {
    assert.deepEqual(await find("karate math"), ["Multi Talented"], "an activity AND a subject");
    assert.deepEqual(await find("math karate"), ["Multi Talented"]);
    assert.deepEqual(await find("multi karate"), ["Multi Talented"], "name AND activity");
    assert.deepEqual(await find("karate arithmetic"), [], "no one has both");
  });

  test("a person who matches through several fields appears once", async () => {
    // "a" appears in the name, the subjects and the activities of Multi Talented.
    for (const q of ["a", "t", "ma", "karate"]) {
      const seen = (await list(ID.S1, {}, { query: q })).teachers.map((t) => t.id);
      assert.equal(new Set(seen).size, seen.length, `no duplicates for "${q}"`);
    }
    assert.equal((await find("multi talented karate taekwondo math")).length, 1);
  });

  test("Home search (no scope) reaches every eligible teacher and coach; Show more pages through the matches", async () => {
    const all = await find("maths");
    assert.ok(all.length >= MATHS_TEACHERS);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list(ID.S1, {}, { query: "math", pageSize: 5, cursor });
      seen.push(...page.teachers.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(seen.length, MATHS_ALL.length);
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(pages, 3);
  });

  test("on the Subjects page the search stays inside the chosen subject", async () => {
    const maths = { offer: "subjects", subjectId: ID.SUBJECT } as const;
    assert.deepEqual(await find("multi", maths), ["Multi Talented"]);
    assert.deepEqual(await find("karate", maths), ["Multi Talented"], "teaches Maths AND offers Karate");
    assert.deepEqual(await find("karate second", maths), [], "a Karate coach who does not teach Maths");
    assert.deepEqual(await find("rugby", maths), [], "Specialty Only teaches Geography, not Maths");
    assert.deepEqual(await find("rugby", { offer: "subjects", subjectId: GEOGRAPHY }), ["Specialty Only"]);
    assert.deepEqual(await find("arithmetic", maths), ["Maths Teacher 03"]);
    assert.deepEqual(await find("maths teacher 05", { offer: "subjects", subjectId: SCIENCE }), []);
  });

  test("on the Activities page the search stays inside the chosen activity", async () => {
    const karate = { offer: "activities", activityId: "karate" } as const;
    assert.deepEqual(await find("multi", karate), ["Multi Talented"]);
    assert.deepEqual(await find("second", karate), ["Karate Second"]);
    assert.deepEqual(await find("taekwondo", karate), ["Multi Talented"], "offers Karate AND Taekwondo");
    assert.deepEqual(await find("teacher two", karate), [], "a football coach");
    assert.deepEqual(await find("talented", { offer: "activities", activityId: "taekwondo" }), ["Multi Talented"]);
    assert.deepEqual(await find("second", { offer: "activities", activityId: "taekwondo" }), []);
    assert.deepEqual(await find("karate", { offer: "activities", categoryId: "martial" }), ["Karate Second", "Multi Talented"]);
  });

  test("Show more works inside a scope with a search", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list(ID.S1, { offer: "subjects", subjectId: ID.SUBJECT }, { query: "teacher", pageSize: 4, cursor });
      seen.push(...page.teachers.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(seen.length, MATHS_TEACHERS + 1, "ten Maths Teachers plus Teacher One");
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(pages, 3);
  });

  test("drafts, unapproved teachers and private details are never searchable", async () => {
    assert.deepEqual(await find("hidden"), [], "title of a published activity of an UNAPPROVED coach");
    assert.deepEqual(await find("karate unapproved"), []);
    assert.deepEqual(await find("not yet"), [], "title of a DRAFT activity");
    assert.deepEqual(await find("karate draft"), [], "a coach with only a draft activity: not listed, not found by name either");
    assert.deepEqual(await find("astronomy"), [], "a subject whose only lesson is a draft");
    assert.deepEqual(await find("stars"), [], "a draft lesson title is not searched at all");
    for (const secret of ["secret-bio-word", "0799123456", "0722000333", "test.invalid", "wallet", "mpesa"]) {
      assert.deepEqual(await find(secret), [], `${secret} is private`);
    }
    // Publishing is what makes the subject findable.
    await db.query("update lessons set status = 'published' where subject_id = $1", [ASTRONOMY]);
    assert.deepEqual(await find("astronomy"), ["Maths Teacher 02"]);
    await db.query("update lessons set status = 'draft' where subject_id = $1", [ASTRONOMY]);
    assert.deepEqual(await find("astronomy"), []);
  });

  test("a student whose account setup isn't complete finds nobody by any field", async () => {
    assert.deepEqual(await names(ID.S3, {}, "karate"), []);
    assert.deepEqual(await names(ID.S4, {}, "math"), []);
  });

  test("no match, wildcards and blank searches", async () => {
    assert.deepEqual(await find("zzzqqq"), []);
    assert.deepEqual(await find("%"), [], "% is just a character");
    assert.deepEqual(await find("_"), []);
    assert.deepEqual(await find("\\"), []);
    assert.deepEqual(await find("   "), (await names(ID.S1, {})), "blank = no search");
    assert.deepEqual(await find("karate ' or 1=1 --"), []);
  });

  test("the match is on the whole word list, up to five words", async () => {
    assert.deepEqual(await find("multi talented karate taekwondo math science"), ["Multi Talented"], "a sixth word is ignored");
  });
});

describe("old links keep working", () => {
  test("?category=martial lists coaches offering ANY activity in that category", async () => {
    // Karate Second (karate), Multi Talented (Karate + Taekwondo). Teacher Four (chess) and Teacher Two (football) are other categories.
    assert.deepEqual(await names(ID.S1, { offer: "activities", categoryId: "martial" }), ["Karate Second", "Multi Talented"]);
    assert.deepEqual(await names(ID.S1, { offer: "activities", categoryId: "sports" }), ["Teacher Two"]);
    assert.deepEqual(await names(ID.S1, { offer: "activities", categoryId: "creative" }), ["Teacher Four"]);
  });

  test("a made-up category lists nobody, and an activity beats a category when both are given", async () => {
    assert.deepEqual(await names(ID.S1, { offer: "activities", categoryId: "nonsense" }), []);
    assert.deepEqual(await names(ID.S1, { offer: "activities", categoryId: "sports", activityId: "taekwondo" }), ["Multi Talented"]);
  });

  test("findCategory resolves ids and names; parseScope keeps a valid category", () => {
    assert.deepEqual(findCategory(" Martial "), { id: "martial", name: "Martial Arts" });
    assert.equal(findCategory("karate"), null, "an activity is not a category");
    assert.deepEqual(parseScope({ offer: "activities", categoryId: "martial" }), { offer: "activities", categoryId: "martial" });
  });

  test("the /student/subjects/<subject> lessons page still exists, and the Activities page redirects old ?category= links", () => {
    assert.ok(existsSync("app/student/subjects/[subjectId]/page.tsx"));
    const marketplace = readFileSync("app/student/marketplace/page.tsx", "utf8");
    assert.match(marketplace, /categoryParam/);
    assert.match(marketplace, /redirect\(/);
  });
});

describe("scope helpers", () => {
  test("the Activities pills come from the catalog and every one resolves", () => {
    const choices = listActivityChoices();
    assert.ok(choices.length >= 15);
    for (const c of choices) assert.equal(findActivity(c.name)?.id, c.id);
    assert.deepEqual(findActivity(" KARATE "), { id: "karate", name: "Karate" });
    assert.equal(findActivity("nope"), null);
    assert.equal(findActivity(undefined), null);
  });

  test("scopeToArgs turns the catalog activity into the name and id the database compares with", () => {
    assert.deepEqual(scopeToArgs({ offer: "activities", activityId: "karate" }), {
      nobody: false, offer: "activities", subject: null, activities: ["Karate", "karate"],
    });
    assert.deepEqual(scopeToArgs({ activityId: "zzz" }), { nobody: true });
    assert.deepEqual(scopeToArgs({}), { nobody: false, offer: null, subject: null, activities: null });
  });

  test("parseScope keeps only valid parts", () => {
    assert.deepEqual(parseScope({ offer: "subjects", subjectId: ID.SUBJECT.toUpperCase() }), { offer: "subjects", subjectId: ID.SUBJECT });
    assert.deepEqual(parseScope({ offer: "x", subjectId: "1; drop table", activityId: "  " }), {});
  });
});

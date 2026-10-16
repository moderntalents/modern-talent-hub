// The approved starter subjects (migration 0025): exactly the 38 approved, in the right level and pathway,
// nothing existing changed, safe to re-run, and the "later" subjects can still be added on Admin -> Subjects.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, readMigration, rejects } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";

const APPROVED: [level: string, pathway: string | null, name: string][] = [
  ["pre_primary", null, "Language Activities"],
  ["pre_primary", null, "Mathematical Activities"],
  ["pre_primary", null, "Creative Activities"],
  ["pre_primary", null, "Environmental Activities"],
  ["pre_primary", null, "Religious Education Activities"],
  ["primary", null, "Environmental Activities"],
  ["primary", null, "Islamic Religious Education"],
  ["junior", null, "English"],
  ["junior", null, "Kiswahili"],
  ["junior", null, "Mathematics"],
  ["junior", null, "Integrated Science"],
  ["junior", null, "Social Studies"],
  ["junior", null, "Pre-Technical Studies"],
  ["junior", null, "Agriculture and Nutrition"],
  ["junior", null, "Creative Arts and Sports"],
  ["junior", null, "Christian Religious Education"],
  ["junior", null, "Islamic Religious Education"],
  ["senior", "core", "English"],
  ["senior", "core", "Kiswahili"],
  ["senior", "core", "Core Mathematics"],
  ["senior", "core", "Essential Mathematics"],
  ["senior", "core", "Community Service Learning"],
  ["senior", "stem", "Biology"],
  ["senior", "stem", "Chemistry"],
  ["senior", "stem", "Physics"],
  ["senior", "stem", "Agriculture"],
  ["senior", "stem", "Computer Studies"],
  ["senior", "social_sciences", "Literature in English"],
  ["senior", "social_sciences", "Fasihi ya Kiswahili"],
  ["senior", "social_sciences", "History and Citizenship"],
  ["senior", "social_sciences", "Geography"],
  ["senior", "social_sciences", "Business Studies"],
  ["senior", "social_sciences", "Christian Religious Education"],
  ["senior", "social_sciences", "Islamic Religious Education"],
  ["senior", "arts_sports", "Sports and Recreation"],
  ["senior", "arts_sports", "Music and Dance"],
  ["senior", "arts_sports", "Theatre and Film"],
  ["senior", "arts_sports", "Fine Arts"],
];

const EXISTING_PRIMARY = [
  "Mathematics", "English", "Kiswahili", "Science & Technology", "Social Studies",
  "Christian Religious Education", "Agriculture", "Creative Arts",
];

type Row = { id: string; level: string; pathway: string | null; name: string; active: boolean; description: string | null; color: string; order_index: number };

describe("approved starter subjects (0025) on a database that already has the 8 Primary subjects and lessons", () => {
  let db: PGlite;
  let before0025: Row[];
  let lessonsBefore: unknown[];

  before(async () => {
    db = await createTestDb({ upTo: "0024_subject_education_levels.sql" });
    await seedWorld(db); // Mathematics (with lessons)
    const others = EXISTING_PRIMARY.filter((n) => n !== "Mathematics")
      .map((n, i) => `('${n.replace(/'/g, "''")}', 'primary', ${i + 2})`)
      .join(", ");
    await db.exec(`insert into subjects (name, level, order_index) values ${others}`);
    before0025 = (await db.query<Row>("select * from subjects order by id")).rows;
    lessonsBefore = (await db.query("select * from lessons order by id")).rows;
    await db.exec(readMigration("0025_approved_starter_subjects.sql"));
  });

  test("adds exactly the 38 approved subjects, each in its level and pathway, all visible", async () => {
    const added = (await db.query<Row>(
      `select * from subjects where id not in (${before0025.map((r) => `'${r.id}'`).join(",")}) order by level, name`,
    )).rows;
    assert.equal(added.length, 38);
    const got = added.map((r) => [r.level, r.pathway, r.name]).sort();
    const want = [...APPROVED].sort();
    assert.deepEqual(got, want);
    assert.ok(added.every((r) => r.active));
  });

  test("the existing 8 Primary subjects and their lessons are unchanged", async () => {
    const now = (await db.query<Row>(`select * from subjects where id in (${before0025.map((r) => `'${r.id}'`).join(",")}) order by id`)).rows;
    assert.deepEqual(now, before0025);
    assert.deepEqual(before0025.map((r) => r.name).sort(), [...EXISTING_PRIMARY].sort());
    assert.deepEqual((await db.query("select * from lessons order by id")).rows, lessonsBefore);
  });

  test("Core and Essential Mathematics are both in the Senior School catalogue, labelled by pathway", async () => {
    const maths = (await db.query<Row>(
      "select name, pathway, description from subjects where level = 'senior' and name like '%Mathematics' order by name",
    )).rows;
    assert.deepEqual(maths.map((m) => [m.name, m.pathway]), [["Core Mathematics", "core"], ["Essential Mathematics", "core"]]);
    assert.match(maths[0].description!, /STEM/);
    assert.match(maths[1].description!, /Social Sciences and Arts & Sports Science/);
  });

  test("running it again adds nothing and changes nothing", async () => {
    const snapshot = (await db.query("select * from subjects order by id")).rows;
    await db.exec(readMigration("0025_approved_starter_subjects.sql"));
    assert.deepEqual((await db.query("select * from subjects order by id")).rows, snapshot);
  });

  test("a subject an admin already added with the same name and level is left as the admin set it", async () => {
    const db2 = await createTestDb({ upTo: "0024_subject_education_levels.sql" });
    await db2.exec(`insert into subjects (name, level, pathway, active, description) values ('Biology', 'senior', 'stem', false, 'Admin note')`);
    await db2.exec(readMigration("0025_approved_starter_subjects.sql"));
    const bio = (await db2.query<Row>("select active, description from subjects where level = 'senior' and name = 'Biology'")).rows;
    assert.deepEqual(bio, [{ active: false, description: "Admin note" }]);
  });

  test("the 'later' subjects can still be added by an admin (and only by an admin)", async () => {
    const later: [string, string | null, string][] = [
      ["primary", null, "Hindu Religious Education"],
      ["primary", null, "Indigenous Language"],
      ["primary", null, "Kenya Sign Language"],
      ["junior", null, "Hindu Religious Education"],
      ["junior", null, "Kenya Sign Language"],
      ["senior", "core", "Kenya Sign Language"],
      ["senior", "core", "Physical Education"],
      ["senior", "core", "ICT"],
      ["senior", "stem", "General Science"],
      ["senior", "stem", "Home Science"],
      ["senior", "stem", "Aviation"],
      ["senior", "stem", "Marine and Fisheries Technology"],
      ["senior", "social_sciences", "Hindu Religious Education"],
      ["senior", "social_sciences", "Indigenous Languages"],
      ["senior", "social_sciences", "Sign Language"],
      ["senior", "social_sciences", "Mandarin Chinese"],
    ];
    for (const [level, pathway, name] of later) {
      const sql = `insert into subjects (name, level, pathway) values ('${name}', '${level}', ${pathway ? `'${pathway}'` : "null"})`;
      assert.equal(await rejects(db, { id: ID.S1 }, sql), true, `student cannot add ${name}`);
      assert.equal(await rejects(db, { id: ID.ADMIN }, sql), false, `admin can add ${name} (${level})`);
    }
  });
});

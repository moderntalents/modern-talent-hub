// Subjects by school level (migration 0024, lib/education.ts, lib/subjects-admin.ts):
// existing subjects become Primary (CBC) untouched, names are unique per level, a subject with lessons can't be
// deleted, students get a grade_code (and level) from the free-text grade, only admins change subjects.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, readMigration, rejects } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import {
  EDUCATION_LEVELS,
  GRADE_OPTIONS,
  gradeCodeFromText,
  levelForGrade,
} from "../lib/education";
import { parseSubjectInput, subjectDbErrorMessage } from "../lib/subjects-admin";

let db: PGlite;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

describe("migration 0024 on an existing database", () => {
  let before0024: PGlite;

  test("existing subjects and lessons are kept as Primary (CBC), with their ids", async () => {
    before0024 = await createTestDb({ upTo: "0023_directory_by_subject_and_activity.sql" });
    await seedWorld(before0024);
    await before0024.exec(`
      insert into subjects (name, color, order_index) values ('Kiswahili', 'red', 3), ('Creative Arts', 'blue', 8);
      update student_profiles set grade = 'Grade 8' where profile_id = '${ID.S1}';
      update student_profiles set grade = 'Form 2' where profile_id = '${ID.S2}';
      update student_profiles set grade = 'pp 2' where profile_id = '${ID.S3}';
    `);
    const subjectsBefore = (await before0024.query("select id, name from subjects order by id")).rows;
    const lessonsBefore = (await before0024.query("select id, subject_id, title, status from lessons order by id")).rows;

    await before0024.exec(readMigration("0024_subject_education_levels.sql"));

    assert.deepEqual((await before0024.query("select id, name from subjects order by id")).rows, subjectsBefore);
    assert.deepEqual(
      (await before0024.query("select id, subject_id, title, status from lessons order by id")).rows,
      lessonsBefore,
    );
    const levels = (await before0024.query<{ level: string; active: boolean; pathway: string | null }>(
      "select distinct level, active, pathway from subjects",
    )).rows;
    assert.deepEqual(levels, [{ level: "primary", active: true, pathway: null }]);

    const grades = (await before0024.query<{ profile_id: string; grade: string; grade_code: string | null }>(
      `select profile_id, grade, grade_code from student_profiles where profile_id in ('${ID.S1}','${ID.S2}','${ID.S3}') order by profile_id`,
    )).rows;
    assert.deepEqual(
      grades.map((g) => [g.grade, g.grade_code]),
      [["Grade 8", "G8"], ["Form 2", null], ["pp 2", "PP2"]],
      "existing grades are read; unreadable ones are left empty, and the text itself is unchanged",
    );
  });

  test("re-running 0024 is harmless", async () => {
    await before0024.exec(readMigration("0024_subject_education_levels.sql"));
    assert.equal(Number((await before0024.query<{ n: number }>("select count(*)::int n from education_levels")).rows[0].n), 4);
  });
});

describe("school levels and subjects", () => {
  before(async () => {
    db = await createTestDb();
    await seedWorld(db);
  });

  test("the four levels, in order, match lib/education.ts", async () => {
    const rows = (await db.query<{ code: string; name: string; grades: string }>(
      "select code, name, grades from education_levels order by order_index",
    )).rows;
    assert.deepEqual(rows, EDUCATION_LEVELS);
  });

  test("the same subject name can exist once per level", async () => {
    await db.exec(`insert into subjects (name, level) values ('Mathematics', 'junior'), ('Mathematics', 'senior')`);
    await assert.rejects(db.exec(`insert into subjects (name, level) values ('Mathematics', 'junior')`));
    await assert.rejects(db.exec(`insert into subjects (name, level) values ('Robotics', 'university')`));
  });

  test("pathways are for Senior School only", async () => {
    await db.exec(`insert into subjects (name, level, pathway) values ('Physics', 'senior', 'stem')`);
    await assert.rejects(db.exec(`insert into subjects (name, level, pathway) values ('Science', 'junior', 'stem')`));
    await assert.rejects(db.exec(`insert into subjects (name, level, pathway) values ('Chemistry', 'senior', 'medicine')`));
  });

  test("a subject with lessons cannot be deleted (its lessons are never deleted with it)", async () => {
    await assert.rejects(db.exec(`delete from subjects where id = '${ID.SUBJECT}'`));
    const n = await one<{ n: number }>(`select count(*)::int n from lessons where subject_id = '${ID.SUBJECT}'`);
    assert.ok(n!.n > 0);
    await db.exec(`insert into subjects (name, level) values ('Empty subject', 'primary')`);
    await db.exec(`delete from subjects where name = 'Empty subject'`);
  });

  test("hiding a subject keeps its lessons", async () => {
    await db.exec(`update subjects set active = false where id = '${ID.SUBJECT}'`);
    const n = await one<{ n: number }>(`select count(*)::int n from lessons where subject_id = '${ID.SUBJECT}'`);
    assert.ok(n!.n > 0);
    await db.exec(`update subjects set active = true where id = '${ID.SUBJECT}'`);
  });

  test("only admins add, change or remove subjects; everyone signed in can read them and the levels", async () => {
    for (const actor of [{ id: ID.S1 }, { id: ID.T1 }] as const) {
      assert.equal(await rejects(db, actor, `insert into subjects (name, level) values ('Sneaky', 'primary')`), true);
      assert.equal(await rejects(db, actor, `update subjects set name = 'Renamed' where id = '${ID.SUBJECT}'`), true);
      assert.equal(await rejects(db, actor, `update education_levels set name = 'X' where code = 'primary'`), true);
      const seen = await as(db, actor, async () => (await db.query("select 1 from subjects")).rows.length);
      assert.ok(seen > 0);
      const levels = await as(db, actor, async () => (await db.query("select 1 from education_levels")).rows.length);
      assert.equal(levels, 4);
    }
    assert.equal(await rejects(db, "anon", `insert into subjects (name, level) values ('Anon', 'primary')`), true);
    assert.equal(
      await rejects(db, { id: ID.ADMIN }, `insert into subjects (name, level, pathway) values ('Biology', 'senior', 'stem')`),
      false,
    );
    assert.equal(await rejects(db, { id: ID.ADMIN }, `update subjects set active = false where name = 'Biology'`), false);
    assert.equal(await rejects(db, { id: ID.ADMIN }, `delete from subjects where name = 'Biology'`), false);
  });
});

describe("student grade -> level", () => {
  before(async () => {
    db = await createTestDb();
    await seedWorld(db);
  });

  test("grade_code follows the free-text grade on every save and can't be set to something else", async () => {
    await as(db, { id: ID.S1 }, () => db.query(`update student_profiles set grade = 'Grade 11' where profile_id = $1`, [ID.S1]));
    assert.equal((await one<{ c: string }>(`select grade_code c from student_profiles where profile_id = $1`, [ID.S1]))!.c, "G11");
    await as(db, { id: ID.S1 }, () =>
      db.query(`update student_profiles set grade_code = 'PP1' where profile_id = $1`, [ID.S1]),
    );
    assert.equal((await one<{ c: string }>(`select grade_code c from student_profiles where profile_id = $1`, [ID.S1]))!.c, "G11");
  });

  test("a student cannot change another student's grade", async () => {
    assert.equal(await rejects(db, { id: ID.S1 }, `update student_profiles set grade = 'PP1' where profile_id = '${ID.S7}'`), true);
  });

  test("sign-up still works unchanged: the free-text grade it sends gives a grade_code", async () => {
    const id = "bbbbbbbb-0000-4000-8000-0000000000a1";
    await db.exec(
      `insert into auth.users (id, email, raw_user_meta_data) values ('${id}', 'new@test.invalid', '{"role":"student","full_name":"New Learner","grade":"Grade 7"}')`,
    );
    const row = await one<{ grade: string; grade_code: string }>(`select grade, grade_code from student_profiles where profile_id = $1`, [id]);
    assert.deepEqual(row, { grade: "Grade 7", grade_code: "G7" });
  });

  test("the app's parser and level rules match the database's, for every option and common spellings", async () => {
    const samples = [
      ...GRADE_OPTIONS.map((g) => g.label),
      "grade6", "G 7", "Gr.9", "Class 4", "Std 5", "Standard 3", "pp1", "PP 2", "Pre-primary 1", "pre unit 2",
      "10", " Grade 12 ", "Form 2", "Form 4", "Grade 13", "Grade 0", "PP3", "", "Year 5", "grade seven",
    ];
    for (const s of samples) {
      const dbCode = (await one<{ c: string | null }>(`select grade_code_from_text($1) c`, [s]))!.c;
      assert.equal(gradeCodeFromText(s), dbCode, `parse ${JSON.stringify(s)}`);
      const dbLevel = (await one<{ l: string | null }>(`select education_level_for_grade($1) l`, [dbCode]))!.l;
      assert.equal(levelForGrade(dbCode), dbLevel, `level of ${dbCode}`);
    }
    for (const g of GRADE_OPTIONS) assert.equal(gradeCodeFromText(g.label), g.code, "every option reads back as itself");
    assert.deepEqual(
      ["PP1", "PP2", "G1", "G6", "G7", "G9", "G10", "G12", null].map(levelForGrade),
      ["pre_primary", "pre_primary", "primary", "primary", "junior", "junior", "senior", "senior", null],
    );
  });
});

describe("Admin -> Subjects form checks", () => {
  test("accepts a complete subject and tidies spaces", () => {
    const r = parseSubjectInput({ name: "  Integrated   Science ", level: "junior", pathway: "", description: "", color: "blue", order: "4" });
    assert.deepEqual(r, {
      ok: true,
      value: { name: "Integrated Science", level: "junior", pathway: null, description: null, color: "blue", order_index: 4 },
    });
  });

  test("rejects missing names, unknown levels, pathways outside Senior School and bad orders", () => {
    const r = parseSubjectInput({ name: "", level: "college", pathway: "stem", color: "pink", order: "1.5" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(Object.keys(r.errors).sort(), ["color", "level", "name", "order", "pathway"]);
    const p = parseSubjectInput({ name: "Science", level: "junior", pathway: "stem", order: "1" });
    assert.equal(p.ok, false);
    const s = parseSubjectInput({ name: "Physics", level: "senior", pathway: "stem", order: "" });
    assert.equal(s.ok && s.value.pathway, "stem");
  });

  test("database errors become plain messages", () => {
    assert.match(subjectDbErrorMessage({ code: "23505" }), /already exists in that level/);
    assert.match(subjectDbErrorMessage({ code: "23503" }), /has lessons/);
  });
});

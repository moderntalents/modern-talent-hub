// Student registration: Grade/Class and School are asked of students under 18 only (lib/registration.ts).
// The age comes from the full date of birth (lib/age.ts); the signup form and the verify-registration
// route share the same rule. The database side is checked against the real migrations in PGlite: an adult
// student created without a grade or school gets a student profile with both left empty.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers/db";
import { ageInYears, toIsoDate } from "../lib/age";
import { hidesSchoolDetails, schoolDetailsPayload } from "../lib/registration";

// Midday in Nairobi on 16 October 2026, so the Kenyan calendar date is unambiguous.
const NOW = new Date("2026-10-16T09:00:00Z");
const ageOn = (iso: string) => ageInYears(iso, NOW);

describe("age from the full date of birth", () => {
  test("the birthday not yet reached this year counts one year less", () => {
    assert.equal(ageOn("2008-10-17"), 17); // turns 18 tomorrow
    assert.equal(ageOn("2008-11-01"), 17);
  });

  test("on the birthday itself the new age applies", () => {
    assert.equal(ageOn("2008-10-16"), 18);
  });

  test("after the birthday this year", () => {
    assert.equal(ageOn("2008-10-15"), 18);
    assert.equal(ageOn("2008-01-01"), 18);
  });

  test("an incomplete or impossible date gives no age", () => {
    assert.equal(toIsoDate(2008, 2, 30, NOW), null);
    assert.equal(toIsoDate(2027, 1, 1, NOW), null); // in the future
  });
});

describe("which students see Grade/Class and School", () => {
  test("17: visible", () => {
    assert.equal(hidesSchoolDetails("student", ageOn("2009-03-10")), false);
  });

  test("18: hidden", () => {
    assert.equal(hidesSchoolDetails("student", ageOn("2008-03-10")), true);
  });

  test("19 and older: hidden", () => {
    assert.equal(hidesSchoolDetails("student", ageOn("2007-03-10")), true);
    assert.equal(hidesSchoolDetails("student", ageOn("1990-03-10")), true);
  });

  test("birthday boundary: the day before turning 18 visible, on the birthday hidden", () => {
    assert.equal(hidesSchoolDetails("student", ageOn("2008-10-17")), false);
    assert.equal(hidesSchoolDetails("student", ageOn("2008-10-16")), true);
  });

  test("while the date of birth is incomplete the fields stay visible, as before", () => {
    assert.equal(hidesSchoolDetails("student", null), false);
  });

  test("teachers are never affected by this rule", () => {
    for (const age of [null, 17, 18, 40]) assert.equal(hidesSchoolDetails("teacher", age), false);
  });
});

describe("what the form sends", () => {
  test("under 18: grade and school are sent exactly as before", () => {
    assert.deepEqual(schoolDetailsPayload("student", 17, "Grade 11", "Hill School"), {
      grade: "Grade 11",
      schoolName: "Hill School",
    });
  });

  test("changing the date of birth to an adult date: grade and school are left out, even if typed earlier", () => {
    const before = schoolDetailsPayload("student", 17, "Grade 11", "Hill School");
    const after = schoolDetailsPayload("student", 18, "Grade 11", "Hill School");
    assert.ok("grade" in before && "schoolName" in before);
    assert.deepEqual(after, {});
    assert.equal(JSON.stringify({ role: "student", ...after }).includes("Grade 11"), false);
  });

  test("changing the date of birth back to an under-18 date: the fields are sent again", () => {
    assert.deepEqual(schoolDetailsPayload("student", 16, "Grade 10", ""), { grade: "Grade 10", schoolName: "" });
  });

  test("a teacher's request is unchanged: grade and school keys are still sent as before", () => {
    assert.deepEqual(schoolDetailsPayload("teacher", 30, "", ""), { grade: "", schoolName: "" });
  });
});

describe("the signup form and the server use the shared rule", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const page = read("app/signup/page.tsx");
  const route = read("app/api/auth/verify-registration/route.ts");

  test("the form hides the fields, skips the grade check and leaves them out of the request when hidden", () => {
    assert.match(page, /hidesSchoolDetails\(role, age\)/);
    assert.match(page, /role === "student" && !hideSchoolDetails && !grade\.trim\(\)/);
    assert.match(page, /\.\.\.schoolDetailsPayload\(role, age, grade, schoolName\)/);
    assert.match(page, /!hideSchoolDetails && \(/);
  });

  test("the form clears grade and school as soon as a date-of-birth (or role) change hides them", () => {
    assert.match(
      page,
      /if \(!hidesSchoolDetails\(nextRole, dobToAge\(nextDob\)\)\) return;\s*setGrade\(""\);\s*setSchoolName\(""\);/,
    );
    assert.match(page, /onChange=\{changeDob\}/);
    assert.match(page, /clearSchoolDetailsIfHidden\(role, next\)/);
  });

  test("the server works out hiding from the date of birth, requires a grade only when shown, and drops hidden values", () => {
    assert.match(route, /hidesSchoolDetails\(role, ageInYears\(dobIso\)\)/);
    assert.match(route, /role === "student" && !hideSchoolDetails && !grade/);
    assert.match(route, /\.\.\.\(hideSchoolDetails \? \{\} : \{ grade, school_name: schoolName \}\)/);
  });
});

describe("database: an adult student created without grade or school", () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
  });

  test("gets a student profile with grade and school left empty", async () => {
    const id = "00000000-0000-4000-8000-0000000000a1";
    await db.exec(
      `insert into auth.users (id, email, raw_user_meta_data) values ('${id}', 'adult@test.invalid', '{"role":"student","full_name":"Adult Learner","phone":"0712345678"}');`,
    );
    const { rows } = await db.query<{ grade: string | null; school_name: string | null }>(
      "select grade, school_name from student_profiles where profile_id = $1",
      [id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].grade, null);
    assert.equal(rows[0].school_name, null);
  });
});

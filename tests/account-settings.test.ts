// Settings (/account): profile editing, the Age & Guardian summary, and the messaging state that the
// Settings and Messages pages show. The pure rules are tested directly; the database side is tested
// against the real migrations in PGlite, acting as the signed-in user exactly as the Settings server
// action does (its writes go through the user's own session, so row-level security applies).

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, rejects } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import { fakeAdmin } from "./helpers/fake-admin";
import { phoneEditable, validateProfile } from "../lib/profile-edit";
import { ageSummary, formatBirthDate } from "../lib/age-summary";
import { threadReadOnlyReason } from "../lib/messages/rules";
import { messagingLockedLabel } from "../lib/messaging-locked-label";
import { getAccountStatus, getMessagingState } from "../lib/messaging-gate";
import { ageStateFromRecord, consentComplete, gateRedirect } from "../lib/account-setup";
import { messagingForAccount } from "../lib/messaging-permission";

const NOW = new Date("2026-09-26T09:00:00Z");
const SUPPORT = "support@example.test";
const OK = { kind: "ok" } as const;

const base = { fullName: "George", phone: "0712 345 678", grade: "Grade 6", schoolName: "", specialty: "", bio: "" };

describe("profile validation (lib/profile-edit.ts)", () => {
  test("a student's edit becomes one profiles update and one student_profiles update", () => {
    const r = validateProfile("student", "adult", { ...base, fullName: "  George   Otieno ", schoolName: "Hill School" });
    assert.ok(r.ok);
    assert.deepEqual(r.changes, {
      profiles: { full_name: "George Otieno", phone: "0712 345 678" },
      student: { grade: "Grade 6", school_name: "Hill School" },
    });
  });

  test("a teacher's edit touches only name, phone, specialty and bio — never payout, wallet or approval", () => {
    const r = validateProfile("teacher", "adult", { ...base, grade: "ignored", specialty: "Piano", bio: "Line 1\nLine 2" });
    assert.ok(r.ok);
    assert.deepEqual(r.changes, {
      profiles: { full_name: "George", phone: "0712 345 678" },
      teacher: { specialty: "Piano", bio: "Line 1\nLine 2" },
    });
  });

  test("an administrator can edit name and (optional) phone only", () => {
    const r = validateProfile("admin", null, { ...base, phone: "" });
    assert.ok(r.ok);
    assert.deepEqual(r.changes, { profiles: { full_name: "George", phone: null } });
  });

  test("the sign-up rules apply: name required, adults need a phone, students a grade, teachers a subject", () => {
    const r = validateProfile("student", "adult", { ...base, fullName: " ", phone: "", grade: "" });
    assert.equal(r.ok, false);
    assert.deepEqual(Object.keys((r as { errors: object }).errors).sort(), ["fullName", "grade", "phone"]);
    const t = validateProfile("teacher", "adult", { ...base, specialty: "" });
    assert.equal(t.ok, false);
    assert.ok((t as { errors: { specialty?: string } }).errors.specialty);
  });

  test("bad phone numbers and over-long values are refused with a message", () => {
    for (const phone of ["abc", "12", "+254 7123456789012345"]) {
      const r = validateProfile("student", "adult", { ...base, phone });
      assert.equal(r.ok, false, phone);
    }
    assert.equal(validateProfile("student", "adult", { ...base, fullName: "x".repeat(101) }).ok, false);
    assert.equal(validateProfile("teacher", "adult", { ...base, specialty: "Piano", bio: "x".repeat(501) }).ok, false);
  });

  test("13–17: phone optional; under 13: phone is never asked for and never written", () => {
    const teen = validateProfile("student", "teen", { ...base, phone: "" });
    assert.ok(teen.ok);
    assert.equal(teen.changes.profiles.phone, null);

    assert.equal(phoneEditable("child"), false);
    const child = validateProfile("student", "child", { ...base, phone: "0712345678" });
    assert.ok(child.ok);
    assert.equal("phone" in child.changes.profiles, false, "an under-13's phone column is left untouched");
  });
});

describe("profile editing against the real database rules", () => {
  let db: PGlite;
  before(async () => {
    db = await createTestDb();
    await seedWorld(db);
  });
  const one = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows[0];

  test("a student can update their own profile and student details", async () => {
    await as(db, { id: ID.S1 }, async () => {
      await db.query("update profiles set full_name = $1, phone = $2 where id = $3", ["Student One Renamed", "0712345678", ID.S1]);
      await db.query(
        "insert into student_profiles (profile_id, grade, school_name) values ($1, $2, $3) on conflict (profile_id) do update set grade = excluded.grade, school_name = excluded.school_name",
        [ID.S1, "Grade 7", "Hill School"],
      );
    });
    assert.equal((await one("select full_name from profiles where id = $1", [ID.S1])).full_name, "Student One Renamed");
    assert.deepEqual(await one("select grade, school_name from student_profiles where profile_id = $1", [ID.S1]), {
      grade: "Grade 7",
      school_name: "Hill School",
    });
    assert.equal(Number((await one("select count(*) as n from student_profiles where profile_id = $1", [ID.S1])).n), 1, "no duplicate row");
  });

  test("nobody can edit someone else's profile, or change their own role", async () => {
    assert.ok(await rejects(db, { id: ID.S1 }, `update profiles set full_name = 'x' where id = '${ID.S2}'`));
    assert.ok(await rejects(db, { id: ID.S1 }, `update student_profiles set grade = 'x' where profile_id = '${ID.S2}'`));
    assert.ok(await rejects(db, { id: ID.S1 }, `update teacher_profiles set bio = 'x' where profile_id = '${ID.T1}'`));
    assert.ok(await rejects(db, { id: ID.S1 }, `update profiles set role = 'admin' where id = '${ID.S1}'`));
  });

  test("a teacher can update specialty and bio, but still not wallet or approval (0012 guard)", async () => {
    await as(db, { id: ID.T1 }, () => db.query("update teacher_profiles set specialty = 'Piano', bio = 'Hello' where profile_id = $1", [ID.T1]));
    assert.deepEqual(await one("select specialty, bio from teacher_profiles where profile_id = $1", [ID.T1]), { specialty: "Piano", bio: "Hello" });
    assert.ok(await rejects(db, { id: ID.T1 }, `update teacher_profiles set wallet_balance = 999 where profile_id = '${ID.T1}'`));
    assert.ok(await rejects(db, { id: ID.T3 }, `update teacher_profiles set approved = true where profile_id = '${ID.T3}'`));
  });

  test("the date of birth and guardian approval still can't be changed by the person (no bypass)", async () => {
    assert.ok(await rejects(db, { id: ID.S2 }, `update age_records set date_of_birth = '1990-01-01' where profile_id = '${ID.S2}'`));
    assert.ok(await rejects(db, { id: ID.S3 }, `update age_records set consent_status = 'granted' where profile_id = '${ID.S3}'`));
    assert.equal((await one("select consent_status from age_records where profile_id = $1", [ID.S3])).consent_status, "pending");
  });

  test("a person can read their own age record (what Settings now shows) but not anyone else's", async () => {
    const own = await as(db, { id: ID.S2 }, () => db.query("select date_of_birth from age_records where profile_id = $1", [ID.S2]));
    assert.equal(own.rows.length, 1);
    const other = await as(db, { id: ID.S2 }, () => db.query("select 1 from age_records where profile_id = $1", [ID.S1]));
    assert.equal(other.rows.length, 0);
  });
});

describe("Age & Guardian summary (lib/age-summary.ts)", () => {
  test("a fully set-up adult still sees their stored details and a way to correct them", () => {
    const s = ageSummary(OK, { date_of_birth: "1990-03-12", guardian_email: null, consent_status: "not_required" }, SUPPORT, NOW);
    assert.equal(s.status, "Your account is set up.");
    assert.deepEqual(s.rows.map((r) => r.label), ["Date of birth", "Age", "Guardian approval"]);
    assert.equal(s.rows[0].value, "12 March 1990");
    assert.equal(s.rows[1].value, "36");
    assert.ok(s.links.some((l) => l.href.startsWith(`mailto:${SUPPORT}`)));
    assert.ok(s.correctionNote);
    assert.ok(!s.links.some((l) => l.href === "/age-check"), "no self-service age re-entry");
  });

  test("an approved under-18 sees a masked guardian email, and nothing about a separate messaging permission", () => {
    const s = ageSummary(OK, { date_of_birth: "2012-01-01", guardian_email: "parent@example.com", consent_status: "granted" }, SUPPORT, NOW);
    assert.equal(s.status, "Your account is set up.");
    assert.deepEqual(s.rows.find((r) => r.label === "Parent or guardian"), { label: "Parent or guardian", value: "p•••@example.com" });
    assert.ok(!s.rows.some((r) => r.label === "Messaging"));
    assert.ok(!s.links.some((l) => l.href === "/student/messages"));
    assert.ok(!JSON.stringify(s).includes("parent@example.com"), "the full guardian address is never shown");
  });

  test("pending and declined go to the existing consent screen", () => {
    const pending = ageSummary(
      { kind: "pending", guardianEmail: "g@x.test" },
      { date_of_birth: "2012-01-01", guardian_email: "g@x.test", consent_status: "pending" },
      SUPPORT,
      NOW,
    );
    assert.equal(pending.links[0].href, "/consent-pending");
    const declined = ageSummary(
      { kind: "declined" },
      { date_of_birth: "2012-01-01", guardian_email: "g@x.test", consent_status: "declined" },
      SUPPORT,
      NOW,
    );
    assert.equal(declined.links[0].href, "/consent-pending");
  });

  test("no record yet: only the existing age check is offered", () => {
    const s = ageSummary({ kind: "needs_age" }, null, SUPPORT, NOW);
    assert.deepEqual(s.links, [{ href: "/age-check", label: "Finish the age check" }]);
  });

  test("dates are formatted without time-zone drift", () => {
    assert.equal(formatBirthDate("2010-01-01"), "1 January 2010");
    assert.equal(formatBirthDate("2010-12-31"), "31 December 2010");
  });
});

// The production database as verified on 2026-09-30: 0001-0010, 0012 and 0013 applied; 0011
// (messaging) not applied.
const productionLikeDb = () => createTestDb({ include: (f) => f < "0015" && !f.startsWith("0011") });

describe("messaging state shown on Settings/Messages (0011: approved accounts may message)", () => {
  test("with messaging installed: every approved account is allowed, with no separate guardian permission", async () => {
    const db = await createTestDb();
    await seedWorld(db);
    const admin = fakeAdmin(db);
    assert.deepEqual(await getMessagingState(ID.S1, admin), { kind: "allowed" }); // adult
    assert.deepEqual(await getMessagingState(ID.S2, admin), { kind: "allowed" }); // under 18, account approved
    assert.deepEqual(await getMessagingState(ID.T1, admin), { kind: "allowed" }); // teacher
    assert.deepEqual(await getMessagingState(ID.S3, admin), { kind: "not_cleared" }); // guardian approval pending
    assert.deepEqual(await getMessagingState(ID.S4, admin), { kind: "not_cleared" }); // no age record
  });

  test("ROOT CAUSE: without the messaging migration, a set-up student is 'unavailable', not 'finish account setup'", async () => {
    const db = await productionLikeDb();
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${ID.S1}', 's1@test.invalid', '{"role":"student","full_name":"S"}');
      insert into age_records (profile_id, date_of_birth, consent_status) values ('${ID.S1}', '1990-01-01', 'not_required');
    `);
    const state = await getMessagingState(ID.S1, fakeAdmin(db));
    assert.deepEqual(state, { kind: "unavailable" });
    assert.notEqual(messagingLockedLabel(state), "Finish account setup");
  });
});

describe("message box shown or not (threadReadOnlyReason)", () => {
  test("shown exactly when the database says the person may send", () => {
    assert.equal(threadReadOnlyReason("ok", false), null);
  });

  test("each refusal keeps it hidden with its own reason", () => {
    assert.match(threadReadOnlyReason("not_cleared", false)!, /age check/);
    assert.match(threadReadOnlyReason("closed", false)!, /closed/);
  });

  test("a failed check stays hidden (fail closed) but is NOT reported as a closed conversation", () => {
    for (const r of [threadReadOnlyReason(null, true), threadReadOnlyReason("ok", true), threadReadOnlyReason(null, false)]) {
      assert.ok(r);
      assert.doesNotMatch(r!, /closed/);
    }
  });
});

describe("one source of truth for account setup (lib/account-setup.ts)", () => {
  test("setup is complete exactly for adults and approved under-18s", () => {
    assert.equal(consentComplete("not_required"), true);
    assert.equal(consentComplete("granted"), true);
    for (const s of ["pending", "declined", "", null, undefined, "something-else"]) assert.equal(consentComplete(s), false);
  });

  test("each missing step links straight to the page that fixes it", () => {
    assert.equal(gateRedirect(ageStateFromRecord(null)), "/age-check");
    assert.equal(gateRedirect(ageStateFromRecord({ consent_status: "pending", guardian_email: "g@x.test" })), "/consent-pending");
    assert.equal(gateRedirect(ageStateFromRecord({ consent_status: "declined", guardian_email: "g@x.test" })), "/consent-pending");
    assert.equal(gateRedirect(ageStateFromRecord({ consent_status: "granted", guardian_email: "g@x.test" })), null);
    assert.equal(gateRedirect(ageStateFromRecord({ consent_status: "not_required", guardian_email: null })), null);
  });

  test("messaging never says 'finish setup' when setup is complete, and always does when it isn't", () => {
    const ok = { kind: "ok" } as const;
    assert.deepEqual(messagingForAccount(ok, { kind: "not_cleared" }), { kind: "unavailable" });
    assert.deepEqual(messagingForAccount(ok, { kind: "allowed" }), { kind: "allowed" });
    assert.deepEqual(messagingForAccount(ok, { kind: "unavailable" }), { kind: "unavailable" });
    for (const setup of [{ kind: "needs_age" }, { kind: "pending", guardianEmail: "g" }, { kind: "declined" }] as const) {
      assert.deepEqual(messagingForAccount(setup, { kind: "allowed" }), { kind: "not_cleared" });
    }
  });

  test("Settings and Messages get the same answer from getAccountStatus for every seeded student", async () => {
    const db = await createTestDb();
    await seedWorld(db);
    const admin = fakeAdmin(db);
    const session = fakeAdmin(db) as unknown as Parameters<typeof getAccountStatus>[0];

    const s1 = await getAccountStatus(session, ID.S1, admin); // adult
    assert.deepEqual([s1.setup.kind, s1.setupHref, s1.messaging.kind], ["ok", null, "allowed"]);
    const s2 = await getAccountStatus(session, ID.S2, admin); // under 18, account approved
    assert.deepEqual([s2.setup.kind, s2.setupHref, s2.messaging.kind], ["ok", null, "allowed"]);
    const s3 = await getAccountStatus(session, ID.S3, admin); // guardian approval pending
    assert.deepEqual([s3.setup.kind, s3.setupHref, s3.messaging.kind], ["pending", "/consent-pending", "not_cleared"]);
    const s4 = await getAccountStatus(session, ID.S4, admin); // no age record
    assert.deepEqual([s4.setup.kind, s4.setupHref, s4.messaging.kind], ["needs_age", "/age-check", "not_cleared"]);
  });

  test("REPORTED BUG, production state: a set-up student is never told to finish setup", async () => {
    const prod = await productionLikeDb();
    await prod.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${ID.S2}', 's2@test.invalid', '{"role":"student","full_name":"S"}');
      insert into age_records (profile_id, date_of_birth, guardian_email, consent_status) values ('${ID.S2}', '2012-01-01', 'g@test.invalid', 'granted');
    `);
    const session = fakeAdmin(prod) as unknown as Parameters<typeof getAccountStatus>[0];
    const status = await getAccountStatus(session, ID.S2, fakeAdmin(prod));
    assert.deepEqual([status.setup.kind, status.setupHref, status.messaging.kind], ["ok", null, "unavailable"]);
    assert.equal(messagingLockedLabel(status.messaging), "Messaging unavailable");

    // The two checks disagree outright (setup is complete, the messaging check says not cleared).
    const disagreeing = { rpc: async () => ({ data: false, error: null }) } as unknown as ReturnType<typeof fakeAdmin>;
    assert.equal((await getAccountStatus(session, ID.S2, disagreeing)).messaging.kind, "unavailable");
  });
});

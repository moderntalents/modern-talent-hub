// Migration 0014: separate parent/guardian permission for private messaging. Run against a real
// Postgres with the repository's actual migrations applied, so these prove the rules hold in the
// database itself — plus the TypeScript copy of the rule (lib/messaging-permission.ts) agrees with it.

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, readMigration, type Actor } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import { ageInYears, todayInKenya } from "../lib/age";
import { messagingAllowed, messagingState, type MessagingRecord } from "../lib/messaging-permission";
import { coversMessaging, CURRENT_CONSENT_VERSION, GUARDIAN_V1, GUARDIAN_V2 } from "../lib/consent-versions";

let db: PGlite;

const SERVICE: Actor = "service";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

async function scalar<T>(sql: string, params: unknown[] = [], actor: Actor = SERVICE): Promise<T> {
  return as(db, actor, async () => {
    const { rows } = await db.query<{ r: T }>(sql, params);
    return rows[0].r;
  });
}

const cleared = (profile: string, at?: string) =>
  at
    ? scalar<boolean>("select messaging_cleared($1, $2::timestamptz) as r", [profile, at])
    : scalar<boolean>("select messaging_cleared($1) as r", [profile]);

const record = (profile: string) =>
  db
    .query<{ consent_status: string; guardian_messaging_allowed: boolean; guardian_messaging_status: string; guardian_messaging_version: string | null }>(
      "select consent_status, guardian_messaging_allowed, guardian_messaging_status, guardian_messaging_version from age_records where profile_id = $1",
      [profile],
    )
    .then((r) => r.rows[0]);

/** A guardian request row as the server creates it. Returns the raw token (as in the email link). */
async function request(
  profile: string,
  o: { purpose?: "platform" | "messaging"; version?: string; email?: string; expired?: boolean } = {},
): Promise<string> {
  const token = randomBytes(16).toString("hex");
  const email =
    o.email ?? (await db.query<{ e: string }>("select guardian_email as e from age_records where profile_id = $1", [profile])).rows[0].e;
  await db.query(
    `insert into guardian_consent_requests (profile_id, guardian_email, token_hash, expires_at, purpose, consent_version)
     values ($1, $2, $3, now() + ($4 || ' days')::interval, $5, $6)`,
    [profile, email, hash(token), o.expired ? "-1" : "7", o.purpose ?? "platform", o.version ?? GUARDIAN_V2],
  );
  return token;
}

const decidePlatform = (token: string, decision: string, messaging: string | null) =>
  scalar<string>("select decide_guardian_consent_with_messaging($1, $2, $3) as r", [hash(token), decision, messaging]);
const decideMessaging = (token: string, decision: string) =>
  scalar<string>("select decide_guardian_messaging_consent($1, $2) as r", [hash(token), decision]);
const withdraw = (profile: string) => scalar<string>("select withdraw_guardian_messaging_consent($1) as r", [profile]);

const fromLesson = (student: string) =>
  scalar<string>("select start_conversation_from_lesson($1, $2) as r", [student, ID.L1]);
const canSend = (user: string, conv: string) => scalar<string>("select messaging_can_send($1, $2) as r", [user, conv]);
const visible = (actor: Actor) => as(db, actor, async () => (await db.query("select id from conversations")).rows.length);

/** A new under-18 student with an approved account (platform consent granted) and no messaging permission. */
async function newMinor(dob = "2012-06-15"): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{\"role\":\"student\",\"full_name\":\"Minor\"}')",
    [id, `${id}@test.invalid`],
  );
  await db.query(
    "insert into age_records (profile_id, date_of_birth, guardian_email, consent_status) values ($1, $2, $3, 'granted')",
    [id, dob, `g-${id}@test.invalid`],
  );
  return id;
}

/** "YYYY-MM-DD" for someone who turns `years` old exactly on today's Kenyan date (plus `dayOffset`). */
function birthdayFor(years: number, dayOffset = 0): string {
  const t = todayInKenya();
  const d = new Date(Date.UTC(t.y - years, t.m - 1, t.d + dayOffset));
  return d.toISOString().slice(0, 10);
}

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
});

beforeEach(async () => {
  await db.exec("delete from conversations; delete from guardian_consent_requests;");
});

describe("existing data when 0014 is applied", () => {
  test("existing rows start with messaging permission OFF, and old requests are recorded as v1 platform requests", async () => {
    const old = await createTestDb({ upTo: "0011_messaging.sql" });
    const minor = crypto.randomUUID();
    const adult = crypto.randomUUID();
    await old.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${minor}', 'm@test.invalid', '{"role":"student","full_name":"Minor"}'),
        ('${adult}', 'a@test.invalid', '{"role":"student","full_name":"Adult"}');
      insert into age_records (profile_id, date_of_birth, guardian_email, consent_status) values
        ('${minor}', '2012-01-01', 'g@test.invalid', 'granted'),
        ('${adult}', '1990-01-01', null, 'not_required');
      insert into guardian_consent_requests (profile_id, guardian_email, token_hash, expires_at, decided_at, decision)
        values ('${minor}', 'g@test.invalid', 'old-hash', now() + interval '1 day', now(), 'approved');
    `);

    await old.exec(readMigration("0014_messaging_guardian_consent.sql"));

    const rows = (await old.query<{ id: string; allowed: boolean; status: string; version: string | null; consent: string }>(
      "select profile_id as id, guardian_messaging_allowed as allowed, guardian_messaging_status as status, guardian_messaging_version as version, consent_status as consent from age_records order by date_of_birth",
    )).rows;
    for (const r of rows) {
      assert.equal(r.allowed, false);
      assert.equal(r.status, "not_requested");
      assert.equal(r.version, null);
    }
    assert.deepEqual(rows.map((r) => r.consent), ["not_required", "granted"], "platform consent is untouched");

    const req = (await old.query<{ purpose: string; consent_version: string; messaging_decision: string | null }>(
      "select purpose, consent_version, messaging_decision from guardian_consent_requests",
    )).rows[0];
    assert.deepEqual(req, { purpose: "platform", consent_version: "guardian-v1", messaging_decision: null });

    const gate = async (p: string) => (await old.query<{ r: boolean }>("select messaging_cleared($1) as r", [p])).rows[0].r;
    assert.equal(await gate(minor), false, "an existing approved under-18 starts with messaging disabled");
    assert.equal(await gate(adult), true, "adults are unaffected");
  });

  test("the wording versions are recorded: v1 does not cover messaging, v2 does", async () => {
    const { rows } = await db.query<{ version: string; covers_messaging: boolean }>(
      "select version, covers_messaging from guardian_consent_versions order by version",
    );
    assert.deepEqual(rows, [
      { version: "guardian-v1", covers_messaging: false },
      { version: "guardian-v2", covers_messaging: true },
    ]);
    // …and the TypeScript list says the same.
    for (const r of rows) assert.equal(coversMessaging(r.version), r.covers_messaging);
    assert.equal(CURRENT_CONSENT_VERSION, GUARDIAN_V2);
  });
});

describe("v1 approvals can never grant messaging", () => {
  test("approving a v1 platform request with 'allow messaging' approves the account but leaves messaging off", async () => {
    const minor = await newMinor();
    await db.query("update age_records set consent_status = 'pending' where profile_id = $1", [minor]);
    const token = await request(minor, { version: GUARDIAN_V1 });

    assert.equal(await decidePlatform(token, "approved", "approved"), "approved");
    const r = await record(minor);
    assert.equal(r.consent_status, "granted");
    assert.equal(r.guardian_messaging_allowed, false);
    assert.equal(r.guardian_messaging_status, "not_requested");
    assert.equal(await cleared(minor), false);
    const req = (await db.query<{ m: string | null }>("select messaging_decision as m from guardian_consent_requests")).rows[0];
    assert.equal(req.m, null);
  });

  test("a messaging-only request carrying v1 wording is refused", async () => {
    const minor = await newMinor();
    const token = await request(minor, { purpose: "messaging", version: GUARDIAN_V1 });
    assert.equal(await decideMessaging(token, "approved"), "invalid");
    assert.equal((await record(minor)).guardian_messaging_allowed, false);
  });

  test("the database refuses messaging permission recorded against v1 wording, even from the server", async () => {
    const minor = await newMinor();
    await assert.rejects(
      db.query(
        "update age_records set guardian_messaging_allowed = true, guardian_messaging_status = 'granted', guardian_messaging_version = 'guardian-v1' where profile_id = $1",
        [minor],
      ),
      /covers messaging/,
    );
    await assert.rejects(
      db.query(
        "update age_records set guardian_messaging_allowed = true, guardian_messaging_status = 'granted', guardian_messaging_version = null where profile_id = $1",
        [minor],
      ),
      /covers messaging/,
    );
    const token = await request(minor, { version: GUARDIAN_V1 });
    await assert.rejects(
      db.query("update guardian_consent_requests set messaging_decision = 'approved', messaging_decided_at = now() where token_hash = $1", [hash(token)]),
      /covers messaging/,
    );
    // The flag and the status can never disagree.
    await assert.rejects(
      db.query("update age_records set guardian_messaging_status = 'granted' where profile_id = $1", [minor]),
      /age_records_messaging_consistent/,
    );
  });
});

describe("v2 guardian decisions", () => {
  test("approving the account with 'allow messaging' on v2 wording switches messaging on", async () => {
    const minor = await newMinor();
    await db.query("update age_records set consent_status = 'pending' where profile_id = $1", [minor]);
    const token = await request(minor);
    assert.equal(await decidePlatform(token, "approved", "approved"), "approved");
    const r = await record(minor);
    assert.deepEqual(r, { consent_status: "granted", guardian_messaging_allowed: true, guardian_messaging_status: "granted", guardian_messaging_version: "guardian-v2" });
    assert.equal(await cleared(minor), true);
  });

  test("approving the account but not messaging leaves messaging off; declining the account ignores the messaging choice", async () => {
    const a = await newMinor();
    await db.query("update age_records set consent_status = 'pending' where profile_id = $1", [a]);
    assert.equal(await decidePlatform(await request(a), "approved", "declined"), "approved");
    assert.deepEqual(await record(a), { consent_status: "granted", guardian_messaging_allowed: false, guardian_messaging_status: "declined", guardian_messaging_version: "guardian-v2" });

    const b = await newMinor();
    await db.query("update age_records set consent_status = 'pending' where profile_id = $1", [b]);
    assert.equal(await decidePlatform(await request(b), "declined", "approved"), "declined");
    const rb = await record(b);
    assert.equal(rb.consent_status, "declined");
    assert.equal(rb.guardian_messaging_allowed, false);
  });

  test("a messaging token cannot be used on the platform page, and a platform token cannot be used for messaging", async () => {
    const minor = await newMinor();
    const messagingToken = await request(minor, { purpose: "messaging" });
    assert.equal(await decidePlatform(messagingToken, "approved", "approved"), "invalid");

    await db.query("update age_records set consent_status = 'pending' where profile_id = $1", [minor]);
    const platformToken = await request(minor);
    assert.equal(await decideMessaging(platformToken, "approved"), "invalid");
    assert.equal((await record(minor)).consent_status, "pending");
  });

  test("messaging requests: single use, expire, only for an approved account and the guardian on record", async () => {
    const minor = await newMinor();
    const t = await request(minor, { purpose: "messaging" });
    assert.equal(await decideMessaging(t, "approved"), "approved");
    assert.equal(await decideMessaging(t, "declined"), "used");
    assert.equal(await cleared(minor), true);

    assert.equal(await decideMessaging(await request(minor, { purpose: "messaging", expired: true }), "approved"), "expired");
    assert.equal(await decideMessaging(await request(minor, { purpose: "messaging", email: "someone-else@test.invalid" }), "approved"), "invalid");
    assert.equal(await decideMessaging(await request(minor, { purpose: "messaging" }), "maybe"), "invalid");
    assert.equal(await decideMessaging("not-a-real-token", "approved"), "invalid");

    const pending = await newMinor();
    await db.query("update age_records set consent_status = 'pending' where profile_id = $1", [pending]);
    assert.equal(await decideMessaging(await request(pending, { purpose: "messaging" }), "approved"), "invalid");
  });
});

describe("declining or withdrawing messaging", () => {
  test("a messaging decline leaves platform consent unchanged and never deletes the account", async () => {
    const t = await request(ID.S8, { purpose: "messaging" });
    assert.equal(await decideMessaging(t, "declined"), "declined");
    const r = await record(ID.S8);
    assert.equal(r.consent_status, "granted", "platform consent unchanged");
    assert.equal(r.guardian_messaging_status, "declined");
    assert.equal(await scalar<boolean>("select age_cleared($1) as r", [ID.S8]), true, "the account is still usable");
    assert.equal((await db.query("select 1 from profiles where id = $1", [ID.S8])).rows.length, 1, "the account still exists");
    assert.equal((await db.query("select 1 from auth.users where id = $1", [ID.S8])).rows.length, 1);
    await assert.rejects(fromLesson(ID.S8), /messaging:not_permitted/);
    await db.query("update age_records set guardian_messaging_status = 'not_requested' where profile_id = $1", [ID.S8]);
  });

  test("withdrawal hides the conversation from BOTH people at once, blocks sending, and changes nothing else", async () => {
    const c = await fromLesson(ID.S2); // S2 ↔ T1
    await scalar("select send_message($1, $2, 'hello', 'message', null, null, null) as r", [ID.S2, c]);
    assert.equal(await visible({ id: ID.S2 }), 1);
    assert.equal(await visible({ id: ID.T1 }), 1);

    const pendingRequest = await request(ID.S2, { purpose: "messaging" });
    try {
      assert.equal(await withdraw(ID.S2), "withdrawn");
      assert.equal(await visible({ id: ID.S2 }), 0, "the student can no longer see the conversation");
      assert.equal(await visible({ id: ID.T1 }), 0, "nor can the teacher");
      assert.equal(await as(db, { id: ID.T1 }, async () => (await db.query("select 1 from messages")).rows.length), 0);
      assert.equal(await canSend(ID.S2, c), "not_permitted");
      assert.equal(await canSend(ID.T1, c), "not_permitted");
      await assert.rejects(fromLesson(ID.S2), /messaging:not_permitted/);

      const r = await record(ID.S2);
      assert.equal(r.consent_status, "granted", "platform consent unchanged");
      assert.equal(r.guardian_messaging_status, "withdrawn");
      assert.equal((await db.query("select 1 from conversations where id = $1", [c])).rows.length, 1, "hidden, not deleted");
      assert.equal(await decideMessaging(pendingRequest, "approved"), "expired", "a waiting request is cancelled too");
    } finally {
      await db.query(
        "update age_records set guardian_messaging_allowed = true, guardian_messaging_status = 'granted', guardian_messaging_version = 'guardian-v2' where profile_id = $1",
        [ID.S2],
      );
    }
    assert.equal(await visible({ id: ID.S2 }), 1, "a new permission brings the thread back");
    assert.equal(await withdraw(crypto.randomUUID()), "no_record");
  });
});

describe("turning 18 (worked out on the day — no birthday job)", () => {
  test("turning 18 unlocks messaging after a guardian DECLINE", async () => {
    const student = await newMinor(birthdayFor(18, 1)); // 18 tomorrow
    assert.equal(await decideMessaging(await request(student, { purpose: "messaging" }), "declined"), "declined");
    assert.equal(await cleared(student), false, "still 17 today");
    await assert.rejects(fromLesson(student), /messaging:not_permitted/);

    await db.query("update age_records set date_of_birth = $2 where profile_id = $1", [student, birthdayFor(18)]); // 18 today
    assert.equal(await cleared(student), true);
    const c = await fromLesson(student);
    assert.equal(await canSend(student, c), "ok");
    assert.equal(await visible({ id: student }), 1);
    assert.equal((await record(student)).guardian_messaging_status, "declined", "the old answer is kept; it simply no longer applies");
  });

  test("turning 18 unlocks messaging after a guardian WITHDRAWAL", async () => {
    const student = await newMinor(birthdayFor(18, 1));
    assert.equal(await decideMessaging(await request(student, { purpose: "messaging" }), "approved"), "approved");
    const c = await fromLesson(student);
    await withdraw(student);
    assert.equal(await visible({ id: student }), 0);

    await db.query("update age_records set date_of_birth = $2 where profile_id = $1", [student, birthdayFor(18)]);
    assert.equal(await visible({ id: student }), 1, "the thread is back on the 18th birthday");
    assert.equal(await visible({ id: ID.T1 }), 1);
    assert.equal(await canSend(student, c), "ok");
  });

  test("18 or over does NOT override a missing or declined PLATFORM consent", async () => {
    const student = await newMinor(birthdayFor(19));
    for (const status of ["pending", "declined"]) {
      await db.query("update age_records set consent_status = $2 where profile_id = $1", [student, status]);
      assert.equal(await cleared(student), false, `platform consent ${status}`);
    }
    assert.equal(await cleared(ID.S4), false, "no age record at all");
  });

  test("29 February birthdays: 18 on 1 March in a non-leap year, on 29 February in a leap year", async () => {
    const age = (dob: string, at: string) => scalar<number>("select age_in_years_kenya($1::date, $2::timestamptz) as r", [dob, at]);
    // Born 29 Feb 2008. 2026 is not a leap year.
    assert.equal(await age("2008-02-29", "2026-02-28T12:00:00+03:00"), 17);
    assert.equal(await age("2008-02-29", "2026-03-01T00:00:00+03:00"), 18);
    // Born 29 Feb 2012; 2030 is not a leap year, 2032 is.
    assert.equal(await age("2012-02-29", "2030-02-28T23:59:59+03:00"), 17);
    assert.equal(await age("2012-02-29", "2030-03-01T00:00:00+03:00"), 18);
    assert.equal(await age("2012-02-29", "2032-02-28T23:59:59+03:00"), 19);
    assert.equal(await age("2012-02-29", "2032-02-29T00:00:00+03:00"), 20);

    const student = await newMinor("2008-02-29");
    assert.equal(await cleared(student, "2026-02-28T12:00:00+03:00"), false);
    assert.equal(await cleared(student, "2026-03-01T00:00:00+03:00"), true);
  });

  test("Nairobi midnight, not UTC midnight, is when the birthday starts", async () => {
    const age = (dob: string, at: string) => scalar<number>("select age_in_years_kenya($1::date, $2::timestamptz) as r", [dob, at]);
    // Nairobi is UTC+3: 24 Sept begins in Nairobi at 21:00 UTC on 23 Sept.
    assert.equal(await age("2008-09-24", "2026-09-23T20:59:59Z"), 17);
    assert.equal(await age("2008-09-24", "2026-09-23T21:00:00Z"), 18, "already the birthday in Nairobi, still the 23rd in UTC");
    assert.equal(await age("2008-09-24", "2026-09-24T20:59:59Z"), 18);

    const student = await newMinor("2008-09-24");
    assert.equal(await cleared(student, "2026-09-23T20:59:59Z"), false);
    assert.equal(await cleared(student, "2026-09-23T21:00:00Z"), true);
  });
});

describe("SQL and TypeScript apply the same rule", () => {
  const moments = [
    "2026-02-28T20:59:59Z", "2026-02-28T21:00:00Z", "2026-03-01T09:00:00Z",
    "2026-09-23T20:59:59Z", "2026-09-23T21:00:00Z", "2026-12-31T20:59:59Z", "2026-12-31T21:00:00Z",
    "2028-02-28T21:00:00Z", "2028-02-29T21:00:00Z",
  ];
  const births = [
    "2008-02-29", "2008-02-28", "2008-03-01", "2008-09-23", "2008-09-24", "2008-09-25",
    "2009-01-01", "2008-12-31", "2009-01-01", "2010-02-28", "2004-02-29", "1990-06-15",
  ];

  test("age_in_years_kenya() matches lib/age.ts ageInYears() on awkward dates and times", async () => {
    for (const at of moments) {
      for (const dob of births) {
        const sql = await scalar<number>("select age_in_years_kenya($1::date, $2::timestamptz) as r", [dob, at]);
        assert.equal(sql, ageInYears(dob, new Date(at)), `dob ${dob} at ${at}`);
      }
    }
  });

  test("messaging_cleared() matches lib/messaging-permission.ts for every combination", async () => {
    const student = await newMinor();
    const statuses = ["not_requested", "granted", "declined", "withdrawn"] as const;
    const consents = ["not_required", "pending", "granted", "declined"] as const;
    for (const dob of ["2008-09-24", "2008-02-29", "2012-01-01", "1990-01-01"]) {
      for (const consent of consents) {
        for (const status of statuses) {
          const allowed = status === "granted";
          await db.query(
            `update age_records set date_of_birth = $2, consent_status = $3, guardian_email = 'g@test.invalid',
               guardian_messaging_allowed = $4, guardian_messaging_status = $5, guardian_messaging_version = $6
             where profile_id = $1`,
            [student, dob, consent, allowed, status, allowed ? GUARDIAN_V2 : null],
          );
          const rec: MessagingRecord = {
            consent_status: consent,
            date_of_birth: dob,
            guardian_messaging_allowed: allowed,
            guardian_messaging_status: status,
            guardian_messaging_version: allowed ? GUARDIAN_V2 : null,
          };
          for (const at of ["2026-09-23T20:59:59Z", "2026-09-23T21:00:00Z", "2026-02-28T21:00:00Z"]) {
            assert.equal(await cleared(student, at), messagingAllowed(rec, new Date(at)), `${dob} ${consent} ${status} ${at}`);
          }
        }
      }
    }
    assert.deepEqual(messagingState(null), { kind: "not_cleared" });
  });
});

describe("the new functions and table are server-only", () => {
  test("browsers (anon and signed-in) cannot call the new functions or read the versions table", async () => {
    const calls = [
      "select age_in_years_kenya('2010-01-01'::date)",
      `select messaging_cleared('${ID.S2}')`,
      "select decide_guardian_consent_with_messaging('x', 'approved', 'approved')",
      "select decide_guardian_messaging_consent('x', 'approved')",
      `select withdraw_guardian_messaging_consent('${ID.S2}')`,
      "select * from guardian_consent_versions",
    ];
    for (const actor of ["anon", { id: ID.S2 }, { id: ID.T1 }, { id: ID.ADMIN }] as Actor[]) {
      for (const sql of calls) {
        await assert.rejects(as(db, actor, () => db.query(sql)), /permission denied/, `${JSON.stringify(actor)}: ${sql}`);
      }
    }
    // A student can still read their own age record (0010), including the new fields, but not write it.
    const own = await as(db, { id: ID.S8 }, async () => (await db.query("select guardian_messaging_allowed from age_records")).rows);
    assert.equal(own.length, 1);
    // Row-level security may raise or may silently match nothing; either way nothing may change.
    await as(db, { id: ID.S8 }, () =>
      db.query("update age_records set guardian_messaging_allowed = true, guardian_messaging_status = 'granted', guardian_messaging_version = 'guardian-v2'"),
    ).catch(() => undefined);
    assert.equal((await record(ID.S8)).guardian_messaging_allowed, false);
  });
});

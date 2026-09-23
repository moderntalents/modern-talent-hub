// Tests for migration 0012 (lock down teacher_profiles), run against a real Postgres that has the
// repository's ACTUAL migrations applied.
//
// Part 1 proves the holes are real on the schema as it was before the fix (so the tests can't pass by
// accident). Part 2 is the 26 checks after the fix: the attacks must fail, and every legitimate flow must
// still work. Part 3 proves the migration changes nothing outside teacher_profiles and can be re-run.

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, readMigration, type Actor } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";

const MESSAGING_PRESENT = existsSync("supabase/migrations/0011_messaging.sql");
const NEW_ID = "aaaaaaaa-0000-4000-8000-0000000000ff";

type Outcome = { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string };

function attemptOn(db: PGlite) {
  return async (actor: Actor, sql: string, params: unknown[] = []): Promise<Outcome> => {
    try {
      const r = await as(db, actor, () => db.query<Record<string, unknown>>(sql, params));
      return { ok: true, rows: r.rows };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };
}
const nothing = (o: Outcome) => !o.ok || o.rows.length === 0; // blocked outright, or row-level security hid every row
const raised = (o: Outcome, pattern: RegExp) => !o.ok && pattern.test(o.error);

async function seed(db: PGlite) {
  await seedWorld(db);
  await db.exec(`update teacher_profiles set wallet_balance = 5000, mpesa_number = '0711222333', bank_account = 'ACC-9999' where profile_id = '${ID.T1}';`);
}

// ------------------------------------------------------------------------------------------------
// Part 1 — the holes exist before the fix
// ------------------------------------------------------------------------------------------------

describe("BEFORE 0012 (migrations 0001–0010): the holes are real", () => {
  let db: PGlite;
  let attempt: ReturnType<typeof attemptOn>;
  before(async () => {
    db = await createTestDb({ include: (f) => f < "0011" });
    attempt = attemptOn(db);
    await seed(db);
  });

  test("an anonymous visitor can read every teacher's wallet, M-Pesa number and bank account", async () => {
    const r = await attempt("anon", "select wallet_balance, mpesa_number, bank_account from teacher_profiles where profile_id = $1", [ID.T1]);
    assert.ok(r.ok && r.rows.length === 1 && r.rows[0].mpesa_number === "0711222333" && r.rows[0].bank_account === "ACC-9999");
  });

  test("a teacher can approve themselves and forge a wallet balance from a browser", async () => {
    const r = await attempt({ id: ID.T3 }, "update teacher_profiles set approved = true, wallet_balance = 999999 where profile_id = $1 returning approved, wallet_balance::int as wallet", [ID.T3]);
    assert.ok(r.ok && r.rows[0].approved === true && r.rows[0].wallet === 999999);
    const w = await attempt({ id: ID.T3 }, "insert into withdrawal_requests (teacher_id, amount, destination) values ($1, 900000, '0700000000') returning status", [ID.T3]);
    assert.ok(w.ok, "…and the forged balance lets them request a payout they never earned");
  });

  test("a teacher can delete their own row and re-insert it pre-approved with any balance", async () => {
    const del = await attempt({ id: ID.T4 }, "delete from teacher_profiles where profile_id = $1 returning 1", [ID.T4]);
    assert.ok(del.ok && del.rows.length === 1);
    const ins = await attempt({ id: ID.T4 }, "insert into teacher_profiles (profile_id, approved, wallet_balance) values ($1, true, 777) returning wallet_balance::int as wallet", [ID.T4]);
    assert.ok(ins.ok && ins.rows[0].wallet === 777);
  });
});

// ------------------------------------------------------------------------------------------------
// Part 2 — the 26 checks after the fix
// ------------------------------------------------------------------------------------------------

describe("AFTER 0012: attacks fail, legitimate flows keep working", () => {
  let db: PGlite;
  let attempt: ReturnType<typeof attemptOn>;
  const balance = async (id: string) => Number((await db.query<{ w: string }>("select wallet_balance::text as w from teacher_profiles where profile_id = $1", [id])).rows[0].w);

  before(async () => {
    db = await createTestDb();
    attempt = attemptOn(db);
    await seed(db);
  });

  // A known starting point for every test (superuser SQL is not restricted by the guard, as in the SQL Editor).
  beforeEach(async () => {
    // (0013 made the wallet ledger append-only, so payments are cleared in replica mode, which skips those triggers.)
    await db.exec(`
      set session_replication_role = replica;
      delete from mpesa_callbacks; delete from wallet_ledger; delete from withdrawal_requests; delete from payment_transactions;
      delete from subscriptions where student_id = '${ID.S7}';
      update platform_wallet set balance = 0;
      reset session_replication_role;
      update teacher_profiles set wallet_balance = case profile_id when '${ID.T1}' then 5000 else 0 end,
        approved = profile_id in ('${ID.T1}', '${ID.T2}', '${ID.T4}'), bio = null, specialty = null, activated = false, activated_at = null;
    `);
  });

  describe("attacks (1–11)", () => {
    test("1. an anonymous visitor can't read teacher wallet / M-Pesa / bank details", async () => {
      assert.ok(nothing(await attempt("anon", "select wallet_balance, mpesa_number, bank_account from teacher_profiles")));
    });
    test("2. a signed-in student can't read them", async () => {
      assert.ok(nothing(await attempt({ id: ID.S1 }, "select wallet_balance, mpesa_number, bank_account from teacher_profiles")));
    });
    test("3. another teacher can't read a teacher's row", async () => {
      assert.ok(nothing(await attempt({ id: ID.T2 }, "select wallet_balance from teacher_profiles where profile_id = $1", [ID.T1])));
    });
    test("4. a teacher can't approve themselves", async () => {
      assert.ok(raised(await attempt({ id: ID.T3 }, "update teacher_profiles set approved = true where profile_id = $1 returning approved", [ID.T3]), /administrator/));
      assert.equal((await db.query("select 1 from teacher_profiles where profile_id = $1 and approved", [ID.T3])).rows.length, 0);
    });
    test("5. a teacher can't forge their wallet balance", async () => {
      assert.ok(raised(await attempt({ id: ID.T1 }, "update teacher_profiles set wallet_balance = 999999 where profile_id = $1", [ID.T1]), /payment system/));
      assert.equal(await balance(ID.T1), 5000);
    });
    test("6. …nor both at once", async () => {
      assert.equal((await attempt({ id: ID.T1 }, "update teacher_profiles set approved = true, wallet_balance = 999999 where profile_id = $1", [ID.T1])).ok, false);
      assert.equal(await balance(ID.T1), 5000);
    });
    test("7. a teacher can't reassign their record to someone else", async () => {
      assert.equal((await attempt({ id: ID.T1 }, "update teacher_profiles set profile_id = $2 where profile_id = $1", [ID.T1, ID.T2])).ok, false);
    });
    test("8. a teacher can't delete their own row (to re-insert it approved)", async () => {
      assert.equal((await attempt({ id: ID.T1 }, "delete from teacher_profiles where profile_id = $1", [ID.T1])).ok, false);
      assert.equal((await db.query("select 1 from teacher_profiles where profile_id = $1", [ID.T1])).rows.length, 1);
    });
    test("9. nobody can insert a teacher row from a browser", async () => {
      for (const actor of [{ id: ID.S7 }, { id: ID.T4 }, { id: ID.ADMIN }, "anon"] as Actor[]) {
        assert.equal((await attempt(actor, "insert into teacher_profiles (profile_id, approved, wallet_balance) values ($1, true, 999999)", [ID.S7])).ok, false);
      }
    });
    test("10. a student can't edit a teacher row", async () => {
      assert.ok(nothing(await attempt({ id: ID.S1 }, "update teacher_profiles set wallet_balance = 0 where profile_id = $1 returning 1", [ID.T1])));
      assert.equal(await balance(ID.T1), 5000);
    });
    test("11. an anonymous visitor can't update", async () => {
      assert.ok(nothing(await attempt("anon", "update teacher_profiles set approved = true returning 1")));
    });
  });

  describe("legitimate flows (12–26)", () => {
    test("12. a teacher reads their OWN row (dashboard / wallet page)", async () => {
      const r = await attempt({ id: ID.T1 }, "select wallet_balance::int as w, mpesa_number, approved, activated from teacher_profiles where profile_id = $1", [ID.T1]);
      assert.ok(r.ok && r.rows.length === 1 && r.rows[0].w === 5000 && r.rows[0].mpesa_number === "0711222333" && r.rows[0].approved === true);
    });
    test("13. a teacher can still edit their own bio, specialty and payout number", async () => {
      const r = await attempt({ id: ID.T1 }, "update teacher_profiles set bio = 'Maths teacher', specialty = 'Maths', mpesa_number = '0799000111' where profile_id = $1 returning bio", [ID.T1]);
      assert.ok(r.ok && r.rows.length === 1);
    });
    test("14. an ADMIN can approve a teacher from their signed-in session (Admin → Teachers)", async () => {
      const r = await attempt({ id: ID.ADMIN }, "update teacher_profiles set approved = true where profile_id = $1 returning approved", [ID.T3]);
      assert.ok(r.ok && r.rows.length === 1 && r.rows[0].approved === true);
    });
    test("15. …and revoke approval", async () => {
      const r = await attempt({ id: ID.ADMIN }, "update teacher_profiles set approved = false where profile_id = $1 returning approved", [ID.T2]);
      assert.ok(r.ok && r.rows.length === 1 && r.rows[0].approved === false);
    });
    test("16. an admin can read every teacher row (the Admin → Teachers page)", async () => {
      const r = await attempt({ id: ID.ADMIN }, "select count(*)::int as n from teacher_profiles");
      assert.ok(r.ok && r.rows[0].n === 4);
    });
    test("17. even an admin session can't edit a wallet balance (only the payment system can)", async () => {
      assert.equal((await attempt({ id: ID.ADMIN }, "update teacher_profiles set wallet_balance = 1 where profile_id = $1", [ID.T1])).ok, false);
      assert.equal(await balance(ID.T1), 5000);
    });
    test("18. the server (service role) can activate a coach", async () => {
      const r = await attempt("service", "update teacher_profiles set activated = true, activated_at = now() where profile_id = $1 returning activated", [ID.T1]);
      assert.ok(r.ok && r.rows.length === 1 && r.rows[0].activated === true);
    });
    test("19. payment completion (service role) still credits the teacher's wallet by 70%", async () => {
      await db.exec(`
        insert into subscriptions (student_id, activity_id, teacher_id, status) values ('${ID.S7}', '${ID.A1}', '${ID.T2}', 'pending_payment');
        insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status)
          select id, student_id, teacher_id, 1000, 'pending' from subscriptions where student_id = '${ID.S7}';`);
      // (0013: completing a payment now needs the verified fields — result 0, how it was confirmed, receipt, callback amount.)
      const r = await attempt("service", "update payment_transactions set status = 'completed', result_code = 0, confirmed_via = 'callback', provider_reference = 'RCPT19', callback_amount = 1000 where teacher_id = $1 returning teacher_share::int as share", [ID.T2]);
      assert.ok(r.ok && r.rows[0].share === 700);
      assert.equal(await balance(ID.T2), 700);
    });
    // method 'bank' explicitly: the coach-b2c-withdrawal branch (0016) gives 'mpesa'
    // withdrawals a new atomic-reservation-at-insert behavior (its own dedicated tests
    // cover that); 'bank' is the Phase 1 path 0016 deliberately leaves untouched, so
    // these three keep validating exactly the original, unchanged mechanic.
    test("20. a teacher can still REQUEST a withdrawal up to their real balance", async () => {
      const r = await attempt({ id: ID.T1 }, "insert into withdrawal_requests (teacher_id, amount, method, destination) values ($1, 1000, 'bank', '0711222333') returning status", [ID.T1]);
      assert.ok(r.ok && r.rows[0].status === "pending");
    });
    test("21. …but not more than it (the original forged-balance attack is stopped)", async () => {
      assert.ok(raised(await attempt({ id: ID.T1 }, "insert into withdrawal_requests (teacher_id, amount, method, destination) values ($1, 900000, 'bank', '0711222333')", [ID.T1]), /exceeds/));
    });
    test("22. processing a payout (service role) still debits the wallet", async () => {
      await db.query("insert into withdrawal_requests (teacher_id, amount, method, destination) values ($1, 1000, 'bank', '0711222333')", [ID.T1]);
      const r = await attempt("service", "update withdrawal_requests set status = 'successful', provider_reference = 'X' where teacher_id = $1 returning status", [ID.T1]);
      assert.ok(r.ok && r.rows.length === 1);
      assert.equal(await balance(ID.T1), 4000);
    });
    test("23. a new teacher signup still creates an unapproved, zero-balance row", async () => {
      await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, 'new@t.invalid', '{\"role\":\"teacher\",\"full_name\":\"New Teacher\"}')", [NEW_ID]);
      try {
        const r = await db.query<{ approved: boolean; w: string }>("select approved, wallet_balance::text as w from teacher_profiles where profile_id = $1", [NEW_ID]);
        assert.deepEqual([r.rows.length, r.rows[0]?.approved, Number(r.rows[0]?.w)], [1, false, 0]);
      } finally {
        await db.query("delete from auth.users where id = $1", [NEW_ID]);
      }
    });
    test("24. deleting the login still removes the teacher row (account deletion, normal path)", async () => {
      await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, 'gone@t.invalid', '{\"role\":\"teacher\",\"full_name\":\"Gone\"}')", [NEW_ID]);
      await db.query("delete from auth.users where id = $1", [NEW_ID]);
      assert.equal((await db.query("select 1 from teacher_profiles where profile_id = $1", [NEW_ID])).rows.length, 0);
    });
    test("25. the account-deletion 'scrub' update (payment records kept) still works", async () => {
      const r = await attempt("service", "update teacher_profiles set bio = null, specialty = null, mpesa_number = null, bank_name = null, bank_account = null, approved = false where profile_id = $1 returning approved", [ID.T1]);
      assert.ok(r.ok && r.rows.length === 1 && r.rows[0].approved === false);
    });
    test("26. messaging (migration 0011) still sees teacher approval correctly", { skip: MESSAGING_PRESENT ? false : "migration 0011 is not on this branch; verified in the combined run" }, async () => {
      const yes = await db.query<{ ok: boolean }>("select messaging_relationship($1, $2) as ok", [ID.S1, ID.T2]);
      assert.equal(yes.rows[0].ok, true);
      await db.query("update teacher_profiles set approved = false where profile_id = $1", [ID.T2]);
      const no = await db.query<{ ok: boolean }>("select messaging_relationship($1, $2) as ok", [ID.S1, ID.T2]);
      assert.equal(no.rows[0].ok, false);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Part 3 — scope and re-runnability
// ------------------------------------------------------------------------------------------------

async function snapshot(db: PGlite) {
  const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows.map((r) => JSON.stringify(r));
  const other = "<> 'teacher_profiles'";
  return {
    tables: await q(`select table_schema, table_name from information_schema.tables where table_schema in ('public','storage') order by 1,2`),
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ('public','storage') order by 1,2`),
    constraints: await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace order by 1,2`),
    policiesElsewhere: await q(`select schemaname, tablename, policyname, cmd, roles, qual, with_check from pg_policies where tablename ${other} order by 1,2,3`),
    triggersElsewhere: await q(`select event_object_table, trigger_name, event_manipulation, action_statement from information_schema.triggers where trigger_schema = 'public' and event_object_table ${other} order by 1,2,3`),
    functionsElsewhere: await q(`select proname, pg_get_functiondef(oid) as def, proacl::text as acl from pg_proc where pronamespace = 'public'::regnamespace and proname <> 'guard_teacher_privileged_columns' order by 1`),
    buckets: await q(`select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by 1`),
    rlsFlags: await q(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`),
    privilegesElsewhere: await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name ${other} order by 1,2,3`),
  };
}

describe("scope of 0012", () => {
  test("it changes nothing outside teacher_profiles (tables, columns, policies, triggers, functions, grants, buckets)", async () => {
    const [before, after] = await Promise.all([
      createTestDb({ include: (f) => f < "0011" }),
      createTestDb({ include: (f) => f < "0011" || f.startsWith("0012") }),
    ]);
    const a = await snapshot(before);
    const b = await snapshot(after);
    for (const key of Object.keys(a) as (keyof typeof a)[]) {
      assert.ok(a[key].length > 0, `sanity: ${key} snapshot should not be empty`);
      assert.deepEqual(b[key], a[key], `0012 changed ${key} outside teacher_profiles`);
    }
    // …and it did change teacher_profiles, exactly as intended.
    const policies = await after.query<{ policyname: string; cmd: string }>("select policyname, cmd from pg_policies where tablename = 'teacher_profiles' order by policyname");
    assert.deepEqual(policies.rows.map((p) => [p.policyname, p.cmd]), [["teacher_profile_read_own_or_admin", "SELECT"], ["teacher_profile_update_own_or_admin", "UPDATE"]]);
  });

  test("it can be run a second time without error and without changing the result", async () => {
    const db = await createTestDb({ include: (f) => f < "0011" || f.startsWith("0012") });
    const policiesBefore = (await db.query("select policyname, cmd, qual, with_check from pg_policies where tablename = 'teacher_profiles' order by policyname")).rows;
    await db.exec(readMigration("0012_lock_down_teacher_profiles.sql"));
    const policiesAfter = (await db.query("select policyname, cmd, qual, with_check from pg_policies where tablename = 'teacher_profiles' order by policyname")).rows;
    assert.deepEqual(policiesAfter, policiesBefore);
    const triggers = await db.query("select trigger_name from information_schema.triggers where event_object_table = 'teacher_profiles' order by 1");
    assert.deepEqual(triggers.rows.map((t) => (t as { trigger_name: string }).trigger_name), ["trg_guard_teacher_activation", "trg_guard_teacher_privileged"]);
  });
});

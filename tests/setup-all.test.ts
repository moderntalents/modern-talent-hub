// supabase/setup-all.sql is the one-shot setup for an EMPTY database. It must be exactly the migration files
// (plus the seed), in order, with nothing left out — in particular 0012 (teacher_profiles lock-down) before
// 0013, which says payments must never go live without it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { migrationFiles } from "./helpers/db";

const SETUP = readFileSync("supabase/setup-all.sql", "utf8");
const BAR = "-- " + "#".repeat(76);

function blocks(): { name: string; body: string }[] {
  const parts = SETUP.split(new RegExp(`\\n${BAR}\\n-- ## (\\S+)\\n${BAR}\\n`));
  const out: { name: string; body: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) out.push({ name: parts[i], body: parts[i + 1] });
  return out;
}

test("setup-all.sql contains every migration file, verbatim, in order (seed right after 0001)", () => {
  const names = blocks().map((b) => b.name);
  const expected = migrationFiles().map((f) => `migrations/${f}`);
  expected.splice(1, 0, "seed.sql");
  assert.deepEqual(names, expected);

  for (const b of blocks()) {
    assert.equal(b.body.trim(), readFileSync(`supabase/${b.name}`, "utf8").trim(), `${b.name} differs from its file`);
  }
  assert.ok(names.indexOf("migrations/0012_lock_down_teacher_profiles.sql") < names.indexOf("migrations/0013_payment_state_machine_and_ledger.sql"));
});

test("setup-all.sql applies cleanly to an empty database and includes the 0012 and 0015 protections", async () => {
  const helpers = readFileSync("tests/helpers/db.ts", "utf8");
  const stubs = /const SUPABASE_STUBS = `([\s\S]*?)`;/.exec(helpers)![1];
  const grants = /const SUPABASE_DEFAULT_GRANTS = `([\s\S]*?)`;/.exec(helpers)![1];
  const db = new PGlite();
  await db.exec(stubs);
  await db.exec(grants);
  await db.exec(SETUP.replace(/create extension if not exists [^;]+;/gi, ""));

  const policies = (await db.query<{ policyname: string }>(
    "select policyname from pg_policies where tablename = 'teacher_profiles' order by 1",
  )).rows.map((r) => r.policyname);
  assert.deepEqual(policies, ["teacher_profile_read_own_or_admin", "teacher_profile_update_own_or_admin"], "0012 policies");
  assert.equal((await db.query("select 1 from pg_trigger where tgname = 'trg_guard_teacher_privileged'")).rows.length, 1, "0012 guard trigger");
  assert.equal((await db.query("select 1 from platform_wallet")).rows.length, 1, "0013 applied");

  const phoneReadable = (await db.query(
    "select 1 from information_schema.column_privileges where table_name = 'payment_transactions' and grantee = 'authenticated' and column_name in ('phone', 'callback_phone') and privilege_type = 'SELECT'",
  )).rows.length;
  assert.equal(phoneReadable, 0, "0015: browsers cannot read the payer's phone");
});

// Migration 0014 may ADD things, and may REPLACE exactly three 0011 messaging functions. Everything
// else that existed after 0011 must be identical afterwards — in particular consent_status,
// decide_guardian_consent() and age_cleared(), and anything to do with payments.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers/db";

const NEW_TABLES = ["guardian_consent_versions"];
const NEW_COLUMNS: Record<string, string[]> = {
  age_records: ["guardian_messaging_allowed", "guardian_messaging_status", "guardian_messaging_version", "guardian_messaging_decided_at"],
  guardian_consent_requests: ["purpose", "consent_version", "messaging_decision", "messaging_decided_at"],
};
const NEW_CONSTRAINTS = [
  "age_records_messaging_consistent",
  "age_records_guardian_messaging_status_check",
  "age_records_guardian_messaging_version_fkey",
  "guardian_consent_requests_purpose_check",
  "guardian_consent_requests_consent_version_fkey",
  "guardian_consent_requests_messaging_decision_check",
  "guardian_consent_requests_messaging_decided",
  // NOT NULL on the new columns (newer Postgres lists these as named constraints)
  "age_records_guardian_messaging_allowed_not_null",
  "age_records_guardian_messaging_status_not_null",
  "guardian_consent_requests_purpose_not_null",
  "guardian_consent_requests_consent_version_not_null",
];
const NEW_TRIGGERS = ["trg_age_records_messaging_version", "trg_guardian_requests_messaging_version"];
const NEW_FUNCTIONS = [
  "guard_messaging_consent_version", "age_in_years_kenya", "messaging_cleared",
  "decide_guardian_consent_with_messaging", "decide_guardian_messaging_consent", "withdraw_guardian_messaging_consent",
];
const REWIRED = ["caller_can_read_conversation", "_open_conversation", "messaging_can_send"];

const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");
const newColumnPairs = Object.entries(NEW_COLUMNS).flatMap(([t, cs]) => cs.map((c) => `('${t}','${c}')`)).join(",");

async function snapshot(db: PGlite) {
  const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows.map((r) => JSON.stringify(r));
  return {
    tables: await q(`select table_schema, table_name from information_schema.tables where table_schema in ('public','storage') and table_name not in (${list(NEW_TABLES)}) order by 1,2`),
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ('public','storage') and table_name not in (${list(NEW_TABLES)}) and (table_name, column_name) not in (${newColumnPairs}) order by 1,2`),
    constraints: await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace and conname not in (${list(NEW_CONSTRAINTS)}) and conrelid::regclass::text not in (${list(NEW_TABLES)}) order by 1,2`),
    policies: await q(`select schemaname, tablename, policyname, cmd, roles, qual, with_check from pg_policies order by 1,2,3`),
    triggers: await q(`select event_object_table, trigger_name, event_manipulation, action_statement from information_schema.triggers where trigger_schema = 'public' and trigger_name not in (${list(NEW_TRIGGERS)}) order by 1,2,3`),
    functions: await q(`select proname, pg_get_functiondef(oid) as def, proacl::text as acl from pg_proc where pronamespace = 'public'::regnamespace and proname not in (${list([...NEW_FUNCTIONS, ...REWIRED])}) order by 1`),
    rewiredAcl: await q(`select proname, proacl::text as acl from pg_proc where pronamespace = 'public'::regnamespace and proname in (${list(REWIRED)}) order by 1`),
    buckets: await q(`select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by 1`),
    rls: await q(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname not in (${list(NEW_TABLES)}) order by 1`),
    tablePrivileges: await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name not in (${list(NEW_TABLES)}) order by 1,2,3`),
  };
}

test("0014 changes nothing that existed after 0011, except replacing the three messaging gates", async () => {
  const [before, after] = await Promise.all([
    createTestDb({ upTo: "0011_messaging.sql" }),
    createTestDb({ upTo: "0014_messaging_guardian_consent.sql" }),
  ]);
  const a = await snapshot(before);
  const b = await snapshot(after);
  for (const key of Object.keys(a) as (keyof typeof a)[]) {
    assert.ok(a[key].length > 0, `sanity: snapshot of ${key} should not be empty`);
    assert.deepEqual(b[key], a[key], `0014 changed existing ${key}`);
  }
});

test("consent_status, decide_guardian_consent() and age_cleared() are exactly as before", async () => {
  const [before, after] = await Promise.all([
    createTestDb({ upTo: "0011_messaging.sql" }),
    createTestDb({ upTo: "0014_messaging_guardian_consent.sql" }),
  ]);
  const defs = async (db: PGlite) =>
    (await db.query<{ proname: string; def: string; acl: string }>(
      "select proname, pg_get_functiondef(oid) as def, proacl::text as acl from pg_proc where proname in ('decide_guardian_consent', 'age_cleared') order by 1",
    )).rows;
  assert.deepEqual(await defs(after), await defs(before));

  const col = async (db: PGlite) =>
    (await db.query("select data_type, is_nullable, column_default from information_schema.columns where table_name = 'age_records' and column_name = 'consent_status'")).rows;
  const check = async (db: PGlite) =>
    (await db.query("select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'age_records'::regclass and pg_get_constraintdef(oid) like '%consent_status%' order by 1")).rows;
  assert.deepEqual(await col(after), await col(before));
  assert.deepEqual(await check(after), await check(before));
});

test("the three rewired functions use messaging_cleared() and keep every 0011 rule", async () => {
  const db = await createTestDb({ upTo: "0014_messaging_guardian_consent.sql" });
  const def = async (name: string) =>
    (await db.query<{ d: string }>("select pg_get_functiondef(oid) as d from pg_proc where proname = $1", [name])).rows[0].d;

  const read = await def("caller_can_read_conversation");
  assert.match(read, /auth\.uid\(\) in \(c\.student_id, c\.teacher_id\)/);
  assert.match(read, /messaging_cleared\(c\.student_id\)/);
  assert.match(read, /messaging_cleared\(c\.teacher_id\)/);

  const open = await def("_open_conversation");
  for (const rule of [/role = 'student'/, /role = 'teacher'/, /approved/, /age_cleared\(p_student\) and age_cleared\(p_teacher\)/, /messaging_cleared\(p_student\) and messaging_cleared\(p_teacher\)/, /on conflict \(student_id, teacher_id\) do nothing/]) {
    assert.match(open, rule);
  }

  const send = await def("messaging_can_send");
  for (const rule of [/not_found/, /age_cleared\(c\.student_id\) and age_cleared\(c\.teacher_id\)/, /messaging_cleared\(c\.student_id\) and messaging_cleared\(c\.teacher_id\)/, /not_permitted/, /messaging_relationship\(c\.student_id, c\.teacher_id\)/, /closed/]) {
    assert.match(send, rule);
  }
});

test("0014 does not touch the M-Pesa / payment migrations", async () => {
  const sql = (await import("node:fs")).readFileSync("supabase/migrations/0014_messaging_guardian_consent.sql", "utf8");
  const code = sql.replace(/--.*$/gm, "");
  assert.doesNotMatch(code, /payment|mpesa|wallet|withdrawal|platform_wallet|subscriptions/i);
});

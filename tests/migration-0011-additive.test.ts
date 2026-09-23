// Migration 0011 must only ADD things. Everything that existed after 0010 (Stages 1 and 2 included)
// must be exactly the same afterwards: tables, columns, policies, functions, triggers, buckets.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers/db";

const NEW_TABLES = ["conversations", "messages"];
const NEW_FUNCTIONS = [
  "age_cleared", "caller_can_read_conversation", "messaging_relationship", "_open_conversation",
  "start_conversation_from_lesson", "start_conversation_from_activity", "start_conversation_as_teacher",
  "messaging_can_send", "send_message", "attachment_in_use", "messaging_conversation_ids", "delete_user_messages",
];

async function snapshot(db: PGlite) {
  const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows.map((r) => JSON.stringify(r));
  const notNew = `not in (${NEW_TABLES.map((t) => `'${t}'`).join(",")})`;
  return {
    tables: await q(`select table_schema, table_name from information_schema.tables where table_schema in ('public','storage') and table_name ${notNew} order by 1,2`),
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ('public','storage') and table_name ${notNew} order by 1,2`),
    constraints: await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace in ('public'::regnamespace) and conrelid::regclass::text ${notNew} order by 1,2`),
    policies: await q(`select schemaname, tablename, policyname, cmd, roles, qual, with_check from pg_policies where tablename ${notNew} order by 1,2,3`),
    triggers: await q(`select event_object_table, trigger_name, event_manipulation, action_statement from information_schema.triggers where trigger_schema in ('public') and event_object_table ${notNew} order by 1,2,3`),
    functions: await q(`select proname, pg_get_functiondef(oid) as def, proacl::text as acl from pg_proc where pronamespace = 'public'::regnamespace and proname not in (${NEW_FUNCTIONS.map((f) => `'${f}'`).join(",")}) order by 1`),
    buckets: await q(`select id, name, public, file_size_limit, allowed_mime_types from storage.buckets where id <> 'message-attachments' order by 1`),
    rls: await q(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname ${notNew} order by 1`),
    tablePrivileges: await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name ${notNew} order by 1,2,3`),
  };
}

test("0011 adds objects only: everything that existed after 0010 is identical afterwards", async () => {
  const [before, after] = await Promise.all([createTestDb({ upTo: "0010_age_and_guardian_consent.sql" }), createTestDb({ upTo: "0011_messaging.sql" })]);
  const a = await snapshot(before);
  const b = await snapshot(after);
  for (const key of Object.keys(a) as (keyof typeof a)[]) {
    assert.ok(a[key].length > 0, `sanity: snapshot of ${key} should not be empty`);
    assert.deepEqual(b[key], a[key], `0011 changed existing ${key}`);
  }
});

test("0011 really does add the new objects", async () => {
  const db = await createTestDb({ upTo: "0011_messaging.sql" });
  const names = (await db.query<{ n: string }>("select proname as n from pg_proc where pronamespace = 'public'::regnamespace")).rows.map((r) => r.n);
  for (const f of NEW_FUNCTIONS) assert.ok(names.includes(f), `missing function ${f}`);
  const tables = (await db.query<{ n: string }>("select table_name as n from information_schema.tables where table_schema = 'public'")).rows.map((r) => r.n);
  for (const t of NEW_TABLES) assert.ok(tables.includes(t), `missing table ${t}`);
});

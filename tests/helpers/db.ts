// Test database: a real (in-process) Postgres via PGlite, shaped like Supabase.
//
// It applies the repository's ACTUAL migration files, so the row-level security policies
// and SQL functions under test are the ones that will run in production. Only the pieces
// Supabase itself provides are stubbed: the three API roles, auth.uid()/auth.role(), the
// auth.users table, and the storage.buckets / storage.objects tables.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    email_confirmed_at timestamptz,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid);
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid);
  create table auth.refresh_tokens (id bigserial primary key, user_id text);
  create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid);
  create table auth.one_time_tokens (id uuid primary key default gen_random_uuid(), user_id uuid);

  -- Same behaviour as Supabase: identity comes from the request's JWT claims.
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id),
    name text,
    owner uuid
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select string_to_array(name, '/') $$;

  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema storage to anon, authenticated, service_role;
`;

// Supabase gives the API roles broad table/function privileges on everything created in
// "public" by default; row-level security and REVOKEs are what actually restrict them. These
// DEFAULT PRIVILEGES are set before any migration runs, exactly so that a migration's own
// REVOKE statements are what the tests see (granting after the fact would undo them).
const SUPABASE_DEFAULT_GRANTS = `
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  grant all on all tables in schema storage to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema storage to anon, authenticated, service_role;
`;

export function readMigration(name: string): string {
  // pgcrypto isn't bundled with PGlite; gen_random_uuid() is built into Postgres 13+.
  return readFileSync(join(MIGRATIONS, name), "utf8").replace(/create extension if not exists [^;]+;/gi, "");
}

/** Every migration that exists on disk, in order. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
}

export async function createTestDb(options: { upTo?: string; include?: (file: string) => boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await db.exec(SUPABASE_DEFAULT_GRANTS);
  for (const file of migrationFiles()) {
    if (options.upTo && file > options.upTo) break;
    if (options.include && !options.include(file)) continue;
    try {
      await db.exec(readMigration(file));
    } catch (err) {
      throw new Error(`Migration ${file} failed to apply in the test database: ${(err as Error).message}`);
    }
  }
  return db;
}

export type Actor = { id: string } | "anon" | "service";

/** Runs `fn` as a Supabase API caller: a signed-in user, an anonymous visitor, or the server (service role). */
export async function as<T>(db: PGlite, actor: Actor, fn: () => Promise<T>): Promise<T> {
  if (actor === "service") {
    await db.exec(`select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claim.role','service_role',false); set role service_role;`);
  } else if (actor === "anon") {
    await db.exec(`select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claim.role','anon',false); set role anon;`);
  } else {
    await db.exec(`select set_config('request.jwt.claim.sub','${actor.id}',false); select set_config('request.jwt.claim.role','authenticated',false); set role authenticated;`);
  }
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claim.role','',false);`);
  }
}

/** Resolves true if the statement is rejected by the database (RLS, a grant, a constraint or a raised exception). */
export async function rejects(db: PGlite, actor: Actor, sql: string, params: unknown[] = []): Promise<boolean> {
  return as(db, actor, async () => {
    try {
      const res = await db.query(sql, params);
      // RLS does not raise for SELECT/UPDATE/DELETE that match nothing; treat "no rows affected" as rejected
      // only when the caller asks about a write (affectedRows is reported for writes).
      return typeof res.affectedRows === "number" && /^\s*(update|delete)/i.test(sql) ? res.affectedRows === 0 : false;
    } catch {
      return true;
    }
  });
}

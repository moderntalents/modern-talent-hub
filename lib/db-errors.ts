import "server-only";
import { NextResponse } from "next/server";

// Postgres / PostgREST codes meaning "this table or function does not exist" —
// i.e. a migration in supabase/migrations hasn't been run on the database the
// deployment is pointed at. (PGRST202 = function not in schema cache,
// PGRST205 = table not in schema cache, 42883 = undefined function,
// 42P01 = undefined table.)
const MISSING_OBJECT_CODES = new Set(["PGRST202", "PGRST205", "42883", "42P01"]);

/**
 * If `error` is a "database setup is incomplete" error, log exactly what is
 * missing (for the Vercel logs) and return a specific 503 instead of a
 * meaningless "something went wrong". Returns null for any other error.
 */
export function missingDatabaseSetupResponse(
  scope: string,
  error: { code?: string; message: string } | null | undefined,
): NextResponse | null {
  if (!error?.code || !MISSING_OBJECT_CODES.has(error.code)) return null;

  console.error(
    `[${scope}] DATABASE SETUP INCOMPLETE — ${error.message}. ` +
      `Run every file in supabase/migrations (0001 → latest) on the Supabase project this deployment uses.`,
  );
  return NextResponse.json(
    {
      error:
        "This feature isn't available yet because the site's database setup is incomplete. " +
        "Please contact the site administrator.",
    },
    { status: 503 },
  );
}

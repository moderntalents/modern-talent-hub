"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/types";

// Browser-side Supabase client. Uses the public anon key only — safe to expose,
// access is governed entirely by the RLS policies in supabase/migrations/0001_init.sql.
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without this check, passing `undefined` straight to createBrowserClient
  // throws a cryptic "Failed to construct 'URL'" deep inside supabase-js —
  // and if that throw happens outside a try/catch (as it did in the signup
  // and login forms), it surfaces as a submit button stuck spinning forever
  // with no visible error at all.
  if (!url || !anonKey) {
    throw new Error(
      "Supabase isn't configured on this deployment (missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). Set them and redeploy — see .env.example.",
    );
  }

  return createBrowserClient<Database>(url, anonKey);
}

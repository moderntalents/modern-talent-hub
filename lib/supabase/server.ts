import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/supabase/types";

// Server-side Supabase client for use in Server Components, Server Actions and
// Route Handlers. Reads/writes the session via cookies so RLS is enforced as
// the signed-in user (never bypasses row level security).
export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Same guard as lib/supabase/client.ts: without it, a missing env var here
  // throws a cryptic error deep inside @supabase/ssr on every server-rendered
  // page instead of a message that says what's actually wrong.
  if (!url || !anonKey) {
    throw new Error(
      "Supabase isn't configured on this deployment (missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). Set them and redeploy — see .env.example.",
    );
  }

  const cookieStore = await cookies();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component that can't set cookies — the
          // middleware refreshes the session instead, so this is safe to ignore.
        }
      },
    },
  });
}

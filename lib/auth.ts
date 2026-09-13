import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/supabase/types";

// Every dashboard route calls this from both its layout (via requireRole) and
// its page, which each need the signed-in user's profile. Without caching,
// that's two round trips per request to Supabase Auth (auth.getUser() calls
// the Auth server to verify the JWT) plus two profile queries. React's
// request-scoped cache() collapses those into one for the lifetime of a
// single render pass, which is where the registration -> dashboard load time
// was actually going.
export const getSessionProfile = cache(async () => {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return null;

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    return profile ? { user, profile } : null;
  } catch (err) {
    // Most commonly: Supabase env vars aren't set yet (see .env.example).
    // Treat it as "not signed in" rather than crashing every page that
    // calls this — the splash page still renders and login/signup will
    // surface their own clear error when actually submitted.
    console.error("[getSessionProfile] Supabase unavailable:", err instanceof Error ? err.message : err);
    return null;
  }
});

/** Redirects to /login if not signed in, or to their own dashboard if signed in with the wrong role. */
export async function requireRole(role: UserRole) {
  const session = await getSessionProfile();

  if (!session) {
    redirect("/login");
  }
  if (session.profile.role !== role) {
    redirect(`/${session.profile.role}`);
  }
  return session;
}

import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/supabase/types";

export async function getSessionProfile() {
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
}

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

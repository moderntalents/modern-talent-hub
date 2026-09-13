import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Supabase redirects here after a Google OAuth sign-in with a `code` to
// exchange for a session. The trg_on_auth_user_created trigger
// (supabase/migrations/0001_init.sql) auto-creates the profiles row for a
// brand-new user, defaulting role to 'student' since Google doesn't supply
// the teacher-specific fields (specialty/bio) the signup form collects.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const errorDescription = searchParams.get("error_description");

  if (errorDescription) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(errorDescription)}`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent("Missing authorization code.")}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();

  return NextResponse.redirect(`${origin}/${profile?.role ?? "student"}`);
}

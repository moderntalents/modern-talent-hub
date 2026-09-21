"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ageInYears, CHILD_AGE, parseIsoDate } from "@/lib/age";
import { purgeUnusedStudent, recordAge } from "@/lib/consent";

// The age check for people who did not give a date of birth at signup: anyone who signed
// in with Google, and every account created before Stage 2. Failures come back as
// { ok: false, message } (production hides thrown server-action errors).

export type SubmitAgeResult =
  | { ok: false; message: string }
  | { ok: true; next: "dashboard" | "consent" | "google_under13"; emailSent?: boolean };

const fail = (message: string): SubmitAgeResult => ({ ok: false, message });

export async function submitAge(dobIso: string, guardianEmail: string): Promise<SubmitAgeResult> {
  try {
    const dob = parseIsoDate(dobIso);
    if (!dob) return fail("Choose your date of birth.");

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return fail("Please sign in again first.");

    const { data: profile } = await supabase.from("profiles").select("role, full_name").eq("id", user.id).single();
    if (!profile) return fail("Your profile couldn't be found.");
    if (profile.role === "admin") return fail("Administrator accounts don't need an age check.");

    const admin = createAdminClient();

    // Under-13s don't use Google sign-in. If this is a brand-new (unused) account made that
    // way, remove it entirely — including the Google details — and send them to email signup.
    // (An older account that already has activity falls through to the normal consent path.)
    const usedGoogle = (user.identities ?? []).some((i) => i.provider === "google");
    if (profile.role === "student" && usedGoogle && ageInYears(dob) < CHILD_AGE) {
      if (await purgeUnusedStudent(admin, user.id)) return { ok: true, next: "google_under13" };
    }

    const recorded = await recordAge(admin, {
      profileId: user.id,
      role: profile.role,
      dobIso: dob,
      accountEmail: user.email ?? null,
      guardianEmail: guardianEmail.trim() || null,
      childName: profile.full_name,
    });
    if (!recorded.ok) return fail(recorded.message);

    return recorded.consent === "pending"
      ? { ok: true, next: "consent", emailSent: recorded.emailSent }
      : { ok: true, next: "dashboard" };
  } catch (err) {
    console.error("[age-check] failed:", err);
    return fail("Something went wrong. Please try again.");
  }
}

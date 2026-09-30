// What a person may change on their own profile from Settings, and how it is checked. Pure, with no
// server-only imports, so the Settings form (browser) and the server action use exactly the same
// rules — and so the rules can be unit tested. The server is still the authority: it re-runs this
// with the age group it works out itself, and the database's row-level security decides which rows
// the person may write at all.
//
// Only fields the app ALREADY collects at sign-up are editable (same limits as
// app/api/auth/verify-registration/route.ts). Nothing here touches login email/password, role,
// date of birth, guardian details, teacher approval, wallet or payout (M-Pesa/bank) details.

import type { AgeGroup } from "@/lib/age";

export type EditableRole = "student" | "teacher" | "admin";

export interface ProfileInput {
  fullName: string;
  phone: string;
  grade: string;
  schoolName: string;
  specialty: string;
  bio: string;
}

/** Same maximum lengths the sign-up route uses. */
export const PROFILE_LIMITS = { fullName: 100, phone: 30, grade: 50, schoolName: 150, specialty: 150, bio: 500 } as const;

export interface ProfileChanges {
  profiles: { full_name: string; phone?: string | null };
  student?: { grade: string; school_name: string | null };
  teacher?: { specialty: string; bio: string | null };
}

export type ProfileValidation =
  | { ok: true; changes: ProfileChanges }
  | { ok: false; errors: Partial<Record<keyof ProfileInput, string>> };

const clean = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

/** Loose phone check: an optional +, then digits, spaces, dashes or brackets, with 7–15 digits. */
export function phoneProblem(phone: string): string | null {
  if (!/^\+?[\d\s()-]+$/.test(phone)) return "Use only digits, spaces and an optional + in your phone number.";
  const digits = phone.replace(/\D/g, "").length;
  if (digits < 7 || digits > 15) return "Enter a full phone number.";
  return null;
}

/** Whether the phone field is shown at all. Under-13s are never asked for (or keep) a phone number. */
export function phoneEditable(group: AgeGroup | null): boolean {
  return group !== "child";
}

/**
 * Checks the submitted form for this person. `group` is the age group worked out on the server from
 * the date of birth on record (null for administrators and anyone without a record).
 */
export function validateProfile(role: EditableRole, group: AgeGroup | null, input: Partial<ProfileInput>): ProfileValidation {
  const errors: Partial<Record<keyof ProfileInput, string>> = {};
  const fullName = clean(input.fullName);
  const phone = clean(input.phone);
  const grade = clean(input.grade);
  const schoolName = clean(input.schoolName);
  const specialty = clean(input.specialty);
  // A bio may have line breaks; only trim the ends.
  const bio = typeof input.bio === "string" ? input.bio.trim() : "";

  if (!fullName) errors.fullName = "Enter your full name.";
  else if (fullName.length > PROFILE_LIMITS.fullName) errors.fullName = `Keep your name under ${PROFILE_LIMITS.fullName} characters.`;

  const changes: ProfileChanges = { profiles: { full_name: fullName } };

  if (phoneEditable(group)) {
    if (phone) {
      const problem = phone.length > PROFILE_LIMITS.phone ? "Enter a full phone number." : phoneProblem(phone);
      if (problem) errors.phone = problem;
    } else if (group === "adult" && role !== "admin") {
      // Same rule as sign-up: adults must give a phone number.
      errors.phone = "Enter your phone number.";
    }
    changes.profiles.phone = phone || null;
  }
  // Under 13: the phone column is left exactly as it is (not written at all).

  if (role === "student") {
    if (!grade) errors.grade = "Enter your grade/class.";
    else if (grade.length > PROFILE_LIMITS.grade) errors.grade = `Keep this under ${PROFILE_LIMITS.grade} characters.`;
    if (schoolName.length > PROFILE_LIMITS.schoolName) errors.schoolName = `Keep this under ${PROFILE_LIMITS.schoolName} characters.`;
    changes.student = { grade, school_name: schoolName || null };
  }

  if (role === "teacher") {
    if (!specialty) errors.specialty = "Enter what you teach.";
    else if (specialty.length > PROFILE_LIMITS.specialty) errors.specialty = `Keep this under ${PROFILE_LIMITS.specialty} characters.`;
    if (bio.length > PROFILE_LIMITS.bio) errors.bio = `Keep your bio under ${PROFILE_LIMITS.bio} characters.`;
    changes.teacher = { specialty, bio: bio || null };
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, changes };
}

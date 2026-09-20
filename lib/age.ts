// Age rules in one place. Pure functions with no server-only imports, so the signup
// form (browser) and the server checks use exactly the same logic.
//
// Decision (Stage 2): anyone under 18 needs a parent or guardian's approval, because
// Kenya's Data Protection Act treats under-18s as children. Under 13 has a few extra
// rules (no phone number asked, no Google sign-in).

export const ADULT_AGE = 18;
export const CHILD_AGE = 13;
export const MIN_BIRTH_YEAR_SPAN = 110; // older than this is treated as a typing mistake

export type AgeGroup = "child" | "teen" | "adult"; // under 13 | 13-17 | 18+

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's calendar date in Kenya (East Africa Time), as {y, m, d}. */
export function todayInKenya(now: Date = new Date()): { y: number; m: number; d: number } {
  const [y, m, d] = now.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" }).split("-").map(Number);
  return { y, m, d };
}

/** Builds "YYYY-MM-DD" from parts, or null if it isn't a real date in the past. */
export function toIsoDate(year: number, month: number, day: number, now: Date = new Date()): string | null {
  if (![year, month, day].every(Number.isInteger)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  // Rolling over (31 Feb -> 3 Mar) means it wasn't a real date.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;

  const t = todayInKenya(now);
  if (year > t.y || (year === t.y && (month > t.m || (month === t.m && day > t.d)))) return null; // future
  if (year < t.y - MIN_BIRTH_YEAR_SPAN) return null;

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Validates an incoming "YYYY-MM-DD" string. Returns it unchanged if it is a real past date. */
export function parseIsoDate(value: unknown, now: Date = new Date()): string | null {
  if (typeof value !== "string") return null;
  const m = ISO.exec(value.trim());
  if (!m) return null;
  return toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]), now);
}

/** Whole years old on `now` (Kenya date). Expects a valid ISO date. */
export function ageInYears(iso: string, now: Date = new Date()): number {
  const m = ISO.exec(iso);
  if (!m) throw new Error(`Not an ISO date: ${iso}`);
  const [by, bm, bd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = todayInKenya(now);
  let age = t.y - by;
  if (t.m < bm || (t.m === bm && t.d < bd)) age -= 1; // birthday not reached yet this year
  return age;
}

export function ageGroup(age: number): AgeGroup {
  if (age < CHILD_AGE) return "child";
  if (age < ADULT_AGE) return "teen";
  return "adult";
}

/** Under 18: a parent or guardian must approve before the app can be used. */
export function needsGuardian(age: number): boolean {
  return age < ADULT_AGE;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks the guardian's email for someone under 18. Returns a message, or null if fine.
 * It may not be the child's own sign-up email (a small hurdle against self-approval —
 * email consent can never be perfect, see the README).
 */
export function guardianEmailProblem(guardianEmail: string, accountEmail: string | null | undefined): string | null {
  const g = guardianEmail.trim().toLowerCase();
  if (!EMAIL.test(g) || g.length > 254) return "Enter your parent or guardian's email address.";
  if (accountEmail && g === accountEmail.trim().toLowerCase()) {
    return "Your parent or guardian needs their own email address, different from yours.";
  }
  return null;
}

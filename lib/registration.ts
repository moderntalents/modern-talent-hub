// Which student registration fields depend on age. Pure functions with no server-only imports, so the
// signup form (browser) and the verify-registration route use exactly the same rule.
//
// Students aged 18 or over are not asked for Grade/Class or School; students under 18 are, as before.
// Teachers are not affected: their form and request are exactly what they were.

import { ADULT_AGE } from "./age";

export type RegistrationRole = "student" | "teacher";

/**
 * True when Grade/Class and School are hidden: a student whose date of birth makes them 18 or over.
 * While the date of birth is incomplete (age null) the fields stay visible, as they always were.
 */
export function hidesSchoolDetails(role: RegistrationRole, age: number | null): boolean {
  return role === "student" && age !== null && age >= ADULT_AGE;
}

/**
 * The grade/school part of the registration request. When the fields are hidden the keys are left out
 * entirely, so nothing typed before they were hidden can be sent.
 */
export function schoolDetailsPayload(
  role: RegistrationRole,
  age: number | null,
  grade: string,
  schoolName: string,
): { grade?: string; schoolName?: string } {
  return hidesSchoolDetails(role, age) ? {} : { grade, schoolName };
}

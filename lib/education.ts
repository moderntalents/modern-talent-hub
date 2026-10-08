// School levels and grades for Subjects (migration 0024). The database is the authority — these mirror
// education_levels, grade_code_from_text() and education_level_for_grade() so pages can label things and
// validate input without an extra round trip. tests/subjects-levels.test.ts keeps the two in step.

export type EducationLevelCode = "pre_primary" | "primary" | "junior" | "senior";
export type GradeCode =
  | "PP1" | "PP2"
  | "G1" | "G2" | "G3" | "G4" | "G5" | "G6"
  | "G7" | "G8" | "G9"
  | "G10" | "G11" | "G12";
export type SeniorPathway = "core" | "stem" | "social_sciences" | "arts_sports";

export const EDUCATION_LEVELS: { code: EducationLevelCode; name: string; grades: string }[] = [
  { code: "pre_primary", name: "Pre-primary", grades: "PP1–PP2" },
  { code: "primary", name: "Primary (CBC)", grades: "Grades 1–6" },
  { code: "junior", name: "Junior School", grades: "Grades 7–9" },
  { code: "senior", name: "Senior School", grades: "Grades 10–12" },
];

/** The choices students pick from. `label` is what is saved in student_profiles.grade. */
export const GRADE_OPTIONS: { code: GradeCode; label: string }[] = [
  { code: "PP1", label: "PP1" },
  { code: "PP2", label: "PP2" },
  ...Array.from({ length: 12 }, (_, i) => ({ code: `G${i + 1}` as GradeCode, label: `Grade ${i + 1}` })),
];

export const SENIOR_PATHWAYS: { code: SeniorPathway; name: string }[] = [
  { code: "core", name: "Core" },
  { code: "stem", name: "STEM" },
  { code: "social_sciences", name: "Social Sciences" },
  { code: "arts_sports", name: "Arts & Sports Science" },
];

export const SUBJECT_COLORS = ["cyan", "orange", "red", "blue"] as const;
export type SubjectColor = (typeof SUBJECT_COLORS)[number];

export function isLevelCode(v: unknown): v is EducationLevelCode {
  return typeof v === "string" && EDUCATION_LEVELS.some((l) => l.code === v);
}

export function isGradeCode(v: unknown): v is GradeCode {
  return typeof v === "string" && GRADE_OPTIONS.some((g) => g.code === v);
}

export function isPathway(v: unknown): v is SeniorPathway {
  return typeof v === "string" && SENIOR_PATHWAYS.some((p) => p.code === v);
}

export function levelName(code: string | null | undefined): string {
  return EDUCATION_LEVELS.find((l) => l.code === code)?.name ?? "";
}

export function pathwayName(code: string | null | undefined): string {
  return SENIOR_PATHWAYS.find((p) => p.code === code)?.name ?? "";
}

export function gradeLabel(code: string | null | undefined): string {
  return GRADE_OPTIONS.find((g) => g.code === code)?.label ?? "";
}

/** Same rules as the database's grade_code_from_text(). */
export function gradeCodeFromText(grade: string | null | undefined): GradeCode | null {
  const t = (grade ?? "").replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
  if (!t) return null;
  const pp = /^(?:pp|preprimary|preunit)([12])$/.exec(t);
  if (pp) return `PP${pp[1]}` as GradeCode;
  const g = /^(?:grade|gr|g|class|standard|std)?([0-9]{1,2})$/.exec(t);
  if (g) {
    const n = Number(g[1]);
    if (n >= 1 && n <= 12) return `G${n}` as GradeCode;
  }
  return null;
}

/** Same rules as the database's education_level_for_grade(). */
export function levelForGrade(code: string | null | undefined): EducationLevelCode | null {
  if (code === "PP1" || code === "PP2") return "pre_primary";
  const n = code && /^G([0-9]{1,2})$/.exec(code) ? Number(code.slice(1)) : NaN;
  if (n >= 1 && n <= 6) return "primary";
  if (n >= 7 && n <= 9) return "junior";
  if (n >= 10 && n <= 12) return "senior";
  return null;
}

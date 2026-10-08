// Checks for Admin -> Subjects (add / edit). Pure, so tests can call it directly; the database enforces the
// same rules again (unique name per level, pathway only for Senior School, valid level).

import {
  isLevelCode,
  isPathway,
  SUBJECT_COLORS,
  type EducationLevelCode,
  type SeniorPathway,
  type SubjectColor,
} from "@/lib/education";

export const SUBJECT_LIMITS = { name: 80, description: 300, orderMin: 0, orderMax: 999 } as const;

export type SubjectInput = {
  name: string;
  level: EducationLevelCode;
  pathway: SeniorPathway | null;
  description: string | null;
  color: SubjectColor;
  order_index: number;
};

export type SubjectErrors = Partial<Record<"name" | "level" | "pathway" | "description" | "color" | "order", string>>;

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

export function parseSubjectInput(raw: {
  name?: unknown;
  level?: unknown;
  pathway?: unknown;
  description?: unknown;
  color?: unknown;
  order?: unknown;
}): { ok: true; value: SubjectInput } | { ok: false; errors: SubjectErrors } {
  const errors: SubjectErrors = {};
  const name = clean(raw.name);
  const description = clean(raw.description);
  const level = clean(raw.level);
  const pathwayRaw = clean(raw.pathway);
  const color = clean(raw.color) || "cyan";
  const orderText = clean(raw.order);
  const order = orderText === "" ? 0 : Number(orderText);

  if (!name) errors.name = "Enter the subject name.";
  else if (name.length > SUBJECT_LIMITS.name) errors.name = `Keep the name under ${SUBJECT_LIMITS.name} characters.`;
  if (!isLevelCode(level)) errors.level = "Choose a school level.";
  if (pathwayRaw && !isPathway(pathwayRaw)) errors.pathway = "Choose a pathway from the list.";
  else if (pathwayRaw && level !== "senior") errors.pathway = "Pathways are for Senior School subjects only.";
  if (description.length > SUBJECT_LIMITS.description) {
    errors.description = `Keep the description under ${SUBJECT_LIMITS.description} characters.`;
  }
  if (!(SUBJECT_COLORS as readonly string[]).includes(color)) errors.color = "Choose a colour from the list.";
  if (!Number.isInteger(order) || order < SUBJECT_LIMITS.orderMin || order > SUBJECT_LIMITS.orderMax) {
    errors.order = `Use a whole number from ${SUBJECT_LIMITS.orderMin} to ${SUBJECT_LIMITS.orderMax}.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      level: level as EducationLevelCode,
      pathway: pathwayRaw ? (pathwayRaw as SeniorPathway) : null,
      description: description || null,
      color: color as SubjectColor,
      order_index: order,
    },
  };
}

/** Plain-language message for a database error on add/edit/delete. */
export function subjectDbErrorMessage(error: { code?: string; message?: string }): string {
  if (error.code === "23505") return "A subject with this name already exists in that level.";
  if (error.code === "23503") return "This subject has lessons, so it can't be deleted. Hide it instead.";
  if (error.code === "23514") return "Pathways are for Senior School subjects only.";
  return "We couldn't save the subject. Please try again.";
}

"use client";

import { Field, Select } from "@/components/ui/Card";
import { ageInYears, toIsoDate } from "@/lib/age";

// A neutral date-of-birth question: three drop-downs that start EMPTY (no pre-selected
// year, no hint about any age limit). It is asked of everyone, in the same way.

export type DobParts = { day: string; month: string; year: string };
export const EMPTY_DOB: DobParts = { day: "", month: "", year: "" };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "YYYY-MM-DD" if all three are chosen and form a real past date, otherwise null. */
export function dobToIso(dob: DobParts): string | null {
  if (!dob.day || !dob.month || !dob.year) return null;
  return toIsoDate(Number(dob.year), Number(dob.month), Number(dob.day));
}

/** Age in whole years, or null while the date is incomplete or not a real date. */
export function dobToAge(dob: DobParts): number | null {
  const iso = dobToIso(dob);
  return iso ? ageInYears(iso) : null;
}

export function DateOfBirthField({
  value,
  onChange,
  disabled,
}: {
  value: DobParts;
  onChange: (next: DobParts) => void;
  disabled?: boolean;
}) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 111 }, (_, i) => thisYear - i);
  const set = (key: keyof DobParts) => (e: React.ChangeEvent<HTMLSelectElement>) =>
    onChange({ ...value, [key]: e.target.value });

  return (
    <Field label="Date of birth" hint="We ask everyone for their date of birth.">
      <div className="grid grid-cols-[1fr_1.6fr_1.2fr] gap-2">
        <Select aria-label="Day of birth" value={value.day} onChange={set("day")} disabled={disabled}>
          <option value="">Day</option>
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        <Select aria-label="Month of birth" value={value.month} onChange={set("month")} disabled={disabled}>
          <option value="">Month</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>
              {m}
            </option>
          ))}
        </Select>
        <Select aria-label="Year of birth" value={value.year} onChange={set("year")} disabled={disabled}>
          <option value="">Year</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}

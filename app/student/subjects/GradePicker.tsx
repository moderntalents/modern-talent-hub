"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { GRADE_OPTIONS } from "@/lib/education";
import { setMyGrade } from "./actions";

/** "Choose your grade" — shown on Subjects when we can't tell a student's grade yet. */
export function GradePicker() {
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-center"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await setMyGrade(code);
          if (result && !result.ok) setError(result.message);
        });
      }}
    >
      <label htmlFor="my-grade" className="sr-only">
        Your grade
      </label>
      <Select id="my-grade" value={code} onChange={(e) => setCode(e.target.value)} required className="sm:max-w-56">
        <option value="" disabled>
          Choose your grade
        </option>
        {GRADE_OPTIONS.map((g) => (
          <option key={g.code} value={g.code}>
            {g.label}
          </option>
        ))}
      </Select>
      <div>
        <Button type="submit" loading={pending} disabled={!code}>
          Save
        </Button>
      </div>
      {error && <ErrorBanner message={error} />}
    </form>
  );
}

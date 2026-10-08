"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { deleteSubject, setSubjectActive } from "./actions";

/** Hide/show a subject, and delete it while it has no lessons. */
export function SubjectRowActions({
  id,
  name,
  active,
  lessonCount,
}: {
  id: string;
  name: string;
  active: boolean;
  lessonCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<{ ok: boolean; message: string } | null>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result && !result.ok) setError(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          compact
          loading={pending}
          onClick={() => {
            if (
              active &&
              !window.confirm(
                `Hide ${name}? Students and teachers won't see it in lists. Its ${lessonCount} lesson(s) are kept and can still be opened.`,
              )
            ) {
              return;
            }
            run(() => setSubjectActive(id, !active));
          }}
        >
          {active ? "Hide" : "Show"}
        </Button>
        {lessonCount === 0 && (
          <Button
            variant="ghost"
            compact
            disabled={pending}
            onClick={() => {
              if (!window.confirm(`Delete ${name}? It has no lessons. This can't be undone.`)) return;
              run(() => deleteSubject(id));
            }}
          >
            Delete
          </Button>
        )}
      </div>
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

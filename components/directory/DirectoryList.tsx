"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { TeacherCard } from "@/components/directory/TeacherCard";
import { loadMoreTeachers } from "@/lib/directory/actions";
import type { DirectoryTeacher } from "@/lib/directory/rules";
import type { MessagingState } from "@/lib/messaging-permission";

/**
 * The first page comes from the server with the page itself; "Show more" asks the server for the next
 * one. Only a page at a time ever reaches the browser, however many teachers there are. The page gives
 * this component a `key` made from the search text, so a new search always starts again from the top.
 */
export function DirectoryList({
  query,
  initial,
  initialCursor,
  messagingState,
}: {
  query: string;
  initial: DirectoryTeacher[];
  initialCursor: string | null;
  messagingState: MessagingState;
}) {
  const [teachers, setTeachers] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function more() {
    if (!cursor) return;
    setError(null);
    startTransition(async () => {
      const page = await loadMoreTeachers({ query, cursor });
      if (!page.ok) {
        setError(page.message);
        return;
      }
      setTeachers((current) => {
        const seen = new Set(current.map((t) => t.id));
        return [...current, ...page.teachers.filter((t) => !seen.has(t.id))];
      });
      setCursor(page.nextCursor);
    });
  }

  const count = teachers.length;
  return (
    <div className="flex flex-col gap-3">
      <p aria-live="polite" className="sr-only">
        {count} {count === 1 ? "teacher or coach" : "teachers and coaches"} shown{cursor ? ", more available" : ""}
      </p>
      <ul className="flex flex-col gap-2" aria-label="Teachers and coaches">
        {teachers.map((t) => (
          <TeacherCard key={t.id} teacher={t} messagingState={messagingState} />
        ))}
      </ul>
      {error && <ErrorBanner message={error} />}
      {cursor && (
        <Button type="button" variant="outline" loading={pending} onClick={more} className="self-center">
          Show more
        </Button>
      )}
    </div>
  );
}

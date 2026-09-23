"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { ErrorBanner } from "@/components/ui/EmptyState";
import {
  startConversationAsTeacher,
  startConversationFromActivity,
  startConversationFromLesson,
} from "@/lib/messages/actions";

type Target =
  | { kind: "lesson"; lessonId: string }
  | { kind: "activity"; activityId: string }
  | { kind: "student"; studentId: string };

// Opens (or returns to) the conversation, then goes to it. The button only says what to open — the
// server works out who the person is and whether the rules allow it.
export function StartConversationButton({
  target,
  label,
  basePath,
  variant = "primary",
}: {
  target: Target;
  label: string;
  basePath: string;
  variant?: "primary" | "outline";
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function open() {
    setError(null);
    startTransition(async () => {
      const result =
        target.kind === "lesson"
          ? await startConversationFromLesson(target.lessonId)
          : target.kind === "activity"
            ? await startConversationFromActivity(target.activityId)
            : await startConversationAsTeacher(target.studentId);
      if (result.ok) router.push(`${basePath}/${result.conversationId}`);
      else setError(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant={variant} loading={pending} onClick={open}>
        {label}
      </Button>
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

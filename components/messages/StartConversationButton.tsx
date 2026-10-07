"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { ErrorBanner } from "@/components/ui/EmptyState";
import {
  startConversationAsStudent,
  startConversationAsTeacher,
  startConversationFromActivity,
} from "@/lib/messages/actions";

type Target =
  | { kind: "activity"; activityId: string }
  | { kind: "teacher"; teacherId: string }
  | { kind: "student"; studentId: string };

// Opens (or returns to) the conversation, then goes to it. The button only says what to open — the
// server works out who the person is and whether the rules allow it.
export function StartConversationButton({
  target,
  label,
  basePath,
  variant = "primary",
  ariaLabel,
}: {
  target: Target;
  label: string;
  basePath: string;
  variant?: "primary" | "outline";
  ariaLabel?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function open() {
    setError(null);
    startTransition(async () => {
      const result =
        target.kind === "activity"
          ? await startConversationFromActivity(target.activityId)
          : target.kind === "teacher"
            ? await startConversationAsStudent(target.teacherId)
            : await startConversationAsTeacher(target.studentId);
      if (result.ok) router.push(`${basePath}/${result.conversationId}`);
      else setError(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant={variant} loading={pending} onClick={open} aria-label={ariaLabel}>
        {label}
      </Button>
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

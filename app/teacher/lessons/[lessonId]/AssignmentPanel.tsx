"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Card, Field, Input, Textarea } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { createAssignment, gradeSubmission } from "./actions";

export interface SubmissionRow {
  id: string;
  studentName: string;
  fileName: string;
  url: string | null;
  grade: number | null;
  feedback: string | null;
}

export function CreateAssignmentForm({ lessonId }: { lessonId: string }) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <p className="mb-3 font-head text-sm font-bold">Add an assignment</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          startTransition(async () => {
            try {
              await createAssignment({ lessonId, title, instructions, dueDate });
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not create assignment.");
            }
          });
        }}
      >
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fractions Worksheet" required />
        </Field>
        <Field label="Instructions (optional)">
          <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
        <Field label="Due date (optional)">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        {error && <ErrorBanner message={error} />}
        <Button type="submit" loading={pending}>
          Create assignment
        </Button>
      </form>
    </Card>
  );
}

export function SubmissionsList({ lessonId, submissions }: { lessonId: string; submissions: SubmissionRow[] }) {
  if (submissions.length === 0) {
    return <p className="text-sm text-ink-faint">No submissions yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {submissions.map((s) => (
        <SubmissionRowItem key={s.id} lessonId={lessonId} submission={s} />
      ))}
    </div>
  );
}

function SubmissionRowItem({ lessonId, submission }: { lessonId: string; submission: SubmissionRow }) {
  const [grade, setGrade] = useState(submission.grade?.toString() ?? "");
  const [feedback, setFeedback] = useState(submission.feedback ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">{submission.studentName}</p>
          {submission.url ? (
            <a href={submission.url} download className="text-xs font-semibold text-brand-cyan-deep">
              {submission.fileName}
            </a>
          ) : (
            <p className="text-xs text-ink-faint">{submission.fileName}</p>
          )}
        </div>
      </div>
      <form
        className="mt-2 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const numGrade = Number(grade);
          if (Number.isNaN(numGrade)) {
            setError("Enter a numeric grade.");
            return;
          }
          startTransition(async () => {
            try {
              await gradeSubmission({ lessonId, submissionId: submission.id, grade: numGrade, feedback });
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not save grade.");
            }
          });
        }}
      >
        <Input className="w-20" type="number" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="Grade" />
        <Input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Feedback (optional)" />
        <Button type="submit" variant="outline" loading={pending}>
          Save
        </Button>
      </form>
      {error && <ErrorBanner message={error} />}
    </Card>
  );
}

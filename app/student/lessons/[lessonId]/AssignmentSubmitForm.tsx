"use client";

import { useState } from "react";
import { FileUploadField } from "@/components/FileUploadField";
import { Badge } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { submitAssignment } from "./actions";

export function AssignmentSubmitForm({
  assignmentId,
  lessonId,
  studentId,
  existingFileName,
  grade,
  feedback,
}: {
  assignmentId: string;
  lessonId: string;
  studentId: string;
  existingFileName: string | null;
  grade: number | null;
  feedback: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submittedName, setSubmittedName] = useState(existingFileName);
  const [saving, setSaving] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      {grade !== null ? (
        <div className="flex items-center gap-2">
          <Badge tone="success">Graded: {grade}</Badge>
          {feedback && <p className="text-xs text-ink-soft">{feedback}</p>}
        </div>
      ) : submittedName ? (
        <Badge tone="info">Submitted: {submittedName}</Badge>
      ) : (
        <Badge tone="warning">Not submitted yet</Badge>
      )}

      {grade === null && (
        <FileUploadField
          bucket="assignment-submissions"
          pathPrefix={`${assignmentId}/${studentId}`}
          label={submittedName ? "Replace file" : "Upload your work"}
          onUploaded={async (file) => {
            setSaving(true);
            setError(null);
            try {
              await submitAssignment({
                assignmentId,
                lessonId,
                storagePath: file.storagePath,
                fileName: file.fileName,
              });
              setSubmittedName(file.fileName);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not save submission.");
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
      {saving && <p className="text-xs text-ink-faint">Saving submission…</p>}
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

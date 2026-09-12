"use client";

import { useState, useTransition } from "react";
import { FileUploadField } from "@/components/FileUploadField";
import { Card } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { humanFileSize } from "@/lib/format";
import { attachMaterial, removeMaterial } from "./actions";

interface Material {
  id: string;
  file_name: string;
  file_size: number | null;
}

export function MaterialsManager({ lessonId, materials }: { lessonId: string; materials: Material[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2">
      {materials.map((m) => (
        <Card key={m.id} className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">{m.file_name}</p>
            <p className="text-xs text-ink-faint">{humanFileSize(m.file_size)}</p>
          </div>
          <button
            disabled={pending}
            onClick={() => startTransition(() => removeMaterial(lessonId, m.id))}
            className="text-xs font-semibold text-brand-red-deep disabled:opacity-50"
          >
            Remove
          </button>
        </Card>
      ))}

      <FileUploadField
        bucket="lesson-materials"
        pathPrefix={lessonId}
        label="Upload material (PDF, Word, video…)"
        onUploaded={(file) => {
          setError(null);
          startTransition(async () => {
            try {
              await attachMaterial({ lessonId, ...file });
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not save file.");
            }
          });
        }}
      />
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

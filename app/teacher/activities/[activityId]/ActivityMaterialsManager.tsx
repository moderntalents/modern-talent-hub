"use client";

import { useState, useTransition } from "react";
import { FileUploadField } from "@/components/FileUploadField";
import { Card } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { humanFileSize } from "@/lib/format";
import { attachActivityMaterial, removeActivityMaterial } from "./actions";

interface Material {
  id: string;
  file_name: string;
  file_size: number | null;
}

export function ActivityMaterialsManager({ activityId, materials }: { activityId: string; materials: Material[] }) {
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
            onClick={() => startTransition(() => removeActivityMaterial(activityId, m.id))}
            className="text-xs font-semibold text-brand-red-deep disabled:opacity-50"
          >
            Remove
          </button>
        </Card>
      ))}

      <FileUploadField
        bucket="activity-materials"
        pathPrefix={activityId}
        label="Upload material for enrolled students"
        onUploaded={(file) => {
          setError(null);
          startTransition(async () => {
            try {
              await attachActivityMaterial({ activityId, ...file });
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

"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Spinner } from "@/components/ui/EmptyState";

export interface UploadedFile {
  storagePath: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

export function FileUploadField({
  bucket,
  pathPrefix,
  accept,
  label = "Choose file",
  onUploaded,
}: {
  bucket: string;
  pathPrefix: string;
  accept?: string;
  label?: string;
  onUploaded: (file: UploadedFile) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      const supabase = createClient();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${pathPrefix}/${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } = await supabase.storage.from(bucket).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
      });

      if (uploadError) throw uploadError;

      onUploaded({
        storagePath: path,
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
        fileSize: file.size,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface-2 px-3.5 text-sm font-medium text-ink-soft hover:border-brand-cyan-deep">
        {uploading ? (
          <>
            <Spinner /> Uploading…
          </>
        ) : (
          <>📎 {label}</>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          disabled={uploading}
          onChange={handleChange}
        />
      </label>
      {error && <p className="text-xs font-medium text-brand-red-deep">{error}</p>}
    </div>
  );
}

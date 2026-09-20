"use client";

import { createClient } from "@/lib/supabase/client";

export interface UploadedFileInfo {
  storagePath: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

/**
 * Uploads each file straight from the browser to a storage bucket (so large
 * files never pass through the server's request-size limit), then calls
 * `attach` to record it against the lesson/activity. Files go under
 * `<folder>/…`, where the folder is the owning lesson/activity id — that is what
 * the storage policy checks. Never throws: returns one message per failed file,
 * so the caller can keep the created record and tell the teacher what to retry.
 */
export async function uploadAndAttach(params: {
  bucket: string;
  folder: string;
  files: File[];
  attach: (file: UploadedFileInfo) => Promise<void>;
  onProgress?: (message: string) => void;
}): Promise<string[]> {
  const supabase = createClient();
  const failures: string[] = [];

  for (let i = 0; i < params.files.length; i++) {
    const file = params.files[i];
    params.onProgress?.(`Uploading file ${i + 1} of ${params.files.length}: ${file.name}`);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${params.folder}/${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from(params.bucket)
        .upload(path, file, { cacheControl: "3600", upsert: false });
      if (uploadError) throw uploadError;

      await params.attach({
        storagePath: path,
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
        fileSize: file.size,
      });
    } catch (err) {
      failures.push(`${file.name} (${err instanceof Error ? err.message : "upload failed"})`);
    }
  }

  return failures;
}

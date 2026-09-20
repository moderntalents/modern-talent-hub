"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card, Field, Input, Select, Textarea } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { humanFileSize } from "@/lib/format";
import { validateUpload } from "@/lib/uploads";
import { attachMaterial } from "../[lessonId]/actions";
import { createLesson } from "./actions";

function PickButton({
  icon,
  label,
  accept,
  multiple,
  disabled,
  onPick,
}: {
  icon: string;
  label: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onPick: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <label className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface-2 px-3.5 text-sm font-medium text-ink-soft hover:border-brand-cyan-deep">
      {icon} {label}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          onPick(Array.from(e.target.files ?? []));
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
    </label>
  );
}

function FileRow({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
  return (
    <Card className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{file.name}</p>
        <p className="text-xs text-ink-faint">{humanFileSize(file.size)}</p>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="shrink-0 text-xs font-semibold text-brand-red-deep disabled:opacity-50"
      >
        Remove
      </button>
    </Card>
  );
}

export function NewLessonForm({ subjects }: { subjects: { id: string; name: string }[] }) {
  const router = useRouter();
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set only when the lesson was created but some files failed, so the teacher
  // can open it and add them there without creating a duplicate lesson.
  const [createdLessonId, setCreatedLessonId] = useState<string | null>(null);

  function pickVideo(picked: File[]) {
    const file = picked[0];
    if (!file) return;
    const problem = validateUpload(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setVideoFile(file);
  }

  function pickFiles(picked: File[]) {
    const accepted: File[] = [];
    const problems: string[] = [];
    for (const file of picked) {
      const problem = validateUpload(file);
      if (problem) problems.push(problem);
      else accepted.push(file);
    }
    setFiles((current) => [...current, ...accepted]);
    setError(problems.length ? problems.join(" ") : null);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    setError(null);
    setPending(true);
    try {
      const created = await createLesson(formData);
      if (created.error || !created.lessonId) {
        setError(created.error ?? "Could not create the lesson.");
        return;
      }
      const lessonId = created.lessonId;

      // Upload straight from the browser to storage (not through the server, so
      // large files aren't limited by the hosting request size), then record
      // each file against the lesson.
      const queue = [...(videoFile ? [videoFile] : []), ...files];
      const failures: string[] = [];
      const supabase = createClient();

      for (let i = 0; i < queue.length; i++) {
        const file = queue[i];
        setProgress(`Uploading file ${i + 1} of ${queue.length}: ${file.name}`);
        try {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const path = `${lessonId}/${crypto.randomUUID()}-${safeName}`;
          const { error: uploadError } = await supabase.storage
            .from("lesson-materials")
            .upload(path, file, { cacheControl: "3600", upsert: false });
          if (uploadError) throw uploadError;

          await attachMaterial({
            lessonId,
            storagePath: path,
            fileName: file.name,
            fileType: file.type || "application/octet-stream",
            fileSize: file.size,
          });
        } catch (err) {
          failures.push(`${file.name} (${err instanceof Error ? err.message : "upload failed"})`);
        }
      }

      if (failures.length > 0) {
        setCreatedLessonId(lessonId);
        setError(
          `The lesson was created, but ${failures.length} file${failures.length > 1 ? "s" : ""} couldn't be uploaded: ` +
            `${failures.join("; ")}. Open the lesson to add ${failures.length > 1 ? "them" : "it"} again.`,
        );
        return;
      }

      router.push(`/teacher/lessons/${lessonId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setPending(false);
      setProgress(null);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field label="Subject">
        <Select name="subjectId" defaultValue="" required>
          <option value="" disabled>
            Choose a CBC subject
          </option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Lesson title">
        <Input name="title" placeholder="Introducing Fractions" required />
      </Field>
      <Field label="Description (optional)">
        <Textarea name="description" placeholder="What this lesson covers" />
      </Field>

      <Field
        label="Video (optional)"
        hint="Paste a YouTube or Vimeo link, or upload a video file (MP4 works best, up to 50 MB — use a link for longer videos)."
      >
        <div className="flex flex-col gap-2">
          <Input name="videoUrl" type="url" placeholder="https://youtube.com/watch?v=…" />
          {videoFile ? (
            <FileRow file={videoFile} disabled={pending} onRemove={() => setVideoFile(null)} />
          ) : (
            <PickButton icon="🎬" label="Upload a video file" accept="video/*" disabled={pending} onPick={pickVideo} />
          )}
        </div>
      </Field>

      <Field
        label="Files (optional)"
        hint="PDF, Word, PowerPoint, Excel, images, audio and more — up to 50 MB each. Students can download them."
      >
        <div className="flex flex-col gap-2">
          {files.map((file, index) => (
            <FileRow
              key={`${file.name}-${index}`}
              file={file}
              disabled={pending}
              onRemove={() => setFiles((current) => current.filter((_, i) => i !== index))}
            />
          ))}
          <PickButton icon="📎" label="Attach files" multiple disabled={pending} onPick={pickFiles} />
        </div>
      </Field>

      {progress && <p className="text-sm font-medium text-ink-soft">{progress}…</p>}
      {error && <ErrorBanner message={error} />}

      {createdLessonId ? (
        <LinkButton href={`/teacher/lessons/${createdLessonId}`}>Open the lesson</LinkButton>
      ) : (
        <Button type="submit" loading={pending}>
          Create lesson (draft)
        </Button>
      )}
    </form>
  );
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { humanFileSize } from "@/lib/format";
import { MAX_BODY_CHARS, MESSAGE_BUCKET, PDF_MIME, validateDeclaredFile } from "@/lib/messages/rules";
import { prepareAttachmentUpload, sendMessage } from "@/lib/messages/actions";

// The message box: text, an "Attach PDF" button, and Send. The checks here are only for quick
// feedback — the server re-checks everything, including what is really inside the file.
export function Composer({ conversationId, role }: { conversationId: string; role: "student" | "teacher" }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isHomework, setIsHomework] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const homeworkLabel = role === "teacher" ? "Send as homework" : "This is my completed homework";

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = ""; // so choosing the same file again still fires
    if (!picked) return;
    const problem = validateDeclaredFile(picked);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setFile(picked);
    // A student attaching a PDF is almost always handing in homework; they can untick it.
    if (role === "student") setIsHomework(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!body.trim() && !file) {
      setError("Write a message or attach a PDF.");
      return;
    }
    setError(null);

    try {
      let attachment: { path: string; name: string } | null = null;

      if (file) {
        setBusy("Uploading PDF…");
        const ticket = await prepareAttachmentUpload({ conversationId, fileName: file.name, fileSize: file.size });
        if (!ticket.ok) throw new Error(ticket.message);

        const { error: uploadError } = await createClient()
          .storage.from(MESSAGE_BUCKET)
          .uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: PDF_MIME });
        if (uploadError) throw new Error("The upload didn't go through. Please check your connection and try again.");
        attachment = { path: ticket.path, name: file.name };
      }

      setBusy("Sending…");
      const kind = isHomework ? (role === "teacher" ? "homework" : "submission") : "message";
      const result = await sendMessage({ conversationId, body, kind, attachment });
      if (!result.ok) throw new Error(result.message);

      setBody("");
      setFile(null);
      setIsHomework(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-[var(--radius-brand)] border border-line bg-surface p-3">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={role === "student" ? "Write to your teacher…" : "Write to your student…"}
        maxLength={MAX_BODY_CHARS}
        rows={3}
        className="min-h-20"
        aria-label="Message"
        disabled={busy !== null}
      />

      {file && (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
          <span className="truncate">
            📎 {file.name} <span className="text-ink-faint">({humanFileSize(file.size)})</span>
          </span>
          <button
            type="button"
            onClick={() => {
              setFile(null);
              setIsHomework(false);
            }}
            disabled={busy !== null}
            className="shrink-0 text-xs font-semibold text-brand-red-deep"
          >
            Remove
          </button>
        </div>
      )}

      {(role === "teacher" || file) && (
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={isHomework}
            onChange={(e) => setIsHomework(e.target.checked)}
            disabled={busy !== null}
            className="h-4 w-4"
          />
          {homeworkLabel}
        </label>
      )}

      {error && <ErrorBanner message={error} />}

      <div className="flex items-center justify-between gap-2">
        <label
          className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink hover:border-brand-cyan-deep ${busy ? "pointer-events-none opacity-50" : ""}`}
        >
          📎 Attach PDF
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden" onChange={pickFile} disabled={busy !== null} />
        </label>
        <Button type="submit" loading={busy !== null}>
          {busy ?? "Send"}
        </Button>
      </div>
      <p className="text-xs text-ink-faint">PDF only, up to 10 MB.</p>
    </form>
  );
}

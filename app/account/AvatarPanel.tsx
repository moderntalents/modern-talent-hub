"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { prepareAvatarImage } from "@/lib/avatars/client";
import { AVATAR_BUCKET } from "@/lib/avatars/rules";
import { prepareAvatarUpload, removeAvatar, saveAvatar } from "@/lib/avatars/actions";

// The "Profile picture" section of Settings, for coaches. Pick a photo → it is cut to a square and
// shrunk in the browser → a preview is shown → "Save photo" uploads it to a one-time link the server
// issued and asks the server to check it and make it the profile picture. The checks here are only for
// quick feedback — the server re-checks the file it receives.
export function AvatarPanel({ name, currentSrc }: { name: string; currentSrc: string | null }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<{ blob: Blob; previewUrl: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Free the preview picture's memory when it is replaced or the page closes.
  const previewUrl = draft?.previewUrl;
  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = ""; // so choosing the same file again still fires
    if (!picked || busy) return;
    setError(null);
    setNotice(null);
    setConfirmingRemove(false);
    setBusy("Preparing your photo…");
    try {
      const prepared = await prepareAvatarImage(picked);
      if (!prepared.ok) setError(prepared.message);
      else setDraft({ blob: prepared.blob, previewUrl: prepared.previewUrl });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!draft || busy) return;
    setError(null);
    try {
      setBusy("Uploading…");
      const ticket = await prepareAvatarUpload({ contentType: "image/jpeg", size: draft.blob.size });
      if (!ticket.ok) throw new Error(ticket.message);

      const { error: uploadError } = await createClient()
        .storage.from(AVATAR_BUCKET)
        .uploadToSignedUrl(ticket.path, ticket.token, draft.blob, { contentType: "image/jpeg" });
      if (uploadError) throw new Error("The upload didn't go through. Please check your connection and try again.");

      setBusy("Saving…");
      const saved = await saveAvatar({ path: ticket.path });
      if (!saved.ok) throw new Error(saved.message);

      setDraft(null);
      setNotice("Your profile picture has been updated.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setError(null);
    setBusy("Removing…");
    try {
      const result = await removeAvatar();
      if (!result.ok) throw new Error(result.message);
      setConfirmingRemove(false);
      setNotice("Your profile picture has been removed.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const hasPicture = !!currentSrc;
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-head text-sm font-bold uppercase tracking-wide text-ink-faint">Profile picture</h2>
      <div className="flex items-center gap-4">
        <Avatar name={name} src={draft ? draft.previewUrl : currentSrc} size="xl" />
        <p className="text-sm text-ink-soft">
          Students see your picture in the coach list, on your profile and in messages. Use a clear photo of your face.
        </p>
      </div>

      <input
        ref={fileInput}
        id="avatar-file"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/*"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a profile picture"
        onChange={pick}
      />

      {draft ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={save} loading={!!busy && busy !== "Preparing your photo…"} disabled={!!busy}>
            Save photo
          </Button>
          <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} disabled={!!busy}>
            Choose a different photo
          </Button>
          <Button type="button" variant="ghost" onClick={() => setDraft(null)} disabled={!!busy}>
            Cancel
          </Button>
        </div>
      ) : confirmingRemove ? (
        <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
          <p className="text-sm font-semibold">Remove your profile picture?</p>
          <p className="text-xs text-ink-soft">Students will see your initials instead. You can add a photo again at any time.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="danger" onClick={remove} loading={!!busy}>
              Yes, remove it
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirmingRemove(false)} disabled={!!busy}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} loading={busy === "Preparing your photo…"} disabled={!!busy}>
            {hasPicture ? "Change photo" : "Upload photo"}
          </Button>
          {hasPicture && (
            <Button type="button" variant="ghost" onClick={() => setConfirmingRemove(true)} disabled={!!busy}>
              Remove photo
            </Button>
          )}
        </div>
      )}

      <p role="status" aria-live="polite" className="text-xs text-ink-faint empty:hidden">
        {busy ?? ""}
      </p>
      {notice && !error && (
        <p role="status" className="rounded-xl bg-success-tint px-4 py-3 text-sm font-medium text-[var(--success-text)]">
          {notice}
        </p>
      )}
      {error && (
        <div role="alert">
          <ErrorBanner message={error} />
        </div>
      )}
      <p className="text-xs text-ink-faint">JPG, PNG or WebP. Your photo is cropped to a square and made smaller automatically.</p>
    </Card>
  );
}

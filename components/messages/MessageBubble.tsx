"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Badge, Textarea } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { humanFileSize } from "@/lib/format";
import { formatMessageTime } from "@/lib/messages/time";
import { DELETED_MESSAGE_TEXT, MAX_BODY_CHARS } from "@/lib/messages/rules";
import { deleteMessage, editMessage } from "@/lib/messages/actions";
import type { ThreadMessage } from "@/lib/messages/queries";

// One message in the conversation, shared by the student and teacher screens.
//
// The ⋮ menu, inline editing and delete confirmation appear ONLY on the signed-in person's own
// messages. That is a convenience, not the protection: the server and the database refuse to change
// anyone else's message however this page is used (see lib/messages/service.ts and
// supabase/migrations/0018_message_edit_delete.sql).
//
// `canEdit` is false while the conversation can't take new messages (closed, or paused for an age
// check). Editing is switched off then, exactly like the message box; deleting your own message
// stays available.
export function MessageBubble({ message: m, canEdit }: { message: ThreadMessage; canEdit: boolean }) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Shown straight after a save/delete so nothing flickers back while the page refreshes. Each is
  // ignored as soon as the refreshed message arrives (the key below changes).
  const [savedText, setSavedText] = useState<{ key: string; body: string } | null>(null);
  const [deletedHere, setDeletedHere] = useState(false);

  const menuWrap = useRef<HTMLDivElement>(null);
  const kebab = useRef<HTMLButtonElement>(null);

  const key = `${m.body}|${m.editedAt ?? ""}`;
  const justSaved = savedText && savedText.key === key ? savedText : null;
  const body = justSaved ? justSaved.body : m.body;
  const isEdited = justSaved !== null || m.editedAt !== null;
  const isDeleted = m.deleted || deletedHere;

  // Close the ⋮ menu on an outside tap/click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!menuWrap.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        kebab.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const align = m.fromMe ? "justify-end" : "justify-start";

  if (isDeleted) {
    return (
      <div className={`flex ${align}`} data-message-id={m.id} data-deleted="true">
        <div className="flex max-w-[85%] flex-col gap-1 rounded-2xl border border-dashed border-line px-3.5 py-2.5 text-sm text-ink-faint">
          <p className="italic">{DELETED_MESSAGE_TEXT}</p>
          <p className="text-[11px]">{formatMessageTime(m.createdAt)}</p>
        </div>
      </div>
    );
  }

  function startEdit() {
    setDraft(body);
    setEditError(null);
    setMenuOpen(false);
    setEditing(true);
  }

  function cancelEdit() {
    if (saving) return;
    setEditing(false);
    setEditError(null);
    kebab.current?.focus();
  }

  async function saveEdit() {
    if (saving) return;
    const next = draft.trim();
    if (next === body.trim()) {
      setEditing(false); // nothing changed: not an edit, so no "Edited" label
      return;
    }
    if (!next && !m.attachmentName) {
      setEditError("A message can't be empty. Write something, or delete the message instead.");
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      const result = await editMessage({ messageId: m.id, body: draft });
      if (!result.ok) {
        setEditError(result.message);
        return;
      }
      setSavedText({ key, body: next });
      setEditing(false);
      router.refresh();
    } catch {
      setEditError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteMessage(m.id);
      if (!result.ok) {
        setDeleteError(result.message);
        return;
      }
      setConfirming(false);
      setDeletedHere(true);
      router.refresh();
    } catch {
      setDeleteError("Something went wrong. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  function closeDialog() {
    if (deleting) return;
    setConfirming(false);
    setDeleteError(null);
    kebab.current?.focus();
  }

  return (
    <div className={`flex ${align}`} data-message-id={m.id}>
      <div
        className={`flex flex-col gap-1.5 rounded-2xl px-3.5 py-2.5 text-sm ${editing ? "w-[85%]" : "max-w-[85%]"} ${
          m.fromMe ? "bg-[var(--info-tint)] text-ink" : "border border-line bg-surface text-ink"
        }`}
      >
        {m.kind === "homework" && <Badge tone="warning">📚 Homework</Badge>}
        {m.kind === "submission" && <Badge tone="success">✅ Completed homework</Badge>}

        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") cancelEdit();
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void saveEdit();
              }}
              maxLength={MAX_BODY_CHARS}
              rows={3}
              className="min-h-20"
              aria-label="Edit your message"
              disabled={saving}
              autoFocus
            />
            {editError && <ErrorBanner message={editError} />}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={cancelEdit} disabled={saving}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void saveEdit()} loading={saving}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          body && <p className="whitespace-pre-wrap break-words">{body}</p>
        )}

        {m.attachmentName && (
          <a
            href={`/api/messages/attachment/${m.id}`}
            className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 font-semibold text-brand-cyan-deep"
          >
            <span>📄</span>
            <span className="min-w-0 flex-1 truncate">{m.attachmentName}</span>
            <span className="shrink-0 text-xs font-normal text-ink-faint">{humanFileSize(m.attachmentSize)}</span>
            <span className="shrink-0 text-xs">Download</span>
          </a>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-ink-faint">
            {formatMessageTime(m.createdAt)}
            {isEdited && (
              <span title={m.editedAt ? `Edited ${formatMessageTime(m.editedAt)}` : undefined}>{" · Edited"}</span>
            )}
          </p>

          {m.fromMe && !editing && (
            <div ref={menuWrap} className="relative -my-2 -mr-1.5">
              <button
                ref={kebab}
                type="button"
                aria-label="Message options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-ink-soft hover:bg-surface-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-cyan-deep"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
                  <circle cx="8" cy="3" r="1.4" />
                  <circle cx="8" cy="8" r="1.4" />
                  <circle cx="8" cy="13" r="1.4" />
                </svg>
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  aria-label="Message options"
                  className="absolute bottom-full right-0 z-20 mb-1 flex min-w-36 flex-col overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow)]"
                >
                  {canEdit && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={startEdit}
                      className="min-h-11 px-4 text-left text-sm font-medium text-ink hover:bg-surface-2"
                    >
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setDeleteError(null);
                      setConfirming(true);
                    }}
                    className="min-h-11 px-4 text-left text-sm font-medium text-brand-red-deep hover:bg-surface-2"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {confirming && (
        <DeleteDialog
          hasFile={Boolean(m.attachmentName)}
          busy={deleting}
          error={deleteError}
          onCancel={closeDialog}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}

function DeleteDialog({
  hasFile,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  hasFile: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  // The latest values, read by the key handler below without re-running the set-up effect (which
  // would move focus back to Cancel every time `busy` changes).
  const latest = useRef({ busy, onCancel });
  useEffect(() => {
    latest.current = { busy, onCancel };
  });

  // Open on the safe choice, keep Tab inside the dialog, close on Escape, and stop the page behind
  // from scrolling while it is open.
  useEffect(() => {
    cancelButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!latest.current.busy) latest.current.onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = panel.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-message-title"
        aria-describedby="delete-message-text"
        className="flex w-full max-w-sm flex-col gap-3 rounded-[var(--radius-brand)] border border-line bg-surface p-5 shadow-[var(--shadow)]"
      >
        <h2 id="delete-message-title" className="font-head text-lg font-extrabold text-ink">
          Delete this message?
        </h2>
        <p id="delete-message-text" className="text-sm text-ink-soft">
          It will be removed for both of you, and the other person will see &ldquo;{DELETED_MESSAGE_TEXT}&rdquo;.
          {hasFile ? " The attached PDF will be removed too." : ""} This can&apos;t be undone.
        </p>
        {error && <ErrorBanner message={error} />}
        <div className="flex justify-end gap-2">
          <Button ref={cancelButton} type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} loading={busy}>
            Delete
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

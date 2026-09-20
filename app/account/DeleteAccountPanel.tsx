"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card, Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { deleteMyAccount } from "./actions";

export function DeleteAccountPanel({ role }: { role: "student" | "teacher" }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    setPending(true);
    setError(null);
    try {
      const result = await deleteMyAccount(text);
      if (!result.ok) {
        setError(result.message);
        setPending(false);
        return;
      }
      // The account is gone; clear this device's copy of the login too.
      try {
        await createClient().auth.signOut({ scope: "local" });
      } catch {
        /* the login no longer exists on the server — nothing to undo */
      }
      window.location.assign("/account-deleted");
    } catch {
      setError("Network problem — check your connection and try again.");
      setPending(false);
    }
  }

  if (!open) {
    return (
      <Card className="flex flex-col gap-3">
        <div>
          <h2 className="font-head text-base font-bold">Delete my account</h2>
          <p className="text-sm text-ink-soft">
            Permanently remove your account and the personal information linked to it.
          </p>
        </div>
        <div>
          <Button variant="danger" onClick={() => setOpen(true)}>
            Delete my account…
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 border-brand-red-deep">
      <div>
        <h2 className="font-head text-base font-bold text-brand-red-deep">Delete my account</h2>
        <p className="mt-1 text-sm text-ink-soft">This happens immediately and <strong>cannot be undone</strong>.</p>
      </div>

      <div>
        <p className="mb-1 text-sm font-semibold">What will be deleted</p>
        <ul className="ml-5 list-disc space-y-1 text-sm text-ink-soft">
          <li>Your login, name, email and phone number.</li>
          <li>Your grade, school and any details you added.</li>
          <li>Files you uploaded, your activity enrolments and live-class records.</li>
          {role === "teacher" && (
            <>
              <li>Your activities and their files, and any draft lessons.</li>
              <li>
                Lessons you <strong>published</strong> stay for students, but your name and details are removed from them.
              </li>
              <li>You need to withdraw any money left in your wallet first.</li>
            </>
          )}
        </ul>
        <p className="mt-2 text-sm text-ink-soft">
          Payment records, if you have any, are kept without your name or email, as the law requires.
        </p>
      </div>

      <Field label="Type DELETE to confirm">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="DELETE"
          autoCapitalize="characters"
          autoComplete="off"
          disabled={pending}
        />
      </Field>

      {error && <ErrorBanner message={error} />}

      <div className="flex flex-wrap gap-2">
        <Button variant="danger" loading={pending} disabled={text.trim() !== "DELETE"} onClick={confirmDelete}>
          Permanently delete my account
        </Button>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setText("");
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </Card>
  );
}

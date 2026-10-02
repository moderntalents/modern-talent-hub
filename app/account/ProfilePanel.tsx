"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card, Field, Input, Textarea } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { PROFILE_LIMITS, type EditableRole, type ProfileInput } from "@/lib/profile-edit";
import { saveMyProfile } from "./profile-actions";

type Errors = Partial<Record<keyof ProfileInput, string>>;

// The Profile section of Settings: shows the saved details, and "Edit profile" opens the same card as
// a form. Checks here are only for the error messages — the server re-checks everything.
export function ProfilePanel({
  role,
  initial,
  showPhone,
  phoneOptional,
}: {
  role: EditableRole;
  initial: ProfileInput;
  showPhone: boolean; // false for under-13s, who are never asked for a phone number
  phoneOptional: boolean; // same rule as sign-up: only adults (not admins) must give one
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ProfileInput>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [saved, setSaved] = useState(false);

  const set = (key: keyof ProfileInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setErrors({});
    try {
      const result = await saveMyProfile(form);
      if (!result.ok) {
        setError(result.message);
        setErrors(result.errors ?? {});
        return;
      }
      setEditing(false);
      setSaved(true);
      router.refresh();
    } catch {
      setError("Network problem — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  const heading = <h2 className="mb-2 font-head text-sm font-bold uppercase tracking-wide text-ink-faint">Profile</h2>;

  if (!editing) {
    const details: [string, string][] = [];
    if (showPhone && initial.phone) details.push(["Phone", initial.phone]);
    if (role === "student") {
      if (initial.grade) details.push(["Grade/class", initial.grade]);
      if (initial.schoolName) details.push(["School", initial.schoolName]);
    }
    if (role === "teacher") {
      if (initial.specialty) details.push(["What I teach", initial.specialty]);
      if (initial.bio) details.push(["Bio", initial.bio]);
    }

    return (
      <Card className="flex flex-col gap-1">
        {heading}
        <p className="font-semibold">{initial.fullName}</p>
        <p className="text-xs capitalize text-ink-faint">{role}</p>
        {details.map(([label, value]) => (
          <p key={label} className="whitespace-pre-wrap break-words text-sm text-ink-soft">
            <span className="text-ink-faint">{label}:</span> {value}
          </p>
        ))}
        {saved && (
          <p className="mt-2 rounded-xl bg-success-tint px-4 py-3 text-sm font-medium text-[var(--success-text)]">
            Your profile has been saved.
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setForm(initial);
            setSaved(false);
            setEditing(true);
          }}
          className="mt-2 w-fit"
        >
          Edit profile
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      {heading}
      <form onSubmit={save} className="flex flex-col gap-3" noValidate>
        <Field label="Full name" htmlFor="profile-name" error={errors.fullName}>
          <Input
            id="profile-name"
            value={form.fullName}
            onChange={set("fullName")}
            maxLength={PROFILE_LIMITS.fullName}
            autoComplete="name"
            disabled={saving}
          />
        </Field>

        {showPhone && (
          <Field
            label="Phone number"
            htmlFor="profile-phone"
            error={errors.phone}
            hint={phoneOptional ? "Optional." : undefined}
          >
            <Input
              id="profile-phone"
              type="tel"
              value={form.phone}
              onChange={set("phone")}
              maxLength={PROFILE_LIMITS.phone}
              autoComplete="tel"
              placeholder="07XX XXX XXX"
              disabled={saving}
            />
          </Field>
        )}

        {role === "student" && (
          <>
            <Field label="Grade/class" htmlFor="profile-grade" error={errors.grade}>
              <Input
                id="profile-grade"
                value={form.grade}
                onChange={set("grade")}
                maxLength={PROFILE_LIMITS.grade}
                placeholder="Grade 6"
                disabled={saving}
              />
            </Field>
            <Field label="School (optional)" htmlFor="profile-school" error={errors.schoolName}>
              <Input
                id="profile-school"
                value={form.schoolName}
                onChange={set("schoolName")}
                maxLength={PROFILE_LIMITS.schoolName}
                disabled={saving}
              />
            </Field>
          </>
        )}

        {role === "teacher" && (
          <>
            <Field label="What you teach" htmlFor="profile-specialty" error={errors.specialty}>
              <Input
                id="profile-specialty"
                value={form.specialty}
                onChange={set("specialty")}
                maxLength={PROFILE_LIMITS.specialty}
                placeholder="Karate, Piano, Coding…"
                disabled={saving}
              />
            </Field>
            <Field label="Bio (optional)" htmlFor="profile-bio" error={errors.bio}>
              <Textarea
                id="profile-bio"
                value={form.bio}
                onChange={set("bio")}
                maxLength={PROFILE_LIMITS.bio}
                rows={4}
                disabled={saving}
              />
            </Field>
          </>
        )}

        {error && <ErrorBanner message={error} />}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setEditing(false);
              setError(null);
              setErrors({});
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

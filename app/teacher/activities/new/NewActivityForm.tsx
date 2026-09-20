"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ACTIVITY_CATEGORIES, type ActivityCategoryId } from "@/lib/constants";
import { Button, LinkButton } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { FileRow, PickButton } from "@/components/UploadPickers";
import { ModeToggle, ScheduleFields } from "@/components/live/LiveModeFields";
import { uploadAndAttach } from "@/lib/upload-client";
import { validateUpload } from "@/lib/uploads";
import { attachActivityMaterial } from "../[activityId]/actions";
import { createActivity } from "./actions";

export function NewActivityForm() {
  const router = useRouter();
  const [categoryId, setCategoryId] = useState<ActivityCategoryId>(ACTIVITY_CATEGORIES[0].id);
  const [billing, setBilling] = useState("month");
  const category = ACTIVITY_CATEGORIES.find((c) => c.id === categoryId)!;

  const [mode, setMode] = useState<"regular" | "live">("regular");
  const [scheduledLocal, setScheduledLocal] = useState("");
  const [duration, setDuration] = useState(60);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set only when the activity was created but some files failed, so the teacher
  // can open it and add them there without creating a duplicate listing.
  const [createdActivityId, setCreatedActivityId] = useState<string | null>(null);

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

    if (mode === "live") {
      const time = Date.parse(scheduledLocal);
      if (!scheduledLocal || Number.isNaN(time)) {
        setError("Choose the date and time for the live class.");
        return;
      }
      // The browser knows the teacher's timezone; send an unambiguous instant.
      formData.set("activityMode", "live");
      formData.set("scheduledAt", new Date(time).toISOString());
      formData.set("durationMinutes", String(duration));
    }

    setPending(true);
    try {
      const created = await createActivity(formData);
      if (created.error || !created.activityId) {
        setError(created.error ?? "Could not create the activity.");
        return;
      }
      const activityId = created.activityId;

      const failures = await uploadAndAttach({
        bucket: "activity-materials",
        folder: activityId,
        files: [...(mode === "regular" && videoFile ? [videoFile] : []), ...files],
        attach: (file) => attachActivityMaterial({ activityId, ...file }),
        onProgress: setProgress,
      });

      if (failures.length > 0) {
        setCreatedActivityId(activityId);
        setError(
          `The activity was created, but ${failures.length} file${failures.length > 1 ? "s" : ""} couldn't be uploaded: ` +
            `${failures.join("; ")}. Open the activity to add ${failures.length > 1 ? "them" : "it"} again.`,
        );
        return;
      }

      router.push(`/teacher/activities/${activityId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setPending(false);
      setProgress(null);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field label="Activity type">
        <ModeToggle
          value={mode}
          onChange={setMode}
          disabled={pending}
          options={[
            { value: "regular", label: "Regular activity" },
            { value: "live", label: "Live activity" },
          ]}
        />
      </Field>

      <Field label="Category">
        <Select
          name="category"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value as ActivityCategoryId)}
        >
          {ACTIVITY_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Activity">
        <Select name="activityType" defaultValue="">
          <option value="" disabled>
            Choose an activity
          </option>
          {category.activities.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Listing title">
        <Input name="title" placeholder="Karate Fundamentals — Beginners" required />
      </Field>
      <Field label="Description (optional)">
        <Textarea name="description" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Level (optional)">
          <Input name="level" placeholder="Beginner–Intermediate" />
        </Field>
        <Field label="Age range (optional)">
          <Input name="ageRange" placeholder="6–15" />
        </Field>
      </div>
      <Field label="Location (optional)">
        <Input name="location" placeholder="Nairobi" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Billing">
          <Select name="billing" value={billing} onChange={(e) => setBilling(e.target.value)}>
            <option value="month">Per month</option>
            <option value="week">Per week</option>
            <option value="lesson">Per lesson</option>
            <option value="day">Per day</option>
            <option value="one-time">One-time</option>
            <option value="free">Free</option>
          </Select>
        </Field>
        <Field label="Price (KSh)">
          <Input name="price" type="number" min={0} disabled={billing === "free"} placeholder="2800" />
        </Field>
      </div>

      {mode === "live" ? (
        <ScheduleFields
          dateTime={scheduledLocal}
          duration={duration}
          onDateTime={setScheduledLocal}
          onDuration={setDuration}
          disabled={pending}
        />
      ) : (
        <Field
          label="Video (optional)"
          hint="Upload a video for your students to watch (MP4 works best, up to 50 MB). Only enrolled students can see it."
        >
          {videoFile ? (
            <FileRow file={videoFile} disabled={pending} onRemove={() => setVideoFile(null)} />
          ) : (
            <PickButton icon="🎬" label="Upload a video file" accept="video/*" disabled={pending} onPick={pickVideo} />
          )}
        </Field>
      )}

      <Field
        label="Files (optional)"
        hint="PDF, Word, PowerPoint, Excel, images, audio and more — up to 50 MB each. Enrolled students can download them."
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

      {mode === "live" && (
        <p className="text-xs text-ink-faint">
          Enrolled students see this as UPCOMING once you publish the activity, and can join after you press Start on the
          activity page.
        </p>
      )}

      {progress && <p className="text-sm font-medium text-ink-soft">{progress}…</p>}
      {error && <ErrorBanner message={error} />}

      {createdActivityId ? (
        <LinkButton href={`/teacher/activities/${createdActivityId}`}>Open the activity</LinkButton>
      ) : (
        <Button type="submit" loading={pending}>
          {mode === "live" ? "Schedule live activity (draft)" : "Create activity (draft)"}
        </Button>
      )}
    </form>
  );
}

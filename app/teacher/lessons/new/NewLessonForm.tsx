"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { createLesson, type FormState } from "./actions";

const initialState: FormState = {};

export function NewLessonForm({ subjects }: { subjects: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(createLesson, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
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
      <Field label="Video URL (optional)" hint="A link to a hosted video (YouTube, Vimeo, or your own storage URL).">
        <Input name="videoUrl" type="url" placeholder="https://…" />
      </Field>

      {state?.error && <ErrorBanner message={state.error} />}

      <Button type="submit" loading={pending}>
        Create lesson (draft)
      </Button>
    </form>
  );
}

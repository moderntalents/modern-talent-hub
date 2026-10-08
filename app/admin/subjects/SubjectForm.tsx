"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { EDUCATION_LEVELS, SENIOR_PATHWAYS, SUBJECT_COLORS } from "@/lib/education";
import { SUBJECT_LIMITS } from "@/lib/subjects-admin";
import { addSubject, updateSubject, type SubjectActionState } from "./actions";

export type SubjectFormValues = {
  id?: string;
  name: string;
  level: string;
  pathway: string | null;
  description: string | null;
  color: string;
  order_index: number;
};

/** Add (no id) or edit (with id) one subject. */
export function SubjectForm({ initial, defaultLevel }: { initial?: SubjectFormValues; defaultLevel?: string }) {
  const editing = Boolean(initial?.id);
  const [state, formAction, pending] = useActionState<SubjectActionState, FormData>(
    editing ? updateSubject : addSubject,
    null,
  );
  const [level, setLevel] = useState(initial?.level ?? defaultLevel ?? "primary");
  const errors = state?.errors ?? {};
  const prefix = initial?.id ?? "new";

  return (
    <form action={formAction} className="flex flex-col gap-3" key={state?.ok && !editing ? state.message : undefined}>
      {editing && <input type="hidden" name="id" value={initial!.id} />}
      <Field label="Subject name" htmlFor={`${prefix}-name`} error={errors.name}>
        <Input
          id={`${prefix}-name`}
          name="name"
          defaultValue={initial?.name ?? ""}
          maxLength={SUBJECT_LIMITS.name}
          required
          disabled={pending}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="School level" htmlFor={`${prefix}-level`} error={errors.level}>
          <Select
            id={`${prefix}-level`}
            name="level"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            disabled={pending}
          >
            {EDUCATION_LEVELS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name} ({l.grades})
              </option>
            ))}
          </Select>
        </Field>
        {level === "senior" ? (
          <Field label="Pathway (optional)" htmlFor={`${prefix}-pathway`} error={errors.pathway}>
            <Select id={`${prefix}-pathway`} name="pathway" defaultValue={initial?.pathway ?? ""} disabled={pending}>
              <option value="">No pathway</option>
              {SENIOR_PATHWAYS.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <input type="hidden" name="pathway" value="" />
        )}
      </div>
      <Field label="Description (optional)" htmlFor={`${prefix}-description`} error={errors.description}>
        <Textarea
          id={`${prefix}-description`}
          name="description"
          defaultValue={initial?.description ?? ""}
          maxLength={SUBJECT_LIMITS.description}
          disabled={pending}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Colour" htmlFor={`${prefix}-color`} error={errors.color}>
          <Select id={`${prefix}-color`} name="color" defaultValue={initial?.color ?? "cyan"} disabled={pending}>
            {SUBJECT_COLORS.map((c) => (
              <option key={c} value={c}>
                {c[0].toUpperCase() + c.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Order" htmlFor={`${prefix}-order`} error={errors.order} hint="Lower numbers show first.">
          <Input
            id={`${prefix}-order`}
            name="order"
            type="number"
            inputMode="numeric"
            min={SUBJECT_LIMITS.orderMin}
            max={SUBJECT_LIMITS.orderMax}
            defaultValue={initial?.order_index ?? 0}
            disabled={pending}
          />
        </Field>
      </div>
      {state && !state.ok && <ErrorBanner message={state.message} />}
      {state?.ok && <p className="text-sm font-semibold text-[var(--success-text)]">{state.message}</p>}
      <div>
        <Button type="submit" loading={pending}>
          {editing ? "Save changes" : "Add subject"}
        </Button>
      </div>
    </form>
  );
}

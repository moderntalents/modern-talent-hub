"use client";

import { useActionState, useState } from "react";
import { ACTIVITY_CATEGORIES, type ActivityCategoryId } from "@/lib/constants";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { createActivity, type FormState } from "./actions";

const initialState: FormState = {};

export function NewActivityForm() {
  const [state, formAction, pending] = useActionState(createActivity, initialState);
  const [categoryId, setCategoryId] = useState<ActivityCategoryId>(ACTIVITY_CATEGORIES[0].id);
  const [billing, setBilling] = useState("month");
  const category = ACTIVITY_CATEGORIES.find((c) => c.id === categoryId)!;

  return (
    <form action={formAction} className="flex flex-col gap-4">
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

      {state?.error && <ErrorBanner message={state.error} />}

      <Button type="submit" loading={pending}>
        Create activity (draft)
      </Button>
    </form>
  );
}

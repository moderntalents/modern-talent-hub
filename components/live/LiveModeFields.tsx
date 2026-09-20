"use client";

import { Field, Input, Select } from "@/components/ui/Card";
import { DURATION_OPTIONS } from "@/lib/live/status";

// The "Recorded / Live" switch and the schedule fields, shared by the New lesson
// and New activity forms. The toggle looks like the Student/Teacher switch on signup.

export function ModeToggle<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`min-h-11 rounded-xl border text-sm font-semibold disabled:opacity-50 ${
            value === option.value
              ? "border-brand-cyan-deep bg-brand-cyan text-ink"
              : "border-line bg-surface text-ink-soft"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ScheduleFields({
  dateTime,
  duration,
  onDateTime,
  onDuration,
  disabled,
}: {
  dateTime: string;
  duration: number;
  onDateTime: (value: string) => void;
  onDuration: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Date and time" hint="Your local time.">
        <Input
          type="datetime-local"
          value={dateTime}
          onChange={(e) => onDateTime(e.target.value)}
          disabled={disabled}
          required
        />
      </Field>
      <Field label="Duration">
        <Select value={duration} onChange={(e) => onDuration(Number(e.target.value))} disabled={disabled}>
          {DURATION_OPTIONS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} minutes
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

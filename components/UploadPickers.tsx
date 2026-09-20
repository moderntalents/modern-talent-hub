"use client";

import { useRef } from "react";
import { Card } from "@/components/ui/Card";
import { humanFileSize } from "@/lib/format";

// Small building blocks for "choose files, then upload when the form is saved"
// (used by the New lesson and New activity forms).

export function PickButton({
  icon,
  label,
  accept,
  multiple,
  disabled,
  onPick,
}: {
  icon: string;
  label: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onPick: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <label className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface-2 px-3.5 text-sm font-medium text-ink-soft hover:border-brand-cyan-deep">
      {icon} {label}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          onPick(Array.from(e.target.files ?? []));
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
    </label>
  );
}

export function FileRow({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
  return (
    <Card className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{file.name}</p>
        <p className="text-xs text-ink-faint">{humanFileSize(file.size)}</p>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="shrink-0 text-xs font-semibold text-brand-red-deep disabled:opacity-50"
      >
        Remove
      </button>
    </Card>
  );
}

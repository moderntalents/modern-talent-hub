"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MAX_SEARCH_CHARS, normalizeSearch } from "@/lib/directory/rules";
import { Spinner } from "@/components/ui/EmptyState";

const DEBOUNCE_MS = 300;

/**
 * The "Search teachers or coaches..." box. Typing updates the address (?q=...), and the server page
 * re-runs the search in the database — nothing is filtered in the browser. Works without JavaScript
 * too: it is a plain GET form, so Enter still searches.
 */
export function DirectorySearch({
  initialQuery,
  placeholder = "Search teachers or coaches...",
}: {
  initialQuery: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlQuery = normalizeSearch(params.get("q") ?? "");
  const [value, setValue] = useState(initialQuery);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last search THIS box put into the address. An address that says something else was changed
  // from outside (Back/Forward, a link), so the box must follow it.
  const lastPushed = useRef(initialQuery);

  useEffect(() => {
    if (urlQuery !== lastPushed.current) {
      lastPushed.current = urlQuery;
      if (timer.current) clearTimeout(timer.current);
      setValue(urlQuery);
    }
  }, [urlQuery]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  function go(text: string) {
    const q = normalizeSearch(text);
    if (q === lastPushed.current && q === urlQuery) return;
    lastPushed.current = q;
    startTransition(() => {
      // Keep the page's other choices (the subject/activity picked) and change only the search text.
      const next = new URLSearchParams(params.toString());
      if (q) next.set("q", q);
      else next.delete("q");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  function onChange(text: string) {
    setValue(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => go(text), DEBOUNCE_MS);
  }

  return (
    <form
      role="search"
      action={pathname}
      method="get"
      onSubmit={(e) => {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        go(value);
      }}
    >
      <label htmlFor="teacher-search" className="sr-only">
        {placeholder.replace(/\.+$/, "")}
      </label>
      {/* Without JavaScript the form reloads the page, so carry the other choices along. */}
      {[...params.entries()]
        .filter(([key]) => key !== "q")
        .map(([key, val]) => (
          <input key={key} type="hidden" name={key} value={val} />
        ))}
      <div className="relative">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          id="teacher-search"
          ref={inputRef}
          name="q"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={MAX_SEARCH_CHARS}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="min-h-12 w-full rounded-full border border-line bg-surface pl-10 pr-11 text-sm text-ink outline-none focus:border-brand-cyan-deep"
        />
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center">
          {pending ? (
            <Spinner />
          ) : value ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setValue("");
                if (timer.current) clearTimeout(timer.current);
                go("");
                inputRef.current?.focus();
              }}
              className="flex h-7 w-7 items-center justify-center rounded-full text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <span aria-hidden="true">✕</span>
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

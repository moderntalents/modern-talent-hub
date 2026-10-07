"use client";

import { useEffect, useRef, useState } from "react";
import { initialsOf } from "@/lib/directory/rules";

const SIZES = {
  md: "h-12 w-12 text-base",
  lg: "h-16 w-16 text-xl",
  xl: "h-28 w-28 text-4xl",
} as const;

/**
 * A person's picture, or — when they have none, or it fails to load — their initials on the
 * Modern Talent Hub tint, so every card looks the same shape and a face is easy to spot.
 * `src` must already be a vetted address (see avatarSrc in lib/directory/rules.ts).
 */
export function Avatar({
  name,
  src,
  size = "lg",
  className = "",
}: {
  name: string;
  src?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showPhoto = !!src && failedSrc !== src;
  const imgRef = useRef<HTMLImageElement>(null);

  // The browser can give up on a picture before this page has finished loading in the browser, in
  // which case onError never fires. If the picture is already finished, ask whether it is usable.
  useEffect(() => {
    const el = imgRef.current;
    if (!el || !el.complete) return; // still loading: onError will say if it fails
    el.decode().catch(() => setFailedSrc(src ?? null));
  }, [src]);
  const base = `relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full ${SIZES[size]} ${className}`;

  if (showPhoto) {
    return (
      // A plain <img>: the picture lives in Supabase Storage and is already sized for the web, and the
      // fallback below needs the browser's own load-error event.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={imgRef}
        src={src}
        alt={`Photo of ${name}`}
        data-avatar="photo"
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(src)}
        className={`${base} border border-line object-cover`}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={name}
      data-avatar="initials"
      className={`${base} bg-[var(--info-tint)] font-head font-extrabold text-[var(--info-text)]`}
    >
      {initialsOf(name)}
    </span>
  );
}

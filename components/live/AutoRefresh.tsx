"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Re-runs the page's server data every few seconds, so an UPCOMING class turns
// LIVE (and a teacher's participant list grows) without anyone reloading.
export function AutoRefresh({ seconds, enabled = true }: { seconds: number; enabled?: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds, enabled]);

  return null;
}

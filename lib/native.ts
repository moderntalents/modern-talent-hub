"use client";

import { useSyncExternalStore } from "react";

// The Android app (Capacitor) adds "MTHApp" to the browser identity — see
// `android.appendUserAgent` in capacitor.config.ts. Everywhere else (websites,
// desktop, phone browsers) this is false and nothing changes.
//
// useSyncExternalStore keeps the first render identical to the server's (false)
// and only switches after the page is live, so there's no hydration mismatch.
export function useIsNativeApp(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => navigator.userAgent.includes("MTHApp"),
    () => false,
  );
}

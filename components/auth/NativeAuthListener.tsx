"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyAuthError } from "@/lib/auth-errors";
import { isNativeApp } from "@/lib/native";
import { parseAuthCallbackUrl } from "@/lib/native-auth";
import { Spinner } from "@/components/ui/EmptyState";

// Runs only inside the Android app (renders nothing on the website). When the
// phone's browser finishes Google sign-in it opens the app with a deep link
// (com.moderntalentshub.app://auth-callback?code=…); this receives it, completes
// the Supabase login, and opens the user's dashboard — the same result as the
// website's /auth/callback, using the same Supabase session.

const LAUNCH_HANDLED_KEY = "mth-launch-link-handled";
const DASHBOARDS = ["student", "teacher", "admin"];

function goToLogin(message: string) {
  window.location.assign(`/login?error=${encodeURIComponent(message)}`);
}

async function finishSignIn(code: string) {
  const supabase = createClient();

  // Trades the one-time code for a login session (needs the secret verifier that
  // was saved in this app when sign-in started).
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("[native-auth] exchangeCodeForSession failed:", error.message);
    goToLogin(friendlyAuthError(error.message));
    return;
  }

  // Same rule as the website's callback: role from the profile, default student.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let role = "student";
  if (user) {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role && DASHBOARDS.includes(profile.role)) role = profile.role;
  }

  // A full navigation, so the server sees the new session cookies.
  window.location.assign(`/${role}`);
}

export function NativeAuthListener() {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isNativeApp()) return;

    let cancelled = false;
    let removeListener: (() => void) | undefined;

    async function handle(url: string) {
      const result = parseAuthCallbackUrl(url);
      if (result.kind === "ignore") return;

      // Close the browser tab if Android left it open behind the app.
      try {
        const { Browser } = await import("@capacitor/browser");
        await Browser.close();
      } catch {
        /* nothing to close */
      }

      if (result.kind === "error") {
        goToLogin(friendlyAuthError(result.message));
        return;
      }

      setBusy(true);
      await finishSignIn(result.code);
    }

    (async () => {
      const { App } = await import("@capacitor/app");

      const listener = await App.addListener("appUrlOpen", (event) => {
        void handle(event.url);
      });
      if (cancelled) {
        void listener.remove();
        return;
      }
      removeListener = () => void listener.remove();

      // If the deep link is what STARTED the app (it had been closed), pick it up
      // once. Android keeps reporting the launch link on every later page load, so
      // remember — for this app session only — that it was handled.
      try {
        if (sessionStorage.getItem(LAUNCH_HANDLED_KEY)) return;
        const launch = await App.getLaunchUrl();
        if (launch?.url) {
          sessionStorage.setItem(LAUNCH_HANDLED_KEY, "1");
          void handle(launch.url);
        }
      } catch {
        /* no launch link */
      }
    })().catch((err) => console.error("[native-auth] setup failed:", err));

    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, []);

  if (!busy) return null;

  return (
    <div className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-paper text-sm font-medium text-ink-soft">
      <Spinner />
      Signing you in…
    </div>
  );
}

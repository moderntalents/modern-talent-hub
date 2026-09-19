"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { friendlyAuthError } from "@/lib/auth-errors";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58Z"
      />
    </svg>
  );
}

// signInWithOAuth() doesn't call Supabase — it just builds a URL and navigates
// the browser there. So when the Google provider is switched off in the
// Supabase dashboard, the user isn't shown our error handling: they land on a
// raw JSON page ("Unsupported provider: provider is not enabled"). Supabase
// publishes which providers are enabled on a public endpoint, so check it first
// and show a friendly message instead of sending them to a dead end.
// Returns true only when Supabase positively says Google is disabled; any
// failure of the check itself falls through to the normal sign-in attempt.
async function isGoogleDisabled(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return false;
  try {
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey } });
    if (!res.ok) return false;
    const settings = await res.json();
    return settings?.external?.google === false;
  } catch {
    return false;
  }
}

export function GoogleButton({
  label = "Continue with Google",
  className = "",
  disabled = false,
  onError,
}: {
  label?: string;
  className?: string;
  disabled?: boolean;
  onError?: (message: string) => void;
}) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    onError?.("");

    try {
      if (await isGoogleDisabled()) {
        console.error("[GoogleButton] Google provider is not enabled in the Supabase dashboard.");
        onError?.(friendlyAuthError("Unsupported provider: provider is not enabled"));
        setLoading(false);
        return;
      }

      const supabase = createClient();
      // redirectTo is built from the origin the user is actually on (the live
      // site in production, localhost only when developing locally), so it can
      // never send a production user to the wrong host. Supabase only honours
      // it if it's in the dashboard's Redirect URLs allow-list.
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      // On success the browser is redirected to Google immediately, so this
      // component unmounts — loading only needs resetting on failure.
      if (error) {
        console.error("[GoogleButton] signInWithOAuth failed:", error.message);
        onError?.(friendlyAuthError(error.message));
        setLoading(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[GoogleButton] signInWithOAuth threw:", message);
      onError?.(friendlyAuthError(message) || "Could not start Google sign-in.");
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      loading={loading}
      disabled={disabled}
      onClick={handleClick}
      className={`w-full ${className}`}
    >
      {!loading && <GoogleIcon />}
      {label}
    </Button>
  );
}

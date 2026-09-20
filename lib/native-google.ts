"use client";

import { createClient } from "@/lib/supabase/client";
import { APP_AUTH_CALLBACK } from "@/lib/native-auth";

/**
 * Google sign-in for the Android app. Asks Supabase for the Google login address
 * (the same Supabase auth as the website — no separate system) and opens it in the
 * phone's real browser (a Chrome Custom Tab), NOT in the app's embedded web view,
 * which Google blocks. When the user finishes, Supabase sends the browser to
 * APP_AUTH_CALLBACK, Android returns to the app, and NativeAuthListener completes
 * the login.
 *
 * `skipBrowserRedirect` makes Supabase hand back the address instead of navigating
 * the web view to it; the secret PKCE "code verifier" is still saved in this app's
 * browser storage, which is what lets only this app finish the login.
 */
export async function startNativeGoogleSignIn(): Promise<{ error?: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: APP_AUTH_CALLBACK, skipBrowserRedirect: true },
  });

  if (error || !data?.url) return { error: error?.message ?? "Could not start Google sign-in." };

  // The address must be the Supabase login endpoint over https before it is opened.
  let target: URL;
  try {
    target = new URL(data.url);
  } catch {
    return { error: "Could not start Google sign-in." };
  }
  if (target.protocol !== "https:") return { error: "Could not start Google sign-in." };

  const { Browser } = await import("@capacitor/browser");
  await Browser.open({ url: target.href });
  return {};
}

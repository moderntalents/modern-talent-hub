// Pure helpers (no imports) for signing in with Google inside the Android app.
//
// Why this exists: Google refuses to show its login page inside an app's built-in
// browser, so the app opens Google in the phone's real browser (a Chrome Custom
// Tab). When the user finishes, Supabase redirects that browser to the deep link
// below, Android hands it back to our app, and the app finishes the login. The
// website is unaffected and keeps its own /auth/callback flow.

export const APP_SCHEME = "com.moderntalentshub.app";
export const APP_AUTH_CALLBACK = `${APP_SCHEME}://auth-callback`;

export type AuthCallback =
  | { kind: "code"; code: string }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

/**
 * Reads the link Android delivered to the app. Only OUR callback is accepted —
 * exact scheme and host — so links from anywhere else are ignored. The code is
 * only useful together with the secret "code verifier" stored in this app's own
 * browser storage when sign-in started (PKCE), so intercepting the link alone
 * can't log anyone in.
 */
export function parseAuthCallbackUrl(raw: string): AuthCallback {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "ignore" };
  }

  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== "auth-callback") return { kind: "ignore" };

  const problem = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (problem) return { kind: "error", message: problem };

  const code = url.searchParams.get("code");
  if (code && /^[\w-]{8,200}$/.test(code)) return { kind: "code", code };

  return { kind: "error", message: "Google sign-in didn't complete. Please try again." };
}

// Client-safe helpers shared by /login, /signup and the Google button, so every
// auth surface maps Supabase errors to the same actionable copy. The raw
// technical message should still be console.error'd by the caller.

export function friendlyAuthError(message: string): string {
  if (/provider is not enabled|unsupported provider/i.test(message)) {
    return "Google sign-in isn't available yet. Please use email and password instead.";
  }
  if (/invalid login credentials/i.test(message)) {
    return "Incorrect email or password.";
  }
  if (/email not confirmed/i.test(message)) {
    return "This email hasn't been verified yet. Register again to get a new 5-digit verification code.";
  }
  if (/token.*(expired|invalid)|invalid.*(otp|token)|otp.*expired/i.test(message)) {
    return "That code is incorrect or has expired. Double-check it or request a new one.";
  }
  if (/already registered|already exists/i.test(message)) {
    return "An account with this email already exists. Try logging in instead.";
  }
  // Supabase throttles auth emails (roughly 1 per 60s per address, plus an
  // hourly cap on the whole project).
  if (/rate limit|security purposes|too many requests/i.test(message)) {
    return "Too many attempts. Please wait a minute before trying again.";
  }
  // Includes "Error sending confirmation email" (SMTP failure) and
  // "Email address not authorized" (Supabase's built-in mailer only delivers to
  // your own team members until a custom SMTP server is configured).
  if (/sending .*email|email address not authorized/i.test(message)) {
    return "We couldn't send the verification email right now. Please try again in a few minutes, or contact support if it keeps happening.";
  }
  if (/code verifier|pkce/i.test(message)) {
    return "Sign-in could not be completed. Please go back to the login page and try again.";
  }
  if (/failed to fetch|networkerror|network request failed/i.test(message)) {
    return "Network problem — check your connection and try again.";
  }
  return message;
}

/** Seconds Supabase says to wait ("...only request this after 42 seconds"), if present. */
export function retryAfterSeconds(message: string): number | null {
  const match = message.match(/after (\d+) seconds?/i);
  return match ? Number(match[1]) : null;
}

/**
 * A post-login `?next=` target is only honoured when it's a same-site path.
 * Anything else (https://evil.example, //evil.example, /\evil) falls back to
 * the user's own dashboard, so a crafted login link can't bounce someone to
 * another site after they enter their password.
 */
export function safeNextPath(next: string | null): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  return next;
}

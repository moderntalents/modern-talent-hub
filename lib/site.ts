import "server-only";

// The public production address that links in our emails point to. Reading it
// from one place (instead of the request's own origin) is what guarantees an
// email link can never carry someone to a Vercel preview / *.vercel.app URL,
// no matter which address the request happened to come from.
//
// Override with NEXT_PUBLIC_SITE_URL (e.g. http://localhost:3000 for local dev).
const DEFAULT_SITE_URL = "https://www.rutechbranding.ink";

export function getSiteUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL).trim();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`NEXT_PUBLIC_SITE_URL is not a valid URL: "${raw}"`);
  }

  if (url.hostname.endsWith(".vercel.app")) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL points at a *.vercel.app address. Email links must use the public production domain.",
    );
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("NEXT_PUBLIC_SITE_URL must be an https:// URL.");
  }

  return url.origin;
}

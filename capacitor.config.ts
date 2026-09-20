import type { CapacitorConfig } from "@capacitor/cli";

// Wraps the live Modern Talent Hub website in a native Android shell for Google
// Play. The app does NOT bundle the web app: `server.url` points its WebView at
// the production site, so the installed app always shows the current version and
// every existing feature (login, 5-digit verification, forgot password, lessons,
// YouTube, PDFs, admin, live classes, Supabase) works exactly as on the web.
//
// Build/test steps: README.md -> "Android app (Google Play)".

// The site's final address. rutechbranding.ink redirects to www, and Capacitor treats
// a redirect to another host as "leaving the app" (it would open the phone's browser),
// so the app is pointed at the www address directly.
const SITE_URL = process.env.CAPACITOR_SERVER_URL || "https://www.rutechbranding.ink";

const config: CapacitorConfig = {
  // Permanent once the app is on Google Play — do not change after publishing.
  appId: "com.moderntalentshub.app",
  appName: "Modern Talent Hub",

  // Tiny local folder (offline page + a forwarding index.html); see mobile/www.
  webDir: "mobile/www",

  server: {
    url: SITE_URL,
    cleartext: false,
    // Pages on these hosts stay inside the app; anything else opens in the browser.
    allowNavigation: ["www.rutechbranding.ink", "rutechbranding.ink"],
    // Shown if the phone has no internet / the site can't be reached.
    errorPath: "offline.html",
  },

  android: {
    allowMixedContent: false,
    backgroundColor: "#ebf1f6",
    // Lets the website know it is inside the app (e.g. to hide Google sign-in,
    // which Google refuses to run inside an app WebView).
    appendUserAgent: "MTHApp",
  },
};

export default config;

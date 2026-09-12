import type { CapacitorConfig } from "@capacitor/cli";

// Wraps the deployed Vercel app in a native Android (and iOS, if ever needed)
// shell for Play Store distribution. This does NOT bundle the web app inside
// the APK/AAB — `server.url` points the WebView at your live production
// deployment, so the installed app always shows the current site (same
// approach as Twitter/Instagram's early hybrid apps). See README.md ->
// "Packaging for Android / Google Play" for the full setup steps, which
// require Android Studio and a Google Play Console account — neither of
// which this environment has, so `npx cap add android` has not been run here.
const config: CapacitorConfig = {
  appId: "com.moderntalenthub.app",
  appName: "Modern Talent Hub",
  webDir: "public",
  server: {
    url: process.env.NEXT_PUBLIC_APP_URL || "https://your-deployment.vercel.app",
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;

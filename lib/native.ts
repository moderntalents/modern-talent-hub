// True only inside the Android app. The app adds "MTHApp" to the browser identity
// (`android.appendUserAgent` in capacitor.config.ts); websites, desktop and phone
// browsers never do, so on the web this is always false and nothing changes.
export function isNativeApp(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("MTHApp");
}

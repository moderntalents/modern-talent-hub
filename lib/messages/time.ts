// Fixed to Kenyan time so a server (UTC) and a browser render the same text.
const FORMAT = new Intl.DateTimeFormat("en-KE", {
  timeZone: "Africa/Nairobi",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function formatMessageTime(iso: string): string {
  return FORMAT.format(new Date(iso));
}

// Works on both server and client. Turns the "video link" a teacher pastes into
// something a lesson page can actually play:
//   * YouTube / Vimeo page links -> an embeddable player URL (a plain <video>
//     tag cannot play those pages)
//   * anything else http(s)      -> treated as a direct video file link
// Embed URLs are rebuilt from a validated ID rather than reusing the pasted
// text, so a crafted link can't inject anything into the iframe.

export type VideoSource = { kind: "embed"; src: string } | { kind: "file"; src: string };

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function getVideoSource(raw: string | null | undefined): VideoSource | null {
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");

  // YouTube: watch?v=ID, youtu.be/ID, /shorts/ID, /embed/ID, /live/ID
  let youtubeId: string | null = null;
  if (host === "youtu.be") {
    youtubeId = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch") youtubeId = url.searchParams.get("v");
    else if (["shorts", "embed", "live", "v"].includes(parts[0])) youtubeId = parts[1] ?? null;
  }
  if (youtubeId && YOUTUBE_ID.test(youtubeId)) {
    return { kind: "embed", src: `https://www.youtube-nocookie.com/embed/${youtubeId}` };
  }

  // Vimeo: vimeo.com/123456789 (optionally /hash for unlisted) or player.vimeo.com/video/123456789
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const match = url.pathname.match(/\/(?:video\/)?(\d{5,})(?:\/([a-f0-9]+))?/i);
    if (match) {
      const hash = match[2] ? `?h=${match[2]}` : "";
      return { kind: "embed", src: `https://player.vimeo.com/video/${match[1]}${hash}` };
    }
  }

  return { kind: "file", src: url.href };
}

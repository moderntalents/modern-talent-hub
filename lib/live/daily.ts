import "server-only";

// The ONLY file that knows about the video-conferencing provider (Daily,
// https://www.daily.co). Everything else in the app talks to these functions,
// so switching provider later means rewriting this file, not the feature.
//
// Environment variables (server-only, never sent to the browser):
//   DAILY_API_KEY   from the Daily dashboard -> Developers -> API keys
//   DAILY_DOMAIN    your Daily subdomain, e.g. "modern-talent" for modern-talent.daily.co
//
// Rooms are PRIVATE: nobody can open one without a meeting token that this
// server mints for a specific signed-in person, and each room expires on its own.

const API = "https://api.daily.co/v1";
const MAX_PARTICIPANTS = 50;

export function isLiveConfigured(): boolean {
  return Boolean(process.env.DAILY_API_KEY && process.env.DAILY_DOMAIN && /^[a-z0-9-]+$/i.test(process.env.DAILY_DOMAIN));
}

async function daily<T>(path: string, init: { method: "POST" | "DELETE"; body?: unknown }): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${process.env.DAILY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const error = new Error(`Video service error (${res.status}): ${detail}`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return (await res.json().catch(() => ({}))) as T;
}

/** Creates a private room that ejects everyone and disappears at `expiresAtMs`. */
export async function createRoom(name: string, expiresAtMs: number): Promise<void> {
  try {
    await daily("/rooms", {
      method: "POST",
      body: {
        name,
        privacy: "private",
        properties: {
          exp: Math.floor(expiresAtMs / 1000),
          eject_at_room_exp: true,
          max_participants: MAX_PARTICIPANTS,
          enable_chat: true,
          enable_screenshare: true,
          enable_knocking: false,
          enable_prejoin_ui: true, // lets people check camera/mic first — helps on phones
          start_video_off: false,
          start_audio_off: false,
        },
      },
    });
  } catch (err) {
    // A previous start attempt may have created the room before the database
    // update failed; reuse it instead of failing the retry.
    if (err instanceof Error && /already exists/i.test(err.message)) return;
    throw err;
  }
}

/**
 * A one-person entry pass for the room. The teacher gets host (owner) rights —
 * mute/remove others, end the meeting, share their screen. Students can use
 * their camera and microphone (they join muted, and can unmute) but can't
 * share screens or moderate.
 */
export async function createMeetingToken(params: {
  roomName: string;
  userName: string;
  userId: string;
  isHost: boolean;
  expiresAtMs: number;
}): Promise<string> {
  const { token } = await daily<{ token: string }>("/meeting-tokens", {
    method: "POST",
    body: {
      properties: {
        room_name: params.roomName,
        user_name: params.userName,
        user_id: params.userId,
        is_owner: params.isHost,
        enable_screenshare: params.isHost,
        start_audio_off: !params.isHost,
        exp: Math.floor(params.expiresAtMs / 1000),
        eject_at_token_exp: true,
      },
    },
  });
  return token;
}

/** Deleting the room removes everyone from it immediately. Missing rooms are fine. */
export async function deleteRoom(name: string): Promise<void> {
  try {
    await daily(`/rooms/${encodeURIComponent(name)}`, { method: "DELETE" });
  } catch (err) {
    if ((err as { status?: number }).status === 404) return;
    throw err;
  }
}

export function roomUrl(roomName: string, token: string): string {
  return `https://${process.env.DAILY_DOMAIN}.daily.co/${encodeURIComponent(roomName)}?t=${encodeURIComponent(token)}`;
}

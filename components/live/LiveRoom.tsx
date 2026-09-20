"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorBanner, Spinner } from "@/components/ui/EmptyState";
import { joinLiveSession } from "@/lib/live/actions";

type RoomState = { phase: "loading" } | { phase: "ready"; url: string } | { phase: "error"; message: string };

// The video room. The server checks who you are and whether you're allowed in,
// and hands back a private link made just for you; this only displays it.
// The camera/microphone permissions on the frame are what let phones (and the
// Android app's WebView) ask for the camera and mic.
export function LiveRoom({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<RoomState>({ phase: "loading" });

  const join = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const result = await joinLiveSession(sessionId);
      if (result.ok && result.url) setState({ phase: "ready", url: result.url });
      else setState({ phase: "error", message: result.ok ? "Could not open the room." : result.message });
    } catch {
      setState({ phase: "error", message: "Network problem — check your connection and try again." });
    }
  }, [sessionId]);

  useEffect(() => {
    void join();
  }, [join]);

  if (state.phase === "loading") {
    return (
      <div className="flex h-64 items-center justify-center gap-3 rounded-[var(--radius-brand)] border border-line bg-surface-2 text-sm font-medium text-ink-soft">
        <Spinner /> Connecting to the live class…
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="flex flex-col gap-3">
        <ErrorBanner message={state.message} />
        <div>
          <Button variant="outline" onClick={() => void join()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <iframe
      src={state.url}
      title="Live class"
      allow="camera; microphone; fullscreen; display-capture; autoplay; clipboard-write"
      allowFullScreen
      className="h-[calc(100dvh-11rem)] min-h-[440px] w-full rounded-[var(--radius-brand)] border border-line bg-black"
    />
  );
}

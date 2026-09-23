// Pure — which label to show a student who can't message yet, for a given (already-known)
// messaging state. No framework imports on purpose, so it's testable without a rendering
// harness (this project has none) and importable from a server component without pulling in
// next/link's client runtime. Does not decide access, only wording — see
// components/messages/MessagingLockedNote.tsx, the only renderer of this.
import type { MessagingState } from "@/lib/messaging-permission";

export function messagingLockedLabel(state: MessagingState): string {
  switch (state.kind) {
    case "needs_guardian":
      return "Needs a parent's OK";
    case "not_cleared":
      return "Finish account setup";
    case "allowed":
      return "Message"; // not expected to render — canMessage is true, callers show StartConversationButton instead
  }
}

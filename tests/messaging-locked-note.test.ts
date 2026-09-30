// The messaging-lock label (lib/messaging-locked-label.ts, rendered by
// components/messages/MessagingLockedNote.tsx) — pure, no rendering needed. Proves the UI text is
// correct per state. There is no separate guardian permission for messaging: the only reasons a
// student can't message are unfinished account setup, or messaging being unavailable.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { messagingLockedLabel } from "../lib/messaging-locked-label";

describe("messagingLockedLabel — the reason shown when a student can't message", () => {
  test("not_cleared: account-setup wording", () => {
    assert.equal(messagingLockedLabel({ kind: "not_cleared" }), "Finish account setup");
  });

  test("unavailable: says messaging is unavailable, never asks the student to finish setup", () => {
    assert.equal(messagingLockedLabel({ kind: "unavailable" }), "Messaging unavailable");
  });

  test("no label mentions a parent's separate permission for messaging", () => {
    for (const kind of ["not_cleared", "unavailable", "allowed"] as const) {
      assert.doesNotMatch(messagingLockedLabel({ kind }), /parent|guardian/i);
    }
  });
});

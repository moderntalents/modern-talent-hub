// The messaging-lock label (lib/messaging-locked-label.ts, rendered by
// components/messages/MessagingLockedNote.tsx) — pure, no rendering needed. Proves the UI text
// is correct per state, and that the underlying permission rule (lib/messaging-permission.ts,
// tested separately in tests/messaging-permission.test.ts) is untouched by this fix.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { messagingLockedLabel } from "../lib/messaging-locked-label";
import { messagingAllowed, messagingState, type MessagingRecord } from "../lib/messaging-permission";

describe("messagingLockedLabel — the reason shown when a student can't message", () => {
  test("needs_guardian: parent-approval wording, not the not_cleared wording", () => {
    assert.equal(messagingLockedLabel({ kind: "needs_guardian", status: "not_requested" }), "Needs a parent's OK");
    assert.equal(messagingLockedLabel({ kind: "needs_guardian", status: "declined" }), "Needs a parent's OK");
    assert.equal(messagingLockedLabel({ kind: "needs_guardian", status: "withdrawn" }), "Needs a parent's OK");
  });

  test("not_cleared: account-setup wording, and specifically NOT \"Needs a parent's OK\"", () => {
    const label = messagingLockedLabel({ kind: "not_cleared" });
    assert.equal(label, "Finish account setup");
    assert.notEqual(label, "Needs a parent's OK");
  });

  test("the two reasons never produce the same label — a student can always tell which one applies", () => {
    const needsGuardian = messagingLockedLabel({ kind: "needs_guardian", status: "not_requested" });
    const notCleared = messagingLockedLabel({ kind: "not_cleared" });
    assert.notEqual(needsGuardian, notCleared);
  });
});

describe("no messaging permission logic was weakened by this fix", () => {
  const base: MessagingRecord = {
    consent_status: "granted",
    date_of_birth: "2012-01-01",
    guardian_messaging_allowed: false,
    guardian_messaging_status: "not_requested",
    guardian_messaging_version: null,
  };
  const NOW = new Date("2026-09-23T09:00:00Z");

  test("allowed: an adult, or an approved-for-messaging minor, is still allowed", () => {
    assert.equal(messagingAllowed({ ...base, consent_status: "not_required", date_of_birth: "1990-01-01" }, NOW), true);
    assert.equal(
      messagingAllowed(
        { ...base, guardian_messaging_allowed: true, guardian_messaging_status: "granted", guardian_messaging_version: "guardian-v2" },
        NOW,
      ),
      true,
    );
  });

  test("needs_guardian: still blocked — this fix only changes what the UI says, never who is allowed", () => {
    assert.deepEqual(messagingState({ ...base, guardian_messaging_status: "declined" }, NOW), {
      kind: "needs_guardian",
      status: "declined",
    });
  });

  test("not_cleared: still blocked — a not_cleared student gains no access through this fix", () => {
    assert.deepEqual(messagingState({ ...base, consent_status: "pending", date_of_birth: "1990-01-01" }, NOW), { kind: "not_cleared" });
    assert.deepEqual(messagingState(null, NOW), { kind: "not_cleared" });
    // The only UI paths that can start a conversation or open the composer — StartConversationButton,
    // startConversationFromLesson/Activity, ThreadScreen — are all reached exclusively through the
    // `canMessage` check (`getMessagingState(...).kind === "allowed"`) in the activity, lesson, and
    // messages pages, which this fix does not touch. A not_cleared or needs_guardian student is
    // routed to MessagingLockedNote / the explanatory panel instead, never to those components; the
    // database's own messaging_cleared() (0014, unmodified) refuses them a second time regardless.
    assert.equal(messagingAllowed({ ...base, consent_status: "pending", date_of_birth: "1990-01-01" }, NOW), false);
  });
});

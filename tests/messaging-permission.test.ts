// The pure messaging rule (lib/messaging-permission.ts) and consent versions (lib/consent-versions.ts).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { messagingAllowed, messagingState, type MessagingRecord } from "../lib/messaging-permission";
import { coversMessaging, GUARDIAN_V1, GUARDIAN_V2 } from "../lib/consent-versions";

const base: MessagingRecord = {
  consent_status: "granted",
  date_of_birth: "2012-01-01",
  guardian_messaging_allowed: false,
  guardian_messaging_status: "not_requested",
  guardian_messaging_version: null,
};
const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-23T09:00:00Z");

describe("messaging permission rule", () => {
  test("under 18 + guardian messaging approval (v2) = allowed", () => {
    assert.equal(
      messagingAllowed({ ...base, guardian_messaging_allowed: true, guardian_messaging_status: "granted", guardian_messaging_version: GUARDIAN_V2 }, NOW),
      true,
    );
  });

  test("under 18 + approval recorded against v1 wording = NOT allowed", () => {
    assert.equal(
      messagingAllowed({ ...base, guardian_messaging_allowed: true, guardian_messaging_status: "granted", guardian_messaging_version: GUARDIAN_V1 }, NOW),
      false,
    );
  });

  test("under 18 + decline or withdrawal = blocked, with the reason kept for the screen", () => {
    for (const status of ["not_requested", "declined", "withdrawn"] as const) {
      assert.deepEqual(messagingState({ ...base, guardian_messaging_status: status }, NOW), { kind: "needs_guardian", status });
    }
  });

  test("18+ with platform consent = allowed automatically, whatever the guardian said about messaging", () => {
    for (const status of ["not_requested", "declined", "withdrawn"] as const) {
      assert.equal(messagingAllowed({ ...base, date_of_birth: "2008-09-23", guardian_messaging_status: status }, NOW), true);
    }
    assert.equal(messagingAllowed({ ...base, consent_status: "not_required", date_of_birth: "1990-01-01" }, NOW), true);
  });

  test("no platform consent = not cleared, even at 18+", () => {
    for (const consent of ["pending", "declined"] as const) {
      assert.deepEqual(messagingState({ ...base, consent_status: consent, date_of_birth: "1990-01-01" }, NOW), { kind: "not_cleared" });
    }
    assert.deepEqual(messagingState(null, NOW), { kind: "not_cleared" });
  });

  test("the 18th birthday starts at midnight in Nairobi, and 29 February birthdays count from 1 March", () => {
    const r = { ...base, date_of_birth: "2008-09-24" };
    assert.equal(messagingAllowed(r, at("2026-09-23T20:59:59Z")), false);
    assert.equal(messagingAllowed(r, at("2026-09-23T21:00:00Z")), true);
    const leap = { ...base, date_of_birth: "2008-02-29" };
    assert.equal(messagingAllowed(leap, at("2026-02-28T20:59:59Z")), false);
    assert.equal(messagingAllowed(leap, at("2026-02-28T21:00:00Z")), true); // 1 March in Nairobi
  });

  test("consent versions: only v2 covers messaging; unknown versions never do", () => {
    assert.equal(coversMessaging(GUARDIAN_V1), false);
    assert.equal(coversMessaging(GUARDIAN_V2), true);
    for (const v of [null, undefined, "", "guardian-v3", "GUARDIAN-V2", "constructor"]) assert.equal(coversMessaging(v), false);
  });
});

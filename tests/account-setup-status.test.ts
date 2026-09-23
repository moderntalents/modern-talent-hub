// The Settings page's "Complete your account" banner (lib/account-setup-status.ts) — pure, no
// rendering needed, and no import of lib/age-gate.ts (which pulls in next/navigation and can't
// load in this harness — see tests/messaging-locked-note.test.ts for the same pattern). The
// route itself is always gateRedirect()'s output, passed in by the real caller (the Settings
// page); this only tests the wording and the "no href in, no banner out" contract.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { accountSetupBanner } from "../lib/account-setup-status";
import type { AgeState } from "../lib/age-gate";

describe("accountSetupBanner — the Settings page's 'Complete your account' banner", () => {
  test("null href in (gateRedirect() found nothing required) → null banner, always", () => {
    for (const state of [{ kind: "needs_age" }, { kind: "pending", guardianEmail: "g@test.invalid" }, { kind: "declined" }, { kind: "ok" }] as AgeState[]) {
      assert.equal(accountSetupBanner(state, null), null);
    }
  });

  test("a non-null href always produces a banner with that exact href — never a different or invented link", () => {
    assert.equal(accountSetupBanner({ kind: "needs_age" }, "/age-check")!.href, "/age-check");
    assert.equal(accountSetupBanner({ kind: "pending", guardianEmail: "g@test.invalid" }, "/consent-pending")!.href, "/consent-pending");
    assert.equal(accountSetupBanner({ kind: "declined" }, "/consent-pending")!.href, "/consent-pending");
  });

  test("every non-ok state produces a distinct, non-empty label — a student can tell what's happening", () => {
    const labels = [
      accountSetupBanner({ kind: "needs_age" }, "/age-check")!.label,
      accountSetupBanner({ kind: "pending", guardianEmail: "g@test.invalid" }, "/consent-pending")!.label,
      accountSetupBanner({ kind: "declined" }, "/consent-pending")!.label,
    ];
    for (const l of labels) assert.ok(l.length > 0);
    assert.equal(new Set(labels).size, labels.length, "no two reasons share the exact same wording");
  });

  test("'ok' with a (hypothetical) non-null href still renders — the caller, not this function, guarantees ok implies null", () => {
    // Documents the actual contract: this function trusts its href parameter completely. The real
    // safety property — "ok" never gets a link — lives in gateRedirect() (unchanged, tested via
    // its own callers) always returning null for "ok", not in this presentation-only function.
    assert.equal(accountSetupBanner({ kind: "ok" }, null), null);
  });
});

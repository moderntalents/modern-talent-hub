// Route-level tests for the parts that don't need a full authenticated Supabase session
// mock: the B2C callback's secret gate (app/api/mpesa/b2c-callback/[secret]/route.ts),
// mirroring how the STK callback's secret gate was tested in Phase 2A. The withdrawal
// creation route (app/api/withdrawals/route.ts) never reads a teacher id from the
// request body at all — it always uses the verified session's user.id — so there is no
// attacker-controlled input path for "withdraw from someone else's wallet" to test at
// the route layer; that invariant is enforced by construction, and the reservation/
// ledger/state-machine behavior it triggers is covered against the real database in
// tests/coach-b2c-withdrawal.test.ts.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { POST as b2cCallback } from "@/app/api/mpesa/b2c-callback/[secret]/route";

const REAL_SECRET = "b2c-correct-horse-battery-staple";

let originalSecret: string | undefined;
beforeEach(() => {
  originalSecret = process.env.MPESA_B2C_CALLBACK_SECRET;
  process.env.MPESA_B2C_CALLBACK_SECRET = REAL_SECRET;
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.MPESA_B2C_CALLBACK_SECRET;
  else process.env.MPESA_B2C_CALLBACK_SECRET = originalSecret;
});

function request(body: unknown) {
  return new Request("https://example.invalid/api/mpesa/b2c-callback/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("B2C callback secret gate", () => {
  test("the wrong secret is rejected with a generic 404 before touching anything", async () => {
    const res = await b2cCallback(request({ Result: {} }), { params: Promise.resolve({ secret: "guessed-wrong" }) });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ResultCode, 1);
  });

  test("no MPESA_B2C_CALLBACK_SECRET configured at all also rejects (fails closed)", async () => {
    delete process.env.MPESA_B2C_CALLBACK_SECRET;
    const res = await b2cCallback(request({}), { params: Promise.resolve({ secret: "anything" }) });
    assert.equal(res.status, 404);
  });

  test("the correct secret but an unparseable payload is rejected with 400", async () => {
    const res = await b2cCallback(request({ not: "a callback" }), { params: Promise.resolve({ secret: REAL_SECRET }) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ResultCode, 1);
  });

  // A well-formed, correctly-secret-gated callback that reaches applyB2CCallback needs a
  // real (or admin-shaped) Supabase client, which this environment has no credentials
  // for — that behavior (unmatched ConversationID, duplicate, success, failure) is
  // exercised directly against the real database in tests/coach-b2c-withdrawal.test.ts
  // instead, exactly like the STK callback route's equivalent split in Phase 2A.
});

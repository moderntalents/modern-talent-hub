// Tests the route-level concerns of app/api/mpesa/callback/[secret]/route.ts that live
// outside lib/mpesa-payments.ts: the callback secret gate, and rejecting an unparseable
// payload before anything ever reaches the database. Calls the route's exported POST
// handler directly (a plain async function) — no real Next.js server needed.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { POST } from "@/app/api/mpesa/callback/[secret]/route";

const REAL_SECRET = "correct-horse-battery-staple";

let originalSecret: string | undefined;
beforeEach(() => {
  originalSecret = process.env.MPESA_CALLBACK_SECRET;
  process.env.MPESA_CALLBACK_SECRET = REAL_SECRET;
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.MPESA_CALLBACK_SECRET;
  else process.env.MPESA_CALLBACK_SECRET = originalSecret;
});

function request(body: unknown) {
  return new Request("https://example.invalid/api/mpesa/callback/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("callback secret gate", () => {
  test("the wrong secret is rejected with a generic 404 before touching anything", async () => {
    const res = await POST(request({ Body: { stkCallback: {} } }), { params: Promise.resolve({ secret: "guessed-wrong" }) });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ResultCode, 1);
  });

  test("no MPESA_CALLBACK_SECRET configured at all also rejects (fails closed, not open)", async () => {
    delete process.env.MPESA_CALLBACK_SECRET;
    const res = await POST(request({}), { params: Promise.resolve({ secret: "anything" }) });
    assert.equal(res.status, 404);
  });

  test("the correct secret but an unparseable payload is rejected with 400, not a silent accept", async () => {
    const res = await POST(request({ not: "a callback" }), { params: Promise.resolve({ secret: REAL_SECRET }) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ResultCode, 1);
  });

  test("malformed JSON body with the correct secret is also rejected with 400", async () => {
    const req = new Request("https://example.invalid/api/mpesa/callback/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(req, { params: Promise.resolve({ secret: REAL_SECRET }) });
    assert.equal(res.status, 400);
  });
});

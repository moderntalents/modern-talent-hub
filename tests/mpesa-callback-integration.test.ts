// Phase 2 integration tests for lib/mpesa-payments.ts: applyStkCallback() and
// reconcilePendingPayment() run against a REAL PGlite database with the actual
// 0001-0010, 0012, 0013 migrations applied — the same Postgres triggers and
// constraints that run in production decide whether a payment is completed and
// a wallet credited. `fakeAdmin()` is a thin Supabase-client-shaped adapter over
// that database (see tests/helpers/fake-admin.ts); it is not a mock of the
// business logic under test.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers/db";
import { seedWorld } from "./helpers/seed";
import { fakeAdmin } from "./helpers/fake-admin";
import { newPayment, resetPayments, wallets, type PaymentRef } from "./helpers/payments";
import { applyStkCallback, parseStkCallback, reconcilePendingPayment } from "@/lib/mpesa-payments";
import type { StkQueryResult } from "@/lib/mpesa";

let db: PGlite;
let admin: ReturnType<typeof fakeAdmin>;

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
  admin = fakeAdmin(db);
});
beforeEach(async () => {
  await resetPayments(db);
});

function successPayload(checkoutRequestId: string, amount: number, phone = "254712345678", overrides: Record<string, unknown> = {}) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "mr-" + checkoutRequestId,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: amount },
            { Name: "MpesaReceiptNumber", Value: "RCPT" + checkoutRequestId.toUpperCase() },
            { Name: "TransactionDate", Value: 20240115103000 },
            { Name: "PhoneNumber", Value: phone },
          ],
        },
        ...overrides,
      },
    },
  };
}

function failurePayload(checkoutRequestId: string, resultCode = 1032, resultDesc = "Request cancelled by user") {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "mr-" + checkoutRequestId,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: resultCode,
        ResultDesc: resultDesc,
      },
    },
  };
}

async function status(id: string): Promise<string> {
  const r = await db.query<{ status: string }>("select status from payment_transactions where id = $1", [id]);
  return r.rows[0].status;
}

async function row(id: string) {
  const r = await db.query<Record<string, unknown>>("select * from payment_transactions where id = $1", [id]);
  return r.rows[0];
}

async function callbackLogOutcomes(checkoutRequestId: string): Promise<string[]> {
  const r = await db.query<{ outcome: string }>(
    "select outcome from mpesa_callbacks where checkout_request_id = $1 order by id",
    [checkoutRequestId],
  );
  return r.rows.map((x) => x.outcome);
}

describe("applyStkCallback — success", () => {
  test("a verified success completes the payment, credits both wallets 70/30, and activates the subscription", async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-ok-1" });
    const before = await wallets(db);

    const parsed = parseStkCallback(successPayload("co-ok-1", 1000))!;
    const outcome = await applyStkCallback(admin, parsed, successPayload("co-ok-1", 1000));

    assert.equal(outcome, "credited");
    assert.equal(await status(p.id), "completed");
    const r = await row(p.id);
    assert.equal(r.confirmed_via, "callback");
    assert.equal(r.provider_reference, "RCPTCO-OK-1");
    assert.equal(Number(r.callback_amount), 1000);
    assert.equal(r.callback_phone, "254712345678");
    assert.equal(r.merchant_request_id, "mr-co-ok-1");
    assert.equal(r.phone_mismatch, false);

    const after = await wallets(db);
    assert.equal(after.teacher(p.teacher) - before.teacher(p.teacher), 700, "coach gets 70%");
    assert.equal(after.platform - before.platform, 300, "platform gets 30%");
    assert.equal(after.ledgerRows - before.ledgerRows, 2, "one ledger row per wallet");

    const sub = await db.query<{ status: string }>("select status from subscriptions where id = $1", [p.subscriptionId]);
    assert.equal(sub.rows[0].status, "active");

    assert.deepEqual(await callbackLogOutcomes("co-ok-1"), ["received", "credited"]);
  });
});

describe("applyStkCallback — failure", () => {
  test("a genuine Daraja failure (e.g. cancelled) marks the payment failed and credits nobody", async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-fail-1" });
    const before = await wallets(db);

    const parsed = parseStkCallback(failurePayload("co-fail-1"))!;
    const outcome = await applyStkCallback(admin, parsed, failurePayload("co-fail-1"));

    assert.equal(outcome, "failed_recorded");
    assert.equal(await status(p.id), "failed");
    const r = await row(p.id);
    assert.equal(r.result_code, 1032);
    assert.equal(r.result_desc, "Request cancelled by user");

    assert.deepEqual(await wallets(db), before, "nothing is credited for a failed payment");
    assert.deepEqual(await callbackLogOutcomes("co-fail-1"), ["received", "failed_recorded"]);
  });
});

describe("applyStkCallback — amount mismatch", () => {
  test("a claimed success whose callback amount does not match the expected amount is sent to review, never credited", async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-amt-1" });
    const before = await wallets(db);

    const parsed = parseStkCallback(successPayload("co-amt-1", 1))!; // paid KES 1 instead of 1000
    const outcome = await applyStkCallback(admin, parsed, successPayload("co-amt-1", 1));

    assert.equal(outcome, "amount_mismatch");
    assert.equal(await status(p.id), "review");
    assert.deepEqual(await wallets(db), before, "an unverified amount must never be credited");
    assert.deepEqual(await callbackLogOutcomes("co-amt-1"), ["received", "amount_mismatch"]);
  });

  test("a claimed success with NO amount at all in the callback is also unverifiable, not a free pass", async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-amt-2" });
    const payload = successPayload("co-amt-2", 1000, "254712345678", { CallbackMetadata: undefined });
    const parsed = parseStkCallback(payload)!;
    const outcome = await applyStkCallback(admin, parsed, payload);
    assert.equal(outcome, "amount_mismatch");
    assert.equal(await status(p.id), "review");
  });
});

describe("applyStkCallback — phone mismatch", () => {
  test("a claimed success whose payer phone does not match the number the prompt was sent to is rejected, never credited", async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-phone-1", phone: "254712345678" });
    const before = await wallets(db);

    const parsed = parseStkCallback(successPayload("co-phone-1", 1000, "254798765432"))!;
    const outcome = await applyStkCallback(admin, parsed, successPayload("co-phone-1", 1000, "254798765432"));

    assert.equal(outcome, "rejected");
    assert.equal(await status(p.id), "review");
    const r = await row(p.id);
    assert.equal(r.phone_mismatch, true);
    assert.deepEqual(await wallets(db), before);
  });
});

describe("applyStkCallback — unknown CheckoutRequestID", () => {
  test("a callback for a CheckoutRequestID that matches no payment (and no activation payment) is logged and ignored, not an error", async () => {
    const payload = successPayload("co-does-not-exist", 1000);
    const parsed = parseStkCallback(payload)!;
    const outcome = await applyStkCallback(admin, parsed, payload);
    assert.equal(outcome, "unmatched");
    assert.deepEqual(await callbackLogOutcomes("co-does-not-exist"), ["received", "unmatched"]);
  });
});

describe("applyStkCallback — duplicate callbacks and immutability", () => {
  let p: PaymentRef;
  beforeEach(async () => {
    p = await newPayment(db, { amount: 1000, checkout: "co-dup-1" });
  });

  test("the same successful callback delivered twice credits the wallet only once", async () => {
    const payload = successPayload("co-dup-1", 1000);
    const parsed = parseStkCallback(payload)!;

    const first = await applyStkCallback(admin, parsed, payload);
    const before = await wallets(db);
    const second = await applyStkCallback(admin, parsed, payload);
    const after = await wallets(db);

    assert.equal(first, "credited");
    assert.equal(second, "duplicate");
    assert.deepEqual(after, before, "a replayed callback must not credit anything a second time");
    assert.deepEqual(await callbackLogOutcomes("co-dup-1"), ["received", "credited", "received", "duplicate"]);
  });

  test("a completed payment cannot become failed and then be credited again by a later callback", async () => {
    const okPayload = successPayload("co-dup-1", 1000);
    await applyStkCallback(admin, parseStkCallback(okPayload)!, okPayload);
    assert.equal(await status(p.id), "completed");
    const afterComplete = await wallets(db);

    // A late/forged "actually it failed" callback for the same CheckoutRequestID.
    const laterFailure = failurePayload("co-dup-1", 1);
    const outcome = await applyStkCallback(admin, parseStkCallback(laterFailure)!, laterFailure);
    assert.equal(outcome, "duplicate");
    assert.equal(await status(p.id), "completed", "a completed payment can never move to failed");

    // And a second "success" for the same id must not credit a second time.
    const secondSuccess = successPayload("co-dup-1", 1000);
    const outcome2 = await applyStkCallback(admin, parseStkCallback(secondSuccess)!, secondSuccess);
    assert.equal(outcome2, "duplicate");
    assert.deepEqual(await wallets(db), afterComplete, "no second credit, no matter what a later callback claims");
  });
});

describe("applyStkCallback — database update failure is handled safely", () => {
  test("when the completion write itself fails, the function returns 'rejected' instead of throwing or silently succeeding", async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-dberr-1" });
    const faultyAdmin = withForcedUpdateError(db, "payment_transactions", 1);

    const payload = successPayload("co-dberr-1", 1000);
    const outcome = await applyStkCallback(faultyAdmin, parseStkCallback(payload)!, payload);

    assert.equal(outcome, "rejected");
    // The real database was never actually written to by the forced-error call.
    assert.equal(await status(p.id), "pending");
  });
});

// reconcilePendingPayment takes the Daraja query call as an injectable parameter
// (default: the real lib/mpesa.ts implementation) specifically so it can be
// swapped for a controlled stub here — ES module exports have no writable
// bindings to monkey-patch, so this is the intended test seam, not a workaround.
function stubQuery(result: StkQueryResult | (() => Promise<StkQueryResult>)) {
  return async () => (typeof result === "function" ? result() : result);
}

describe("STK Query reconciliation (reconcilePendingPayment)", () => {
  test("a pending payment confirmed successful by STK Query is completed, with confirmed_via = 'query'", async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-query-1" });
    const before = await wallets(db);
    const result = await reconcilePendingPayment(
      admin,
      p.id,
      stubQuery({
        checkoutRequestId: "co-query-1",
        resultCode: 0,
        resultDesc: "The service request is processed successfully.",
        merchantRequestId: "mr-q-1",
      }),
    );
    assert.equal(result.outcome, "completed");
    assert.equal(await status(p.id), "completed");
    const r = await row(p.id);
    assert.equal(r.confirmed_via, "query");
    const after = await wallets(db);
    assert.equal(after.teacher(p.teacher) - before.teacher(p.teacher), 700);
  });

  test("an unsuccessful STK Query result (e.g. timed out) marks the payment failed, credits nobody", async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-query-2" });
    const before = await wallets(db);
    const result = await reconcilePendingPayment(
      admin,
      p.id,
      stubQuery({ checkoutRequestId: "co-query-2", resultCode: 1037, resultDesc: "DS timeout user cannot be reached" }),
    );
    assert.equal(result.outcome, "failed");
    assert.equal(await status(p.id), "failed");
    assert.deepEqual(await wallets(db), before);
  });

  test('"still processing" leaves the payment exactly as it was — never completed on HTTP success alone', async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-query-3" });
    const result = await reconcilePendingPayment(
      admin,
      p.id,
      stubQuery({ checkoutRequestId: "co-query-3", resultCode: null, resultDesc: "still processing" }),
    );
    assert.equal(result.outcome, "still_pending");
    assert.equal(await status(p.id), "pending");
  });

  test("a Daraja timeout/network error during the query is handled safely: query_unavailable, payment stays pending", async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-query-4" });
    const failingQuery = async (): Promise<StkQueryResult> => {
      throw new Error("M-Pesa STK status query timed out.");
    };
    const result = await reconcilePendingPayment(admin, p.id, failingQuery);
    assert.equal(result.outcome, "query_unavailable");
    assert.equal(await status(p.id), "pending");
    const r = await row(p.id);
    assert.equal(r.query_attempts, 1);
  });

  test("querying an already-final payment is a safe no-op (already_final), never re-queries Daraja", async () => {
    const p = await newPayment(db, { amount: 1000, checkout: "co-query-5" });
    await db.query("update payment_transactions set status = 'failed', result_code = 1 where id = $1", [p.id]);
    const mustNotBeCalled = async (): Promise<StkQueryResult> => {
      throw new Error("must not be called for an already-final payment");
    };
    const result = await reconcilePendingPayment(admin, p.id, mustNotBeCalled);
    assert.equal(result.outcome, "already_final");
    assert.equal(result.status, "failed");
  });

  test("a payment with no checkout_request_id at all cannot be queried", async () => {
    const p = await newPayment(db, { amount: 1000 }); // no checkout id supplied
    const result = await reconcilePendingPayment(admin, p.id);
    assert.equal(result.outcome, "query_unavailable");
  });
});

// ---- test-only helper: forces the NEXT `.update()` call on `table` to resolve with a
// database error instead of touching the real database, so the "handle DB errors safely"
// code path can be exercised deterministically. Every other call goes to the real PGlite db.
function withForcedUpdateError(pglite: PGlite, table: string, times: number) {
  const real = fakeAdmin(pglite) as unknown as { from: (t: string) => Record<string, unknown> };
  let remaining = times;
  return {
    from: (t: string) => {
      const builder = real.from(t) as { update: (p: unknown) => unknown; then?: unknown };
      if (t !== table) return builder;
      const originalUpdate = builder.update.bind(builder);
      builder.update = (payload: unknown) => {
        const chained = originalUpdate(payload) as { then: unknown };
        if (remaining > 0) {
          remaining -= 1;
          (chained as Record<string, unknown>).then = (resolve: (r: unknown) => unknown) =>
            resolve({ data: null, error: { message: "simulated database failure" } });
        }
        return chained;
      };
      return builder;
    },
  } as unknown as ReturnType<typeof fakeAdmin>;
}

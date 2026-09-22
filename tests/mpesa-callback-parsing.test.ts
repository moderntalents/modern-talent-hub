// Pure-function tests for the parsing/verification helpers in lib/mpesa-payments.ts.
// No database, no fetch — these are plain data-in, data-out checks.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseStkCallback, parseDarajaTimestamp, amountMatches, phoneMatches } from "@/lib/mpesa-payments";

function successPayload(overrides: Record<string, unknown> = {}) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "mr-1",
        CheckoutRequestID: "co-1",
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: 1000 },
            { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" },
            { Name: "TransactionDate", Value: 20240115103000 },
            { Name: "PhoneNumber", Value: 254712345678 },
          ],
        },
        ...overrides,
      },
    },
  };
}

function failurePayload(resultCode = 1032, resultDesc = "Request cancelled by user") {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "mr-2",
        CheckoutRequestID: "co-2",
        ResultCode: resultCode,
        ResultDesc: resultDesc,
      },
    },
  };
}

describe("parseStkCallback", () => {
  test("parses a successful callback's metadata items", () => {
    const parsed = parseStkCallback(successPayload());
    assert.ok(parsed);
    assert.equal(parsed!.checkoutRequestId, "co-1");
    assert.equal(parsed!.merchantRequestId, "mr-1");
    assert.equal(parsed!.resultCode, 0);
    assert.equal(parsed!.amount, 1000);
    assert.equal(parsed!.receipt, "NLJ7RT61SV");
    assert.equal(parsed!.phone, "254712345678");
    assert.equal(parsed!.transactionDate, "20240115103000");
  });

  test("parses a failure callback with no CallbackMetadata at all", () => {
    const parsed = parseStkCallback(failurePayload());
    assert.ok(parsed);
    assert.equal(parsed!.resultCode, 1032);
    assert.equal(parsed!.resultDesc, "Request cancelled by user");
    assert.equal(parsed!.amount, null);
    assert.equal(parsed!.receipt, null);
    assert.equal(parsed!.phone, null);
  });

  test("returns null for garbage/malformed/missing payloads", () => {
    assert.equal(parseStkCallback(null), null);
    assert.equal(parseStkCallback(undefined), null);
    assert.equal(parseStkCallback({}), null);
    assert.equal(parseStkCallback({ Body: {} }), null);
    assert.equal(parseStkCallback({ Body: { stkCallback: {} } }), null, "missing CheckoutRequestID");
    assert.equal(parseStkCallback({ Body: { stkCallback: { CheckoutRequestID: "co-1" } } }), null, "missing/non-numeric ResultCode");
    assert.equal(parseStkCallback("just a string"), null);
    assert.equal(parseStkCallback(42), null);
  });
});

describe("parseDarajaTimestamp", () => {
  test("converts Africa/Nairobi (UTC+3) local time to a correct UTC instant", () => {
    // 2024-01-15 10:30:00 Nairobi time = 2024-01-15 07:30:00 UTC.
    const d = parseDarajaTimestamp("20240115103000");
    assert.ok(d);
    assert.equal(d!.toISOString(), "2024-01-15T07:30:00.000Z");
  });

  test("returns null for anything that isn't exactly 14 digits", () => {
    assert.equal(parseDarajaTimestamp(null), null);
    assert.equal(parseDarajaTimestamp(""), null);
    assert.equal(parseDarajaTimestamp("2024011510300"), null);
    assert.equal(parseDarajaTimestamp("202401151030000"), null);
    assert.equal(parseDarajaTimestamp("not-a-date-xxxx"), null);
  });
});

describe("amountMatches", () => {
  test("true only when the callback amount exactly equals the expected amount", () => {
    assert.equal(amountMatches(1000, 1000), true);
    assert.equal(amountMatches(1000, 1000.0), true);
  });
  test("false when the amounts differ, or nothing was reported to check", () => {
    assert.equal(amountMatches(1000, 999), false);
    assert.equal(amountMatches(1000, 1001), false);
    assert.equal(amountMatches(1000, null), false, "a claimed success with no amount at all cannot be verified");
  });
});

describe("phoneMatches", () => {
  test("true when both are known and agree (after normalization)", () => {
    assert.equal(phoneMatches("254712345678", "254712345678"), true);
    assert.equal(phoneMatches("254712345678", "0712345678"), true, "normalizes the callback's phone before comparing");
  });
  test("false when both are known and disagree", () => {
    assert.equal(phoneMatches("254712345678", "254798765432"), false);
  });
  test("true (nothing to verify) when either side is unknown", () => {
    assert.equal(phoneMatches(null, "254712345678"), true);
    assert.equal(phoneMatches("254712345678", null), true);
    assert.equal(phoneMatches(null, null), true);
  });
});

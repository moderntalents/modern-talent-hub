// Phase 2 tests for lib/mpesa.ts: the hardened Daraja HTTP layer (STK Push + STK Query).
// These never make a real network call — global.fetch is replaced with a controllable
// mock for each test and restored afterwards. Run with the same env vars every other
// suite uses so a config-validation test can freely unset one and know it's the only change.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const REQUIRED_ENV = {
  MPESA_ENV: "sandbox",
  MPESA_CONSUMER_KEY: "test-consumer-key",
  MPESA_CONSUMER_SECRET: "SUPER-SECRET-CONSUMER-VALUE",
  MPESA_SHORTCODE: "174379",
  MPESA_PASSKEY: "SUPER-SECRET-PASSKEY-VALUE",
  MPESA_CALLBACK_URL: "https://example.invalid/api/mpesa/callback/topsecret",
};
const SECRET_STRINGS = [REQUIRED_ENV.MPESA_CONSUMER_SECRET, REQUIRED_ENV.MPESA_PASSKEY, "sample-access-token-xyz"];

function setEnv() {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
}
function clearEnv() {
  for (const k of Object.keys(REQUIRED_ENV)) delete process.env[k];
}

type FetchMock = (input: unknown, init?: RequestInit) => Promise<Response> | Response;
let originalFetch: typeof fetch;
let originalConsoleError: typeof console.error;
let consoleErrors: unknown[][];

beforeEach(() => {
  setEnv();
  originalFetch = globalThis.fetch;
  originalConsoleError = console.error;
  consoleErrors = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };
});
afterEach(() => {
  clearEnv();
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

function mockFetch(handler: FetchMock) {
  globalThis.fetch = handler as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const TOKEN_OK = { access_token: "sample-access-token-xyz" };

/** A fetch mock that answers the OAuth token call, then delegates everything else. */
function withToken(next: FetchMock): FetchMock {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/oauth/v1/generate")) return jsonResponse(TOKEN_OK);
    return next(input, init);
  };
}

function assertNoSecretLeak(haystack: string) {
  for (const secret of SECRET_STRINGS) {
    assert.ok(!haystack.includes(secret), `leaked a secret value: found "${secret}" in "${haystack}"`);
  }
}

function allLoggedText(): string {
  return consoleErrors.map((args) => args.map(String).join(" ")).join("\n");
}

describe("STK Push (CustomerPayBillOnline)", () => {
  test("a successful push returns the Daraja identifiers", async () => {
    const { initiateStkPush } = await import("@/lib/mpesa");
    mockFetch(
      withToken(async (_input, init) => {
        const body = JSON.parse(String((init as RequestInit).body));
        assert.equal(body.TransactionType, "CustomerPayBillOnline", "must stay PayBill, not Buy Goods/Till");
        assert.equal(body.Amount, 500);
        assert.equal(body.BusinessShortCode, REQUIRED_ENV.MPESA_SHORTCODE);
        assert.equal(body.PartyB, REQUIRED_ENV.MPESA_SHORTCODE, "PartyB must be the PayBill shortcode, not a till number");
        return jsonResponse({
          MerchantRequestID: "mr-1",
          CheckoutRequestID: "co-1",
          ResponseCode: "0",
          ResponseDescription: "Success. Request accepted for processing",
        });
      }),
    );
    const result = await initiateStkPush({
      phoneNumber: "254712345678",
      amount: 500,
      accountReference: "MTH-abcd1234",
      transactionDesc: "Football club",
    });
    assert.equal(result.checkoutRequestId, "co-1");
    assert.equal(result.merchantRequestId, "mr-1");
  });

  test("a Daraja-side rejection (non-zero ResponseCode) throws with Daraja's own message", async () => {
    const { initiateStkPush } = await import("@/lib/mpesa");
    mockFetch(withToken(async () => jsonResponse({ ResponseCode: "1", errorMessage: "Invalid PartyA" }, 200)));
    await assert.rejects(
      initiateStkPush({ phoneNumber: "254712345678", amount: 500, accountReference: "MTH-1", transactionDesc: "x" }),
      /Invalid PartyA/,
    );
  });

  test("fails closed when M-Pesa configuration is incomplete", async () => {
    delete process.env.MPESA_PASSKEY;
    const { initiateStkPush } = await import("@/lib/mpesa");
    mockFetch(async () => {
      throw new Error("fetch must never be called when not configured");
    });
    await assert.rejects(
      initiateStkPush({ phoneNumber: "254712345678", amount: 500, accountReference: "MTH-1", transactionDesc: "x" }),
      /not configured/i,
    );
  });

  test("rejects a fractional amount without rounding it", async () => {
    const { initiateStkPush } = await import("@/lib/mpesa");
    let called = false;
    mockFetch(async () => {
      called = true;
      return jsonResponse({ ResponseCode: "0", MerchantRequestID: "m", CheckoutRequestID: "c" });
    });
    await assert.rejects(
      initiateStkPush({ phoneNumber: "254712345678", amount: 499.5, accountReference: "MTH-1", transactionDesc: "x" }),
      /whole number/i,
    );
    assert.equal(called, false, "must not call Daraja at all for an invalid amount");
  });

  test("rejects zero, negative and above-the-cap amounts", async () => {
    const { initiateStkPush } = await import("@/lib/mpesa");
    mockFetch(withToken(async () => jsonResponse({ ResponseCode: "0", MerchantRequestID: "m", CheckoutRequestID: "c" })));
    for (const bad of [0, -5, 250_001, NaN]) {
      await assert.rejects(
        initiateStkPush({ phoneNumber: "254712345678", amount: bad, accountReference: "MTH-1", transactionDesc: "x" }),
      );
    }
  });

  test("normalizes/validates the phone number: a malformed MSISDN is refused before calling Daraja", async () => {
    const { initiateStkPush } = await import("@/lib/mpesa");
    let called = false;
    mockFetch(async () => {
      called = true;
      return jsonResponse({ ResponseCode: "0" });
    });
    for (const bad of ["0712345678", "254712345", "2547123456789", "not-a-phone", "254212345678"]) {
      await assert.rejects(
        initiateStkPush({ phoneNumber: bad, amount: 500, accountReference: "MTH-1", transactionDesc: "x" }),
        /phone/i,
      );
    }
    assert.equal(called, false);
  });

  test("accepts a valid 2541XXXXXXXX (Airtel/other) number, not just 2547", async () => {
    const { initiateStkPush } = await import("@/lib/mpesa");
    mockFetch(withToken(async () => jsonResponse({ ResponseCode: "0", MerchantRequestID: "m", CheckoutRequestID: "c" })));
    await assert.doesNotReject(
      initiateStkPush({ phoneNumber: "254112345678", amount: 500, accountReference: "MTH-1", transactionDesc: "x" }),
    );
  });

  test("keeps AccountReference and TransactionDesc within Daraja's limits", async () => {
    const { initiateStkPush } = await import("@/lib/mpesa");
    mockFetch(withToken(async () => jsonResponse({ ResponseCode: "0", MerchantRequestID: "m", CheckoutRequestID: "c" })));
    await assert.rejects(
      initiateStkPush({
        phoneNumber: "254712345678",
        amount: 500,
        accountReference: "THIS-IS-WAY-TOO-LONG",
        transactionDesc: "x",
      }),
      /AccountReference/,
    );
    await assert.rejects(
      initiateStkPush({
        phoneNumber: "254712345678",
        amount: 500,
        accountReference: "MTH-1",
        transactionDesc: "This description is definitely too long for Daraja",
      }),
      /TransactionDesc/,
    );
  });

  test("a Daraja/network timeout on the STK push itself throws a clear, non-hanging error", async () => {
    const { initiateStkPush } = await import("@/lib/mpesa");
    mockFetch(
      withToken(async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      }),
    );
    await assert.rejects(
      initiateStkPush({ phoneNumber: "254712345678", amount: 500, accountReference: "MTH-1", transactionDesc: "x" }),
      /timed out/i,
    );
  });

  test("a network error obtaining the token throws a clear error without leaking request internals", async () => {
    const { initiateStkPush } = await import("@/lib/mpesa");
    mockFetch(async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND sandbox.safaricom.co.ke");
    });
    await assert.rejects(
      initiateStkPush({ phoneNumber: "254712345678", amount: 500, accountReference: "MTH-1", transactionDesc: "x" }),
      /network error|could not reach/i,
    );
  });

  test("never logs the consumer secret, passkey, or access token — success, failure or timeout", async () => {
    const { initiateStkPush } = await import("@/lib/mpesa");

    mockFetch(withToken(async () => jsonResponse({ ResponseCode: "0", MerchantRequestID: "m", CheckoutRequestID: "c" })));
    await initiateStkPush({ phoneNumber: "254712345678", amount: 500, accountReference: "MTH-1", transactionDesc: "x" });

    mockFetch(withToken(async () => jsonResponse({ ResponseCode: "1", errorMessage: "boom" })));
    await initiateStkPush({ phoneNumber: "254712345678", amount: 500, accountReference: "MTH-1", transactionDesc: "x" }).catch(
      (e: Error) => assertNoSecretLeak(e.message),
    );

    mockFetch(async () => {
      throw new Error("network down");
    });
    await initiateStkPush({ phoneNumber: "254712345678", amount: 500, accountReference: "MTH-1", transactionDesc: "x" }).catch(
      (e: Error) => assertNoSecretLeak(e.message),
    );

    assertNoSecretLeak(allLoggedText());
  });
});

describe("STK Query", () => {
  test("a confirmed success (ResultCode 0) is reported, not assumed from the HTTP status alone", async () => {
    const { queryStkPushStatus } = await import("@/lib/mpesa");
    mockFetch(
      withToken(async () =>
        jsonResponse({
          ResponseCode: "0",
          MerchantRequestID: "mr-1",
          CheckoutRequestID: "co-1",
          ResultCode: 0,
          ResultDesc: "The service request is processed successfully.",
        }),
      ),
    );
    const result = await queryStkPushStatus("co-1");
    assert.equal(result.resultCode, 0);
  });

  test("a definite failure result (e.g. cancelled by user) is reported as a real, non-null ResultCode", async () => {
    const { queryStkPushStatus } = await import("@/lib/mpesa");
    mockFetch(
      withToken(async () =>
        jsonResponse({
          ResponseCode: "0",
          CheckoutRequestID: "co-1",
          ResultCode: 1032,
          ResultDesc: "Request cancelled by user",
        }),
      ),
    );
    const result = await queryStkPushStatus("co-1");
    assert.equal(result.resultCode, 1032);
  });

  test('"still processing" (HTTP 500 / errorCode 500.001.1001) is reported as null, not as success or failure', async () => {
    const { queryStkPushStatus } = await import("@/lib/mpesa");
    mockFetch(
      withToken(async () =>
        jsonResponse({ requestId: "r1", errorCode: "500.001.1001", errorMessage: "The transaction is being processed" }, 500),
      ),
    );
    const result = await queryStkPushStatus("co-1");
    assert.equal(result.resultCode, null, "still-processing must be a distinct, non-final state — never a silent success");
  });

  test("a genuine query failure (unrelated HTTP 500) throws rather than being treated as any kind of result", async () => {
    const { queryStkPushStatus } = await import("@/lib/mpesa");
    mockFetch(withToken(async () => jsonResponse({ errorCode: "500.001.9999", errorMessage: "Internal error" }, 500)));
    await assert.rejects(queryStkPushStatus("co-1"));
  });

  test("a timeout/network error querying Daraja throws a clear error, not a false result", async () => {
    const { queryStkPushStatus } = await import("@/lib/mpesa");
    mockFetch(
      withToken(async () => {
        throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      }),
    );
    await assert.rejects(queryStkPushStatus("co-1"), /timed out/i);
  });

  test("requires a checkoutRequestId and fails closed without configuration", async () => {
    const { queryStkPushStatus } = await import("@/lib/mpesa");
    await assert.rejects(queryStkPushStatus(""), /checkoutRequestId/);
    delete process.env.MPESA_SHORTCODE;
    await assert.rejects(queryStkPushStatus("co-1"), /not configured/i);
  });
});

describe("payment amount validation (validatePaymentAmount)", () => {
  test("accepts whole shillings in range, rejects everything else without coercing", async () => {
    const { validatePaymentAmount } = await import("@/lib/mpesa");
    assert.equal(validatePaymentAmount(1), 1);
    assert.equal(validatePaymentAmount(250_000), 250_000);
    assert.equal(validatePaymentAmount("500"), 500);
    for (const bad of [0, -1, 250_001, 99.5, NaN, Infinity, "abc", null, undefined]) {
      assert.throws(() => validatePaymentAmount(bad));
    }
  });
});

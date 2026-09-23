// Tests for migration 0016 (coach B2C withdrawal) and lib/mpesa-withdrawals.ts, run
// against a REAL PGlite Postgres with 0001-0010, 0012, 0013, 0015, 0016, 0017 applied —
// the actual triggers/constraints that run in production decide whether a withdrawal can
// be created, reserved, and finalized. fakeAdmin() is the same thin Supabase-client-shaped
// adapter used across the other Phase 2 test files.
//
// applyB2CCallback now matches by ConversationID against withdrawal_b2c_attempts (0017),
// not against withdrawal_requests directly — insertAttempt() below stands in for what
// createB2CAttempt()/attachB2CIdentifiers() would have done in the real request flow.
// The multi-attempt-specific scenarios (retries, the reconciliation sweep, admin
// resolution, and the callback/retry concurrency races) live in
// tests/b2c-reconciliation.test.ts.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, as } from "./helpers/db";
import { seedWorld, ID } from "./helpers/seed";
import { fakeAdmin } from "./helpers/fake-admin";
import { attemptOn, raised } from "./helpers/payments";
import { applyB2CCallback, parseB2CCallback } from "@/lib/mpesa-withdrawals";

let db: PGlite;
let admin: ReturnType<typeof fakeAdmin>;
let attempt: ReturnType<typeof attemptOn>;

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
  admin = fakeAdmin(db);
  attempt = attemptOn(db);
});

async function setupWallet(teacherId: string, balance: number, mpesaNumber: string | null = "254712345678") {
  await db.query("update teacher_profiles set wallet_balance = $1, mpesa_number = $2 where profile_id = $3", [
    balance,
    mpesaNumber,
    teacherId,
  ]);
}

beforeEach(async () => {
  await db.exec(`
    set session_replication_role = replica;
    delete from wallet_ledger;
    delete from withdrawal_reconciliation_log;
    delete from withdrawal_b2c_attempts;
    delete from withdrawal_requests;
    update teacher_profiles set wallet_balance = 0, mpesa_number = null;
    reset session_replication_role;
  `);
});

async function insertMpesaWithdrawal(teacherId: string, amount: number, destination = "0700000000") {
  return db.query<{
    id: string;
    status: string;
    amount: string;
    destination: string;
  }>(
    "insert into withdrawal_requests (teacher_id, amount, method, destination) values ($1, $2, 'mpesa', $3) returning *",
    [teacherId, amount, destination],
  );
}

async function ledgerRows(teacherId: string) {
  const r = await db.query<{ entry_type: string; amount: string; withdrawal_request_id: string }>(
    "select entry_type, amount::text as amount, withdrawal_request_id from wallet_ledger where teacher_id = $1 order by id",
    [teacherId],
  );
  return r.rows;
}

async function balance(teacherId: string): Promise<number> {
  const r = await db.query<{ b: string }>("select wallet_balance::text as b from teacher_profiles where profile_id = $1", [teacherId]);
  return Number(r.rows[0].b);
}

function successPayload(conversationId: string, amount: number, receipt = "B2C-RCPT-1", overrides: Record<string, unknown> = {}) {
  return {
    Result: {
      ResultType: 0,
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      OriginatorConversationID: "orig-" + conversationId,
      ConversationID: conversationId,
      TransactionID: "TXN123",
      ResultParameters: {
        ResultParameter: [
          { Key: "TransactionAmount", Value: amount },
          { Key: "TransactionReceipt", Value: receipt },
        ],
      },
      ...overrides,
    },
  };
}

async function insertAttempt(withdrawalId: string, conversationId: string, status: "requested" | "accepted" = "accepted", attemptNumber = 1) {
  await db.query(
    "insert into withdrawal_b2c_attempts (withdrawal_request_id, attempt_number, status, conversation_id, originator_conversation_id) values ($1, $2, $3, $4, $5)",
    [withdrawalId, attemptNumber, status, conversationId, "orig-" + conversationId],
  );
}

function failurePayload(conversationId: string, resultCode = 2001, resultDesc = "The initiator information is invalid.") {
  return {
    Result: {
      ResultType: 0,
      ResultCode: resultCode,
      ResultDesc: resultDesc,
      OriginatorConversationID: "orig-" + conversationId,
      ConversationID: conversationId,
    },
  };
}

// ==================================================================================================
describe("atomic reservation at insert time", () => {
  test("insufficient balance is refused, and nothing is reserved", async () => {
    await setupWallet(ID.T2, 500);
    await assert.rejects(insertMpesaWithdrawal(ID.T2, 501), /exceeds/);
    assert.equal(await balance(ID.T2), 500);
    assert.deepEqual(await ledgerRows(ID.T2), []);
  });

  test("zero and negative amounts are refused by the table's own check constraint", async () => {
    await setupWallet(ID.T2, 500);
    await assert.rejects(insertMpesaWithdrawal(ID.T2, 0));
    await assert.rejects(insertMpesaWithdrawal(ID.T2, -50));
  });

  test("no registered M-Pesa number refuses the withdrawal", async () => {
    await setupWallet(ID.T2, 500, null);
    await assert.rejects(insertMpesaWithdrawal(ID.T2, 100), /No M-Pesa number/);
    assert.equal(await balance(ID.T2), 500);
  });

  test("a valid request is reserved atomically: balance debited, ledger row written, status is processing", async () => {
    await setupWallet(ID.T2, 1000);
    const r = await insertMpesaWithdrawal(ID.T2, 400);
    const row = r.rows[0];

    assert.equal(row.status, "processing");
    assert.equal(await balance(ID.T2), 600);

    const rows = await ledgerRows(ID.T2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entry_type, "withdrawal_debit");
    assert.equal(Number(rows[0].amount), -400);
    assert.equal(rows[0].withdrawal_request_id, row.id);
  });

  test("the registered M-Pesa number is used — a freely-typed destination is ignored", async () => {
    await setupWallet(ID.T2, 1000, "254799999999");
    const r = await insertMpesaWithdrawal(ID.T2, 100, "254700000000-attacker-supplied");
    assert.equal(r.rows[0].destination, "254799999999");
  });

  test("two withdrawals submitted back-to-back cannot collectively exceed the balance", async () => {
    await setupWallet(ID.T2, 1000);
    const results = await Promise.allSettled([insertMpesaWithdrawal(ID.T2, 700), insertMpesaWithdrawal(ID.T2, 700)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "only one of the two overlapping 700 requests against a 1000 balance can succeed");
    assert.equal(rejected.length, 1);
    assert.equal(await balance(ID.T2), 300, "exactly one 700 reservation was taken");
  });

  test("a coach can run several withdrawals at once as long as they don't collectively exceed the balance", async () => {
    await setupWallet(ID.T2, 1000);
    await insertMpesaWithdrawal(ID.T2, 300);
    await insertMpesaWithdrawal(ID.T2, 300);
    assert.equal(await balance(ID.T2), 400);
    assert.equal((await ledgerRows(ID.T2)).length, 2);
  });

  test("bank withdrawals are completely unaffected: no reservation, no ledger row, status stays pending", async () => {
    await setupWallet(ID.T2, 1000);
    const r = await db.query<{ status: string; destination: string }>(
      "insert into withdrawal_requests (teacher_id, amount, method, destination) values ($1, 200, 'bank', 'Equity 001122') returning status, destination",
      [ID.T2],
    );
    assert.equal(r.rows[0].status, "pending");
    assert.equal(r.rows[0].destination, "Equity 001122", "bank destination is never overridden");
    assert.equal(await balance(ID.T2), 1000, "bank is not reserved at insert — unchanged Phase 1 behavior");
    assert.deepEqual(await ledgerRows(ID.T2), []);
  });
});

// ==================================================================================================
describe("applyB2CCallback — success", () => {
  test("a verified success finalizes the withdrawal, without a second debit", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 400);
    const w = rows[0];
    await insertAttempt(w.id, "conv-1");

    const payload = successPayload("conv-1", 400);
    const outcome = await applyB2CCallback(admin, parseB2CCallback(payload)!);

    assert.equal(outcome, "resolved_successful");
    const after = await db.query<{ status: string; provider_reference: string; result_code: number }>(
      "select status, provider_reference, result_code from withdrawal_requests where id = $1",
      [w.id],
    );
    assert.equal(after.rows[0].status, "successful");
    assert.equal(after.rows[0].provider_reference, "B2C-RCPT-1");
    assert.equal(after.rows[0].result_code, 0);
    assert.equal(await balance(ID.T2), 600, "balance unchanged by success — it was already reserved");
    assert.equal((await ledgerRows(ID.T2)).length, 1, "still just the original debit — no second ledger row");
  });

  test("a mismatched Daraja-reported amount is logged for manual review, without changing the outcome, status, balance or ledger", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 400);
    const w = rows[0];
    await insertAttempt(w.id, "conv-mismatch-1");

    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    let outcome: string;
    try {
      // 400 was authorized/reserved; Daraja reports having paid 350.
      outcome = await applyB2CCallback(admin, parseB2CCallback(successPayload("conv-mismatch-1", 350))!);
    } finally {
      console.error = originalError;
    }

    assert.ok(
      logged.some((args) => String(args[0]).includes("AMOUNT MISMATCH")),
      "the mismatch must be logged loudly for manual review",
    );

    assert.equal(outcome, "resolved_successful", "log-only — the callback still resolves exactly as a normal success would");
    const after = await db.query<{ status: string }>("select status from withdrawal_requests where id = $1", [w.id]);
    assert.equal(after.rows[0].status, "successful", "status is unaffected by the mismatch");
    assert.equal(await balance(ID.T2), 600, "balance is exactly what a normal 400 reservation produces — the mismatch never touches the wallet");
    assert.equal((await ledgerRows(ID.T2)).length, 1, "still exactly the one original debit — no reversal, no second entry, no attempt-level effect");

    const attempt = await db.query<{ status: string; attempt_number: number }>(
      "select status, attempt_number from withdrawal_b2c_attempts where withdrawal_request_id = $1",
      [w.id],
    );
    assert.equal(attempt.rows.length, 1, "no new attempt was created because of the mismatch");
    assert.equal(attempt.rows[0].status, "succeeded");
  });

  test("a duplicate success callback has no additional financial effect", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 400);
    const w = rows[0];
    await insertAttempt(w.id, "conv-2");
    const payload = successPayload("conv-2", 400);
    const parsed = parseB2CCallback(payload)!;

    const first = await applyB2CCallback(admin, parsed);
    const balanceAfterFirst = await balance(ID.T2);
    const ledgerAfterFirst = await ledgerRows(ID.T2);
    const second = await applyB2CCallback(admin, parsed);

    assert.equal(first, "resolved_successful");
    assert.equal(second, "superseded_recorded", "the attempt is no longer live once resolved, so a repeat callback is recorded for audit only");
    assert.equal(await balance(ID.T2), balanceAfterFirst);
    assert.deepEqual(await ledgerRows(ID.T2), ledgerAfterFirst);
  });

  test("a completed withdrawal cannot be processed successfully again via a direct update either", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 400);
    const w = rows[0];
    await db.query("update withdrawal_requests set conversation_id = $1, status = 'successful', result_code = 0, processed_at = now() where id = $2", [
      "conv-3",
      w.id,
    ]);
    await assert.rejects(
      db.query("update withdrawal_requests set status = 'processing' where id = $1", [w.id]),
      /final and cannot be changed/,
    );
  });
});

// ==================================================================================================
describe("applyB2CCallback — failure and reversal", () => {
  test("a failure callback marks the withdrawal failed and restores the reserved amount exactly once", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 400);
    const w = rows[0];
    await insertAttempt(w.id, "conv-4");
    assert.equal(await balance(ID.T2), 600, "reserved");

    const outcome = await applyB2CCallback(admin, parseB2CCallback(failurePayload("conv-4"))!);
    assert.equal(outcome, "resolved_failed");
    assert.equal(await balance(ID.T2), 1000, "fully restored");

    const rows2 = await ledgerRows(ID.T2);
    assert.equal(rows2.length, 2);
    assert.equal(rows2[0].entry_type, "withdrawal_debit");
    assert.equal(rows2[1].entry_type, "withdrawal_reversal");
    assert.equal(Number(rows2[1].amount), 400);
  });

  test("a duplicate failure callback does not restore the amount twice", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 400);
    const w = rows[0];
    await insertAttempt(w.id, "conv-5");
    const parsed = parseB2CCallback(failurePayload("conv-5"))!;

    const first = await applyB2CCallback(admin, parsed);
    const balanceAfterFirst = await balance(ID.T2);
    const second = await applyB2CCallback(admin, parsed);

    assert.equal(first, "resolved_failed");
    assert.equal(second, "superseded_recorded");
    assert.equal(await balance(ID.T2), balanceAfterFirst);
    assert.equal((await ledgerRows(ID.T2)).length, 2, "still exactly one debit and one reversal");
  });

  test("the ledger's unique key blocks a second reversal even via a direct update, rolling it back", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 400);
    const w = rows[0];
    await insertAttempt(w.id, "conv-6");
    await applyB2CCallback(admin, parseB2CCallback(failurePayload("conv-6"))!);
    // Force the row back to 'processing' at the SQL level (bypassing the app) to prove the
    // unique index itself — not just the app-level duplicate check — stops a second reversal.
    await db.exec("set session_replication_role = replica");
    await db.query("update withdrawal_requests set status = 'processing' where id = $1", [w.id]);
    await db.exec("reset session_replication_role");
    await assert.rejects(
      db.query("update withdrawal_requests set status = 'failed', result_code = 1 where id = $1", [w.id]),
      /wallet_ledger_withdrawal_key/,
    );
  });
});

// ==================================================================================================
describe("callback matching, validation and idempotency edge cases", () => {
  test("an unknown ConversationID is handled safely, not an error", async () => {
    const outcome = await applyB2CCallback(admin, parseB2CCallback(successPayload("conv-does-not-exist", 100))!);
    assert.equal(outcome, "unmatched");
  });

  test("a malformed/unparseable payload is rejected before touching the database", () => {
    assert.equal(parseB2CCallback(null), null);
    assert.equal(parseB2CCallback({}), null);
    assert.equal(parseB2CCallback({ Result: {} }), null, "missing ConversationID");
    assert.equal(parseB2CCallback({ Result: { ConversationID: "x" } }), null, "missing/non-numeric ResultCode");
  });

  test("a callback for a still-'requested' attempt (arrives before the synchronous accept was recorded) still resolves it live", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 200);
    const w = rows[0];
    await insertAttempt(w.id, "conv-7", "requested");
    const outcome = await applyB2CCallback(admin, parseB2CCallback(successPayload("conv-7", 200))!);
    assert.equal(outcome, "resolved_successful", "'requested' is still live, same as 'accepted' — only 'succeeded'/'failed'/'ambiguous'/'superseded' are not");
    const after = await db.query<{ status: string }>("select status from withdrawal_requests where id = $1", [w.id]);
    assert.equal(after.rows[0].status, "successful");
  });

  test("illegal state transitions are rejected by the database", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 400);
    const w = rows[0];
    // processing -> reversed is not a legal direct transition (reversed only follows successful).
    await assert.rejects(db.query("update withdrawal_requests set status = 'reversed' where id = $1", [w.id]), /Illegal withdrawal status change/);
    // successful -> failed is not legal either.
    await db.query("update withdrawal_requests set status = 'successful', result_code = 0 where id = $1", [w.id]);
    await assert.rejects(db.query("update withdrawal_requests set status = 'failed' where id = $1", [w.id]), /final and cannot be changed/);
  });

  test("successful -> reversed (admin claw-back) credits the wallet back and logs a ledger reversal for mpesa", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 400);
    const w = rows[0];
    await db.query("update withdrawal_requests set status = 'successful', result_code = 0 where id = $1", [w.id]);
    assert.equal(await balance(ID.T2), 600);
    await db.query("update withdrawal_requests set status = 'reversed' where id = $1", [w.id]);
    assert.equal(await balance(ID.T2), 1000);
    const rows2 = await ledgerRows(ID.T2);
    assert.equal(rows2.filter((r) => r.entry_type === "withdrawal_reversal").length, 1);
  });
});

// ==================================================================================================
describe("authorization (RLS on withdrawal_requests, unchanged by 0016)", () => {
  test("a coach cannot insert a withdrawal for another coach's wallet", async () => {
    await setupWallet(ID.T2, 1000);
    const outcome = await attempt(
      { id: ID.T4 },
      "insert into withdrawal_requests (teacher_id, amount, method, destination) values ($1, 100, 'mpesa', 'x')",
      [ID.T2],
    );
    assert.ok(!outcome.ok, "RLS still refuses inserting a row with someone else's teacher_id");
  });

  test("a coach can only read their own withdrawals; an admin can read all", async () => {
    await setupWallet(ID.T2, 1000);
    await insertMpesaWithdrawal(ID.T2, 100);
    const rowCount = async (actor: Parameters<typeof attempt>[0]) => {
      const o = await attempt(actor, "select id from withdrawal_requests");
      return o.ok ? o.rows.length : -1;
    };
    assert.ok((await rowCount({ id: ID.T2 })) >= 1);
    assert.equal(await rowCount({ id: ID.T4 }), 0);
    assert.ok((await rowCount({ id: ID.ADMIN })) >= 1);
  });

  test("a browser session cannot change a withdrawal's status directly", async () => {
    await setupWallet(ID.T2, 1000);
    const { rows } = await insertMpesaWithdrawal(ID.T2, 100);
    // RLS has no UPDATE policy for withdrawal_requests at all (0001), so this doesn't
    // raise — it silently matches zero rows. Both are checked: the statement affects
    // nothing, and the row itself is provably unchanged afterward.
    for (const actor of [{ id: ID.T2 }, { id: ID.ADMIN }, "anon"] as const) {
      const outcome = await attempt(actor, "update withdrawal_requests set status = 'successful' where id = $1 returning id", [rows[0].id]);
      assert.ok(!outcome.ok || outcome.rows.length === 0, `${JSON.stringify(actor)} must not be able to update a withdrawal`);
    }
    const after = await db.query<{ status: string }>("select status from withdrawal_requests where id = $1", [rows[0].id]);
    assert.equal(after.rows[0].status, "processing", "status is unchanged by any of the attempts above");
  });
});
